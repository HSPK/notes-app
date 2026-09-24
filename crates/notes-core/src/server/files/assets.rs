use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::Read;

use axum::body::Bytes;

use super::{Root, cache::touch_lru, platform, validate_relative};
use crate::server::ApiError;

const MAX_ASSET_BYTES: usize = 16 * 1024 * 1024;
const MIN_CACHED_ASSET_BYTES: usize = 64 * 1024;
const MAX_CACHED_ASSET_BYTES: usize = 8 * 1024 * 1024;
const MAX_CACHE_BYTES: usize = 32 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 64;

pub(in crate::server) struct Asset {
    pub(in crate::server) bytes: Bytes,
    pub(in crate::server) mime: &'static str,
    pub(in crate::server) download: bool,
}

struct CachedAsset {
    fingerprint: platform::EntryFingerprint,
    bytes: Bytes,
}

#[derive(Default)]
pub(super) struct AssetCache {
    entries: HashMap<String, CachedAsset>,
    order: VecDeque<String>,
    bytes: usize,
}

impl AssetCache {
    fn get(&mut self, path: &str, fingerprint: platform::EntryFingerprint) -> Option<Bytes> {
        let bytes = match self.entries.get(path) {
            Some(entry) if entry.fingerprint == fingerprint => entry.bytes.clone(),
            Some(_) => {
                self.remove(path);
                return None;
            }
            None => return None,
        };
        touch_lru(&mut self.order, path);
        Some(bytes)
    }

    fn insert(&mut self, path: String, fingerprint: platform::EntryFingerprint, bytes: Bytes) {
        if bytes.len() > MAX_CACHED_ASSET_BYTES {
            return;
        }
        self.remove(&path);
        while self.entries.len() >= MAX_CACHE_ENTRIES || self.bytes + bytes.len() > MAX_CACHE_BYTES
        {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(entry) = self.entries.remove(&oldest) {
                self.bytes -= entry.bytes.len();
            }
        }
        self.bytes += bytes.len();
        self.order.push_back(path.clone());
        self.entries
            .insert(path, CachedAsset { fingerprint, bytes });
    }

    fn remove(&mut self, path: &str) {
        if let Some(entry) = self.entries.remove(path) {
            self.bytes -= entry.bytes.len();
        }
        self.order.retain(|candidate| candidate != path);
    }
}

impl Root {
    pub(in crate::server) fn store_image(
        &self,
        directory: &str,
        extension: &str,
        bytes: &[u8],
        check: impl Fn() -> Result<(), ApiError>,
    ) -> Result<String, ApiError> {
        validate_relative(directory)?;
        validate_size(bytes.len() as u64)?;
        let mut parent = self.directory.try_clone()?;
        for component in directory.split('/') {
            check()?;
            match parent.metadata(component.as_ref()) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    parent.create_dir(component.as_ref()).map_err(|error| {
                        ApiError::io("Could not create the image directory", error)
                    })?;
                    parent.sync()?;
                }
                Err(error) => {
                    return Err(ApiError::io("Could not inspect the image directory", error));
                }
            }
            parent = parent.open_child(component.as_ref(), true)?;
        }
        let mut random = [0; 16];
        getrandom::fill(&mut random).map_err(|error| ApiError::internal(error.to_string()))?;
        let filename = format!("image-{}.{}", crate::server::hex(&random), extension);
        let mut staged = super::StagedFile::write(&parent, bytes, None)?;
        check()?;
        staged.commit(filename.as_ref(), false)?;
        parent.sync()?;
        Ok(format!("{directory}/{filename}"))
    }

    pub(in crate::server) fn asset(&self, path: &str) -> Result<Asset, ApiError> {
        validate_relative(path)?;
        let (mime, download, text) = asset_type(path)
            .ok_or_else(|| ApiError::forbidden("This attachment type cannot be served."))?;
        let resolved = self.resolve(path)?;
        let mut file = resolved.parent.open_regular(&resolved.name)?;
        let metadata = file
            .metadata()
            .map_err(|error| ApiError::io("Could not inspect the file", error))?;
        validate_size(metadata.len())?;
        let fingerprint = platform::fingerprint(&metadata);
        let cacheable = !download
            && metadata.len() >= MIN_CACHED_ASSET_BYTES as u64
            && metadata.len() <= MAX_CACHED_ASSET_BYTES as u64;
        if cacheable {
            if let Ok(mut cache) = self.asset_cache.lock() {
                if let Some(bytes) = cache.get(path, fingerprint) {
                    return Ok(Asset {
                        bytes,
                        mime,
                        download,
                    });
                }
            }
        }
        let bytes = Bytes::from(read(&mut file, metadata.len())?);
        if text && std::str::from_utf8(&bytes).is_err() {
            return Err(ApiError::bad_request(
                "This text attachment is not valid UTF-8.",
            ));
        }
        if cacheable {
            if let Ok(mut cache) = self.asset_cache.lock() {
                cache.insert(path.to_owned(), fingerprint, bytes.clone());
            }
        }
        Ok(Asset {
            bytes,
            mime,
            download,
        })
    }
}

