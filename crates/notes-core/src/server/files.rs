#[path = "files/platform.rs"]
mod platform;

use std::ffi::OsString;
use std::fs::{self, File, Metadata};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use percent_encoding::percent_decode_str;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{ApiError, MAX_DOCUMENT_BYTES, hex, markdown};

const MAX_ASSET_BYTES: usize = 16 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 2048;
const BOM: &[u8] = b"\xef\xbb\xbf";

pub(super) struct Root {
    path: PathBuf,
    directory: platform::Directory,
    // On Windows, denying delete sharing on every ancestor prevents junction swaps.
    _ancestors: Vec<platform::Directory>,
}

#[derive(Debug, Serialize)]
pub(super) struct Tree {
    root: String,
    files: Vec<TreeFile>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
struct TreeFile {
    path: String,
    name: String,
}

#[derive(Debug, Serialize)]
pub(super) struct Document {
    pub(super) path: String,
    pub(super) content: String,
    pub(super) html: String,
    pub(super) version: String,
}

pub(super) struct Asset {
    pub(super) bytes: Vec<u8>,
    pub(super) mime: &'static str,
    pub(super) download: bool,
}

struct Resolved {
    name: OsString,
    parent: platform::Directory,
    _parents: Vec<platform::Directory>,
}

#[derive(Clone, Copy)]
struct TreeLimits {
    entries: usize,
    files: usize,
    depth: usize,
    duration: Duration,
}

impl Default for TreeLimits {
    fn default() -> Self {
        Self {
            entries: 20_000,
            files: 5_000,
            depth: 32,
            duration: Duration::from_secs(2),
        }
    }
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

    pub(super) fn tree(&self) -> Result<Tree, ApiError> {
        self.tree_with_limits(TreeLimits::default())
    }

    fn tree_with_limits(&self, limits: TreeLimits) -> Result<Tree, ApiError> {
        let mut walk = TreeWalk {
            files: Vec::new(),
            scanned: 0,
            truncated: false,
            exhausted: false,
            started: Instant::now(),
            limits,
        };
        walk.directory(&self.directory, "", 0)?;
        walk.files.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(Tree {
            root: self.path.to_string_lossy().into_owned(),
            files: walk.files,
            truncated: walk.truncated,
        })
    }

    pub(super) fn document(&self, path: &str) -> Result<Document, ApiError> {
        validate_document_path(path)?;
        let resolved = self.resolve(path)?;
        let mut file = resolved.parent.open_regular(&resolved.name)?;
        let bytes = read_limited(&mut file, MAX_DOCUMENT_BYTES, "Markdown files")?;
        document_from_bytes(path, &bytes)
    }

    pub(super) fn save(
        &self,
        path: &str,
        content: &str,
        expected_version: &str,
        check_active: impl Fn() -> Result<(), ApiError>,
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
        let bytes = preserve_format(&original_bytes, content)?;
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
        document_from_bytes(path, &bytes)
    }

    pub(super) fn create(
        &self,
        path: &str,
        content: &str,
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
        document_from_bytes(path, content.as_bytes())
    }

