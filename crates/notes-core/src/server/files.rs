#[path = "files/assets.rs"]
mod assets;
#[path = "files/attachments.rs"]
mod attachments;
pub(super) use attachments::{Attachment, media_file};
#[path = "files/cache.rs"]
mod cache;
#[path = "files/documents.rs"]
mod documents;
#[path = "files/format.rs"]
mod format;
#[path = "files/identities.rs"]
mod identities;
#[path = "files/identity_store.rs"]
mod identity_store;
#[path = "files/paths.rs"]
mod paths;
#[path = "files/platform.rs"]
mod platform;
#[path = "files/recycle.rs"]
mod recycle;
#[path = "files/tree.rs"]
mod tree;

pub(super) use documents::document_from_bytes;
use format::preserve_format;
pub(super) use identities::Reference;
use paths::{ignored_directory, validate_directory_path};
pub(super) use paths::{is_markdown, validate_document_path, validate_relative};
#[cfg(test)]
use tree::TreeLimits;
pub(super) use tree::{Tree, TreeFile};

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, File, Metadata};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock, atomic::AtomicU64};
use std::time::UNIX_EPOCH;

use axum::http::StatusCode;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{ApiError, MAX_DOCUMENT_BYTES, frontmatter, hex};

const BOM: &[u8] = b"\xef\xbb\xbf";

pub(super) struct Root {
    path: PathBuf,
    directory: platform::Directory,
    asset_cache: Mutex<assets::AssetCache>,
    document_cache: Mutex<documents::DocumentCache>,
    title_cache: RwLock<HashMap<String, tree::CachedTitle>>,
    resources: OnceLock<super::state_store::ProjectStore>,
    resource_epoch: AtomicU64,
    // On Windows, denying delete sharing on every ancestor prevents junction swaps.
    _ancestors: Vec<platform::Directory>,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct Document {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) project: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) references: Vec<identities::Reference>,
    pub(super) path: String,
    pub(super) content: String,
    pub(super) html: String,
    pub(super) version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) warning: Option<String>,
    pub(super) bom: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EntryDetails {
    path: String,
    name: String,
    title: Option<Arc<str>>,
    size: u64,
    modified_unix_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MovedEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    path: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    document: Option<Document>,
}

struct Resolved {
    name: OsString,
    parent: platform::Directory,
    _parents: Vec<platform::Directory>,
}

impl Root {
    pub(super) fn open(path: &Path) -> Result<Self, ApiError> {
        platform::ensure_supported()?;
        let path = fs::canonicalize(path)
            .map_err(|error| ApiError::io("Could not open the selected folder", error))?;
        let mut ancestors = Vec::<platform::Directory>::new();
        for component in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
            let directory = match ancestors.last() {
                None => platform::Directory::open(component, false)?,
                Some(parent) => parent.open_child(
                    component.file_name().ok_or_else(|| {
                        ApiError::bad_request("The selected folder has an invalid path.")
                    })?,
                    false,
                )?,
            };
            ancestors.push(directory);
        }
        let directory = ancestors
            .pop()
            .ok_or_else(|| ApiError::bad_request("Choose an existing Markdown folder."))?;
        Ok(Self {
            path,
            directory,
            asset_cache: Mutex::new(assets::AssetCache::default()),
            document_cache: Mutex::new(documents::DocumentCache::default()),
            title_cache: RwLock::new(HashMap::new()),
            resources: OnceLock::new(),
            resource_epoch: AtomicU64::new(u64::MAX),
            _ancestors: ancestors,
        })
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    fn resolve(&self, path: &str) -> Result<Resolved, ApiError> {
        validate_relative(path)?;
        let components = path.split('/').collect::<Vec<_>>();
        let mut parents = Vec::<platform::Directory>::new();
        for component in &components[..components.len() - 1] {
            let parent = parents.last().unwrap_or(&self.directory);
            let next = parent.open_child(component.as_ref(), true)?;
            parents.push(next);
        }
        let parent = parents.last().unwrap_or(&self.directory).try_clone()?;
        let name = OsString::from(components[components.len() - 1]);
        Ok(Resolved {
            name,
            parent,
            _parents: parents,
        })
    }

