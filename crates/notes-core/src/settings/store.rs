use std::path::{Path, PathBuf};

use super::Settings;
use crate::storage::{PublishMode, load_json, save_json};

/// Owns the platform location and atomic persistence of editor settings.
#[derive(Clone, Debug)]
pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn platform_default() -> Result<Self, String> {
        #[cfg(windows)]
        {
            std::env::var_os("LOCALAPPDATA")
                .map(|path| Self::new(PathBuf::from(path).join("NotesApp").join("settings.json")))
                .ok_or_else(|| "LOCALAPPDATA is not set.".into())
        }
        #[cfg(target_os = "macos")]
        {
            std::env::var_os("HOME")
                .map(|path| {
                    Self::new(
                        PathBuf::from(path)
                            .join("Library")
                            .join("Application Support")
                            .join("NotesApp")
                            .join("settings.json"),
                    )
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
            Ok(Self::new(directory.join("notes-app").join("settings.json")))
        }
        #[cfg(not(any(windows, unix)))]
        {
            Err("This platform has no supported settings directory.".into())
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<Option<Settings>, String> {
        let settings: Option<Settings> = load_json(&self.path, "settings")?;
        if let Some(settings) = &settings {
            settings.validate()?;
        }
        Ok(settings)
    }

    pub fn save(&self, settings: &Settings) -> Result<(), String> {
        settings.validate()?;
        // Refuse to replace a corrupt previous configuration.
        self.load()?;
        save_json(&self.path, "settings", settings, PublishMode::Replace)
    }
}
