use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    #[serde(rename = "Directory", alias = "directory")]
    pub directory: PathBuf,
    #[serde(rename = "Port", alias = "port")]
    pub port: u16,
    #[serde(rename = "AutoStart", alias = "autoStart")]
    pub auto_start: bool,
    #[serde(rename = "AutoOpenBrowser", alias = "autoOpenBrowser")]
    pub auto_open_browser: bool,
    #[serde(rename = "EditorAppearance", alias = "editorAppearance")]
    pub appearance: crate::appearance::Appearance,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            directory: PathBuf::new(),
            port: 8123,
            auto_start: true,
            auto_open_browser: true,
            appearance: crate::appearance::Appearance::default(),
        }
    }
}

impl Settings {
    pub fn path() -> Result<PathBuf, String> {
        #[cfg(windows)]
        {
            std::env::var_os("LOCALAPPDATA")
                .map(|p| PathBuf::from(p).join("NotesApp").join("settings.json"))
                .ok_or_else(|| "LOCALAPPDATA is not set.".into())
        }
        #[cfg(target_os = "macos")]
        {
            std::env::var_os("HOME")
                .map(|p| {
                    PathBuf::from(p)
                        .join("Library")
                        .join("Application Support")
                        .join("NotesApp")
                        .join("settings.json")
                })
                .ok_or_else(|| "HOME is not set.".into())
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let directory =
                match std::env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
                    Some(value) => {
                        let path = PathBuf::from(value);
                        if !path.is_absolute() {
                            return Err("XDG_CONFIG_HOME must be absolute.".into());
                        }
                        path
                    }
                    None => PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set.")?)
                        .join(".config"),
                };
            Ok(directory.join("notes-app").join("settings.json"))
        }
        #[cfg(not(any(windows, unix)))]
        {
            Err("This platform has no supported settings directory.".into())
        }
    }

    pub fn load(path: &Path) -> Result<Option<Self>, String> {
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("Cannot read {}: {e}", path.display())),
        };
        let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
        let result: Self = serde_json::from_slice(bytes).map_err(|e| {
            format!(
                "Invalid settings in {} (file was not changed): {e}",
                path.display()
            )
        })?;
        result.validate()?;
        Ok(Some(result))
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.port == 0 {
            return Err("Settings port must be between 1 and 65535.".into());
        }
        self.appearance.validate()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        self.validate()?;
        // Refuse to replace a corrupt previous configuration.
        Self::load(path)?;
        let parent = path.parent().ok_or("Settings path has no parent.")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random)
            .map_err(|error| format!("Could not name the settings staging file: {error}"))?;
        let name = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let temporary = parent.join(format!(".settings-{name}.new"));
        let mut created = false;
        let result = (|| {
            use std::io::Write;
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
            created = true;
            file.write_all(&serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?)
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
            drop(file);
            #[cfg(windows)]
            {
                use std::os::windows::ffi::OsStrExt;
                use windows_sys::Win32::Storage::FileSystem::{
                    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
                };
                let src: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
                let dst: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
                if unsafe {
                    MoveFileExW(
                        src.as_ptr(),
                        dst.as_ptr(),
                        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                    )
                } == 0
                {
                    return Err(std::io::Error::last_os_error().to_string());
                }
            }
            #[cfg(not(windows))]
            fs::rename(&temporary, path).map_err(|e| e.to_string())?;
            Ok(())
        })();
        if result.is_err() && created {
            if let Err(error) = fs::remove_file(temporary) {
                eprintln!("Could not remove the settings staging file: {error}");
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn editor_appearance_migration_and_validation() {
        let legacy: Settings =
            serde_json::from_str(r#"{"Theme":"old-mkdocs-theme","Appearance":"dark","Port":8123}"#)
                .unwrap();
        assert_eq!(legacy.appearance, crate::appearance::Appearance::default());
        let mut next = legacy;
        next.appearance.theme = crate::appearance::Theme::Dark;
        next.appearance.latin_font = "Custom English Font".into();
        next.appearance.cjk_font = "自定义中文字体".into();
        let json = serde_json::to_string(&next).unwrap();
        assert!(json.contains("EditorAppearance"));
        let restored: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.appearance, next.appearance);
        assert!(restored.validate().is_ok());
        next.appearance.latin_font = " ".into();
        assert!(next.validate().is_err());
        next.appearance.latin_font = "x".repeat(129);
        assert!(next.validate().is_err());
        assert!(
            serde_json::from_str::<Settings>(r#"{"EditorAppearance":{"theme":"unknown"}}"#)
                .is_err()
        );
    }
    #[test]
    fn migrates_legacy_and_defaults() {
        let settings: Settings = serde_json::from_str(r#"{"Directory":"C:\\笔记","Port":9000,"AutoStart":false,"AutoOpenBrowser":false,"Theme":"old"}"#).unwrap();
        assert_eq!(settings.port, 9000);
        assert!(!settings.auto_start);
        assert!(!settings.auto_open_browser);
        assert!(Settings::default().auto_start);
        assert!(Settings::default().auto_open_browser);
        assert!(
            Settings {
                port: 0,
                ..Settings::default()
            }
            .validate()
            .is_err()
        );
    }
    #[test]
    fn atomic_round_trip_and_corrupt_preservation() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("settings-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let mut settings = Settings::default();
        settings.save(&path).unwrap();
        settings.port = 9001;
        settings.appearance.theme = crate::appearance::Theme::Light;
        settings.appearance.latin_font = "Consolas".into();
        settings.appearance.cjk_font = "宋体".into();
        settings.save(&path).unwrap();
        assert_eq!(Settings::load(&path).unwrap().unwrap().port, 9001);
        assert_eq!(
            Settings::load(&path).unwrap().unwrap().appearance,
            settings.appearance
        );
        fs::write(&path, b"broken").unwrap();
        assert!(settings.save(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        fs::remove_dir_all(dir).unwrap();
    }
}
