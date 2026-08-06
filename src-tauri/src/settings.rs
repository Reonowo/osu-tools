//! the app settings file: plain json in the tauri config dir. v1 held exactly
//! one setting -- the stable-install override the spec's osu!.db lookup calls
//! for ("auto-detected from standard locations; overridable in settings").
//! v2 adds the viewer preferences that should survive a restart: playback
//! volume and the analysis-overlay toggles. playback rate stays session-only
//! (it belongs to the replay you are watching, not to the app).
//!
//! every field is `#[serde(default)]` at the container level, so a v1 file --
//! or any future file written by an older build -- hydrates the new fields
//! from `Default` instead of failing to parse and losing the stable path.
//! values are additionally range-checked on load: the file is user-editable,
//! and a hand-typed volume of 900 must not reach the audio element

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const SETTINGS_FILE: &str = "settings.json";

/// inclusive bounds for `OverlayPrefs::display_length`, mirroring lazer's
/// ReplayAnalysisDisplayLength setting range (osurulesetconfigmanager.cs:27-31)
pub const DISPLAY_LENGTH_MIN: f64 = 200.0;
pub const DISPLAY_LENGTH_MAX: f64 = 2000.0;
pub const DISPLAY_LENGTH_DEFAULT: f64 = 800.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// the directory holding osu!.db; None means auto-detect from the
    /// standard install locations
    pub osu_stable_path: Option<String>,
    /// linear amplitude percent, 0-100. linear because osu-framework applies
    /// its aggregate volume straight to the bass channel volume
    /// (TrackBass.cs:371), so a linear slider is the osu!-matching one
    pub volume: u32,
    pub overlays: OverlayPrefs,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings { osu_stable_path: None, volume: 100, overlays: OverlayPrefs::default() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OverlayPrefs {
    pub cursor_path: bool,
    pub click_markers: bool,
    pub frame_markers: bool,
    pub hide_cursor: bool,
    pub key_overlay: bool,
    /// ms of replay either side of `now` the analysis overlays cover
    pub display_length: f64,
}

impl Default for OverlayPrefs {
    fn default() -> OverlayPrefs {
        OverlayPrefs {
            cursor_path: false,
            click_markers: false,
            frame_markers: false,
            hide_cursor: false,
            key_overlay: true,
            display_length: DISPLAY_LENGTH_DEFAULT,
        }
    }
}

impl Settings {
    /// force every range-limited field back inside its bounds. applied after
    /// parsing a file (which the user can edit by hand) and before persisting
    /// a frontend-supplied update, so neither path can publish a value the
    /// audio element or the renderer would choke on
    pub fn sanitize(&mut self) {
        self.volume = self.volume.min(100);
        let length = self.overlays.display_length;
        self.overlays.display_length = if length.is_finite() {
            length.clamp(DISPLAY_LENGTH_MIN, DISPLAY_LENGTH_MAX)
        } else {
            DISPLAY_LENGTH_DEFAULT
        };
    }
}

/// a missing or unreadable settings file must never brick startup
pub fn load_settings(config_dir: &Path) -> Settings {
    let mut settings: Settings = fs::read_to_string(config_dir.join(SETTINGS_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    settings.sanitize();
    settings
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

    fn sample() -> Settings {
        Settings {
            osu_stable_path: Some(r"D:\games\osu!".into()),
            volume: 60,
            overlays: OverlayPrefs {
                cursor_path: true,
                click_markers: true,
                frame_markers: false,
                hide_cursor: true,
                key_overlay: false,
                display_length: 1200.0,
            },
        }
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let settings = sample();
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
    fn defaults_are_full_volume_with_the_key_overlay_on() {
        let settings = Settings::default();
        assert_eq!(settings.volume, 100);
        assert!(settings.overlays.key_overlay, "the key overlay ships enabled");
        assert_eq!(settings.overlays.display_length, DISPLAY_LENGTH_DEFAULT);
        assert!(!settings.overlays.cursor_path);
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
        // the wire contract shared with src/lib/scene-types.ts
        assert_eq!(
            serde_json::to_value(sample()).unwrap(),
            json!({
                "osuStablePath": r"D:\games\osu!",
                "volume": 60,
                "overlays": {
                    "cursorPath": true,
                    "clickMarkers": true,
                    "frameMarkers": false,
                    "hideCursor": true,
                    "keyOverlay": false,
                    "displayLength": 1200.0,
                },
            })
        );

        assert_eq!(
            serde_json::to_value(Settings::default()).unwrap(),
            json!({
                "osuStablePath": null,
                "volume": 100,
                "overlays": {
                    "cursorPath": false,
                    "clickMarkers": false,
                    "frameMarkers": false,
                    "hideCursor": false,
                    "keyOverlay": true,
                    "displayLength": 800.0,
                },
            })
        );
    }

    #[test]
    fn legacy_settings_files_hydrate_new_fields_with_defaults() {
        // a v1 file holds only osuStablePath; the stable path must survive and
        // everything added since must come up on its default
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            br#"{"osuStablePath":"D:\\games\\osu!"}"#,
        )
        .unwrap();

        let loaded = load_settings(dir.path());
        assert_eq!(loaded.osu_stable_path.as_deref(), Some(r"D:\games\osu!"));
        assert_eq!(loaded.volume, 100);
        assert_eq!(loaded.overlays, OverlayPrefs::default());

        // a partially-written overlays object hydrates per field too
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            br#"{"volume":40,"overlays":{"cursorPath":true}}"#,
        )
        .unwrap();
        let loaded = load_settings(dir.path());
        assert_eq!(loaded.volume, 40);
        assert!(loaded.overlays.cursor_path);
        assert!(loaded.overlays.key_overlay, "untouched fields keep their default");
        assert_eq!(loaded.overlays.display_length, DISPLAY_LENGTH_DEFAULT);
    }

    #[test]
    fn out_of_range_prefs_are_sanitized_on_load() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            br#"{"volume":900,"overlays":{"displayLength":50}}"#,
        )
        .unwrap();
        let loaded = load_settings(dir.path());
        assert_eq!(loaded.volume, 100);
        assert_eq!(loaded.overlays.display_length, DISPLAY_LENGTH_MIN);

        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            br#"{"overlays":{"displayLength":9999}}"#,
        )
        .unwrap();
        assert_eq!(load_settings(dir.path()).overlays.display_length, DISPLAY_LENGTH_MAX);
    }

    #[test]
    fn a_non_finite_display_length_falls_back_to_the_default() {
        // json has no nan/inf literal, so this can only arrive through the
        // command boundary -- sanitize is what both paths share
        let mut settings = Settings { overlays: OverlayPrefs { display_length: f64::NAN, ..OverlayPrefs::default() }, ..Settings::default() };
        settings.sanitize();
        assert_eq!(settings.overlays.display_length, DISPLAY_LENGTH_DEFAULT);

        settings.overlays.display_length = f64::INFINITY;
        settings.sanitize();
        assert_eq!(settings.overlays.display_length, DISPLAY_LENGTH_DEFAULT);
    }
}
