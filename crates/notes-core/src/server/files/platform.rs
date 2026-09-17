use std::ffi::OsStr;
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