fn validate_size(size: u64) -> Result<(), ApiError> {
    if size > MAX_ASSET_BYTES as u64 {
        Err(ApiError::too_large(format!(
            "Attachments cannot exceed {} MiB.",
            MAX_ASSET_BYTES / 1024 / 1024
        )))
    } else {
        Ok(())
    }
}

fn read(file: &mut File, size: u64) -> Result<Vec<u8>, ApiError> {
    let mut bytes = Vec::with_capacity((size as usize).min(MAX_ASSET_BYTES));
    file.take((MAX_ASSET_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| ApiError::io("Could not read the file", error))?;
    validate_size(bytes.len() as u64)?;
    Ok(bytes)
}

fn asset_type(path: &str) -> Option<(&'static str, bool, bool)> {
    let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => ("image/png", false, false),
        "jpg" | "jpeg" => ("image/jpeg", false, false),
        "gif" => ("image/gif", false, false),
        "webp" => ("image/webp", false, false),
        "avif" => ("image/avif", false, false),
        "bmp" => ("image/bmp", false, false),
        "ico" => ("image/x-icon", false, false),
        "svg" => ("image/svg+xml; charset=utf-8", false, true),
        "pdf" => ("application/pdf", true, false),
        "txt" | "csv" | "log" | "json" | "yaml" | "yml" | "toml" | "xml" | "md" | "markdown" => {
            ("text/plain; charset=utf-8", true, true)
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_enforces_entry_and_byte_limits_and_invalidates_fingerprints() {
        let mut cache = AssetCache::default();
        for index in 0..=MAX_CACHE_ENTRIES {
            cache.insert(
                format!("{index}.png"),
                platform::EntryFingerprint([index as u64; 5]),
                Bytes::from_static(b"x"),
            );
        }
        assert_eq!(cache.entries.len(), MAX_CACHE_ENTRIES);
        assert!(!cache.entries.contains_key("0.png"));
        assert!(
            cache
                .get("64.png", platform::EntryFingerprint([64; 5]))
                .is_some()
        );
        assert!(
            cache
                .get("64.png", platform::EntryFingerprint([65; 5]))
                .is_none()
        );
        assert!(!cache.entries.contains_key("64.png"));

        let chunk = Bytes::from(vec![0; MAX_CACHED_ASSET_BYTES]);
        let mut cache = AssetCache::default();
        for index in 0..5 {
            cache.insert(
                format!("{index}.png"),
                platform::EntryFingerprint([index; 5]),
                chunk.clone(),
            );
        }
        assert_eq!(
            cache.entries.len(),
            MAX_CACHE_BYTES / MAX_CACHED_ASSET_BYTES
        );
        assert!(!cache.entries.contains_key("0.png"));
    }

    #[test]
    #[ignore = "performance benchmark"]
    fn benchmark_asset_cache_hits() {
        const ITERATIONS: usize = 1_000_000;
        let mut cache = AssetCache::default();
        for index in 0..MAX_CACHE_ENTRIES {
            cache.insert(
                format!("images/{index}.png"),
                platform::EntryFingerprint([index as u64; 5]),
                Bytes::from_static(b"cached"),
            );
        }
        let path = format!("images/{}.png", MAX_CACHE_ENTRIES - 1);
        let fingerprint = platform::EntryFingerprint([(MAX_CACHE_ENTRIES - 1) as u64; 5]);
        for _ in 0..100 {
            std::hint::black_box(cache.get(&path, fingerprint));
        }
        let mut runs = Vec::new();
        for _ in 0..8 {
            let started = std::time::Instant::now();
            for _ in 0..ITERATIONS {
                std::hint::black_box(cache.get(
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
