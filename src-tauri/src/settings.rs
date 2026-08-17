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
//! v6 adds `timeline`: the timeline dock's per-layer visibility toggles.
//! v7 adds `keybinds`: the frontend's sparse keybind override map, stored
//! opaquely -- see `KeybindOverrides`.
//! v8 adds `audio`: the channels under the master volume, plus the audio
//! offset. `volume` itself stays exactly where it is, because it has always
//! been the master -- so a v7 file loads with the level the user set and the
//! new channels at full, which reproduces the behaviour they already had. no
//! migration.
//! v9 adds `gameplay`: the two gameplay preferences that are not render
//! effects (positional hitsound level, always-play-first-combo-break).
//!
//! every field is `#[serde(default)]` at the container level, so a v1 file --
//! or any future file written by an older build -- hydrates the new fields
//! from `Default` instead of failing to parse and losing the stable path.
//! values are additionally range-checked on load: the file is user-editable,
//! and a hand-typed volume of 900 must not reach the audio element

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Deserializer, Serialize};

pub const SETTINGS_FILE: &str = "settings.json";

/// inclusive bounds for `OverlayPrefs::display_length`, mirroring lazer's
/// ReplayAnalysisDisplayLength setting range (osurulesetconfigmanager.cs:27-31)
pub const DISPLAY_LENGTH_MIN: f64 = 200.0;
pub const DISPLAY_LENGTH_MAX: f64 = 2000.0;
pub const DISPLAY_LENGTH_DEFAULT: f64 = 800.0;

/// the playfield grid's allowed spacings in osu!px, `0` meaning off -- the
/// four sizes osu!'s own beatmap editor offers. anything else in the file is
/// a hand edit or a newer build's value, and falls back to off
pub const GRID_SPACINGS: [u32; 5] = [0, 4, 8, 16, 32];

/// the beatmap background's black scrim, percent; 100 is fully black,
/// matching osu!'s own dim control. the default is what the viewer drew
/// hardcoded before the control existed
pub const BACKGROUND_DIM_MAX: u32 = 100;
pub const BACKGROUND_DIM_DEFAULT: u32 = 70;

/// inclusive bounds for `AudioPrefs::offset_ms`, mirroring lazer's own
/// AudioOffset setting range (OsuConfigManager.cs:109)
pub const AUDIO_OFFSET_MIN: f64 = -500.0;
pub const AUDIO_OFFSET_MAX: f64 = 500.0;

/// how many recently opened replays the list keeps.
///
/// this also bounds how long a beatmap association lives: every open resolves
/// through the association stored on the `.osr`'s entry, and the entry is
/// evicted here, so a hand-paired beatmap (and a recorded mismatch consent) is
/// forgotten once this many *other* replays have been opened since. deliberate
/// for now -- TODO.md tracks it beside the other association-repair gap -- but
/// it is a cap on a *pairing*, not only on a list, which is why it says so here
pub const MAX_RECENTS: usize = 12;

/// the defensive caps on the keybind override map. the frontend owns what an
/// action is and what a binding looks like; these are structural bounds, the
/// same posture every other pref gets, and nothing more
pub const MAX_KEYBIND_ACTIONS: usize = 64;
pub const MAX_KEYBIND_BINDINGS: usize = 4;
pub const MAX_KEYBIND_STRING: usize = 64;

/// the frontend's sparse keybind overrides: action -> its binding slots, only
/// for actions the user actually changed.
///
/// stored opaquely on purpose. this crate knows neither the action vocabulary
/// nor the uniqueness rule and should not learn them: an override written by a
/// newer build has to survive a downgrade rather than being scrubbed on first
/// load by a validator that merely does not recognise it yet, which is why the
/// bindings stay `serde_json::Value` instead of a mirrored struct
pub type KeybindOverrides = BTreeMap<String, Vec<serde_json::Value>>;