    pub(super) fn asset(&self, path: &str) -> Result<Asset, ApiError> {
        validate_relative(path)?;
        let (mime, download, text) = asset_type(path)
            .ok_or_else(|| ApiError::forbidden("This attachment type cannot be served."))?;
        let resolved = self.resolve(path)?;
        let mut file = resolved.parent.open_regular(&resolved.name)?;
        let bytes = read_limited(&mut file, MAX_ASSET_BYTES, "Attachments")?;
        if text && std::str::from_utf8(&bytes).is_err() {
            return Err(ApiError::bad_request(
                "This text attachment is not valid UTF-8.",
            ));
        }
        Ok(Asset {
            bytes,
            mime,
            download,
        })
    }
}

struct TreeWalk {
    files: Vec<TreeFile>,
    scanned: usize,
    truncated: bool,
    exhausted: bool,
    started: Instant,
    limits: TreeLimits,
}

impl TreeWalk {
    fn directory(
        &mut self,
        directory: &platform::Directory,
        relative: &str,
        depth: usize,
    ) -> Result<(), ApiError> {
        let entries = directory
            .entries()
            .map_err(|error| ApiError::io("Could not enumerate a Markdown folder", error))?;
        for entry in entries {
            if self.exhausted {
                break;
            }
            if self.scanned >= self.limits.entries || self.started.elapsed() >= self.limits.duration
            {
                self.truncated = true;
                self.exhausted = true;
                break;
            }
            self.scanned += 1;
            let entry =
                entry.map_err(|error| ApiError::io("Could not read a folder entry", error))?;
            let metadata = directory
                .metadata(&entry)
                .map_err(|error| ApiError::io("Could not inspect a folder entry", error))?;
            if metadata.is_link() || metadata.is_hidden() {
                continue;
            }
            let name = entry.into_string().map_err(|_| {
                ApiError::bad_request("A folder entry has a non-Unicode file name.")
            })?;
            let path = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            if metadata.is_dir() {
                if ignored_directory(&name) {
                    continue;
                }
                if depth >= self.limits.depth {
                    self.truncated = true;
                    continue;
                }
                validate_relative(&format!("{path}/document.md"))?;
                let child = directory.open_child(name.as_ref(), true)?;
                self.directory(&child, &path, depth + 1)?;
            } else if metadata.is_file() && is_markdown(&name) {
                validate_document_path(&path)?;
                if self.files.len() >= self.limits.files {
                    self.truncated = true;
                    self.exhausted = true;
                    break;
                }
                self.files.push(TreeFile { path, name });
            }
        }
        Ok(())
    }
}

pub(super) fn is_markdown(path: &str) -> bool {
    matches!(
        path.rsplit_once('.')
            .map(|(_, extension)| extension.to_ascii_lowercase())
            .as_deref(),
        Some("md" | "markdown")
    )
}

pub(super) fn validate_document_path(path: &str) -> Result<(), ApiError> {
    validate_relative(path)?;
    if !is_markdown(path) {
        return Err(ApiError::bad_request("Choose a .md or .markdown file."));
    }
    Ok(())
}

pub(super) fn validate_relative(path: &str) -> Result<(), ApiError> {
    validate_path_syntax(path)?;
    // Query extraction already decodes once. Reject dangerous additional encodings
    // without changing legitimate file names that contain a literal percent sign.
    let mut candidate = path.to_owned();
    for _ in 0..4 {
        let decoded = percent_decode_str(&candidate)
            .decode_utf8()
            .map_err(|_| ApiError::bad_request("The path has an invalid percent encoding."))?;
        if decoded == candidate {
            return Ok(());
        }
        validate_path_syntax(&decoded)?;
        candidate = decoded.into_owned();
    }
    Err(ApiError::bad_request(
        "The path has too many layers of percent encoding.",
    ))
}

fn validate_path_syntax(path: &str) -> Result<(), ApiError> {
    if path.is_empty() || path.len() > MAX_PATH_BYTES {
        return Err(ApiError::bad_request(
            "The relative path is empty or too long.",
        ));
    }
    if path.chars().any(|character| {
        character.is_control()
            || matches!(character, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
    }) {
        return Err(ApiError::forbidden(
            "Absolute, device, stream, and backslash paths are not allowed.",
        ));
    }
    let components = path.split('/').collect::<Vec<_>>();
    if components.len() > 64 {
        return Err(ApiError::bad_request(
            "The relative path has too many folders.",
        ));
    }
    for (index, component) in components.iter().enumerate() {
        if component.is_empty()
            || matches!(*component, "." | "..")
            || component.ends_with(['.', ' '])
            || reserved_name(component)
        {
            return Err(ApiError::forbidden(
                "Path traversal and reserved file names are not allowed.",
            ));
        }
        if index + 1 < components.len() && ignored_directory(component) {
            return Err(ApiError::forbidden(
                "Hidden and dependency folders are not accessible.",
            ));
        }
    }
    Ok(())
}

pub(super) fn ignored_directory(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name.to_ascii_lowercase().as_str(),
            "node_modules"
                | "target"
                | "venv"
                | "__pycache__"
                | "build"
                | "dist"
                | "$recycle.bin"
                | "system volume information"
        )
}

fn reserved_name(name: &str) -> bool {
    let base = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
        || ["COM", "LPT"].iter().any(|prefix| {
            base.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
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

fn document_from_bytes(path: &str, bytes: &[u8]) -> Result<Document, ApiError> {
    validate_content(bytes)?;
    let content = std::str::from_utf8(bytes.strip_prefix(BOM).unwrap_or(bytes))
        .map_err(|_| ApiError::bad_request("The Markdown file is not valid UTF-8."))?;
    Ok(Document {
        path: path.to_owned(),
        content: content.to_owned(),
        html: markdown::render(path, content),
        version: version(bytes),
    })
}

fn preserve_format(original: &[u8], content: &str) -> Result<Vec<u8>, ApiError> {
    let has_bom = original.starts_with(BOM) || content.starts_with('\u{feff}');
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let original = std::str::from_utf8(original)
        .map_err(|_| ApiError::bad_request("The original document is not valid UTF-8."))?;
    let bytes = original.as_bytes();
    let only_crlf = bytes.contains(&b'\n')
        && bytes.iter().enumerate().all(|(index, byte)| match byte {
            b'\n' => index > 0 && bytes[index - 1] == b'\r',
            b'\r' => bytes.get(index + 1) == Some(&b'\n'),
            _ => true,
        });
    let content = if only_crlf && !content.contains('\r') {
        content.replace('\n', "\r\n")
    } else if bytes.contains(&b'\r') && !bytes.contains(&b'\n') && !content.contains('\r') {
        content.replace('\n', "\r")
    } else {
        content.to_owned()
    };
    let mut result = Vec::with_capacity(content.len() + if has_bom { BOM.len() } else { 0 });
    if has_bom {
        result.extend_from_slice(BOM);
    }
    result.extend_from_slice(content.as_bytes());
    validate_content(&result)?;
    Ok(result)
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
mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let mut random = [0; 8];
            getrandom::fill(&mut random).unwrap();
            let path = PathBuf::from("target")
                .join("server-unit-tests")
                .join(hex(&random));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Err(error) = fs::remove_dir_all(&self.0) {
                eprintln!("Could not clean backend unit-test fixture: {error}");
            }
        }
    }

    #[test]
    fn unsafe_paths_and_encoded_variants_are_rejected() {
        for path in [
            "../secret.md",
            "notes/../../secret.md",
            "/secret.md",
            "C:/secret.md",
            "C:\\secret.md",
            "\\\\server\\share\\secret.md",
            "notes.md:secret",
            "notes\\..\\secret.md",
            "a//b.md",
            "a/./b.md",
            "nul.md",
            "COM1.md",
            "a./note.md",
            "a /note.md",
            ".git/config.md",
            "NODE_MODULES/note.md",
            "%2e%2e/secret.md",
            "%252e%252e%255csecret.md",
            "bad\0.md",
        ] {
            assert!(validate_relative(path).is_err(), "accepted {path:?}");
        }
        for path in ["目录/中文 笔记.md", "notes/100%.md", "notes/a-b_1.MARKDOWN"] {
            validate_document_path(path).unwrap();
        }
    }

    #[test]
    fn formatting_preserves_bom_and_existing_uniform_newlines() {
        let original = b"\xef\xbb\xbf# title\r\nold\r\n";
        assert_eq!(
            preserve_format(original, "# 标题\nnew\n").unwrap(),
            "\u{feff}# 标题\r\nnew\r\n".as_bytes()
        );
        assert_eq!(preserve_format(b"a\n", "b\r\n").unwrap(), b"b\r\n");
        assert_eq!(preserve_format(b"a\r\nb\n", "x\ny\n").unwrap(), b"x\ny\n");
        assert_eq!(preserve_format(b"a\r", "b\n").unwrap(), b"b\r");
    }

    #[test]
    fn binary_and_oversized_markdown_are_rejected() {
        assert!(validate_content(b"\xff").is_err());
        assert!(validate_content(b"abc\0xyz").is_err());
        assert!(validate_content(&vec![b'a'; MAX_DOCUMENT_BYTES + 1]).is_err());
        assert!(validate_content("Unicode 📝\r\n\t".as_bytes()).is_ok());
    }

    #[test]
    fn traversal_reference_normalization_is_separate_from_api_paths() {
        assert!(validate_relative("guides/../readme.md").is_err());
        assert!(
            markdown::render("guides/page.md", "[readme](../readme.md)")
                .contains("/?file=readme.md")
        );
    }

    #[test]
    fn reading_saving_and_creating_preserve_content_and_versions() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("notes")).unwrap();
        fs::write(
            fixture.0.join("notes").join("原稿.md"),
            "\u{feff}# 原稿\r\nbefore\r\n",
        )
        .unwrap();
        let root = Root::open(&fixture.0).unwrap();
        let original = root.document("notes/原稿.md").unwrap();
        assert_eq!(original.content, "# 原稿\r\nbefore\r\n");
        let saved = root
            .save(
                "notes/原稿.md",
                "# Changed\nafter\n",
                &original.version,
                || Ok(()),
            )
            .unwrap();
        let expected = "\u{feff}# Changed\r\nafter\r\n".as_bytes();
        assert_eq!(saved.version, version(expected));
        assert_eq!(saved.content, "# Changed\r\nafter\r\n");
        assert_eq!(
            fs::read(fixture.0.join("notes").join("原稿.md")).unwrap(),
            expected
        );
        let created = root
            .create("notes/new.markdown", "# New\n📝\n", || Ok(()))
            .unwrap();
        assert_eq!(created.content, "# New\n📝\n");
        assert_eq!(
            root.document("notes/new.markdown").unwrap().version,
            created.version
        );
        assert_eq!(fs::read_dir(fixture.0.join("notes")).unwrap().count(), 2);
    }

