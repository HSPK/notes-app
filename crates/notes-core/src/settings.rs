#[path = "settings/store.rs"]
mod store;

pub use store::SettingsStore;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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
    #[serde(rename = "WebPreferences", alias = "webPreferences")]
    pub web: WebPreferences,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            directory: PathBuf::new(),
            port: 8123,
            auto_start: true,
            auto_open_browser: true,
            appearance: crate::appearance::Appearance::default(),
            web: WebPreferences::default(),
        }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if self.port == 0 {
            return Err("Settings port must be between 1 and 65535.".into());
        }
        self.appearance.validate()?;
        self.web.validate()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DefaultView {
    Live,
    Source,
    Compare,
    Read,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SidebarTab {
    Files,
    Outline,
    Git,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InterfaceDensity {
    Compact,
    Comfortable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitDiffMode {
    Working,
    Staged,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageCompression {
    Original,
    Webp,
    Jpeg,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WebPreferences {
    pub image_directory: String,
    pub image_compression: ImageCompression,
    pub image_max_edge: u32,
    pub image_quality: u8,
    pub auto_save_delay_ms: u64,
    pub default_view: DefaultView,
    pub source_line_wrap: bool,
    pub spellcheck: bool,
    pub font_size_px: u8,
    pub line_height_percent: u16,
    pub density: InterfaceDensity,
    pub default_sidebar: SidebarTab,
    pub sidebar_open: bool,
    pub hidden_patterns: Vec<String>,
    pub tree_refresh_seconds: u64,
    pub git_refresh_seconds: u64,
    pub git_show_untracked: bool,
    pub git_default_diff: GitDiffMode,
    pub large_document_threshold_kib: u32,
    pub preview_delay_ms: u64,
    pub outline_delay_ms: u64,
    pub reduced_motion: bool,
    pub high_contrast: bool,
    pub strong_focus: bool,
}

impl Default for WebPreferences {
    fn default() -> Self {
        Self {
            image_directory: "assets/images".into(),
            image_compression: ImageCompression::Original,
            image_max_edge: 0,
            image_quality: 85,
            auto_save_delay_ms: 1000,
            default_view: DefaultView::Live,
            source_line_wrap: true,
            spellcheck: true,
            font_size_px: 17,
            line_height_percent: 175,
            density: InterfaceDensity::Comfortable,
            default_sidebar: SidebarTab::Files,
            sidebar_open: true,
            hidden_patterns: Vec::new(),
            tree_refresh_seconds: 0,
            git_refresh_seconds: 15,
            git_show_untracked: true,
            git_default_diff: GitDiffMode::Working,
            large_document_threshold_kib: 768,
            preview_delay_ms: 300,
            outline_delay_ms: 75,
            reduced_motion: false,
            high_contrast: false,
            strong_focus: true,
        }
    }
}

impl WebPreferences {
    pub fn validate(&self) -> Result<(), String> {
        if self.image_max_edge != 0 && !(256..=8192).contains(&self.image_max_edge) {
            return Err("Image maximum edge must be zero or between 256 and 8192 pixels.".into());
        }
        if !(50..=100).contains(&self.image_quality) {
            return Err("Image quality must be between 50 and 100.".into());
        }
        if self.image_directory.len() > 512
            || self.image_directory.split('/').any(|part| {
                part.is_empty()
                    || part.starts_with('.')
                    || part.chars().any(|c| {
                        c.is_control()
                            || matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                    })
            })
        {
            return Err("Image directory must be a safe project-relative path.".into());
        }

        let ranged = |value, minimum, maximum, name| {
            if value < minimum || value > maximum {
                Err(format!("{name} must be between {minimum} and {maximum}."))
            } else {
                Ok(())
            }
        };
        ranged(self.auto_save_delay_ms, 250, 10_000, "Auto-save delay")?;
        ranged(self.font_size_px as u64, 12, 28, "Editor font size")?;
        ranged(
            self.line_height_percent as u64,
            120,
            240,
            "Editor line height",
        )?;
        if self.tree_refresh_seconds != 0 {
            ranged(
                self.tree_refresh_seconds,
                5,
                3600,
                "Library refresh interval",
            )?;
        }
        if self.git_refresh_seconds != 0 {
            ranged(self.git_refresh_seconds, 3, 3600, "Git refresh interval")?;
        }
        ranged(
            self.large_document_threshold_kib as u64,
            256,
            4096,
            "Large document threshold",
        )?;
        ranged(self.preview_delay_ms, 0, 5000, "Preview delay")?;
        ranged(self.outline_delay_ms, 0, 2000, "Outline delay")?;
        if self.hidden_patterns.len() > 100
            || self.hidden_patterns.iter().any(|pattern| {
                pattern.is_empty() || pattern.len() > 256 || pattern.chars().any(char::is_control)
            })
            || self.hidden_patterns.iter().map(String::len).sum::<usize>() > 16 * 1024
        {
            return Err("Hidden paths contain too many or invalid patterns.".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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
        assert_eq!(Settings::default().web.auto_save_delay_ms, 1000);
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
        let store = SettingsStore::new(path.clone());
        let mut settings = Settings::default();
        store.save(&settings).unwrap();
        settings.port = 9001;
        settings.appearance.theme = crate::appearance::Theme::Light;
        settings.appearance.latin_font = "Consolas".into();
        settings.appearance.cjk_font = "宋体".into();
        store.save(&settings).unwrap();
        assert_eq!(store.load().unwrap().unwrap().port, 9001);
        assert_eq!(
            store.load().unwrap().unwrap().appearance,
            settings.appearance
        );
        fs::write(&path, b"broken").unwrap();
        assert!(store.save(&settings).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        fs::remove_dir_all(dir).unwrap();
    }
}
