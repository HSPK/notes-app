use std::ffi::{CStr, CString, OsStr, OsString};
use std::fs::File;
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, RawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::Path;
use std::ptr::NonNull;

use super::{ApiError, EntryFingerprint, check_name};

pub(in super::super) struct Directory {
    file: File,
}

pub(in super::super) struct EntryMetadata {
    mode: libc::mode_t,
    fingerprint: EntryFingerprint,
}

impl EntryMetadata {
    pub(in super::super) fn is_dir(&self) -> bool {
        self.mode & libc::S_IFMT == libc::S_IFDIR
    }

    pub(in super::super) fn is_file(&self) -> bool {
        self.mode & libc::S_IFMT == libc::S_IFREG
    }

    pub(in super::super) fn is_link(&self) -> bool {
        self.mode & libc::S_IFMT == libc::S_IFLNK
    }

    pub(in super::super) fn is_hidden(&self) -> bool {
        false
    }

    pub(in super::super) fn fingerprint(&self) -> EntryFingerprint {
        self.fingerprint
    }
}

impl Directory {
    pub(in super::super) fn open(path: &Path, _check_hidden: bool) -> Result<Self, ApiError> {
        let path = c_string(path.as_os_str())
            .map_err(|error| ApiError::io("Invalid document folder path", error))?;
        let file = open_at(libc::AT_FDCWD, &path, directory_flags(), 0)
            .map_err(|error| open_error("Could not open a document folder", error))?;
        Self::from_file(file)
    }

    pub(in super::super) fn open_child(
        &self,
        name: &OsStr,
        _check_hidden: bool,
    ) -> Result<Self, ApiError> {
        let metadata = self.checked_metadata(name)?;
        if !metadata.is_dir() {
            return Err(ApiError::bad_request("A parent path is not a directory."));
        }
        let name = child_name(name)
            .map_err(|error| ApiError::io("Invalid document folder name", error))?;
        let file = open_at(self.file.as_raw_fd(), &name, directory_flags(), 0)
            .map_err(|error| open_error("Could not open a document folder", error))?;
        Self::from_file(file)
    }

    fn from_file(file: File) -> Result<Self, ApiError> {
        let metadata = file
            .metadata()
            .map_err(|error| ApiError::io("Could not inspect a document folder", error))?;
        if !metadata.is_dir() {
            return Err(ApiError::forbidden(
                "Only real directories can be accessed.",
            ));
        }
        Ok(Self { file })
    }

    pub(in super::super) fn try_clone(&self) -> Result<Self, ApiError> {
        Ok(Self {
            file: self
                .file
                .try_clone()
                .map_err(|error| ApiError::io("Could not retain the document folder", error))?,
        })
    }

    pub(in super::super) fn metadata(&self, name: &OsStr) -> io::Result<EntryMetadata> {
        let name = child_name(name)?;
        let mut stat = MaybeUninit::<libc::stat>::uninit();
        // SAFETY: the name is NUL-terminated and stat points to writable storage.
        // AT_SYMLINK_NOFOLLOW inspects the entry itself, never its target.
        let result = unsafe {
            libc::fstatat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result == -1 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful fstatat initialized the entire stat structure.
        let stat = unsafe { stat.assume_init() };
        #[cfg(target_os = "linux")]
        let fingerprint = EntryFingerprint([
            stat.st_size as u64,
            stat.st_mtime as u64,
            stat.st_mtime_nsec as u64,
            stat.st_ctime as u64,
            stat.st_ctime_nsec as u64,
        ]);
        #[cfg(target_os = "macos")]
        let fingerprint = EntryFingerprint([
            stat.st_size as u64,
            stat.st_mtimespec.tv_sec as u64,
            stat.st_mtimespec.tv_nsec as u64,
            stat.st_ctimespec.tv_sec as u64,
            stat.st_ctimespec.tv_nsec as u64,
        ]);
        Ok(EntryMetadata {
            mode: stat.st_mode,
            fingerprint,
        })
    }

    fn checked_metadata(&self, name: &OsStr) -> Result<EntryMetadata, ApiError> {
        let metadata = self
            .metadata(name)
            .map_err(|error| ApiError::io("Could not inspect the requested path", error))?;
        if metadata.is_link() {
            return Err(ApiError::forbidden("Symbolic links are not accessible."));
        }
        Ok(metadata)
    }

    pub(in super::super) fn open_regular(&self, name: &OsStr) -> Result<File, ApiError> {
        if !self.checked_metadata(name)?.is_file() {
            return Err(ApiError::bad_request(
                "The requested path is not a regular file.",
            ));
        }
        let name =
            child_name(name).map_err(|error| ApiError::io("Invalid document file name", error))?;
        // NONBLOCK prevents a raced-in FIFO from hanging before the handle's
        // metadata can reject it; it has no effect on regular file reads.
        let file = open_at(
            self.file.as_raw_fd(),
            &name,
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            0,
        )
        .map_err(|error| open_error("Could not open the requested file", error))?;
        check_regular(&file)?;
        Ok(file)
    }

    pub(in super::super) fn create_new(&self, name: &OsStr) -> io::Result<File> {
        open_at(
            self.file.as_raw_fd(),
            &child_name(name)?,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o666,
        )
    }

    pub(in super::super) fn create_dir(&self, name: &OsStr) -> io::Result<()> {
        let name = child_name(name)?;
        // SAFETY: name is a validated, NUL-terminated child and the directory descriptor is live.
        if unsafe { libc::mkdirat(self.file.as_raw_fd(), name.as_ptr(), 0o777) } == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    pub(in super::super) fn move_entry_to(
        &self,
        source: &OsStr,
        destination_parent: &Self,
        destination: &OsStr,
    ) -> io::Result<()> {
        let source = child_name(source)?;
        let destination = child_name(destination)?;
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                self.file.as_raw_fd(),
                source.as_ptr(),
                destination_parent.file.as_raw_fd(),
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_os = "macos")]
        let result = unsafe {
            libc::renameatx_np(
                self.file.as_raw_fd(),
                source.as_ptr(),
                destination_parent.file.as_raw_fd(),
                destination.as_ptr(),
                libc::RENAME_EXCL,
            ) as libc::c_long
        };
        if result == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    // Returns whether the staging name still needs removal after publication.
    pub(in super::super) fn commit(
        &self,
        source: &OsStr,
        destination: &OsStr,
        replace: bool,
    ) -> io::Result<bool> {
        let source = child_name(source)?;
        let destination = child_name(destination)?;
        let fd = self.file.as_raw_fd();
        // SAFETY: both names are valid C strings and fd is owned for this call.
        // Neither operation follows a destination symlink. linkat without flags
        // atomically fails if ANY entry already occupies the destination name.
        let result = unsafe {
            if replace {
                libc::renameat(fd, source.as_ptr(), fd, destination.as_ptr())
            } else {
                libc::linkat(fd, source.as_ptr(), fd, destination.as_ptr(), 0)
            }
        };
        if result == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(!replace)
        }
    }