    pub(super) fn save(
        &self,
        path: &str,
        content: &str,
        expected_version: &str,
        check_active: impl Fn() -> Result<(), ApiError>,
    ) -> Result<Document, ApiError> {
        self.save_content(path, content, expected_version, check_active, true)
    }

    pub(super) fn restore(
        &self,
        path: &str,
        content: &str,
        expected_version: &str,
        check_active: impl Fn() -> Result<(), ApiError>,
    ) -> Result<Document, ApiError> {
        self.save_content(path, content, expected_version, check_active, false)
    }

    fn save_content(
        &self,
        path: &str,
        content: &str,
        expected_version: &str,
        check_active: impl Fn() -> Result<(), ApiError>,
        preserve: bool,
    ) -> Result<Document, ApiError> {
        check_active()?;
        validate_document_path(path)?;
        validate_content(content.as_bytes())?;
        if expected_version.len() != 64
            || !expected_version
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(ApiError::bad_request(
                "An expected SHA-256 document version is required.",
            ));
        }
        let resolved = self.resolve(path).map_err(deleted_conflict)?;
        let mut original = resolved
            .parent
            .open_regular(&resolved.name)
            .map_err(deleted_conflict)?;
        let metadata = original
            .metadata()
            .map_err(|error| ApiError::io("Could not inspect the original document", error))?;
        if metadata.permissions().readonly() {
            return Err(ApiError::forbidden("The document is read-only."));
        }
        let original_bytes = read_limited(&mut original, MAX_DOCUMENT_BYTES, "Markdown files")
            .map_err(deleted_conflict)?;
        check_version(&original_bytes, expected_version)?;
        validate_content(&original_bytes)?;
        let bytes = if preserve {
            preserve_format(&original_bytes, content)?
        } else {
            content.as_bytes().to_vec()
        };
        check_active()?;
        let mut staged = StagedFile::write(&resolved.parent, &bytes, Some(&metadata))?;

