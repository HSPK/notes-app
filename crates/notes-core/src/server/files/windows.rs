use std::ffi::{OsStr, OsString};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_SYSTEM,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
};

use super::{ApiError, check_name};

pub(in super::super) struct Directory {
    file: File,
    path: PathBuf,
}

pub(in super::super) struct EntryMetadata(Metadata);

impl EntryMetadata {
    pub(in super::super) fn is_dir(&self) -> bool {
        self.0.is_dir()
    }

    pub(in super::super) fn is_file(&self) -> bool {
        self.0.is_file()
    }

    pub(in super::super) fn is_link(&self) -> bool {
        self.0.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }

    pub(in super::super) fn is_hidden(&self) -> bool {
        self.0.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
    }
}

impl Directory {
    pub(in super::super) fn open(path: &Path, check_hidden: bool) -> Result<Self, ApiError> {
        let metadata = checked_metadata(path, check_hidden)?;
        if !metadata.is_dir() {
            return Err(ApiError::bad_request("A parent path is not a directory."));
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(path)
            .map_err(|error| ApiError::io("Could not open a document folder", error))?;
        let metadata = EntryMetadata(
            file.metadata()
                .map_err(|error| ApiError::io("Could not inspect a document folder", error))?,
        );
        if metadata.is_link() || !metadata.is_dir() || (check_hidden && metadata.is_hidden()) {
            return Err(ApiError::forbidden(
                "Symbolic links, junctions, and hidden folders are not accessible.",
            ));
        }
        Ok(Self {
            file,
            path: path.to_owned(),
        })
    }

    pub(in super::super) fn open_child(
        &self,
        name: &OsStr,
        check_hidden: bool,
    ) -> Result<Self, ApiError> {
        let path = self
            .child_path(name)
            .map_err(|error| ApiError::io("Invalid document folder name", error))?;
        Self::open(&path, check_hidden)
    }

    pub(in super::super) fn try_clone(&self) -> Result<Self, ApiError> {
        Ok(Self {
            file: self
                .file
                .try_clone()
                .map_err(|error| ApiError::io("Could not retain the document folder", error))?,
            path: self.path.clone(),
        })
    }

    fn child_path(&self, name: &OsStr) -> io::Result<PathBuf> {
        check_name(name)?;
        Ok(self.path.join(name))
    }

    pub(in super::super) fn metadata(&self, name: &OsStr) -> io::Result<EntryMetadata> {
        fs::symlink_metadata(self.child_path(name)?).map(EntryMetadata)
    }

    pub(in super::super) fn open_regular(&self, name: &OsStr) -> Result<File, ApiError> {
        let path = self
            .child_path(name)
            .map_err(|error| ApiError::io("Invalid document file name", error))?;
        if !checked_metadata(&path, true)?.is_file() {
            return Err(ApiError::bad_request(
                "The requested path is not a regular file.",
            ));
        }
        let file = regular_options()
            .read(true)
            .open(path)
            .map_err(|error| ApiError::io("Could not open the requested file", error))?;
        let metadata = EntryMetadata(
            file.metadata()
                .map_err(|error| ApiError::io("Could not inspect the opened file", error))?,
        );
        if metadata.is_link() || metadata.is_hidden() || !metadata.is_file() {
            return Err(ApiError::forbidden(
                "Only regular, non-hidden files can be accessed.",
            ));
        }
        Ok(file)
    }

    pub(in super::super) fn create_new(&self, name: &OsStr) -> io::Result<File> {
        regular_options()
            .write(true)
            .create_new(true)
            .open(self.child_path(name)?)
    }

    pub(in super::super) fn entries(
        &self,
    ) -> io::Result<impl Iterator<Item = io::Result<OsString>>> {
        Ok(fs::read_dir(&self.path)?.map(|entry| entry.map(|entry| entry.file_name())))
    }

    pub(in super::super) fn remove_file(&self, name: &OsStr) -> io::Result<()> {
        fs::remove_file(self.child_path(name)?)
    }

    pub(in super::super) fn sync(&self) -> Result<(), ApiError> {
        Ok(())
    }

    // Returns whether the staging name still needs removal after publication.
    pub(in super::super) fn commit(
        &self,
        source: &OsStr,
        destination: &OsStr,
        replace: bool,
    ) -> io::Result<bool> {
        let source = self
            .child_path(source)?
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let destination = self
            .child_path(destination)?
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let flags = MOVEFILE_WRITE_THROUGH
            | if replace {
                MOVEFILE_REPLACE_EXISTING
            } else {
                0
            };
        // SAFETY: both paths are NUL-terminated. Renaming replaces the entry,
        // never a symlink target; ancestors remain held without delete sharing.
        if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), flags) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(false)
        }
    }
}

fn checked_metadata(path: &Path, check_hidden: bool) -> Result<EntryMetadata, ApiError> {
    let metadata = EntryMetadata(
        fs::symlink_metadata(path)
            .map_err(|error| ApiError::io("Could not inspect the requested path", error))?,
    );
    if metadata.is_link() || (check_hidden && metadata.is_hidden()) {
        return Err(ApiError::forbidden(
            "Symbolic links, junctions, and hidden files are not accessible.",
        ));
    }
    Ok(metadata)
}

fn regular_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    // Deny simultaneous in-place writers, but permit atomic replacement of an open file.
    options
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE);
    options
}
