use std::{fs, path::Path};

use serde::{Serialize, de::DeserializeOwned};

#[derive(Clone, Copy)]
pub(crate) enum PublishMode {
    Create,
    Replace,
}

pub(crate) fn load_json<T: DeserializeOwned>(
    path: &Path,
    description: &str,
) -> Result<Option<T>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read {}: {error}", path.display())),
    };
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    serde_json::from_slice(bytes).map(Some).map_err(|error| {
        format!(
            "Invalid {description} in {} (file was not changed): {error}",
            path.display()
        )
    })
}

pub(crate) fn save_json<T: Serialize>(
    path: &Path,
    description: &str,
    value: &T,
    mode: PublishMode,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Could not serialize {description}: {error}"))?;
    let parent = path.parent().ok_or("Storage path has no parent.")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random)
        .map_err(|error| format!("Could not name the {description} staging file: {error}"))?;
    let name = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let temporary = parent.join(format!(".{description}-{name}.new"));
    let mut cleanup_needed = false;
    let result = (|| {
        use std::io::Write;

        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        cleanup_needed = true;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        drop(file);

        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
            };

            let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
            let destination: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let flags = MOVEFILE_WRITE_THROUGH
                | if matches!(mode, PublishMode::Replace) {
                    MOVEFILE_REPLACE_EXISTING
                } else {
                    0
                };
            if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), flags) } == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            cleanup_needed = false;
        }
        #[cfg(not(windows))]
        {
            match mode {
                PublishMode::Create => {
                    fs::hard_link(&temporary, path).map_err(|error| error.to_string())?;
                    fs::remove_file(&temporary).map_err(|error| error.to_string())?;
                }
                PublishMode::Replace => {
                    fs::rename(&temporary, path).map_err(|error| error.to_string())?;
                }
            }
            cleanup_needed = false;
            fs::File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    })();
    if result.is_err() && cleanup_needed {
        if let Err(error) = fs::remove_file(temporary) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("Could not remove a {description} staging file: {error}");
            }
        }
    }
    result
}
