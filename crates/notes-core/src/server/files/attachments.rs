use super::{ApiError, Root, platform, validate_relative};
use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Serialize)]
pub(in crate::server) struct Attachment {
    pub path: String,
    pub size: u64,
    pub stamp: String,
}
#[derive(Serialize)]
pub(in crate::server) struct Attachments {
    pub files: Vec<Attachment>,
    pub truncated: bool,
}

pub(in crate::server) fn media_file(path: &str) -> bool {
    matches!(
        path.rsplit_once('.')
            .map(|(_, extension)| extension.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "bmp" | "ico" | "svg" | "pdf")
    )
}

impl Root {
    pub(in crate::server) fn attachment_stamp(&self, path: &str) -> Result<String, ApiError> {
        validate_relative(path)?;
        let resolved = self.resolve(path)?;
        let file = resolved.parent.open_regular(&resolved.name)?;
        let metadata = file
            .metadata()
            .map_err(|error| ApiError::io("Could not inspect the attachment", error))?;
        Ok(platform::fingerprint(&metadata)
            .0
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(":"))
    }

    pub(in crate::server) fn attachments(&self) -> Result<Attachments, ApiError> {
        let mut walk = Walk {
            result: Attachments {
                files: Vec::new(),
                truncated: false,
            },
            scanned: 0,
            started: Instant::now(),
        };
        walk.directory(&self.directory, "", 0)?;
        Ok(walk.result)
    }
}

struct Walk {
    result: Attachments,
    scanned: usize,
    started: Instant,
}
impl Walk {
    fn directory(
        &mut self,
        directory: &platform::Directory,
        parent: &str,
        depth: usize,
    ) -> Result<(), ApiError> {
        for entry in directory
            .entries()
            .map_err(|error| ApiError::io("Could not scan attachments", error))?
        {
            if self.scanned >= 20_000
                || self.result.files.len() >= 5000
                || self.started.elapsed() > Duration::from_secs(2)
            {
                self.result.truncated = true;
                break;
            }
            self.scanned += 1;
            let entry =
                entry.map_err(|error| ApiError::io("Could not read an attachment entry", error))?;
            let metadata = directory
                .metadata(&entry)
                .map_err(|error| ApiError::io("Could not inspect an attachment entry", error))?;
            if metadata.is_link() || metadata.is_hidden() {
                continue;
            }
            let name = entry
                .into_string()
                .map_err(|_| ApiError::bad_request("Attachment names must be Unicode."))?;
            let path = if parent.is_empty() {
                name.clone()
            } else {
                format!("{parent}/{name}")
            };
            if metadata.is_dir() && !super::paths::ignored_directory(&name) {
                if depth >= 32 {
                    self.result.truncated = true;
                    continue;
                }
                validate_relative(&format!("{path}/file.png"))?;
                self.directory(
                    &directory.open_child(name.as_ref(), true)?,
                    &path,
                    depth + 1,
                )?;
            } else if metadata.is_file() && media_file(&name) {
                validate_relative(&path)?;
                let file = directory.open_regular(name.as_ref())?;
                let metadata = file
                    .metadata()
                    .map_err(|error| ApiError::io("Could not inspect an attachment", error))?;
                self.result.files.push(Attachment {
                    path,
                    size: metadata.len(),
                    stamp: platform::fingerprint(&metadata)
                        .0
                        .iter()
                        .map(u64::to_string)
                        .collect::<Vec<_>>()
                        .join(":"),
                });
            }
        }
        Ok(())
    }
}
