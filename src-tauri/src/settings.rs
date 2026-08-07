//! the app settings file: plain json in the tauri config dir. v1 held exactly
//! one setting -- the stable-install override the spec's osu!.db lookup calls
//! for ("auto-detected from standard locations; overridable in settings").
//! v2 adds the viewer preferences that should survive a restart: playback
//! volume and the analysis-overlay toggles. playback rate stays session-only
//! (it belongs to the replay you are watching, not to the app).
//! v3 adds `recents`: the start screen's list of previously opened replays,
//! most-recent-first and capped at `MAX_RECENTS`, so a v2 file hydrates it
//! empty rather than losing the rest of the settings.
//! v4 adds `effects`: the per-effect render toggles, behind one master.
//! v5 adds the beatmap association each recents entry reopens through, so a
//! manually paired beatmap survives a restart instead of being looked up
//! again (or asked for again).
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

/// how many recently opened replays the start screen keeps
pub const MAX_RECENTS: usize = 12;

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
    /// most-recent-first, capped at `MAX_RECENTS`
    pub recents: Vec<RecentReplay>,
    pub editing: EditingPrefs,
    pub effects: EffectPrefs,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            osu_stable_path: None,
            volume: 100,
            overlays: OverlayPrefs::default(),
            recents: Vec::new(),
            editing: EditingPrefs::default(),
            effects: EffectPrefs::default(),
        }
    }
}

/// one entry in the start screen's recents list: what the card renders, plus
/// the beatmap association `commands::load_recent_replay` reopens through.
/// every association field hydrates absent, so an entry written before they
/// existed simply reopens the way it always did (the osu! stable lookup)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RecentReplay {
    pub osr_path: String,
    pub title: String,
    pub version: String,
    pub player_name: Option<String>,
    /// 0-1
    pub accuracy: f64,
    pub max_combo: u32,
    /// unix milliseconds, for the relative "2h ago" label
    pub opened_at_ms: i64,
    /// the beatmap source the last open resolved: a picked `.osu`/`.osz`, or
    /// the `.osu` the stable lookup found
    pub beatmap_path: Option<String>,
    /// the folder that source sits in. always a real directory that outlives
    /// the session -- never an `.osz` extraction lease, which is deleted the
    /// moment its scene is replaced (`cache::CacheLease`)
    pub beatmap_dir: Option<String>,
    /// the hash of the beatmap actually loaded, which is the replay's own
    /// unless the user overrode a mismatch
    pub beatmap_md5: Option<String>,
    /// the user's recorded consent to loading this replay against a beatmap
    /// that is not the one it was played on. it belongs to `beatmap_md5`, not
    /// to the path: content that no longer hashes to it never inherits it
    pub allow_mismatch: bool,
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

/// the (future) replay-editing surface's preferences. kept separate from
/// `OverlayPrefs` -- these are not analysis overlays, they govern how frame
/// edits behave once the replay-document ipc lands
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EditingPrefs {
    pub snap_to_lattice: bool,
    pub warn_on_overwrite: bool,
}

impl Default for EditingPrefs {
    fn default() -> EditingPrefs {
        EditingPrefs {
            snap_to_lattice: true,
            warn_on_overwrite: true,
        }
    }
}

/// the renderer's per-effect toggles. `enabled` is the master: an effect is
/// live only when the master and its own flag are both on, so switching the
/// master off hides everything without erasing what the user chose
/// underneath it. everything ships on -- the defaults are the full-fat look
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EffectPrefs {
    pub enabled: bool,
    pub hit_animations: bool,
    pub hit_effects: bool,
    pub cursor_glow: bool,
    pub cursor_trail: bool,
    pub follow_points: bool,
}

impl Default for EffectPrefs {
    fn default() -> EffectPrefs {
        EffectPrefs {
            enabled: true,
            hit_animations: true,
            hit_effects: true,
            cursor_glow: true,
            cursor_trail: true,
            follow_points: true,
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
        self.recents.truncate(MAX_RECENTS);
        for recent in &mut self.recents {
            recent.accuracy = if recent.accuracy.is_finite() {
                recent.accuracy.clamp(0.0, 1.0)
            } else {
                0.0
            };
        }
    }

    /// most recent first, one entry per path. re-opening a replay moves it to
    /// the front rather than adding a duplicate
    pub fn push_recent(&mut self, entry: RecentReplay) {
        self.recents.retain(|r| r.osr_path != entry.osr_path);
        self.recents.insert(0, entry);
        self.recents.truncate(MAX_RECENTS);
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
            recents: Vec::new(),
            editing: EditingPrefs::default(),
            effects: EffectPrefs {
                enabled: true,
                hit_animations: false,
                hit_effects: true,
                cursor_glow: false,
                cursor_trail: true,
                follow_points: false,
            },
        }
    }