        // An editor may have replaced the directory entry while the staging file was written.
        let mut latest = resolved
            .parent
            .open_regular(&resolved.name)
            .map_err(deleted_conflict)?;
        let latest_bytes = read_limited(&mut latest, MAX_DOCUMENT_BYTES, "Markdown files")
            .map_err(deleted_conflict)?;
        check_version(&latest_bytes, expected_version)?;
        check_active()?;
        // Windows replacement requires closing the destination read handles.
        // The parent directory chain remains pinned throughout the rename.
        drop(latest);
        drop(original);
        staged.commit(&resolved.name, true)?;
        drop(staged);
        resolved.parent.sync()?;
        if let Ok(mut cache) = self.document_cache.lock() {
            cache.remove_tree(path);
        }
        self.rendered_document(path, &bytes)
    }

    pub(super) fn create(
        &self,
        path: &str,
        content: &str,
        check_active: impl Fn() -> Result<(), ApiError>,
    ) -> Result<Document, ApiError> {
        self.create_content(path, content, None, check_active)
    }

    pub(super) fn create_restored(
        &self,
        path: &str,
        content: &str,
        id: &str,
        check_active: impl Fn() -> Result<(), ApiError>,
    ) -> Result<Document, ApiError> {
        self.create_content(path, content, Some(id), check_active)
    }

    fn create_content(
        &self,
        path: &str,
        content: &str,
        restored: Option<&str>,
        check_active: impl Fn() -> Result<(), ApiError>,
    ) -> Result<Document, ApiError> {
        check_active()?;
        validate_document_path(path)?;
        validate_content(content.as_bytes())?;
        let resolved = self.resolve(path)?;
        match resolved.parent.metadata(&resolved.name) {
            Ok(_) => return Err(ApiError::conflict("A file already exists at this path.")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(ApiError::io(
                    "Could not inspect the new document path",
                    error,
                ));
            }
        }
        let mut staged = StagedFile::write(&resolved.parent, content.as_bytes(), None)?;
        check_active()?;
        staged.commit(&resolved.name, false)?;
        drop(staged);
        resolved.parent.sync()?;
        if let Ok(mut cache) = self.document_cache.lock() {
            cache.remove_tree(path);
        }
        if let Some(store) = self.resources.get() {
            let path = self.canonical_document_path(path)?;
            if let Some(id) = restored {
                store.restore_resource(id, &path)?;
            } else {
                store.retire_resource(&path)?;
            }
        }
        self.rendered_document(path, content.as_bytes())
    }

    pub(super) fn details(&self, path: &str) -> Result<EntryDetails, ApiError> {
        validate_document_path(path)?;
        let resolved = self.resolve(path)?;
        let entry_metadata = resolved
            .parent
            .metadata(&resolved.name)
            .map_err(|error| ApiError::io("Could not inspect the document", error))?;
        let file = resolved.parent.open_regular(&resolved.name)?;
        let metadata = file
            .metadata()
            .map_err(|error| ApiError::io("Could not inspect the document", error))?;
        let modified_unix_ms = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| u64::try_from(duration.as_millis()).ok());
        Ok(EntryDetails {
            path: path.to_owned(),
            name: path.rsplit('/').next().unwrap_or(path).to_owned(),
            title: self.title_for(
                path,
                &resolved.parent,
                &resolved.name,
                entry_metadata.fingerprint(),
            ),
            size: metadata.len(),
            modified_unix_ms,
        })
    }

    fn prepare_move(
        &self,
        path: &str,
        destination: &str,
    ) -> Result<(Resolved, Resolved, &'static str), ApiError> {
        if path == destination {
            return Err(ApiError::bad_request(
                "Choose a different destination path.",
            ));
        }
        validate_relative(path)?;
        validate_relative(destination)?;
        let source = self.resolve(path)?;
        let metadata = source
            .parent
            .metadata(&source.name)
            .map_err(|error| ApiError::io("Could not inspect the source entry", error))?;
        if metadata.is_link() || metadata.is_hidden() {
            return Err(ApiError::forbidden(
                "Hidden files and symbolic links cannot be moved.",
            ));
        }
        let kind = if metadata.is_file() {
            validate_document_path(path)?;
            validate_document_path(destination)?;
            "file"
        } else if metadata.is_dir() {
            validate_directory_path(path)?;
            validate_directory_path(destination)?;
            if destination.starts_with(&format!("{path}/")) {
                return Err(ApiError::bad_request(
                    "A folder cannot be moved inside itself.",
                ));
            }
            "directory"
        } else {
            return Err(ApiError::forbidden(
                "Only Markdown files and real folders can be moved.",
            ));
        };
        let target = self.resolve(destination)?;
        match target.parent.metadata(&target.name) {
            Ok(_) => return Err(ApiError::conflict("The destination already exists.")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(ApiError::io("Could not inspect the destination", error));
            }
        }
        Ok((source, target, kind))
    }

    pub(super) fn check_move(
        &self,
        path: &str,
        destination: &str,
    ) -> Result<&'static str, ApiError> {
        self.prepare_move(path, destination)
            .map(|(_, _, kind)| kind)
    }

    pub(super) fn move_entry(&self, path: &str, destination: &str) -> Result<MovedEntry, ApiError> {
        let canonical = self.canonical_destination(destination)?;
        let destination = canonical.as_str();
        let (source, target, kind) = self.prepare_move(path, destination)?;
        let move_file = || {
            source
                .parent
                .move_entry_to(&source.name, &target.parent, &target.name)
                .map_err(|error| ApiError::io("Could not move the entry", error))
        };
        if let Some(store) = self.resources.get() {
            store.move_resources(path, destination, move_file, || {
                target
                    .parent
                    .move_entry_to(&target.name, &source.parent, &source.name)
                    .map_err(|error| ApiError::io("Could not roll back the entry move", error))
            })?;
        } else {
            move_file()?;
        }
        source.parent.sync()?;
        target.parent.sync()?;
        if let Ok(mut cache) = self.document_cache.lock() {
            cache.remove_tree(path);
            cache.remove_tree(destination);
        }
        let document = if kind == "file" {
            Some(self.document(destination)?)
        } else {
            None
        };
        let id = if let Some(store) = self.resources.get() {
            Some(
                store
                    .identify(
                        destination,
                        if kind == "file" {
                            super::state_store::resources::ResourceKind::Document
                        } else {
                            super::state_store::resources::ResourceKind::Directory
                        },
                    )?
                    .id,
            )
        } else {
            None
        };
        Ok(MovedEntry {
            id,
            path: destination.to_owned(),
            kind,
            document,
        })
    }
}