/// a hand edit -- or a newer build's shape -- must never fail the whole
/// settings parse and take the stable path down with it. anything that is not
/// an action mapped to a list of bindings is dropped entry by entry; what is
/// left travels untouched
fn lenient_keybinds<'de, D: Deserializer<'de>>(deserializer: D) -> Result<KeybindOverrides, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    let serde_json::Value::Object(map) = value else {
        return Ok(KeybindOverrides::new());
    };
    Ok(map
        .into_iter()
        .filter_map(|(action, bindings)| match bindings {
            serde_json::Value::Array(items) => Some((action, items)),
            _ => None,
        })
        .collect())
}

/// true when every string inside a stored binding is within the cap, keys of
/// nested objects included
fn keybind_strings_within_cap(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(s) => s.len() <= MAX_KEYBIND_STRING,
        serde_json::Value::Array(items) => items.iter().all(keybind_strings_within_cap),
        serde_json::Value::Object(fields) => fields
            .iter()
            .all(|(key, field)| key.len() <= MAX_KEYBIND_STRING && keybind_strings_within_cap(field)),
        _ => true,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// the directory holding osu!.db; None means auto-detect from the
    /// standard install locations
    pub osu_stable_path: Option<String>,
    /// the MASTER volume: linear amplitude percent, 0-100. linear because
    /// osu-framework applies its aggregate volume straight to the bass channel
    /// volume (TrackBass.cs:371), so a linear slider is the osu!-matching one.
    /// it keeps this top-level key -- which is where it has always been, and
    /// what it has always behaved as -- so a settings file written before the
    /// other channels existed loads with its level intact and no migration
    pub volume: u32,
    /// the channels under the master, plus the rest of the audio category
    pub audio: AudioPrefs,
    /// gameplay preferences that are not render effects: how far hit samples
    /// are panned, and whether the play's first combo break always sounds
    pub gameplay: GameplayPrefs,
    pub overlays: OverlayPrefs,
    /// most-recent-first, capped at `MAX_RECENTS`
    pub recents: Vec<RecentReplay>,
    pub editing: EditingPrefs,
    pub effects: EffectPrefs,
    pub timeline: TimelinePrefs,
    /// sparse: only the actions the user actually rebound. an absent action
    /// keeps following the frontend's own default, which is what lets a later
    /// improvement to a default reach someone who has opened this surface
    #[serde(deserialize_with = "lenient_keybinds")]
    pub keybinds: KeybindOverrides,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            osu_stable_path: None,
            volume: 100,
            audio: AudioPrefs::default(),
            gameplay: GameplayPrefs::default(),
            overlays: OverlayPrefs::default(),
            recents: Vec::new(),
            editing: EditingPrefs::default(),
            effects: EffectPrefs::default(),
            timeline: TimelinePrefs::default(),
            keybinds: KeybindOverrides::new(),
        }
    }
}

/// the audio category's own preferences: the two channels under the master
/// (`Settings::volume`), which stays where it has always been. effective gain
/// is master x channel and zero anywhere is the mute, so a fresh install
/// starts both at full and the master alone governs
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioPrefs {
    /// linear amplitude percent, 0-100, on the same terms as the master
    pub music_volume: u32,
    pub hitsound_volume: u32,
    /// the global audio offset in milliseconds, matching lazer's own setting
    /// exactly: default 0, range -500..500, step 1
    /// (OsuConfigManager.cs:109). positive moves the playfield, judgements and
    /// hit samples ahead of the music
    pub offset_ms: f64,
    /// lazer's `BeatmapHitsounds` (beatmapskinprovidingcontainer.cs:26),
    /// inverted so the stored default is `false`. drops the beatmap's own
    /// sample FILES from the lookup chain; the map's design -- which bank each
    /// object draws from, which additions fire, per-object volume -- is object
    /// data and keeps applying
    pub ignore_beatmap_hitsounds: bool,
}

impl Default for AudioPrefs {
    fn default() -> AudioPrefs {
        AudioPrefs {
            music_volume: 100,
            hitsound_volume: 100,
            offset_ms: 0.0,
            ignore_beatmap_hitsounds: false,
        }
    }
}