    #[test]
    fn tree_limits_report_truncation_and_sort_results() {
        let fixture = Fixture::new();
        let path = &fixture.0;
        fs::create_dir_all(path.join("nested")).unwrap();
        fs::write(path.join("z.md"), "z").unwrap();
        fs::write(path.join("a.md"), "a").unwrap();
        fs::write(path.join("nested").join("b.md"), "b").unwrap();
        {
            let root = Root::open(&path).unwrap();
            let tree = root
                .tree_with_limits(TreeLimits {
                    files: 1,
                    ..TreeLimits::default()
                })
                .unwrap();
            assert_eq!(tree.files.len(), 1);
            assert!(tree.truncated);
            let tree = root.tree().unwrap();
            assert_eq!(
                tree.files
                    .iter()
                    .map(|file| file.path.as_str())
                    .collect::<Vec<_>>(),
                ["a.md", "nested/b.md", "z.md"]
            );
            assert!(!tree.truncated);
            let tree = root
                .tree_with_limits(TreeLimits {
                    entries: 1,
                    ..TreeLimits::default()
                })
                .unwrap();
            assert!(tree.truncated);
            let tree = root
                .tree_with_limits(TreeLimits {
                    depth: 0,
                    ..TreeLimits::default()
                })
                .unwrap();
            assert!(tree.truncated);
        }
    }

