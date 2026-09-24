use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io;
use std::path::Path;

use super::{ApiError, EntryFingerprint};

pub(in super::super) struct Directory;
pub(in super::super) struct EntryMetadata;

fn unsupported() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "Unsupported filesystem platform",
    )
}

fn api_error() -> ApiError {
    ApiError::io(
        "This backend supports Windows, macOS, and Linux",
        unsupported(),
    )
}

impl EntryMetadata {
    pub(in super::super) fn is_dir(&self) -> bool {
        false
    }
    pub(in super::super) fn is_file(&self) -> bool {
        false
    }
    pub(in super::super) fn is_link(&self) -> bool {
        false
    }
    pub(in super::super) fn is_hidden(&self) -> bool {
        false
    }
    pub(in super::super) fn fingerprint(&self) -> EntryFingerprint {
        EntryFingerprint([0; 5])
    }
}

impl Directory {
    pub(in super::super) fn open(_: &Path, _: bool) -> Result<Self, ApiError> {
        Err(api_error())
    }
    pub(in super::super) fn open_child(&self, _: &OsStr, _: bool) -> Result<Self, ApiError> {
        Err(api_error())
    }
    pub(in super::super) fn try_clone(&self) -> Result<Self, ApiError> {
        Err(api_error())
    }
    pub(in super::super) fn metadata(&self, _: &OsStr) -> io::Result<EntryMetadata> {
        Err(unsupported())
    }
    pub(in super::super) fn open_regular(&self, _: &OsStr) -> Result<File, ApiError> {
        Err(api_error())
    }
    pub(in super::super) fn create_new(&self, _: &OsStr) -> io::Result<File> {
        Err(unsupported())
    }
    pub(in super::super) fn create_dir(&self, _: &OsStr) -> io::Result<()> {
        Err(unsupported())
    }
    pub(in super::super) fn move_entry_to(&self, _: &OsStr, _: &Self, _: &OsStr) -> io::Result<()> {
        Err(unsupported())
    }
    pub(in super::super) fn entries(&self) -> io::Result<std::iter::Empty<io::Result<OsString>>> {
        Err(unsupported())
    }
    pub(in super::super) fn remove_file(&self, _: &OsStr) -> io::Result<()> {
        Err(unsupported())
    }
    pub(in super::super) fn sync(&self) -> Result<(), ApiError> {
        Err(api_error())
    }
    pub(in super::super) fn commit(&self, _: &OsStr, _: &OsStr, _: bool) -> io::Result<bool> {
        Err(unsupported())
    }
}
