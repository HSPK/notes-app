use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Appearance {
    pub theme: Theme,
    pub latin_font: String,
    pub cjk_font: String,
}

impl Default for Appearance {
    fn default() -> Self {
        #[cfg(windows)]
        let (latin, cjk) = ("Segoe UI", "Microsoft YaHei");
        #[cfg(target_os = "macos")]
        let (latin, cjk) = ("Helvetica Neue", "PingFang SC");
        #[cfg(not(any(windows, target_os = "macos")))]
        let (latin, cjk) = ("sans-serif", "sans-serif");
        Self {
            theme: Theme::System,
            latin_font: latin.into(),
            cjk_font: cjk.into(),
        }
    }
}

impl Appearance {
    pub fn validate(&self) -> Result<(), String> {
        for (label, family) in [
            ("English font", &self.latin_font),
            ("Chinese font", &self.cjk_font),
        ] {
            if family.trim().is_empty()
                || family.chars().count() > 128
                || family.chars().any(char::is_control)
            {
                return Err(format!(
                    "{label} must be a font family name of 1-128 characters."
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_are_typed_and_validate_custom_family_names() {
        let appearance: Appearance =
            serde_json::from_str(r#"{"theme":"dark","latinFont":"Georgia","cjkFont":"微软雅黑"}"#)
                .unwrap();
        appearance.validate().unwrap();
        assert_eq!(appearance.theme, Theme::Dark);
        assert_eq!(
            serde_json::to_value(appearance).unwrap()["latinFont"],
            "Georgia"
        );
        assert!(serde_json::from_str::<Appearance>(r#"{"theme":"unknown"}"#).is_err());
        for family in [
            "".to_owned(),
            " \t".into(),
            "bad\nfont".into(),
            "x".repeat(129),
        ] {
            assert!(
                Appearance {
                    latin_font: family,
                    ..Appearance::default()
                }
                .validate()
                .is_err()
            );
        }
    }
}