    #[test]
    fn tree_entry_and_time_budgets_bound_non_document_scanning() {
        let fixture = Fixture::new();
        for index in 0..64 {
            fs::write(fixture.0.join(format!("{index}.txt")), "not Markdown").unwrap();
        }
        for directory in [".private", "node_modules", "target", "build"] {
            fs::create_dir(fixture.0.join(directory)).unwrap();
            fs::write(fixture.0.join(directory).join("hidden.md"), "hidden").unwrap();
        }
        let root = Root::open(&fixture.0).unwrap();
        let tree = root
            .tree_with_limits(TreeLimits {
                entries: 3,
                ..TreeLimits::default()
            })
            .unwrap();
        assert!(tree.truncated);
        assert!(tree.files.is_empty());
        let tree = root
            .tree_with_limits(TreeLimits {
                duration: Duration::ZERO,
                ..TreeLimits::default()
            })
            .unwrap();
        assert!(tree.truncated);
        assert!(tree.files.is_empty());
        let tree = root.tree().unwrap();
        assert!(!tree.truncated);
        assert!(tree.files.is_empty());
    }

    #[test]
    fn cancelled_saves_and_failed_replacements_clean_staging_files() {
        use std::cell::Cell;

        let fixture = Fixture::new();
        fs::write(fixture.0.join("note.md"), "original").unwrap();
        let root = Root::open(&fixture.0).unwrap();
        let original = root.document("note.md").unwrap();
        let checks = Cell::new(0);
        let result = root.save("note.md", "changed", &original.version, || {
            checks.set(checks.get() + 1);
            if checks.get() >= 3 {
                Err(ApiError::new(StatusCode::REQUEST_TIMEOUT, "cancelled"))
            } else {
                Ok(())
            }
        });
        assert_eq!(result.unwrap_err().status, StatusCode::REQUEST_TIMEOUT);
        assert_eq!(
            fs::read_to_string(fixture.0.join("note.md")).unwrap(),
            "original"
        );
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);