    pub(in super::super) fn remove_file(&self, name: &OsStr) -> io::Result<()> {
        let name = child_name(name)?;
        // SAFETY: name is NUL-terminated and the parent descriptor is live.
        if unsafe { libc::unlinkat(self.file.as_raw_fd(), name.as_ptr(), 0) } == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    pub(in super::super) fn sync(&self) -> Result<(), ApiError> {
        self.file
            .sync_all()
            .map_err(|error| ApiError::io("Could not flush the document folder", error))
    }

    pub(in super::super) fn entries(&self) -> io::Result<ReadDir> {
        // Opening "." creates an independent directory cursor; dup/try_clone
        // would share an offset and interfere with concurrent/repeated walks.
        let file = open_at(self.file.as_raw_fd(), c".", directory_flags(), 0)?;
        // SAFETY: fdopendir receives an open directory descriptor. On failure
        // File still owns it; only success transfers ownership to DIR.
        let directory = NonNull::new(unsafe { libc::fdopendir(file.as_raw_fd()) })
            .ok_or_else(io::Error::last_os_error)?;
        let _ = file.into_raw_fd();
        Ok(ReadDir {
            directory,
            finished: false,
        })
    }
}

pub(in super::super) struct ReadDir {
    directory: NonNull<libc::DIR>,
    finished: bool,
}

impl Iterator for ReadDir {
    type Item = io::Result<OsString>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        loop {
            // SAFETY: errno is thread-local; DIR is owned exclusively by this
            // iterator. Copy d_name before calling readdir again.
            unsafe {
                *errno_ptr() = 0;
                let entry = libc::readdir(self.directory.as_ptr());
                if entry.is_null() {
                    let error = *errno_ptr();
                    self.finished = true;
                    return if error == 0 {
                        None
                    } else {
                        Some(Err(io::Error::from_raw_os_error(error)))
                    };
                }
                let name = CStr::from_ptr((*entry).d_name.as_ptr()).to_bytes();
                if name != b"." && name != b".." {
                    return Some(Ok(OsString::from_vec(name.to_vec())));
                }
            }
        }
    }
}

impl Drop for ReadDir {
    fn drop(&mut self) {
        // SAFETY: this DIR owns its descriptor and is closed exactly once.
        if unsafe { libc::closedir(self.directory.as_ptr()) } == -1 {
            eprintln!(
                "Could not close a Notes folder iterator: {}",
                io::Error::last_os_error()
            );
        }
    }
}

fn errno_ptr() -> *mut libc::c_int {
    // SAFETY: these APIs return the current thread's errno storage.
    #[cfg(target_os = "linux")]
    unsafe {
        libc::__errno_location()
    }
    #[cfg(target_os = "macos")]
    unsafe {
        libc::__error()
    }
}

fn directory_flags() -> libc::c_int {
    libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_DIRECTORY
}

fn c_string(name: &OsStr) -> io::Result<CString> {
    CString::new(name.as_bytes())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))
}

fn child_name(name: &OsStr) -> io::Result<CString> {
    check_name(name)?;
    c_string(name)
}

fn open_at(fd: RawFd, name: &CStr, flags: libc::c_int, mode: libc::mode_t) -> io::Result<File> {
    // SAFETY: name is NUL-terminated; mode is supplied even for non-creating
    // opens. A successful descriptor is transferred immediately to File.
    let opened = unsafe { libc::openat(fd, name.as_ptr(), flags, mode as libc::c_uint) };
    if opened == -1 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: openat returned a new, uniquely owned descriptor.
        Ok(unsafe { File::from_raw_fd(opened) })
    }
}

fn check_regular(file: &File) -> Result<(), ApiError> {
    let metadata = file
        .metadata()
        .map_err(|error| ApiError::io("Could not inspect the opened file", error))?;
    if !metadata.is_file() {
        return Err(ApiError::forbidden("Only regular files can be accessed."));
    }
    Ok(())
}

fn open_error(context: &str, error: io::Error) -> ApiError {
    if error.raw_os_error() == Some(libc::ELOOP) {
        return ApiError::forbidden("Symbolic links are not accessible.");
    }
    ApiError::io(context, error)
}
