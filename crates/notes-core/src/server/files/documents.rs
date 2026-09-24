use std::collections::{HashMap, VecDeque};
use std::fs::File;

use axum::body::Bytes;

use super::{
    BOM, Document, MAX_DOCUMENT_BYTES, Root, cache::touch_lru, platform, read_limited,
    validate_content, validate_document_path, version,
};
use crate::server::{ApiError, frontmatter, markdown};

const MAX_CACHE_BYTES: usize = 32 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 16;
const MAX_CACHED_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;

impl Document {
    pub(in crate::server) fn raw_content(&self) -> std::borrow::Cow<'_, str> {
        if self.bom {
            std::borrow::Cow::Owned(format!("\u{feff}{}", self.content))
        } else {
            std::borrow::Cow::Borrowed(&self.content)
        }
    }
}

struct CachedDocument {
    fingerprint: platform::EntryFingerprint,
    document: Document,
    json: Option<Bytes>,
    bytes: usize,
}

#[derive(Default)]
pub(super) struct DocumentCache {
    entries: HashMap<String, CachedDocument>,
    order: VecDeque<String>,
    bytes: usize,
}

impl Root {
    pub(in crate::server) fn source_document(&self, path: &str) -> Result<Document, ApiError> {
        let (mut file, fingerprint) = self.open_document(path)?;
        if let Ok(mut cache) = self.document_cache.lock() {
            if let Some(document) = cache.get_source(path, fingerprint) {
                return Ok(document);
            }
        }
        let bytes = read_limited(&mut file, MAX_DOCUMENT_BYTES, "Markdown files")?;
        self.identify_document(source_from_bytes(path, &bytes)?)
    }

    pub(in crate::server) fn document_stamp(&self, path: &str) -> Result<String, ApiError> {
        let (_, stamp) = self.open_document(path)?;
        Ok(stamp
            .0
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(":"))
    }

    pub(in crate::server) fn document(&self, path: &str) -> Result<Document, ApiError> {
        self.resource_revision()?;
        let (mut file, fingerprint) = self.open_document(path)?;
        if let Ok(mut cache) = self.document_cache.lock() {
            if let Some(document) = cache.get(path, fingerprint) {
                return Ok(document);
            }
        }
        let bytes = read_limited(&mut file, MAX_DOCUMENT_BYTES, "Markdown files")?;
        let document = self.rendered_document(path, &bytes)?;
        if let Ok(mut cache) = self.document_cache.lock() {
            cache.insert(path.to_owned(), fingerprint, document.clone(), None);
        }
        Ok(document)
    }

    pub(in crate::server) fn document_json(&self, path: &str) -> Result<Bytes, ApiError> {
        self.resource_revision()?;
        let (mut file, fingerprint) = self.open_document(path)?;
        if let Ok(mut cache) = self.document_cache.lock() {
            if let Some(json) = cache.get_json(path, fingerprint) {
                return Ok(json);
            }
        }
        let bytes = read_limited(&mut file, MAX_DOCUMENT_BYTES, "Markdown files")?;
        let document = self.rendered_document(path, &bytes)?;
        let json =
            Bytes::from(serde_json::to_vec(&document).map_err(|error| {
                ApiError::internal(format!("Could not encode document: {error}"))
            })?);
        if let Ok(mut cache) = self.document_cache.lock() {
            cache.insert(path.to_owned(), fingerprint, document, Some(json.clone()));
        }
        Ok(json)
    }

    fn open_document(&self, path: &str) -> Result<(File, platform::EntryFingerprint), ApiError> {
        validate_document_path(path)?;
        let resolved = self.resolve(path)?;
        let file = resolved.parent.open_regular(&resolved.name)?;
        let metadata = file
            .metadata()
            .map_err(|error| ApiError::io("Could not inspect the document", error))?;
        Ok((file, platform::fingerprint(&metadata)))
    }
}