/// gameplay preferences that are not render effects. they persist beside the
/// effects rather than with the volumes because that is lazer's own split:
/// `Sections/Gameplay/AudioSettings` holds these two while `Sections/Audio`
/// holds the levels and the offset. this is where they are STORED, not where
/// they are shown -- the viewer renders both in its audio category, and the
/// keys were left here so no settings file needs migrating (the reasoning is
/// at `src/components/settings/AudioCategory.tsx`)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GameplayPrefs {
    /// osuconfigmanager.cs:144 PositionalHitsoundsLevel, 0-1, default 0.2 --
    /// how far a hit sample is panned toward its object's side of the
    /// playfield
    pub positional_hitsound_level: f64,
    /// comboeffects.cs:59 -- whether the play's FIRST combo break sounds even
    /// when the combo lost was small. lazer defaults it on
    pub always_play_first_combo_break: bool,
}

impl Default for GameplayPrefs {
    fn default() -> GameplayPrefs {
        GameplayPrefs {
            positional_hitsound_level: 0.2,
            always_play_first_combo_break: true,
        }
    }
}

/// one entry in the recents list: what the card renders, plus the beatmap
/// association every open resolves through (`commands::saved_beatmap`). the
/// association belongs to the `.osr`, not to this entry -- the entry is only
/// where it is stored (docs/adr/0005). every association field hydrates absent,
/// so an entry written before they existed simply opens the way it always did
/// (the osu! stable lookup)
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
    /// darkens idle (no-button) frame markers so they read against the cursor
    /// path -- this viewer's own pref with no lazer counterpart (lazer's
    /// framemarker.cs paints them path-pink), so it ships off
    pub tint_idle_markers: bool,
    pub hide_cursor: bool,
    pub key_overlay: bool,
    /// ms of replay either side of `now` the analysis overlays cover
    pub display_length: f64,
    /// the playfield grid's spacing in osu!px, one of `GRID_SPACINGS`, `0`
    /// meaning off. one field rather than a flag plus a size, so the setting
    /// cannot reach an incoherent state
    pub playfield_grid: u32,
}

impl Default for OverlayPrefs {
    fn default() -> OverlayPrefs {
        OverlayPrefs {
            cursor_path: false,
            click_markers: false,
            frame_markers: false,
            tint_idle_markers: false,
            hide_cursor: false,
            key_overlay: true,
            display_length: DISPLAY_LENGTH_DEFAULT,
            // off: a grid the user never asked for must not appear over their
            // replay
            playfield_grid: 0,
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
    /// percent 0-100, 100 fully black. it rides on this group for where it
    /// belongs in the settings dialog, not because `enabled` gates it -- the
    /// background dim is not an effect and applies whatever the master says
    pub background_dim: u32,
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
            background_dim: BACKGROUND_DIM_DEFAULT,
        }
    }
}

/// the timeline dock's per-layer visibility: which of the object lane's
/// decorations -- and the overview strip's severity ticks -- draw. everything
/// ships on; hiding is an opt-out for readers who find a layer noisy on
/// their maps. the selected press's extended tether is selection chrome and
/// deliberately not gated here
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TimelinePrefs {
    pub hit_window_bands: bool,
    pub tethers: bool,
    pub nested_marks: bool,
    pub severity_ticks: bool,
}

