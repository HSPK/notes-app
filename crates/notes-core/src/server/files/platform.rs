use std::ffi::OsStr;
use std::fs::Metadata;
use std::io;

use super::super::ApiError;

#[cfg(windows)]
#[path = "windows.rs"]
mod implementation;
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "unix.rs"]
mod implementation;
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
#[path = "unsupported.rs"]
mod implementation;

pub(super) use implementation::Directory;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct EntryFingerprint(pub(super) [u64; 5]);

pub(super) fn fingerprint(metadata: &Metadata) -> EntryFingerprint {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        EntryFingerprint([
            metadata.len(),
            metadata.mtime() as u64,
            metadata.mtime_nsec() as u64,
            metadata.ctime() as u64,
            metadata.ctime_nsec() as u64,
        ])
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        EntryFingerprint([
            metadata.file_size(),
            metadata.last_write_time(),
            metadata.creation_time(),
            metadata.file_attributes() as u64,
            0,
        ])
    }
    #[cfg(not(any(unix, windows)))]
    {
        EntryFingerprint([metadata.len(), 0, 0, 0, 0])
    }
}

pub(super) fn ensure_supported() -> Result<(), ApiError> {
    if cfg!(any(windows, target_os = "linux", target_os = "macos")) {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "This backend supports Windows, macOS, and Linux.",
        ))
    }
}

fn check_name(name: &OsStr) -> io::Result<()> {
    // All descriptor-relative operations must receive exactly one child name,
    // never an absolute path or traversal (including internal staging calls).
    let mut components = std::path::Path::new(name).components();
    if matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none()
        && !name.is_empty()
        && !name.as_encoded_bytes().contains(&0)
        && !name.as_encoded_bytes().contains(&b'/')
        && !name.as_encoded_bytes().contains(&b'\\')
    {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected a single relative file name",
        ))
    }
}