impl DocumentCache {
    pub(super) fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.bytes = 0;
    }

    fn get_with<T>(
        &mut self,
        path: &str,
        fingerprint: platform::EntryFingerprint,
        project: impl FnOnce(&CachedDocument) -> Option<T>,
    ) -> Option<T> {
        let value = match self.entries.get(path) {
            Some(entry) if entry.fingerprint == fingerprint => project(entry)?,
            Some(_) => {
                self.remove(path);
                return None;
            }
            None => return None,
        };
        touch_lru(&mut self.order, path);
        Some(value)
    }

    pub(super) fn get(
        &mut self,
        path: &str,
        fingerprint: platform::EntryFingerprint,
    ) -> Option<Document> {
        self.get_with(path, fingerprint, |entry| Some(entry.document.clone()))
    }

    fn get_source(
        &mut self,
        path: &str,
        fingerprint: platform::EntryFingerprint,
    ) -> Option<Document> {
        self.get_with(path, fingerprint, |entry| {
            let document = &entry.document;
            Some(Document {
                id: document.id.clone(),
                project: document.project.clone(),
                references: Vec::new(),
                path: document.path.clone(),
                content: document.content.clone(),
                version: document.version.clone(),
                title: document.title.clone(),
                bom: document.bom,
                warning: document.warning.clone(),
                html: String::new(),
            })
        })
    }

    pub(super) fn get_json(
        &mut self,
        path: &str,
        fingerprint: platform::EntryFingerprint,
    ) -> Option<Bytes> {
        self.get_with(path, fingerprint, |entry| entry.json.clone())
    }

    pub(super) fn insert(
        &mut self,
        path: String,
        fingerprint: platform::EntryFingerprint,
        document: Document,
        json: Option<Bytes>,
    ) {
        let bytes = document.path.len()
            + document.content.len()
            + document.html.len()
            + document.version.len()
            + document.id.as_ref().map_or(0, String::len)
            + document.title.as_ref().map_or(0, String::len)
            + document
                .references
                .iter()
                .map(|reference| {
                    reference.source.len()
                        + reference.resource.id.len()
                        + reference.resource.path.len()
                        + reference.resource.project.len()
                })
                .sum::<usize>()
            + json.as_ref().map_or(0, Bytes::len);
        if bytes > MAX_CACHED_DOCUMENT_BYTES {
            return;
        }
        self.remove(&path);
        while self.entries.len() >= MAX_CACHE_ENTRIES || self.bytes + bytes > MAX_CACHE_BYTES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(entry) = self.entries.remove(&oldest) {
                self.bytes -= entry.bytes;
            }
        }

        self.bytes += bytes;
        self.order.push_back(path.clone());
        self.entries.insert(
            path,
            CachedDocument {
                fingerprint,
                document,
                json,
                bytes,
            },
        );
    }

    pub(super) fn remove_tree(&mut self, path: &str) {
        let prefix = format!("{path}/");
        let paths = self
            .entries
            .keys()
            .filter(|candidate| *candidate == path || candidate.starts_with(&prefix))
            .cloned()
            .collect::<Vec<_>>();
        for path in paths {
            self.remove(&path);
        }
    }

    fn remove(&mut self, path: &str) {
        if let Some(entry) = self.entries.remove(path) {
            self.bytes -= entry.bytes;
        }
        self.order.retain(|candidate| candidate != path);
    }
}

pub(in crate::server) fn document_from_bytes(
    path: &str,
    bytes: &[u8],
) -> Result<Document, ApiError> {
    let mut document = source_from_bytes(path, bytes)?;
    document.html = markdown::render(path, &document.content);
    Ok(document)
}