pub(super) fn validate_content(bytes: &[u8]) -> Result<(), ApiError> {
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(ApiError::too_large(
            "Markdown documents cannot exceed 4 MiB.",
        ));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| ApiError::bad_request("The Markdown file is not valid UTF-8."))?;
    if text
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(ApiError::bad_request(
            "Binary files cannot be edited as Markdown.",
        ));
    }
    Ok(())
}

fn read_limited(file: &mut File, limit: usize, kind: &str) -> Result<Vec<u8>, ApiError> {
    let metadata = file
        .metadata()
        .map_err(|error| ApiError::io("Could not inspect the file", error))?;
    if metadata.len() > limit as u64 {
        return Err(ApiError::too_large(format!(
            "{kind} cannot exceed {} MiB.",
            limit / 1024 / 1024
        )));
    }
    let mut bytes = Vec::with_capacity((metadata.len() as usize).min(limit));
    file.take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| ApiError::io("Could not read the file", error))?;
    if bytes.len() > limit {
        return Err(ApiError::too_large(format!(
            "{kind} cannot exceed {} MiB.",
            limit / 1024 / 1024
        )));
    }
    Ok(bytes)
}

fn version(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn check_version(bytes: &[u8], expected: &str) -> Result<(), ApiError> {
    if !version(bytes).eq_ignore_ascii_case(expected) {
        return Err(ApiError::conflict(
            "The document changed outside this editor. Reload it before saving.",
        ));
    }
    Ok(())
}

fn deleted_conflict(error: ApiError) -> ApiError {
    if error.status == StatusCode::NOT_FOUND {
        ApiError::conflict("The document was moved or deleted. It has not been recreated.")
    } else if matches!(
        error.status,
        StatusCode::BAD_REQUEST | StatusCode::PAYLOAD_TOO_LARGE
    ) {
        ApiError::conflict("The document or one of its folders changed outside this editor.")
    } else {
        error
    }
}

struct StagedFile {
    name: OsString,
    parent: platform::Directory,
    file: File,
    cleanup_needed: bool,
}

impl StagedFile {
    fn write(
        parent: &platform::Directory,
        bytes: &[u8],
        original: Option<&Metadata>,
    ) -> Result<Self, ApiError> {
        let parent = parent.try_clone()?;
        let mut random = [0_u8; 16];
        for _ in 0..8 {
            getrandom::fill(&mut random).map_err(|error| {
                ApiError::internal(format!("Could not stage the document: {error}"))
            })?;
            let name = OsString::from(format!(".notes-save-{}.tmp", hex(&random)));
            match parent.create_new(&name) {
                Ok(file) => {
                    let mut staged = Self {
                        name,
                        parent,
                        file,
                        cleanup_needed: true,
                    };
                    staged.file.write_all(bytes).map_err(|error| {
                        ApiError::io("Could not write the staged document", error)
                    })?;
                    if let Some(original) = original {
                        staged
                            .file
                            .set_permissions(original.permissions())
                            .map_err(|error| {
                                ApiError::io("Could not preserve document permissions", error)
                            })?;
                    }
                    staged.file.sync_all().map_err(|error| {
                        ApiError::io("Could not flush the staged document", error)
                    })?;
                    return Ok(staged);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(ApiError::io("Could not create a staging file", error)),
            }
        }
        Err(ApiError::internal(
            "Could not allocate a unique staging file.",
        ))
    }

    fn commit(&mut self, destination: &std::ffi::OsStr, replace: bool) -> Result<(), ApiError> {
        let source_retained = self
            .parent
            .commit(&self.name, destination, replace)
            .map_err(|error| ApiError::io("Could not atomically save the document", error))?;
        // A no-clobber Unix publication links the staged inode into place. Keep
        // ownership of the staging name until Drop unlinks it, even after success.
        self.cleanup_needed = source_retained;
        Ok(())
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if self.cleanup_needed {
            if let Err(error) = self.parent.remove_file(&self.name) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("Could not remove a Notes staging file: {error}");
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "files/tests.rs"]
mod tests;
