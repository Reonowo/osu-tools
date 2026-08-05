//! the app settings file: plain json in the tauri config dir. v1 has exactly
//! one setting -- the stable-install override the spec's osu!.db lookup
//! calls for ("auto-detected from standard locations; overridable in
//! settings")

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// the directory holding osu!.db; None means auto-detect from the
    /// standard install locations
    pub osu_stable_path: Option<String>,
}

/// a missing or unreadable settings file must never brick startup
pub fn load_settings(config_dir: &Path) -> Settings {
    fs::read_to_string(config_dir.join(SETTINGS_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_settings(config_dir: &Path, settings: &Settings) -> std::io::Result<()> {
    fs::create_dir_all(config_dir)?;
    let json = serde_json::to_string_pretty(settings).expect("settings always serialize");
    fs::write(config_dir.join(SETTINGS_FILE), json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings { osu_stable_path: Some(r"D:\games\osu!".into()) };
        save_settings(dir.path(), &settings).unwrap();
        assert_eq!(load_settings(dir.path()), settings);
    }

    #[test]
    fn missing_or_corrupt_settings_fall_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_settings(dir.path()), Settings::default());
        std::fs::write(dir.path().join(SETTINGS_FILE), b"{not json").unwrap();
        assert_eq!(load_settings(dir.path()), Settings::default());
    }

    #[test]
    fn save_creates_the_config_directory() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested").join("config");
        save_settings(&nested, &Settings::default()).unwrap();
        assert!(nested.join(SETTINGS_FILE).is_file());
    }

    #[test]
    fn settings_serialize_with_camel_case_keys() {
        // verify the serialized json uses camelCase keys, not snake_case
        let settings = Settings { osu_stable_path: Some(r"D:\games\osu!".into()) };
        assert_eq!(
            serde_json::to_value(&settings).unwrap(),
            json!({ "osuStablePath": r"D:\games\osu!" })
        );

        // verify default settings serializes with null value
        assert_eq!(
            serde_json::to_value(Settings::default()).unwrap(),
            json!({ "osuStablePath": null })
        );
    }
}