    fn recent(path: &str, opened_at_ms: i64) -> RecentReplay {
        RecentReplay {
            osr_path: path.to_string(),
            title: "Title".into(),
            version: "Insane".into(),
            player_name: Some("adminuser".into()),
            accuracy: 0.5,
            max_combo: 300,
            opened_at_ms,
            beatmap_path: Some(r"D:\games\osu!\Songs\1 fixture\map.osu".into()),
            beatmap_dir: Some(r"D:\games\osu!\Songs\1 fixture".into()),
            beatmap_md5: Some("d41d8cd98f00b204e9800998ecf8427e".into()),
            allow_mismatch: false,
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
        assert!(settings.editing.snap_to_lattice, "snapping ships enabled");
        assert!(settings.editing.warn_on_overwrite, "the overwrite warning ships enabled");
        assert_eq!(
            settings.effects,
            EffectPrefs {
                enabled: true,
                hit_animations: true,
                hit_effects: true,
                cursor_glow: true,
                cursor_trail: true,
                follow_points: true,
            },
            "every effect ships enabled, master included"
        );
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
                "recents": [],
                "editing": { "snapToLattice": true, "warnOnOverwrite": true },
                "effects": {
                    "enabled": true,
                    "hitAnimations": false,
                    "hitEffects": true,
                    "cursorGlow": false,
                    "cursorTrail": true,
                    "followPoints": false,
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
                "recents": [],
                "editing": { "snapToLattice": true, "warnOnOverwrite": true },
                "effects": {
                    "enabled": true,
                    "hitAnimations": true,
                    "hitEffects": true,
                    "cursorGlow": true,
                    "cursorTrail": true,
                    "followPoints": true,
                },
            })
        );
    }

    #[test]
    fn recents_serialize_with_camel_case_keys() {
        let mut settings = Settings::default();
        settings.push_recent(recent(r"C:\a.osr", 7));
        let value = serde_json::to_value(&settings).unwrap();
        assert_eq!(
            value["recents"][0],
            json!({
                "osrPath": r"C:\a.osr",
                "title": "Title",
                "version": "Insane",
                "playerName": "adminuser",
                "accuracy": 0.5,
                "maxCombo": 300,
                "openedAtMs": 7,
                "beatmapPath": r"D:\games\osu!\Songs\1 fixture\map.osu",
                "beatmapDir": r"D:\games\osu!\Songs\1 fixture",
                "beatmapMd5": "d41d8cd98f00b204e9800998ecf8427e",
                "allowMismatch": false,
            })
        );
    }

    #[test]
    fn a_recents_entry_written_before_the_association_reopens_without_one() {
        // the four association fields are what a v4 file lacks; hydrating them
        // absent is what keeps such an entry reopening through the stable
        // lookup instead of failing to parse the whole settings file
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            br#"{"recents":[{"osrPath":"C:\\a.osr","title":"Title","maxCombo":300}]}"#,
        )
        .unwrap();

        let entry = load_settings(dir.path()).recents.remove(0);
        assert_eq!(entry.title, "Title");
        assert_eq!(entry.beatmap_path, None);
        assert_eq!(entry.beatmap_dir, None);
        assert_eq!(entry.beatmap_md5, None);
        assert!(!entry.allow_mismatch, "no stored consent means no override on reopen");
    }

    #[test]
    fn the_beatmap_association_survives_a_save_and_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        settings.push_recent(RecentReplay {
            beatmap_path: Some(r"D:\maps\set.osz".into()),
            beatmap_dir: Some(r"D:\maps".into()),
            beatmap_md5: Some("0123456789abcdef0123456789abcdef".into()),
            allow_mismatch: true,
            ..recent(r"C:\a.osr", 7)
        });
        save_settings(dir.path(), &settings).unwrap();
        assert_eq!(load_settings(dir.path()).recents, settings.recents);
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
        assert_eq!(loaded.recents, Vec::new());
        assert_eq!(loaded.editing, EditingPrefs::default());
        assert_eq!(loaded.effects, EffectPrefs::default());

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
    fn a_v2_settings_file_hydrates_an_empty_recents_list() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SETTINGS_FILE), br#"{"volume":40}"#).unwrap();
        assert_eq!(load_settings(dir.path()).recents, Vec::new());
    }

    #[test]
    fn a_legacy_file_hydrates_the_editing_prefs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SETTINGS_FILE), br#"{"volume":40}"#).unwrap();
        assert_eq!(load_settings(dir.path()).editing, EditingPrefs::default());
    }

    #[test]
    fn a_legacy_file_hydrates_the_effect_prefs_per_field() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SETTINGS_FILE), br#"{"volume":40}"#).unwrap();
        assert_eq!(load_settings(dir.path()).effects, EffectPrefs::default());

        // a partially-written effects object hydrates the rest from Default,
        // so a build that adds a sixth effect still reads a five-effect file
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            br#"{"effects":{"cursorTrail":false}}"#,
        )
        .unwrap();
        let loaded = load_settings(dir.path());
        assert!(!loaded.effects.cursor_trail);
        assert!(loaded.effects.enabled, "untouched fields keep their default");
        assert!(loaded.effects.hit_animations);
    }

    #[test]
    fn effect_prefs_survive_a_save_and_load_round_trip() {
        // the master stays on while granular flags go off: turning the master
        // off must never be what erases them, so the file has to carry both
        // halves independently
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings {
            effects: EffectPrefs { enabled: false, cursor_glow: false, ..EffectPrefs::default() },
            ..Settings::default()
        };
        save_settings(dir.path(), &settings).unwrap();
        let loaded = load_settings(dir.path());
        assert_eq!(loaded.effects, settings.effects);
        assert!(!loaded.effects.enabled);
        assert!(!loaded.effects.cursor_glow);
        assert!(loaded.effects.hit_effects, "an effect left on stays on under a disabled master");
    }

    #[test]
    fn a_recents_entry_missing_fields_still_hydrates_the_rest_of_settings() {
        // recents is user-editable too, and one hand-trimmed entry must not
        // fail serde_json::from_str for the whole file -- that would fall
        // through to unwrap_or_default() and silently drop osuStablePath,
        // volume, overlays and editing, which the next save_settings would
        // then write to disk as data loss
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            br#"{"osuStablePath":"D:\\games\\osu!","volume":42,"recents":[{"osrPath":"C:\\a.osr"}]}"#,
        )
        .unwrap();

        let loaded = load_settings(dir.path());
        assert_eq!(loaded.osu_stable_path.as_deref(), Some(r"D:\games\osu!"));
        assert_eq!(loaded.volume, 42);
        assert_eq!(loaded.overlays, OverlayPrefs::default());
        assert_eq!(loaded.editing, EditingPrefs::default());
        assert_eq!(
            loaded.recents,
            vec![RecentReplay { osr_path: r"C:\a.osr".into(), ..RecentReplay::default() }]
        );
    }

    #[test]
    fn push_recent_dedupes_by_path_and_keeps_the_newest_first() {
        let mut settings = Settings::default();
        settings.push_recent(recent(r"C:\a.osr", 1));
        settings.push_recent(recent(r"C:\b.osr", 2));
        settings.push_recent(recent(r"C:\a.osr", 3));

        let paths: Vec<&str> = settings.recents.iter().map(|r| r.osr_path.as_str()).collect();
        assert_eq!(paths, vec![r"C:\a.osr", r"C:\b.osr"]);
        assert_eq!(settings.recents[0].opened_at_ms, 3);
    }

    #[test]
    fn push_recent_caps_the_list() {
        let mut settings = Settings::default();
        for i in 0..(MAX_RECENTS + 5) {
            settings.push_recent(recent(&format!("C:\\{i}.osr"), i as i64));
        }
        assert_eq!(settings.recents.len(), MAX_RECENTS);
        assert_eq!(settings.recents[0].osr_path, format!("C:\\{}.osr", MAX_RECENTS + 4));
    }

    #[test]
    fn sanitize_truncates_and_clamps_a_hand_edited_recents_list() {
        let mut settings = Settings {
            recents: (0..(MAX_RECENTS + 3)).map(|i| recent(&format!("C:\\{i}.osr"), i as i64)).collect(),
            ..Settings::default()
        };
        settings.recents[0].accuracy = 9.0;
        settings.sanitize();
        assert_eq!(settings.recents.len(), MAX_RECENTS);
        assert_eq!(settings.recents[0].accuracy, 1.0);
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