        let checks = Cell::new(0);
        let result = root.create("new.md", "new", || {
            checks.set(checks.get() + 1);
            if checks.get() >= 2 {
                Err(ApiError::new(StatusCode::REQUEST_TIMEOUT, "cancelled"))
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        assert!(!fixture.0.join("new.md").exists());
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);

        fs::create_dir(fixture.0.join("directory.md")).unwrap();
        let resolved = root.resolve("directory.md").unwrap();
        {
            let mut staged = StagedFile::write(&resolved.parent, b"never published", None).unwrap();
            assert!(staged.commit(&resolved.name, true).is_err());
        }
        assert!(fixture.0.join("directory.md").is_dir());
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 2);
    }

    #[test]
    fn creation_does_not_clobber_a_file_created_during_staging() {
        use std::cell::Cell;

        let fixture = Fixture::new();
        let root = Root::open(&fixture.0).unwrap();
        let checks = Cell::new(0);
        let result = root.create("new.md", "app content", || {
            checks.set(checks.get() + 1);
            if checks.get() == 2 {
                fs::write(fixture.0.join("new.md"), "external content").unwrap();
            }
            Ok(())
        });
        assert_eq!(result.unwrap_err().status, StatusCode::CONFLICT);
        assert_eq!(
            fs::read_to_string(fixture.0.join("new.md")).unwrap(),
            "external content"
        );
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn a_changed_version_after_staging_keeps_external_content_and_cleans_up() {
        use std::cell::Cell;

        let fixture = Fixture::new();
        fs::write(fixture.0.join("note.md"), "original").unwrap();
        let root = Root::open(&fixture.0).unwrap();
        let original = root.document("note.md").unwrap();
        let checks = Cell::new(0);
        let result = root.save("note.md", "app content", &original.version, || {
            checks.set(checks.get() + 1);
            if checks.get() == 2 {
                fs::write(fixture.0.join("replacement.md"), "external content").unwrap();
                fs::rename(fixture.0.join("replacement.md"), fixture.0.join("note.md")).unwrap();
            }
            Ok(())
        });
        assert_eq!(result.unwrap_err().status, StatusCode::CONFLICT);
        assert_eq!(
            fs::read_to_string(fixture.0.join("note.md")).unwrap(),
            "external content"
        );
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_link_parents_and_final_entries_are_never_followed() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("notes")).unwrap();
        fs::create_dir(fixture.0.join("outside")).unwrap();
        fs::write(fixture.0.join("outside").join("note.md"), "outside").unwrap();
        let outside = fs::canonicalize(fixture.0.join("outside")).unwrap();
        symlink(&outside, fixture.0.join("notes").join("linked")).unwrap();
        symlink(
            outside.join("note.md"),
            fixture.0.join("notes").join("linked.md"),
        )
        .unwrap();
        symlink(
            outside.join("missing.md"),
            fixture.0.join("notes").join("dangling.md"),
        )
        .unwrap();
        let root = Root::open(&fixture.0.join("notes")).unwrap();
        for path in ["linked/note.md", "linked.md", "dangling.md"] {
            assert_eq!(
                root.document(path).unwrap_err().status,
                StatusCode::FORBIDDEN
            );
            assert!(
                root.save(path, "changed", &version(b"outside"), || Ok(()))
                    .is_err()
            );
            assert!(root.create(path, "new", || Ok(())).is_err());
        }
        assert!(root.tree().unwrap().files.is_empty());
        assert_eq!(
            fs::read_to_string(outside.join("note.md")).unwrap(),
            "outside"
        );
        assert!(!outside.join("missing.md").exists());
        assert_eq!(fs::read_dir(fixture.0.join("notes")).unwrap().count(), 3);
    }