pub(super) fn source_from_bytes(path: &str, bytes: &[u8]) -> Result<Document, ApiError> {
    validate_content(bytes)?;
    let content = std::str::from_utf8(bytes.strip_prefix(BOM).unwrap_or(bytes))
        .map_err(|_| ApiError::bad_request("The Markdown file is not valid UTF-8."))?;
    Ok(Document {
        id: None,
        project: None,
        references: Vec::new(),
        warning: None,
        bom: bytes.starts_with(BOM),
        path: path.to_owned(),
        content: content.to_owned(),
        html: String::new(),
        version: version(bytes),
        title: frontmatter::title(content),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(path: &str, size: usize) -> Document {
        Document {
            id: None,
            project: None,
            references: Vec::new(),
            warning: None,
            bom: false,
            path: path.to_owned(),
            content: "c".repeat(size),
            html: "h".repeat(size),
            version: "0".repeat(64),
            title: None,
        }
    }

    #[test]
    fn source_projection_keeps_cached_rendered_data_and_checks_freshness() {
        let mut cache = DocumentCache::default();
        let mut original = document("source.md", 12);
        original.bom = true;
        original.title = Some("Cached title".into());
        let fingerprint = platform::EntryFingerprint([7; 5]);
        let json = Bytes::from(serde_json::to_vec(&original).unwrap());
        cache.insert(
            "source.md".into(),
            fingerprint,
            original.clone(),
            Some(json.clone()),
        );
        let source = cache.get_source("source.md", fingerprint).unwrap();
        assert!(source.html.is_empty());
        assert_eq!(source.content, original.content);
        assert_eq!(source.version, original.version);
        assert_eq!(source.title, original.title);
        assert!(source.bom);
        assert_eq!(cache.get_json("source.md", fingerprint), Some(json));
        assert_eq!(
            cache.get("source.md", fingerprint).unwrap().html,
            original.html
        );
        assert!(
            cache
                .get_source("source.md", platform::EntryFingerprint([8; 5]))
                .is_none()
        );
        assert!(cache.entries.is_empty());
        assert_eq!(cache.bytes, 0);
    }

    #[test]
    fn cache_is_bounded_and_invalidates_changed_or_moved_paths() {
        let mut cache = DocumentCache::default();
        for index in 0..=MAX_CACHE_ENTRIES {
            cache.insert(
                format!("folder/{index}.md"),
                platform::EntryFingerprint([index as u64; 5]),
                document(&format!("folder/{index}.md"), 1),
                None,
            );
        }
        assert_eq!(cache.entries.len(), MAX_CACHE_ENTRIES);
        assert!(!cache.entries.contains_key("folder/0.md"));
        assert!(
            cache
                .get("folder/16.md", platform::EntryFingerprint([16_u64; 5]))
                .is_some()
        );
        assert!(
            cache
                .get("folder/16.md", platform::EntryFingerprint([17_u64; 5]))
                .is_none()
        );
        cache.remove_tree("folder");
        assert!(cache.entries.is_empty());

        cache.insert(
            "large.md".into(),
            platform::EntryFingerprint([1; 5]),
            document("large.md", MAX_CACHED_DOCUMENT_BYTES),
            None,
        );
        assert!(!cache.entries.contains_key("large.md"));

        let json = Bytes::from_static(br#"{"path":"note.md"}"#);
        cache.insert(
            "note.md".into(),
            platform::EntryFingerprint([2; 5]),
            document("note.md", 1),
            Some(json.clone()),
        );
        assert_eq!(
            cache.get_json("note.md", platform::EntryFingerprint([2; 5])),
            Some(json)
        );
        assert!(
            cache
                .get_json("note.md", platform::EntryFingerprint([3; 5]))
                .is_none()
        );
        assert!(!cache.entries.contains_key("note.md"));
    }

    #[test]
    #[ignore = "performance benchmark"]
    fn benchmark_document_cache_hits() {
        const ITERATIONS: usize = 1_000_000;
        let mut cache = DocumentCache::default();
        for index in 0..MAX_CACHE_ENTRIES {
            cache.insert(
                format!("folder/{index}.md"),
                platform::EntryFingerprint([index as u64; 5]),
                document(&format!("folder/{index}.md"), 1),
                Some(Bytes::from_static(br#"{"content":"cached"}"#)),
            );
        }
        let path = format!("folder/{}.md", MAX_CACHE_ENTRIES - 1);
        let fingerprint = platform::EntryFingerprint([(MAX_CACHE_ENTRIES - 1) as u64; 5]);
        for _ in 0..100 {
            std::hint::black_box(cache.get_json(&path, fingerprint));
        }
        let mut runs = Vec::new();
        for _ in 0..8 {
            let started = std::time::Instant::now();
            for _ in 0..ITERATIONS {
                std::hint::black_box(cache.get_json(
                    std::hint::black_box(&path),
                    std::hint::black_box(fingerprint),
                ));
            }
            runs.push(started.elapsed().as_secs_f64() * 1e9 / ITERATIONS as f64);
        }
        runs.sort_by(f64::total_cmp);
        println!(
            "{{\"entries\":{MAX_CACHE_ENTRIES},\"nanosecondsPerHit\":{:.2}}}",
            (runs[3] + runs[4]) / 2.0
        );
    }
}