impl Default for TimelinePrefs {
    fn default() -> TimelinePrefs {
        TimelinePrefs {
            hit_window_bands: true,
            tethers: true,
            nested_marks: true,
            severity_ticks: true,
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
        self.audio.music_volume = self.audio.music_volume.min(100);
        self.audio.hitsound_volume = self.audio.hitsound_volume.min(100);
        // a hand-edited NaN would poison every time the clock computes, so it
        // falls back to no offset rather than being clamped into range
        self.audio.offset_ms = if self.audio.offset_ms.is_finite() {
            self.audio.offset_ms.clamp(AUDIO_OFFSET_MIN, AUDIO_OFFSET_MAX)
        } else {
            0.0
        };
        self.effects.background_dim = self.effects.background_dim.min(BACKGROUND_DIM_MAX);
        // a level is a 0-1 ratio; a hand-edited NaN centres everything rather
        // than poisoning the balance the samples are panned with
        let level = self.gameplay.positional_hitsound_level;
        self.gameplay.positional_hitsound_level = if level.is_finite() { level.clamp(0.0, 1.0) } else { 0.0 };
        let length = self.overlays.display_length;
        self.overlays.display_length = if length.is_finite() {
            length.clamp(DISPLAY_LENGTH_MIN, DISPLAY_LENGTH_MAX)
        } else {
            DISPLAY_LENGTH_DEFAULT
        };
        if !GRID_SPACINGS.contains(&self.overlays.playfield_grid) {
            self.overlays.playfield_grid = 0;
        }
        // the keybind caps: entry count, bindings per action, string length.
        // structure only -- whether an action exists and whether two of them
        // want the same key are the frontend's questions, answered by its own
        // fold, and a validator here would scrub what a newer build wrote
        self.keybinds.retain(|action, bindings| {
            bindings.truncate(MAX_KEYBIND_BINDINGS);
            action.len() <= MAX_KEYBIND_STRING && bindings.iter().all(keybind_strings_within_cap)
        });
        if self.keybinds.len() > MAX_KEYBIND_ACTIONS {
            // the map is ordered, so which entries survive is the same on
            // every run rather than whatever the hash happened to yield
            let kept: Vec<String> = self.keybinds.keys().take(MAX_KEYBIND_ACTIONS).cloned().collect();
            self.keybinds.retain(|action, _| kept.contains(action));
        }
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
            audio: AudioPrefs {
                music_volume: 80,
                hitsound_volume: 35,
                offset_ms: -12.0,
                ignore_beatmap_hitsounds: true,
            },
            gameplay: GameplayPrefs {
                positional_hitsound_level: 0.5,
                always_play_first_combo_break: false,
            },
            overlays: OverlayPrefs {
                cursor_path: true,
                click_markers: true,
                frame_markers: false,
                tint_idle_markers: true,
                hide_cursor: true,
                key_overlay: false,
                display_length: 1200.0,
                playfield_grid: 16,
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
                background_dim: 35,
            },
            timeline: TimelinePrefs {
                hit_window_bands: false,
                tethers: true,
                nested_marks: false,
                severity_ticks: true,
            },
            keybinds: keybinds([("selectTool", json!({ "hotkey": "К", "codes": ["KeyV"] }))]),
        }
    }