    #[cfg(unix)]
    #[test]
    fn later_requests_keep_the_selected_root_when_its_ancestor_is_swapped() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        fs::create_dir_all(fixture.0.join("container").join("notes")).unwrap();
        fs::create_dir_all(fixture.0.join("outside").join("notes")).unwrap();
        fs::write(
            fixture.0.join("container").join("notes").join("note.md"),
            "inside",
        )
        .unwrap();
        fs::write(
            fixture.0.join("outside").join("notes").join("note.md"),
            "outside",
        )
        .unwrap();
        let root = Root::open(&fixture.0.join("container").join("notes")).unwrap();
        fs::rename(fixture.0.join("container"), fixture.0.join("held")).unwrap();
        symlink(
            fs::canonicalize(fixture.0.join("outside")).unwrap(),
            fixture.0.join("container"),
        )
        .unwrap();
        let original = root.document("note.md").unwrap();
        assert_eq!(original.content, "inside");
        root.save("note.md", "updated", &original.version, || Ok(()))
            .unwrap();
        root.create("new.md", "new inside", || Ok(())).unwrap();
        let tree = root.tree().unwrap();
        assert_eq!(
            tree.files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["new.md", "note.md"]
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join("held").join("notes").join("note.md")).unwrap(),
            "updated"
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join("outside").join("notes").join("note.md")).unwrap(),
            "outside"
        );
        assert!(
            !fixture
                .0
                .join("outside")
                .join("notes")
                .join("new.md")
                .exists()
        );
        assert_eq!(
            fs::read_dir(fixture.0.join("held").join("notes"))
                .unwrap()
                .count(),
            2
        );
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_directory_iterators_have_independent_cursors() {
        let fixture = Fixture::new();
        for index in 0..5 {
            fs::write(fixture.0.join(format!("{index}.md")), "note").unwrap();
        }
        let root = Root::open(&fixture.0).unwrap();
        let mut first = root.directory.entries().unwrap();
        let mut first_names = vec![first.next().unwrap().unwrap()];
        let mut second_names = root
            .directory
            .entries()
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        first_names.extend(first.collect::<Result<Vec<_>, _>>().unwrap());
        first_names.sort();
        second_names.sort();
        assert_eq!(first_names.len(), 5);
        assert_eq!(first_names, second_names);
        assert_eq!(root.tree().unwrap().files.len(), 5);
        assert_eq!(root.tree().unwrap().files.len(), 5);
    }

    #[cfg(unix)]
    #[test]
    fn abandoned_staging_is_removed_from_the_pinned_parent_after_a_swap() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        fs::create_dir_all(fixture.0.join("notes").join("child")).unwrap();
        fs::create_dir(fixture.0.join("outside")).unwrap();
        fs::write(
            fixture.0.join("notes").join("child").join("note.md"),
            "original",
        )
        .unwrap();
        let root = Root::open(&fixture.0.join("notes")).unwrap();
        let resolved = root.resolve("child/note.md").unwrap();
        let staged = StagedFile::write(&resolved.parent, b"unpublished", None).unwrap();
        let staging_name = staged.name.clone();
        fs::write(fixture.0.join("outside").join(&staging_name), "outside").unwrap();
        fs::rename(
            fixture.0.join("notes").join("child"),
            fixture.0.join("notes").join("held"),
        )
        .unwrap();
        symlink(
            fs::canonicalize(fixture.0.join("outside")).unwrap(),
            fixture.0.join("notes").join("child"),
        )
        .unwrap();
        drop(staged);
        assert!(
            !fixture
                .0
                .join("notes")
                .join("held")
                .join(&staging_name)
                .exists()
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join("outside").join(&staging_name)).unwrap(),
            "outside"
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join("notes").join("held").join("note.md")).unwrap(),
            "original"
        );
        assert_eq!(fs::read_dir(fixture.0.join("outside")).unwrap().count(), 1);
    }

    #[test]
    fn a_held_parent_cannot_be_replaced_with_an_escaping_directory() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("notes")).unwrap();
        fs::create_dir(fixture.0.join("outside")).unwrap();
        fs::write(fixture.0.join("outside").join("note.md"), "outside").unwrap();
        fs::create_dir(fixture.0.join("notes").join("child")).unwrap();
        let root = Root::open(&fixture.0.join("notes")).unwrap();
        let resolved = root.resolve("child/note.md").unwrap();
        let moved = fs::rename(
            fixture.0.join("notes").join("child"),
            fixture.0.join("notes").join("held"),
        );
        #[cfg(windows)]
        assert!(
            moved.is_err(),
            "Windows allowed a held ancestor to be substituted"
        );
        #[cfg(unix)]
        {
            moved.unwrap();
            std::os::unix::fs::symlink(
                fs::canonicalize(fixture.0.join("outside")).unwrap(),
                fixture.0.join("notes").join("child"),
            )
            .unwrap();
        }
        let mut staged = StagedFile::write(&resolved.parent, b"inside", None).unwrap();
        staged.commit(&resolved.name, false).unwrap();
        assert_eq!(
            fs::read_to_string(fixture.0.join("outside").join("note.md")).unwrap(),
            "outside"
        );
        #[cfg(windows)]
        assert_eq!(
            fs::read_to_string(fixture.0.join("notes").join("child").join("note.md")).unwrap(),
            "inside"
        );
        #[cfg(unix)]
        assert_eq!(
            fs::read_to_string(fixture.0.join("notes").join("held").join("note.md")).unwrap(),
            "inside"
        );
    }
}