    /// one binding per named action, which is the shape every override in
    /// these tests takes
    fn keybinds<const N: usize>(entries: [(&str, serde_json::Value); N]) -> KeybindOverrides {
        entries
            .into_iter()
            .map(|(action, binding)| (action.to_string(), vec![binding]))
            .collect()
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
        assert!(
            settings.editing.warn_on_overwrite,
            "the overwrite warning ships enabled"
        );
        assert_eq!(
            settings.effects,
            EffectPrefs {
                enabled: true,
                hit_animations: true,
                hit_effects: true,
                cursor_glow: true,
                cursor_trail: true,
                follow_points: true,
                background_dim: BACKGROUND_DIM_DEFAULT,
            },
            "every effect ships enabled, master included"
        );
        assert_eq!(
            settings.timeline,
            TimelinePrefs {
                hit_window_bands: true,
                tethers: true,
                nested_marks: true,
                severity_ticks: true,
            },
            "every timeline layer ships visible"
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
                "audio": {
                    "musicVolume": 80,
                    "hitsoundVolume": 35,
                    "offsetMs": -12.0,
                    "ignoreBeatmapHitsounds": true,
                },
                "gameplay": { "positionalHitsoundLevel": 0.5, "alwaysPlayFirstComboBreak": false },
                "overlays": {
                    "cursorPath": true,
                    "clickMarkers": true,
                    "frameMarkers": false,
                    "tintIdleMarkers": true,
                    "hideCursor": true,
                    "keyOverlay": false,
                    "displayLength": 1200.0,
                    "playfieldGrid": 16,
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
                    "backgroundDim": 35,
                },
                "timeline": {
                    "hitWindowBands": false,
                    "tethers": true,
                    "nestedMarks": false,
                    "severityTicks": true,
                },
                "keybinds": { "selectTool": [{ "hotkey": "К", "codes": ["KeyV"] }] },
            })
        );

        assert_eq!(
            serde_json::to_value(Settings::default()).unwrap(),
            json!({
                "osuStablePath": null,
                "volume": 100,
                "audio": {
                    "musicVolume": 100,
                    "hitsoundVolume": 100,
                    "offsetMs": 0.0,
                    "ignoreBeatmapHitsounds": false,
                },
                "gameplay": { "positionalHitsoundLevel": 0.2, "alwaysPlayFirstComboBreak": true },
                "overlays": {
                    "cursorPath": false,
                    "clickMarkers": false,
                    "frameMarkers": false,
                    "tintIdleMarkers": false,
                    "hideCursor": false,
                    "keyOverlay": true,
                    "displayLength": 800.0,
                    "playfieldGrid": 0,
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
                    "backgroundDim": 70,
                },
                "timeline": {
                    "hitWindowBands": true,
                    "tethers": true,
                    "nestedMarks": true,
                    "severityTicks": true,
                },
                "keybinds": {},
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
        assert!(
            !entry.allow_mismatch,
            "no stored consent means no override on reopen"
        );
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
        assert_eq!(loaded.timeline, TimelinePrefs::default());
        assert_eq!(loaded.keybinds, KeybindOverrides::new());

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
    fn a_file_holding_only_the_old_volume_key_keeps_its_level_and_defaults_the_channels() {
        // the whole no-migration claim in one test: `volume` has always been
        // the master, so a settings file written before the channels existed
        // must load with the user's level untouched and the two new channels
        // at full -- which reproduces exactly the behaviour they had
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SETTINGS_FILE), br#"{"volume":40}"#).unwrap();
        let loaded = load_settings(dir.path());
        assert_eq!(loaded.volume, 40);
        assert_eq!(loaded.audio, AudioPrefs::default());
    }

    #[test]
    fn hand_edited_channel_volumes_are_clamped_on_load() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            br#"{"audio":{"musicVolume":900,"hitsoundVolume":101}}"#,
        )
        .unwrap();
        let loaded = load_settings(dir.path());
        assert_eq!(loaded.audio.music_volume, 100);
        assert_eq!(loaded.audio.hitsound_volume, 100);
    }

    #[test]
    fn a_hand_edited_audio_offset_is_clamped_and_a_non_finite_one_falls_back_to_zero() {
        let dir = tempfile::tempdir().unwrap();
        for (written, expected) in [(r#"9000"#, AUDIO_OFFSET_MAX), (r#"-9000"#, AUDIO_OFFSET_MIN)] {
            std::fs::write(
                dir.path().join(SETTINGS_FILE),
                format!(r#"{{"audio":{{"offsetMs":{written}}}}}"#).as_bytes(),
            )
            .unwrap();
            assert_eq!(load_settings(dir.path()).audio.offset_ms, expected);
        }

        // a NaN would poison every time the clock computes from it, so unlike
        // the volumes it falls back to no offset rather than to a bound --
        // neither bound is a neutral value (same rule as display length)
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            br#"{"audio":{"offsetMs":null}}"#,
        )
        .unwrap();
        assert_eq!(load_settings(dir.path()).audio.offset_ms, 0.0);
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
    fn a_legacy_file_hydrates_the_timeline_prefs_per_field() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SETTINGS_FILE), br#"{"volume":40}"#).unwrap();
        assert_eq!(load_settings(dir.path()).timeline, TimelinePrefs::default());

        // a partially-written timeline object hydrates the rest from Default
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            br#"{"timeline":{"tethers":false}}"#,
        )
        .unwrap();
        let loaded = load_settings(dir.path());
        assert!(!loaded.timeline.tethers);
        assert!(
            loaded.timeline.hit_window_bands,
            "untouched fields keep their default"
        );
        assert!(loaded.timeline.severity_ticks);
    }

    #[test]
    fn effect_prefs_survive_a_save_and_load_round_trip() {
        // the master stays on while granular flags go off: turning the master
        // off must never be what erases them, so the file has to carry both
        // halves independently
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings {
            effects: EffectPrefs {
                enabled: false,
                cursor_glow: false,
                ..EffectPrefs::default()
            },
            ..Settings::default()
        };
        save_settings(dir.path(), &settings).unwrap();
        let loaded = load_settings(dir.path());
        assert_eq!(loaded.effects, settings.effects);
        assert!(!loaded.effects.enabled);
        assert!(!loaded.effects.cursor_glow);
        assert!(
            loaded.effects.hit_effects,
            "an effect left on stays on under a disabled master"
        );
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
            vec![RecentReplay {
                osr_path: r"C:\a.osr".into(),
                ..RecentReplay::default()
            }]
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
        assert_eq!(
            settings.recents[0].osr_path,
            format!("C:\\{}.osr", MAX_RECENTS + 4)
        );
    }

    #[test]
    fn sanitize_truncates_and_clamps_a_hand_edited_recents_list() {
        let mut settings = Settings {
            recents: (0..(MAX_RECENTS + 3))
                .map(|i| recent(&format!("C:\\{i}.osr"), i as i64))
                .collect(),
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
        assert_eq!(
            load_settings(dir.path()).overlays.display_length,
            DISPLAY_LENGTH_MAX
        );
    }

    #[test]
    fn a_playfield_grid_spacing_outside_the_allowed_set_falls_back_to_off() {
        // same shape as the non-finite display length above: an unrecognised
        // value is a hand edit or a newer build's, and off is the inert answer
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            br#"{"overlays":{"playfieldGrid":24}}"#,
        )
        .unwrap();
        assert_eq!(load_settings(dir.path()).overlays.playfield_grid, 0);

        for spacing in GRID_SPACINGS {
            let mut settings = Settings {
                overlays: OverlayPrefs {
                    playfield_grid: spacing,
                    ..OverlayPrefs::default()
                },
                ..Settings::default()
            };
            settings.sanitize();
            assert_eq!(settings.overlays.playfield_grid, spacing);
        }
    }

    #[test]
    fn a_hand_edited_background_dim_clamps_to_fully_black() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            br#"{"effects":{"backgroundDim":900}}"#,
        )
        .unwrap();
        assert_eq!(
            load_settings(dir.path()).effects.background_dim,
            BACKGROUND_DIM_MAX
        );

        // an untouched effects object keeps the default, which is what a fresh
        // install renders the background at
        std::fs::write(dir.path().join(SETTINGS_FILE), br#"{"volume":40}"#).unwrap();
        assert_eq!(
            load_settings(dir.path()).effects.background_dim,
            BACKGROUND_DIM_DEFAULT
        );
    }

    #[test]
    fn keybind_overrides_survive_a_save_and_load_round_trip() {
        // including the deliberately-unbound state: an empty binding list is
        // not the same thing as an absent action, and collapsing the two would
        // make unbinding a lie that expires at the next launch
        let dir = tempfile::tempdir().unwrap();
        let mut overrides = keybinds([("selectTool", json!({ "hotkey": "К", "codes": ["KeyV"] }))]);
        overrides.insert("eraseTool".into(), Vec::new());
        let settings = Settings {
            keybinds: overrides.clone(),
            ..Settings::default()
        };
        save_settings(dir.path(), &settings).unwrap();

        let loaded = load_settings(dir.path());
        assert_eq!(loaded.keybinds, overrides);
        assert_eq!(
            loaded.keybinds.get("eraseTool").map(Vec::len),
            Some(0),
            "an unbind comes back as an unbind, not as an absent action"
        );
        assert!(!loaded.keybinds.contains_key("moveTool"));
    }

    #[test]
    fn a_legacy_file_hydrates_an_empty_keybind_map() {
        // a v6 file has no keybinds at all; the stable path and every other
        // pref must survive it, and nothing may come up rebound
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            br#"{"osuStablePath":"D:\\games\\osu!","volume":40}"#,
        )
        .unwrap();
        let loaded = load_settings(dir.path());
        assert_eq!(loaded.osu_stable_path.as_deref(), Some(r"D:\games\osu!"));
        assert_eq!(loaded.volume, 40);
        assert_eq!(loaded.keybinds, KeybindOverrides::new());
    }

    #[test]
    fn an_override_this_build_does_not_recognise_survives_untouched() {
        // the whole reason the map is opaque: a downgrade must not scrub what a
        // newer build wrote, so neither the action name nor the fields of a
        // binding are validated here
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            br#"{"keybinds":{"someFutureAction":[{"hotkey":"Mod+J","codes":["KeyJ"],"seq":["G","G"]}]}}"#,
        )
        .unwrap();
        let loaded = load_settings(dir.path());
        assert_eq!(
            loaded.keybinds.get("someFutureAction").unwrap()[0],
            json!({ "hotkey": "Mod+J", "codes": ["KeyJ"], "seq": ["G", "G"] })
        );
    }

    #[test]
    fn a_hand_edited_keybind_map_is_clamped_to_its_structural_caps() {
        let mut settings = Settings {
            keybinds: (0..(MAX_KEYBIND_ACTIONS + 5))
                .map(|i| (format!("action{i:03}"), vec![json!({ "hotkey": "J" })]))
                .collect(),
            ..Settings::default()
        };
        settings.keybinds.insert(
            "tooManyBindings".into(),
            (0..(MAX_KEYBIND_BINDINGS + 3))
                .map(|i| json!({ "hotkey": format!("F{i}") }))
                .collect(),
        );
        settings.keybinds.insert(
            "tooLong".into(),
            vec![json!({ "hotkey": "x".repeat(MAX_KEYBIND_STRING + 1) })],
        );
        settings
            .keybinds
            .insert("k".repeat(MAX_KEYBIND_STRING + 1), vec![json!({ "hotkey": "J" })]);
        settings.sanitize();

        assert_eq!(settings.keybinds.len(), MAX_KEYBIND_ACTIONS);
        assert!(!settings.keybinds.contains_key("tooLong"));
        assert!(!settings
            .keybinds
            .contains_key(&"k".repeat(MAX_KEYBIND_STRING + 1)));
        // the caps are deterministic: the same file always clamps the same way
        let mut again = Settings {
            keybinds: settings.keybinds.clone(),
            ..Settings::default()
        };
        again.sanitize();
        assert_eq!(again.keybinds, settings.keybinds);
    }

    #[test]
    fn a_bindings_list_is_capped_without_losing_the_action() {
        let mut settings = Settings {
            keybinds: [(
                "selectTool".to_string(),
                (0..(MAX_KEYBIND_BINDINGS + 3))
                    .map(|i| json!({ "hotkey": format!("F{i}") }))
                    .collect(),
            )]
            .into_iter()
            .collect(),
            ..Settings::default()
        };
        settings.sanitize();
        assert_eq!(
            settings.keybinds.get("selectTool").map(Vec::len),
            Some(MAX_KEYBIND_BINDINGS)
        );
    }

    #[test]
    fn a_keybind_map_of_the_wrong_shape_does_not_lose_the_rest_of_settings() {
        // the same failure mode the recents test guards: one hand-edited
        // branch must not fail serde_json::from_str for the whole file and
        // silently drop the stable path on the next save
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            br#"{"osuStablePath":"D:\\games\\osu!","keybinds":"nope"}"#,
        )
        .unwrap();
        assert_eq!(
            load_settings(dir.path()).osu_stable_path.as_deref(),
            Some(r"D:\games\osu!")
        );

        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            br#"{"volume":42,"keybinds":{"selectTool":"K","moveTool":[{"hotkey":"N"}]}}"#,
        )
        .unwrap();
        let loaded = load_settings(dir.path());
        assert_eq!(loaded.volume, 42);
        assert!(
            !loaded.keybinds.contains_key("selectTool"),
            "an action mapped to something that is not a list of bindings is dropped"
        );
        assert_eq!(loaded.keybinds.get("moveTool").unwrap()[0], json!({ "hotkey": "N" }));
    }

    #[test]
    fn a_non_finite_display_length_falls_back_to_the_default() {
        // json has no nan/inf literal, so this can only arrive through the
        // command boundary -- sanitize is what both paths share
        let mut settings = Settings {
            overlays: OverlayPrefs {
                display_length: f64::NAN,
                ..OverlayPrefs::default()
            },
            ..Settings::default()
        };
        settings.sanitize();
        assert_eq!(settings.overlays.display_length, DISPLAY_LENGTH_DEFAULT);

        settings.overlays.display_length = f64::INFINITY;
        settings.sanitize();
        assert_eq!(settings.overlays.display_length, DISPLAY_LENGTH_DEFAULT);
    }
}
