//! skin discovery and loading: finding the skins a user already has, and
//! turning one into a **manifest** the frontend resolves lookups against.
//!
//! three places supply skins and only one of them copies. the detected stable
//! install's `Skins` folder is enumerated in place (that is where a real user's
//! skins already are, in quantity) and a directly-picked folder is read in
//! place too; only an `.osk` import copies, because an archive has nowhere else
//! to be read from (see [`crate::osk`]).
//!
//! # Two failure postures, and they differ on purpose
//!
//! A skin that no longer resolves is a **lookup miss** -- the same posture as a
//! stale beatmap association: the load falls back to the bundled default and
//! says so, rather than failing. A skin that breaches a resource cap is refused
//! **whole**, with a named reason, because silently loading half a skin's
//! textures gives the user something that looks wrong with no explanation.
//!
//! # The manifest is held beside the scene, not on it
//!
//! A skin is app-wide and changes without a scene reload, which is exactly why
//! the beatmap's sample file map -- which rides the scene -- is not the model to
//! copy here. Nothing in this module touches a `LoadedScene`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use engine::formats::skin_ini::{decode_skin_ini, SkinIni};
use serde::{Deserialize, Serialize};

use crate::error::IpcError;
use crate::limits;
use crate::media::SAMPLE_EXTENSIONS;

/// the extensions a skin texture may use, in the order a lookup prefers them.
///
/// exactly what the framework's texture store registers
/// (`textureloaderstore.cs:27-28`), so a file this crate scans in is one the
/// frontend's lookup can actually ask for. the order matters when a skin ships
/// both spellings of one element
pub const TEXTURE_EXTENSIONS: [&str; 2] = ["png", "jpg"];

/// where a skin came from. shown as the picker's source badge, and the reason
/// the bundled row is a row at all rather than a "no skin selected" state
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkinSource {
    Bundled,
    Stable,
    Folder,
    Imported,
}

/// the rule set a skin's lookups and drawing obey. a property of the skin, not
/// a setting.
///
/// there are exactly two and no more: a lazer-authored `.osk` is accepted as
/// far as its legacy-named assets carry it, and introduces no third era
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkinEra {
    Lazer,
    Legacy,
}

/// the persisted selection: both the kind of location and the path.
///
/// paths are absolute for every kind, imported included. an imported skin's
/// directory could in principle be stored as a name relative to the app-owned
/// root, but a uniform absolute path means one resolution rule and one failure
/// mode -- and that failure mode is already the documented one: a locator that
/// no longer resolves is a miss that falls back to the bundled default with a
/// notice, never an error
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SkinLocator {
    /// the app's own look. no path: it ships inside the app, which is what
    /// makes "Argon" and "no skin selected" one row rather than two concepts
    Bundled,
    Stable { path: String },
    Folder { path: String },
    Imported { path: String },
}

impl Default for SkinLocator {
    fn default() -> SkinLocator {
        SkinLocator::Bundled
    }
}

impl SkinLocator {
    pub fn source(&self) -> SkinSource {
        match self {
            SkinLocator::Bundled => SkinSource::Bundled,
            SkinLocator::Stable { .. } => SkinSource::Stable,
            SkinLocator::Folder { .. } => SkinSource::Folder,
            SkinLocator::Imported { .. } => SkinSource::Imported,
        }
    }

    pub fn era(&self) -> SkinEra {
        match self {
            SkinLocator::Bundled => SkinEra::Lazer,
            _ => SkinEra::Legacy,
        }
    }

    pub fn dir(&self) -> Option<&Path> {
        match self {
            SkinLocator::Bundled => None,
            SkinLocator::Stable { path } | SkinLocator::Folder { path } | SkinLocator::Imported { path } => {
                Some(Path::new(path))
            }
        }
    }
}

/// the configuration keys this app honours, resolved through the engine's
/// fixture-pinned accessors so the parse rules live in exactly one place.
///
/// `None` means the skin did not answer, which is what makes the drawables'
/// own defaults applicable -- those defaults are cited at their draw sites, not
/// baked in here. `settings` carries the raw map beside them so a key this
/// version does not yet honour is still visible rather than dropped
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkinConfigDto {
    /// what a `LegacySetting.Version` lookup answers -- the declared version or
    /// the latest. every version fork in the drawing code compares against this
    pub version: f64,
    pub is_latest_version: bool,
    /// the DECLARED palette, empty when the skin declared none. the classic-four
    /// fallback is applied by the consumer that knows which era it is in, not
    /// here
    pub combo_colours: Vec<[u8; 4]>,
    pub slider_border: Option<[u8; 4]>,
    pub slider_track_override: Option<[u8; 4]>,
    /// `[Colours] SliderBall` -- the ball's BASE colour (legacysliderball.cs:47),
    /// which the combo accent replaces only when the tint permission is on
    pub slider_ball: Option<[u8; 4]>,
    /// `[Colours] SpinnerBackground` -- the old-style spinner background's tint
    /// (legacyoldstylespinner.cs:44), else the drawable's flat grey
    pub spinner_background: Option<[u8; 4]>,
    pub animation_framerate: Option<i32>,
    pub layered_hit_sounds: Option<bool>,
    pub allow_slider_ball_tint: Option<bool>,
    pub combo_prefix: Option<String>,
    pub combo_overlap: Option<f32>,
    pub hit_circle_prefix: Option<String>,
    pub hit_circle_overlap: Option<f32>,
    pub cursor_centre: Option<bool>,
    pub cursor_expand: Option<bool>,
    pub cursor_rotate: Option<bool>,
    pub cursor_trail_rotate: Option<bool>,
    pub hit_circle_overlay_above_number: Option<bool>,
    pub spinner_frequency_modulate: Option<bool>,
    pub spinner_no_blink: Option<bool>,
    /// every declared key/value pair as written, for anything above not yet
    /// honoured
    pub settings: BTreeMap<String, String>,
}

impl SkinConfigDto {
    fn from_ini(ini: &SkinIni) -> SkinConfigDto {
        SkinConfigDto {
            version: ini.effective_version_f64(),
            is_latest_version: ini.is_latest_version,
            combo_colours: ini.combo_colours.clone(),
            slider_border: ini.custom_colour("SliderBorder"),
            slider_track_override: ini.custom_colour("SliderTrackOverride"),
            slider_ball: ini.custom_colour("SliderBall"),
            spinner_background: ini.custom_colour("SpinnerBackground"),
            animation_framerate: ini.int_setting("AnimationFramerate"),
            layered_hit_sounds: ini.bool_setting("LayeredHitSounds"),
            allow_slider_ball_tint: ini.bool_setting("AllowSliderBallTint"),
            combo_prefix: ini.string_setting("ComboPrefix").map(str::to_owned),
            combo_overlap: ini.float_setting("ComboOverlap"),
            hit_circle_prefix: ini.string_setting("HitCirclePrefix").map(str::to_owned),
            hit_circle_overlap: ini.float_setting("HitCircleOverlap"),
            cursor_centre: ini.bool_setting("CursorCentre"),
            cursor_expand: ini.bool_setting("CursorExpand"),
            cursor_rotate: ini.bool_setting("CursorRotate"),
            cursor_trail_rotate: ini.bool_setting("CursorTrailRotate"),
            // osulegacyskintransformer.cs:308-312 -- lazer falls back to the
            // misspelled key, which real skins in the wild wrote. the fallback
            // is reproduced, the typo is not propagated onto the wire
            hit_circle_overlay_above_number: ini
                .bool_setting("HitCircleOverlayAboveNumber")
                .or_else(|| ini.bool_setting("HitCircleOverlayAboveNumer")),
            spinner_frequency_modulate: ini.bool_setting("SpinnerFrequencyModulate"),
            spinner_no_blink: ini.bool_setting("SpinnerNoBlink"),
            settings: ini.settings.clone(),
        }
    }
}

/// one row in the picker: everything shown before a skin is selected
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinEntry {
    pub locator: SkinLocator,
    /// the declared name, or the folder name when it is absent or decodes to
    /// replacement characters -- the name the user recognises anyway
    pub name: String,
    pub author: String,
    pub source: SkinSource,
    pub era: SkinEra,
    /// a named reason this skin cannot be loaded, or `None`. a refused skin
    /// still appears: silently omitting it would leave the user looking for a
    /// skin they can see on disk
    pub refusal: Option<String>,
}

/// a loaded skin: the resolved file map plus the decoded configuration.
///
/// held beside the scene rather than on it -- see the module doc
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinManifest {
    pub locator: SkinLocator,
    pub name: String,
    pub author: String,
    pub source: SkinSource,
    pub era: SkinEra,
    /// lowercased relative path (extension included, `/`-joined for a file in
    /// a subdirectory) -> absolute path. the file map, not a lookup map: which
    /// of `cursor@2x.png` and `cursor.png` answers a `cursor` lookup is an era
    /// rule, and era rules live in the frontend's lookup chain beside the
    /// sample ones. subdirectory keys are what a skin.ini prefix such as
    /// `HitCirclePrefix: Assets/default/default` resolves through -- the same
    /// full-relative-path keying lazer's own store uses
    /// (RealmBackedResourceStore.cs:48-59).
    ///
    /// the key is UNICODE-lowercased, not ascii-lowercased, because the side
    /// that builds the lookup key is javascript and `String.toLowerCase` folds
    /// the whole range. an ascii-only folding here would leave a key like
    /// `Ösu-0.png` untouched while the frontend asked for `ösu-0.png`, so the
    /// skin's own file would be invisible to the chain and its `blank` entry
    /// could never match
    pub files: BTreeMap<String, String>,
    /// the file names whose image is degenerate -- 1x1 or smaller.
    ///
    /// shipping a 1x1 transparent `.png` is the standard way a skinner REMOVES
    /// an element, so this is a decision the skin made and not an absence. the
    /// chain stops at such a file either way (it exists, so the source answers),
    /// but knowing which files are blank lets the answer be `empty` rather than
    /// `found`, which is what keeps "the skin drew nothing" decidable without a
    /// canvas -- and lets a drawable skip building a sprite it would never see.
    ///
    /// dimensions are read from the image header, so a larger fully-transparent
    /// file is NOT listed here. it draws as transparent, which is visually the
    /// same thing, and detecting it would mean decoding every pixel of every
    /// asset at load time
    pub blank: Vec<String>,
    pub config: SkinConfigDto,
    /// set when the requested locator did not resolve and the bundled default
    /// answered instead -- the miss posture, surfaced rather than swallowed
    pub fell_back: Option<SkinFallback>,
}

/// why a load ended up on the bundled default instead of what was asked for
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinFallback {
    pub requested: SkinLocator,
    pub reason: String,
}

impl SkinManifest {
    /// the app's own look. no files: Argon's art is procedural and its samples
    /// are the bundled tiers the frontend already ships, so the bundled skin
    /// has nothing to resolve from disk
    pub fn bundled() -> SkinManifest {
        SkinManifest {
            locator: SkinLocator::Bundled,
            name: "Argon".to_string(),
            author: "osu!".to_string(),
            source: SkinSource::Bundled,
            era: SkinEra::Lazer,
            files: BTreeMap::new(),
            blank: Vec::new(),
            config: SkinConfigDto {
                version: 1.0,
                ..SkinConfigDto::default()
            },
            fell_back: None,
        }
    }
}

/// the raw result of walking one skin directory
#[derive(Debug)]
struct SkinScan {
    files: BTreeMap<String, PathBuf>,
    ini: SkinIni,
}

/// the display name for a skin: the declared one, unless it is absent or
/// unreadable, in which case the folder name -- which is the name the user
/// knows it by.
///
/// "unreadable" is specifically a name that decoded to replacement characters.
/// the codec decodes lossy UTF-8 with no charset guessing (a deliberate
/// decision recorded there), so a Shift-JIS skin name arrives as U+FFFD runs;
/// showing those would be worse than showing the folder
fn display_name(declared: &str, dir: &Path) -> String {
    let usable = !declared.trim().is_empty() && !declared.contains('\u{fffd}');
    if usable {
        return declared.to_string();
    }
    dir.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| declared.to_string())
}

fn skins_dir(stable_root: &Path) -> PathBuf {
    stable_root.join("Skins")
}

/// every skin directory inside a detected stable install's `Skins` folder,
/// sorted by name. a missing or unreadable `Skins` folder is an empty list,
/// not an error: a user with no stable install still gets a picker
pub fn enumerate_stable_skins(stable_root: &Path) -> Vec<SkinEntry> {
    enumerate_dir(&skins_dir(stable_root), SkinSource::Stable)
}

/// every imported skin in the app-owned directory, sorted by name
pub fn enumerate_imported_skins(skins_root: &Path) -> Vec<SkinEntry> {
    enumerate_dir(skins_root, SkinSource::Imported)
}

fn enumerate_dir(root: &Path, source: SkinSource) -> Vec<SkinEntry> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        // the import's own working directories (`.importing-*`, `.retiring-*`)
        // live in this root, and a crash can leave one behind. they are not
        // skins and must never be listed as one -- a dot prefix is the marker,
        // which also skips whatever else a platform keeps here
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .map(|entry| entry.path())
        .collect();
    dirs.sort();

    dirs.iter().map(|dir| entry_for(dir, source)).collect()
}

/// read one skin far enough to list it: its name, its author, and whether a
/// cap refuses it. the directory walk this does is the same one a load does,
/// so a refusal shows up in the picker rather than only at selection time
pub fn entry_for(dir: &Path, source: SkinSource) -> SkinEntry {
    let locator = match source {
        SkinSource::Bundled => SkinLocator::Bundled,
        SkinSource::Stable => SkinLocator::Stable {
            path: dir.to_string_lossy().into_owned(),
        },
        SkinSource::Folder => SkinLocator::Folder {
            path: dir.to_string_lossy().into_owned(),
        },
        SkinSource::Imported => SkinLocator::Imported {
            path: dir.to_string_lossy().into_owned(),
        },
    };

    match scan_skin_dir(dir) {
        Ok(scan) => SkinEntry {
            name: display_name(&scan.ini.name, dir),
            author: scan.ini.author.clone(),
            source,
            era: locator.era(),
            locator,
            refusal: None,
        },
        Err(error) => SkinEntry {
            name: display_name("", dir),
            author: String::new(),
            source,
            era: locator.era(),
            locator,
            refusal: Some(refusal_reason(&error)),
        },
    }
}

/// the picker's own wording for a refusal. a cap breach names the cap, because
/// "this skin is too large" without saying in what way is exactly the silent
/// half-load this posture exists to avoid
fn refusal_reason(error: &IpcError) -> String {
    match error {
        IpcError::ResourceLimit { cap, limit, actual } => {
            format!("exceeds {cap} (limit {limit}, actual {actual})")
        }
        IpcError::Io { message } => format!("could not be read: {message}"),
        other => format!("{other:?}"),
    }
}

/// load one skin into a manifest.
///
/// a locator that no longer resolves is a MISS, not an error: the bundled
/// default answers and the manifest records that it happened, so the surface
/// can say so. a cap breach is different and propagates -- the skin is refused
/// whole
pub fn load_skin(locator: &SkinLocator) -> Result<SkinManifest, IpcError> {
    let Some(dir) = locator.dir() else {
        return Ok(SkinManifest::bundled());
    };

    if !dir.is_dir() {
        let mut manifest = SkinManifest::bundled();
        manifest.fell_back = Some(SkinFallback {
            requested: locator.clone(),
            reason: format!("the skin folder is no longer at {}", dir.display()),
        });
        return Ok(manifest);
    }

    let scan = scan_skin_dir(dir)?;

    let blank = scan
        .files
        .iter()
        .filter(|(name, path)| {
            name.rsplit_once('.')
                .is_some_and(|(_, extension)| TEXTURE_EXTENSIONS.contains(&extension))
                && image_is_degenerate(path)
        })
        .map(|(name, _)| name.clone())
        .collect();

    Ok(SkinManifest {
        name: display_name(&scan.ini.name, dir),
        author: scan.ini.author.clone(),
        source: locator.source(),
        era: locator.era(),
        locator: locator.clone(),
        files: scan
            .files
            .into_iter()
            .map(|(name, path)| (name, path.to_string_lossy().into_owned()))
            .collect(),
        blank,
        config: SkinConfigDto::from_ini(&scan.ini),
        fell_back: None,
    })
}

/// walk a skin directory: every texture and sample file it holds, plus its
/// decoded `skin.ini`.
///
/// the walk RECURSES into subdirectories, because osu! skins are not flat by
/// format: the skin.ini prefix keys (`HitCirclePrefix: Assets/default/default`)
/// name files at depth, and both stable and lazer resolve them (lazer keys its
/// lookup on the file's full relative path -- RealmBackedResourceStore.cs:48-59).
/// a skin is untrusted third-party input, so the walk holds four properties:
///
/// - **symlinks are never followed**, files or directories. `DirEntry::file_type`
///   reports a reparse point or symlink as neither a file nor a directory, and
///   both branches additionally refuse `is_symlink`, so nothing outside the
///   canonicalized root can ever be read through it
/// - **depth and breadth are capped** (`MAX_SKIN_DIR_DEPTH`, `MAX_SKIN_DIRS`),
///   each a named refusal like every other cap, so a folder someone dropped a
///   backup into refuses loudly rather than scanning without bound
/// - **map keys are built by the walk itself** -- lowercased entry names joined
///   with `/` -- never parsed from any string the skin controls, so a `..` or an
///   absolute component cannot occur in one
/// - **dot-prefixed directories are skipped** (`.git` is common in distributed
///   skins), matching the dot-skip the skins root already applies
///
/// `validate_skin_dir` is every cap a LOAD applies, run over a directory before
/// anything else acts on it.
///
/// the `.osk` import needs this: its own budgets bound the archive (member
/// count, total and per-file bytes) but not the load-side ones (texture count,
/// animation frames, sample bytes, `skin.ini` size). without checking them
/// before the swap, an archive that passes the import and fails the load is
/// written over the user's existing same-named skin and only then refused --
/// which is the opposite of "refused WHOLE with a named reason"
pub(crate) fn validate_skin_dir(dir: &Path) -> Result<(), IpcError> {
    scan_skin_dir(dir)?;
    Ok(())
}

fn scan_skin_dir(dir: &Path) -> Result<SkinScan, IpcError> {
    scan_skin_dir_with_budgets(dir, &SkinBudgets::default())
}

/// the caps, as a parameter so the boundary tests can drive them with tiny
/// inputs -- the same shape every other capped entry point in this crate uses
#[derive(Debug, Clone)]
pub struct SkinBudgets {
    pub max_files: usize,
    pub max_bytes: u64,
    pub max_file_bytes: u64,
    pub max_textures: usize,
    pub max_animation_frames: usize,
    /// the SHARED sample budget, not a skin-only one: `MAX_SAMPLE_BYTES` spans
    /// the beatmap's own files and any skin's, so a skin and a mapset cannot
    /// each spend the whole 256 MiB. a parameter here for the same reason the
    /// rest are -- the real value is far too large to drive a boundary test
    pub max_sample_bytes: u64,
    /// deepest subdirectory nesting the walk follows below the skin root
    pub max_depth: usize,
    /// most subdirectories one walk may visit in total
    pub max_dirs: usize,
}

impl Default for SkinBudgets {
    fn default() -> SkinBudgets {
        SkinBudgets {
            max_files: limits::MAX_SKIN_FILES,
            max_bytes: limits::MAX_SKIN_BYTES,
            max_file_bytes: limits::MAX_SKIN_FILE_BYTES,
            max_textures: limits::MAX_SKIN_TEXTURES,
            max_animation_frames: limits::MAX_SKIN_ANIMATION_FRAMES,
            max_sample_bytes: engine::limits::MAX_SAMPLE_BYTES,
            max_depth: limits::MAX_SKIN_DIR_DEPTH,
            max_dirs: limits::MAX_SKIN_DIRS,
        }
    }
}

fn scan_skin_dir_with_budgets(dir: &Path, budgets: &SkinBudgets) -> Result<SkinScan, IpcError> {
    // canonicalize first: read_dir over the canonical directory yields only its
    // own entries, so the "strictly inside" property media::resolve_media_path
    // enforces for a named file holds here by construction
    let dir = dunce::canonicalize(dir).map_err(|e| IpcError::Io {
        message: format!("{}: {e}", dir.display()),
    })?;

    let mut files: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut total_bytes: u64 = 0;
    let mut texture_count: usize = 0;
    // animation frame sets, keyed on the stem with its trailing frame index
    // removed. counted per set rather than in total, because the hazard is one
    // element declaring a hundred thousand frames, not a skin holding many
    // short animations
    let mut animation_frames: BTreeMap<String, usize> = BTreeMap::new();

    // subdirectories still to visit, each carrying the key prefix its files
    // get (lowercased, `/`-joined -- built by the walk, never parsed from the
    // skin) and the raw-cased twin the case-collision tie-break compares
    struct PendingDir {
        path: PathBuf,
        lowered_prefix: String,
        raw_prefix: String,
        depth: usize,
    }
    let mut pending = vec![PendingDir {
        path: dir.clone(),
        lowered_prefix: String::new(),
        raw_prefix: String::new(),
        depth: 0,
    }];
    let mut dirs_visited: usize = 0;

    while let Some(current) = pending.pop() {
        let entries = std::fs::read_dir(&current.path).map_err(|e| IpcError::Io {
            message: format!("{}: {e}", current.path.display()),
        })?;

        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            // `file_type` does not follow links, so a symlink (or a windows
            // junction, which rust reports the same way) is neither a file nor
            // a directory here -- but the property is load-bearing enough to
            // state rather than inherit: nothing outside the canonicalized
            // root may ever be read through this walk
            if kind.is_symlink() {
                continue;
            }
            let raw_name = entry.file_name().to_string_lossy().into_owned();

            if kind.is_dir() {
                // `.git` is common in distributed skins; the dot-skip matches
                // the one the skins root already applies to working directories
                if raw_name.starts_with('.') {
                    continue;
                }
                let depth = current.depth + 1;
                if depth > budgets.max_depth {
                    return Err(limit(
                        "MAX_SKIN_DIR_DEPTH",
                        budgets.max_depth as u64,
                        depth as u64,
                    ));
                }
                dirs_visited += 1;
                if dirs_visited > budgets.max_dirs {
                    return Err(limit(
                        "MAX_SKIN_DIRS",
                        budgets.max_dirs as u64,
                        dirs_visited as u64,
                    ));
                }
                pending.push(PendingDir {
                    path: entry.path(),
                    lowered_prefix: format!("{}{}/", current.lowered_prefix, raw_name.to_lowercase()),
                    raw_prefix: format!("{}{}/", current.raw_prefix, raw_name),
                    depth,
                });
                continue;
            }
            if !kind.is_file() {
                continue;
            }

            let file_name = raw_name.to_lowercase();
            let Some((stem, extension)) = file_name.rsplit_once('.') else {
                continue;
            };
            let is_texture = TEXTURE_EXTENSIONS.contains(&extension);
            let is_sample = SAMPLE_EXTENSIONS.contains(&extension);
            // `skin.ini` is read separately below; everything else that is
            // neither a texture nor a sample (a readme, a source .psd, a
            // backup) is not part of the skin and is not charged against its
            // budget either
            if !is_texture && !is_sample {
                continue;
            }

            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            if size > budgets.max_file_bytes {
                return Err(limit("MAX_SKIN_FILE_BYTES", budgets.max_file_bytes, size));
            }
            total_bytes = total_bytes.saturating_add(size);
            if total_bytes > budgets.max_bytes {
                return Err(limit("MAX_SKIN_BYTES", budgets.max_bytes, total_bytes));
            }

            if is_texture {
                texture_count += 1;
                if texture_count > budgets.max_textures {
                    return Err(limit(
                        "MAX_SKIN_TEXTURES",
                        budgets.max_textures as u64,
                        texture_count as u64,
                    ));
                }
                // the set key carries the directory prefix: same-named
                // animations in different folders are different sets
                if let Some(set) = animation_set_name(stem) {
                    let frames = animation_frames
                        .entry(format!("{}{set}", current.lowered_prefix))
                        .or_insert(0);
                    *frames += 1;
                    if *frames > budgets.max_animation_frames {
                        return Err(limit(
                            "MAX_SKIN_ANIMATION_FRAMES",
                            budgets.max_animation_frames as u64,
                            *frames as u64,
                        ));
                    }
                }
            }

            // two files differing only in case (anywhere in their path)
            // collapse to one lookup name, and `read_dir`'s order is
            // filesystem-defined -- without a tie-break the same folder could
            // answer with a different file on a later run. the raw relative
            // path decides, as `media`'s sample resolution decides its own
            let raw_relative = format!("{}{}", current.raw_prefix, raw_name);
            match files.entry(format!("{}{}", current.lowered_prefix, file_name)) {
                std::collections::btree_map::Entry::Vacant(slot) => {
                    slot.insert(entry.path());
                }
                std::collections::btree_map::Entry::Occupied(mut slot) => {
                    let incumbent = slot
                        .get()
                        .strip_prefix(&dir)
                        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
                        .unwrap_or_default();
                    if raw_relative.as_str() < incumbent.as_str() {
                        slot.insert(entry.path());
                    }
                }
            }
            if files.len() > budgets.max_files {
                return Err(limit(
                    "MAX_SKIN_FILES",
                    budgets.max_files as u64,
                    files.len() as u64,
                ));
            }
        }
    }

    // the sample half is charged against the engine's own sample budget, which
    // documents itself as spanning the beatmap's files AND any skin's -- so a
    // skin and a mapset cannot each spend the whole budget
    let sample_bytes: u64 = files
        .iter()
        .filter(|(name, _)| {
            name.rsplit_once('.')
                .is_some_and(|(_, extension)| SAMPLE_EXTENSIONS.contains(&extension))
        })
        .map(|(_, path)| std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0))
        .fold(0u64, |sum, size| sum.saturating_add(size));
    if sample_bytes > budgets.max_sample_bytes {
        return Err(limit("MAX_SAMPLE_BYTES", budgets.max_sample_bytes, sample_bytes));
    }

    let ini = read_skin_ini(&dir)?;
    Ok(SkinScan { files, ini })
}

/// a skin with no `skin.ini` still loads -- and it does NOT load as one that
/// declared nothing. an absent file resolves to the latest version, while a
/// present file with no `Version` key resolves to `1.0`; the two fork real
/// drawing behaviour, which is why the engine exposes both entry points
fn read_skin_ini(dir: &Path) -> Result<SkinIni, IpcError> {
    // the file name is matched case-insensitively: osu! itself does, and
    // `Skin.ini` is common enough in the wild that treating it as absent would
    // silently drop a skin's whole configuration
    let Some(path) = find_case_insensitive(dir, "skin.ini") else {
        return Ok(SkinIni::without_file());
    };

    // read through the crate's capped reader rather than a declared-length
    // check plus an unbounded `read`: the two steps are not atomic, so a file
    // that grows between them would outrun the cap it was just measured
    // against. `read_file_capped` re-checks after a `take(cap + 1)` read, which
    // is the same three-step shape the media path uses
    let bytes = crate::media::read_file_capped(
        &path,
        engine::limits::MAX_SKIN_INI_BYTES,
        "MAX_SKIN_INI_BYTES",
    )?;
    Ok(decode_skin_ini(&bytes)?)
}

/// whether an image's declared dimensions are 1x1 or smaller -- the standard
/// way a skinner removes an element.
///
/// read from the image HEADER, never by decoding: the answer is needed for
/// every texture a skin ships, and decoding thousands of assets to learn their
/// size would make selecting a skin a visible pause. an unreadable or
/// unrecognised header answers false, which is the conservative side -- the
/// file still exists, so the chain still stops there, and the only cost is a
/// sprite that draws nothing being built anyway
fn image_is_degenerate(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    // enough for a PNG's IHDR and for a JPEG's first few segments; a JPEG whose
    // frame header sits past this reads as non-degenerate, which is the same
    // conservative side
    let mut head = [0u8; 512];
    let read = {
        use std::io::Read;
        let mut filled = 0;
        loop {
            match file.read(&mut head[filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(_) => break,
            }
            if filled == head.len() {
                break;
            }
        }
        filled
    };
    let head = &head[..read];

    match image_dimensions(head) {
        Some((width, height)) => width <= 1 && height <= 1,
        None => false,
    }
}

/// `(width, height)` from a PNG or JPEG header, or `None` when the bytes are
/// neither
fn image_dimensions(head: &[u8]) -> Option<(u32, u32)> {
    const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if head.len() >= 24 && head[..8] == PNG_SIGNATURE && &head[12..16] == b"IHDR" {
        let width = u32::from_be_bytes(head[16..20].try_into().ok()?);
        let height = u32::from_be_bytes(head[20..24].try_into().ok()?);
        return Some((width, height));
    }

    // jpeg: walk the marker segments to the start-of-frame, whose payload
    // carries the dimensions at a fixed offset
    if head.len() >= 4 && head[0] == 0xFF && head[1] == 0xD8 {
        let mut cursor = 2usize;
        while cursor + 4 <= head.len() {
            if head[cursor] != 0xFF {
                cursor += 1;
                continue;
            }
            let marker = head[cursor + 1];
            // standalone markers carry no length
            if matches!(marker, 0xD8 | 0xD9 | 0xFF) || (0xD0..=0xD7).contains(&marker) {
                cursor += 2;
                continue;
            }
            let length = u16::from_be_bytes([head[cursor + 2], head[cursor + 3]]) as usize;
            let is_start_of_frame = (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
            if is_start_of_frame {
                let payload = cursor + 4;
                if payload + 5 > head.len() {
                    return None;
                }
                let height = u16::from_be_bytes([head[payload + 1], head[payload + 2]]) as u32;
                let width = u16::from_be_bytes([head[payload + 3], head[payload + 4]]) as u32;
                return Some((width, height));
            }
            cursor += 2 + length.max(2);
        }
    }

    None
}

fn find_case_insensitive(dir: &Path, wanted: &str) -> Option<PathBuf> {
    std::fs::read_dir(dir).ok()?.flatten().find_map(|entry| {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        (name == wanted && entry.file_type().is_ok_and(|kind| kind.is_file())).then(|| entry.path())
    })
}

/// the animation set a frame belongs to, or `None` for a single sprite.
///
/// osu!'s animation naming is `<element>-<frame>`, zero-indexed -- and
/// `<element><frame>` for the separator-less families, of which the slider
/// ball (`sliderb0`..`sliderb9`) is the one that matters here. an `@2x`
/// suffix sits AFTER the frame index (`followpoint-3@2x.png`), so it is
/// stripped first
fn animation_set_name(stem: &str) -> Option<String> {
    let base = stem.strip_suffix("@2x").unwrap_or(stem);
    if let Some((element, frame)) = base.rsplit_once('-') {
        if !element.is_empty() && !frame.is_empty() && frame.bytes().all(|byte| byte.is_ascii_digit()) {
            return Some(element.to_string());
        }
    }
    // the separator is not always a hyphen: the slider ball's frames are
    // `sliderb0`..`sliderb9`, which the frontend's request builder passes as an
    // EMPTY separator. charging only the hyphenated family would leave that one
    // bounded by the texture cap alone -- ten times the frame ceiling, on the
    // very element the cap's own documentation names as the hazard
    let digits = base.len() - base.bytes().rev().take_while(u8::is_ascii_digit).count();
    let (element, frame) = base.split_at(digits);
    (!element.is_empty() && !frame.is_empty()).then(|| element.to_string())
}

fn limit(cap: &str, limit: u64, actual: u64) -> IpcError {
    IpcError::ResourceLimit {
        cap: cap.to_string(),
        limit,
        actual,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, bytes: &[u8]) {
        std::fs::write(dir.join(name), bytes).unwrap();
    }

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("skin-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_folder_skin_loads_with_its_files_and_configuration() {
        let root = temp("folder-load");
        let skin = root.join("My Skin");
        std::fs::create_dir_all(&skin).unwrap();
        write(&skin, "skin.ini", b"[General]\nName: Declared\nAuthor: Someone\nVersion: 2.5\n");
        write(&skin, "cursor.png", b"x");
        write(&skin, "CURSOR@2x.PNG", b"xx");
        write(&skin, "normal-hitnormal.wav", b"xxx");
        write(&skin, "readme.txt", b"not part of the skin");

        let manifest = load_skin(&SkinLocator::Folder {
            path: skin.to_string_lossy().into_owned(),
        })
        .expect("loads");

        assert_eq!(manifest.name, "Declared");
        assert_eq!(manifest.author, "Someone");
        assert_eq!(manifest.era, SkinEra::Legacy);
        assert_eq!(manifest.source, SkinSource::Folder);
        assert_eq!(manifest.config.version, 2.5);
        // lowercased keys, and a non-asset file is not in the map
        let keys: Vec<&String> = manifest.files.keys().collect();
        assert_eq!(keys, vec!["cursor.png", "cursor@2x.png", "normal-hitnormal.wav"]);
        assert!(manifest.fell_back.is_none());
    }

    #[test]
    fn a_skin_with_no_ini_still_loads_and_is_not_the_same_as_declaring_nothing() {
        let root = temp("no-ini");
        let skin = root.join("Bare");
        std::fs::create_dir_all(&skin).unwrap();
        write(&skin, "cursor.png", b"x");

        let bare = load_skin(&SkinLocator::Folder {
            path: skin.to_string_lossy().into_owned(),
        })
        .expect("loads");
        // an absent file is the LATEST version
        assert_eq!(bare.config.version, 2.7);
        assert!(bare.config.is_latest_version);
        // ...while a present file declaring no version is the oldest
        write(&skin, "skin.ini", b"[General]\nName: Bare\n");
        let declared = load_skin(&SkinLocator::Folder {
            path: skin.to_string_lossy().into_owned(),
        })
        .expect("loads");
        assert_eq!(declared.config.version, 1.0);
        assert!(!declared.config.is_latest_version);
    }

    #[test]
    fn a_skin_ini_is_found_whatever_its_case() {
        let root = temp("ini-case");
        let skin = root.join("Cased");
        std::fs::create_dir_all(&skin).unwrap();
        write(&skin, "Skin.ini", b"[General]\nName: Cased\n");

        let manifest = load_skin(&SkinLocator::Folder {
            path: skin.to_string_lossy().into_owned(),
        })
        .expect("loads");
        assert_eq!(manifest.name, "Cased");
    }

    #[test]
    fn a_stale_locator_is_a_miss_that_falls_back_and_says_so() {
        let root = temp("stale");
        let missing = root.join("deleted-between-sessions");

        let manifest = load_skin(&SkinLocator::Stable {
            path: missing.to_string_lossy().into_owned(),
        })
        .expect("a miss is not an error");

        assert_eq!(manifest.locator, SkinLocator::Bundled);
        assert_eq!(manifest.source, SkinSource::Bundled);
        let fallback = manifest.fell_back.expect("the miss is reported");
        assert!(matches!(fallback.requested, SkinLocator::Stable { .. }));
        assert!(fallback.reason.contains("no longer"));
    }

    #[test]
    fn an_unnamed_skin_is_listed_under_its_folder_name() {
        let root = temp("unnamed");
        let skin = root.join("Rafis 2016");
        std::fs::create_dir_all(&skin).unwrap();
        write(&skin, "cursor.png", b"x");

        let entry = entry_for(&skin, SkinSource::Stable);
        assert_eq!(entry.name, "Rafis 2016");
        assert!(entry.refusal.is_none());
    }

    #[test]
    fn a_name_that_decoded_to_replacement_characters_falls_back_to_the_folder() {
        let root = temp("mojibake");
        let skin = root.join("Shift JIS Skin");
        std::fs::create_dir_all(&skin).unwrap();
        let mut ini = Vec::from(&b"[General]\nName: "[..]);
        ini.extend_from_slice(&[0x82, 0xA0, 0x82, 0xA2]);
        ini.push(b'\n');
        std::fs::write(skin.join("skin.ini"), ini).unwrap();

        assert_eq!(entry_for(&skin, SkinSource::Stable).name, "Shift JIS Skin");
    }

    #[test]
    fn stable_skins_enumerate_in_name_order() {
        let root = temp("enumerate");
        let skins = skins_dir(&root);
        for name in ["Beta", "Alpha", "Gamma"] {
            let dir = skins.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            write(&dir, "cursor.png", b"x");
        }
        // a loose file beside the skin folders is not a skin
        write(&skins, "notes.txt", b"x");

        let entries = enumerate_stable_skins(&root);
        assert_eq!(
            entries.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(),
            vec!["Alpha", "Beta", "Gamma"]
        );
        assert!(entries.iter().all(|entry| entry.source == SkinSource::Stable));
        assert!(entries.iter().all(|entry| entry.era == SkinEra::Legacy));
    }

    #[test]
    fn no_stable_install_enumerates_empty_rather_than_failing() {
        let root = temp("no-install");
        assert!(enumerate_stable_skins(&root).is_empty());
    }

    #[test]
    fn skin_file_count_cap_boundary() {
        let root = temp("cap-files");
        let skin = root.join("Many");
        std::fs::create_dir_all(&skin).unwrap();
        let budgets = SkinBudgets {
            max_files: 3,
            ..SkinBudgets::default()
        };
        for index in 0..3 {
            write(&skin, &format!("sprite{index}.png"), b"x");
        }
        assert!(scan_skin_dir_with_budgets(&skin, &budgets).is_ok());

        write(&skin, "sprite3.png", b"x");
        let error = scan_skin_dir_with_budgets(&skin, &budgets).expect_err("past the cap");
        assert!(matches!(&error, IpcError::ResourceLimit { cap, .. } if cap == "MAX_SKIN_FILES"));
    }

    #[test]
    fn skin_total_byte_cap_boundary() {
        let root = temp("cap-bytes");
        let skin = root.join("Heavy");
        std::fs::create_dir_all(&skin).unwrap();
        let budgets = SkinBudgets {
            max_bytes: 8,
            ..SkinBudgets::default()
        };
        write(&skin, "a.png", &[0u8; 4]);
        write(&skin, "b.png", &[0u8; 4]);
        assert!(scan_skin_dir_with_budgets(&skin, &budgets).is_ok());

        write(&skin, "c.png", &[0u8; 1]);
        let error = scan_skin_dir_with_budgets(&skin, &budgets).expect_err("past the cap");
        assert!(matches!(&error, IpcError::ResourceLimit { cap, .. } if cap == "MAX_SKIN_BYTES"));
    }

    #[test]
    fn skin_sample_byte_budget_boundary() {
        // MAX_SAMPLE_BYTES is SHARED with the beatmap's own files, which is why
        // a skin is charged against it at all: without this a skin and a mapset
        // could each spend the whole budget. textures are not charged here --
        // they have their own caps
        let root = temp("cap-sample-bytes");
        let skin = root.join("Loud");
        std::fs::create_dir_all(&skin).unwrap();
        let budgets = SkinBudgets {
            max_sample_bytes: 8,
            ..SkinBudgets::default()
        };
        write(&skin, "normal-hitnormal.wav", &[0u8; 4]);
        write(&skin, "normal-hitclap.wav", &[0u8; 4]);
        // a texture of any size does not touch this budget
        write(&skin, "cursor.png", &[0u8; 64]);
        assert!(scan_skin_dir_with_budgets(&skin, &budgets).is_ok());

        write(&skin, "normal-hitfinish.wav", &[0u8; 1]);
        let error = scan_skin_dir_with_budgets(&skin, &budgets).expect_err("past the cap");
        assert!(matches!(&error, IpcError::ResourceLimit { cap, .. } if cap == "MAX_SAMPLE_BYTES"));
    }

    #[test]
    fn skin_per_file_byte_cap_boundary() {
        let root = temp("cap-file-bytes");
        let skin = root.join("OneBigFile");
        std::fs::create_dir_all(&skin).unwrap();
        let budgets = SkinBudgets {
            max_file_bytes: 4,
            ..SkinBudgets::default()
        };
        write(&skin, "a.png", &[0u8; 4]);
        assert!(scan_skin_dir_with_budgets(&skin, &budgets).is_ok());

        write(&skin, "a.png", &[0u8; 5]);
        let error = scan_skin_dir_with_budgets(&skin, &budgets).expect_err("past the cap");
        assert!(matches!(&error, IpcError::ResourceLimit { cap, .. } if cap == "MAX_SKIN_FILE_BYTES"));
    }

    #[test]
    fn skin_texture_count_cap_boundary() {
        let root = temp("cap-textures");
        let skin = root.join("ManyTextures");
        std::fs::create_dir_all(&skin).unwrap();
        let budgets = SkinBudgets {
            max_textures: 2,
            ..SkinBudgets::default()
        };
        write(&skin, "a.png", b"x");
        write(&skin, "b.jpg", b"x");
        // samples do not count against the texture cap
        write(&skin, "c.wav", b"x");
        assert!(scan_skin_dir_with_budgets(&skin, &budgets).is_ok());

        write(&skin, "d.png", b"x");
        let error = scan_skin_dir_with_budgets(&skin, &budgets).expect_err("past the cap");
        assert!(matches!(&error, IpcError::ResourceLimit { cap, .. } if cap == "MAX_SKIN_TEXTURES"));
    }

    #[test]
    fn a_nested_texture_is_keyed_by_its_relative_path() {
        // the shape the fix exists for: `HitCirclePrefix: Assets/default/default`
        // names digit glyphs in a subfolder, and the frontend chain asks for
        // `assets/default/default-0` against exactly these keys
        let root = temp("nested");
        let skin = root.join("Prefixed");
        let font = skin.join("Assets").join("Default");
        std::fs::create_dir_all(&font).unwrap();
        write(&skin, "skin.ini", b"[Fonts]\nHitCirclePrefix: Assets/Default/default\n");
        write(&skin, "cursor.png", b"x");
        std::fs::write(font.join("default-0@2x.png"), b"x").unwrap();
        std::fs::write(font.join("gone.png"), blank_png()).unwrap();
        // a dot-directory is skipped whole, as the skins root already skips its
        // own working directories
        let git = skin.join(".git").join("objects");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join("aa.png"), b"not a skin file").unwrap();

        let manifest = load_skin(&SkinLocator::Folder {
            path: skin.to_string_lossy().into_owned(),
        })
        .expect("loads");

        let keys: Vec<&String> = manifest.files.keys().collect();
        assert_eq!(
            keys,
            vec![
                "assets/default/default-0@2x.png",
                "assets/default/gone.png",
                "cursor.png"
            ]
        );
        // blank detection reaches a nested file under its path key
        assert_eq!(manifest.blank, vec!["assets/default/gone.png".to_string()]);
    }

    #[test]
    fn skin_dir_depth_cap_boundary() {
        let root = temp("cap-depth");
        let skin = root.join("Deep");
        let within = skin.join("a").join("b");
        std::fs::create_dir_all(&within).unwrap();
        std::fs::write(within.join("x.png"), b"x").unwrap();
        let budgets = SkinBudgets {
            max_depth: 2,
            ..SkinBudgets::default()
        };
        assert!(scan_skin_dir_with_budgets(&skin, &budgets).is_ok());

        std::fs::create_dir_all(within.join("c")).unwrap();
        let error = scan_skin_dir_with_budgets(&skin, &budgets).expect_err("past the cap");
        assert!(matches!(&error, IpcError::ResourceLimit { cap, .. } if cap == "MAX_SKIN_DIR_DEPTH"));
    }

    #[test]
    fn skin_dir_count_cap_boundary() {
        let root = temp("cap-dirs");
        let skin = root.join("Broad");
        std::fs::create_dir_all(skin.join("a")).unwrap();
        std::fs::create_dir_all(skin.join("b")).unwrap();
        let budgets = SkinBudgets {
            max_dirs: 2,
            ..SkinBudgets::default()
        };
        assert!(scan_skin_dir_with_budgets(&skin, &budgets).is_ok());

        std::fs::create_dir_all(skin.join("c")).unwrap();
        let error = scan_skin_dir_with_budgets(&skin, &budgets).expect_err("past the cap");
        assert!(matches!(&error, IpcError::ResourceLimit { cap, .. } if cap == "MAX_SKIN_DIRS"));
    }

    #[test]
    fn a_symlink_is_never_followed() {
        let root = temp("symlink");
        let skin = root.join("Linked");
        std::fs::create_dir_all(&skin).unwrap();
        write(&skin, "cursor.png", b"x");
        // a directory OUTSIDE the skin, reachable only through links inside it
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("evil.png"), b"x").unwrap();

        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&outside, skin.join("linked")).and_then(|()| {
            std::os::windows::fs::symlink_file(outside.join("evil.png"), skin.join("evil.png"))
        });
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, skin.join("linked"))
            .and_then(|()| std::os::unix::fs::symlink(outside.join("evil.png"), skin.join("evil.png")));
        if linked.is_err() {
            // creating symlinks needs developer mode on windows; without it
            // there is nothing to exercise, and a silent pass beats a test
            // that cannot run on most machines
            return;
        }

        let scan = scan_skin_dir(&skin).expect("scans");
        let keys: Vec<&String> = scan.files.keys().collect();
        assert_eq!(keys, vec!["cursor.png"]);
    }

    #[test]
    fn the_skin_wire_types_serialize_with_the_keys_the_frontend_reads() {
        // `src/lib/scene-types.ts` says its field names are frozen by the rust
        // serialization tests. for the skin half they were not: every key here
        // rested on `rename_all` alone, so a rename would leave the frontend
        // reading `undefined` with both suites still green -- `fellBack` going
        // quiet would silently stop reporting a stale locator, and
        // `layeredHitSounds` going quiet would resurrect a hitnormal a skin
        // deliberately switched off
        let manifest = SkinManifest {
            locator: SkinLocator::Stable {
                path: r"D:\osu!\Skins\Rafis".to_string(),
            },
            name: "Rafis 2016".to_string(),
            author: "Rafis".to_string(),
            source: SkinSource::Stable,
            era: SkinEra::Legacy,
            files: BTreeMap::from([("cursor.png".to_string(), r"D:\cursor.png".to_string())]),
            blank: vec!["hit300.png".to_string()],
            config: SkinConfigDto {
                version: 2.5,
                is_latest_version: false,
                combo_colours: vec![[1, 2, 3, 255]],
                slider_border: Some([4, 5, 6, 255]),
                slider_track_override: Some([7, 8, 9, 255]),
                slider_ball: Some([2, 170, 255, 255]),
                spinner_background: Some([100, 100, 100, 255]),
                animation_framerate: Some(30),
                layered_hit_sounds: Some(false),
                allow_slider_ball_tint: Some(true),
                combo_prefix: Some("score".to_string()),
                combo_overlap: Some(-2.0),
                hit_circle_prefix: Some("default".to_string()),
                hit_circle_overlap: Some(-1.5),
                cursor_centre: Some(true),
                cursor_expand: Some(false),
                cursor_rotate: Some(true),
                cursor_trail_rotate: Some(false),
                hit_circle_overlay_above_number: Some(true),
                spinner_frequency_modulate: Some(false),
                spinner_no_blink: Some(true),
                settings: BTreeMap::from([("Custom".to_string(), "1".to_string())]),
            },
            fell_back: Some(SkinFallback {
                requested: SkinLocator::Folder {
                    path: r"C:\gone".to_string(),
                },
                reason: "no longer there".to_string(),
            }),
        };

        assert_eq!(
            serde_json::to_value(&manifest).unwrap(),
            serde_json::json!({
                "locator": { "kind": "stable", "path": r"D:\osu!\Skins\Rafis" },
                "name": "Rafis 2016",
                "author": "Rafis",
                "source": "stable",
                "era": "legacy",
                "files": { "cursor.png": r"D:\cursor.png" },
                "blank": ["hit300.png"],
                "config": {
                    "version": 2.5,
                    "isLatestVersion": false,
                    "comboColours": [[1, 2, 3, 255]],
                    "sliderBorder": [4, 5, 6, 255],
                    "sliderTrackOverride": [7, 8, 9, 255],
                    "sliderBall": [2, 170, 255, 255],
                    "spinnerBackground": [100, 100, 100, 255],
                    "animationFramerate": 30,
                    "layeredHitSounds": false,
                    "allowSliderBallTint": true,
                    "comboPrefix": "score",
                    "comboOverlap": -2.0,
                    "hitCirclePrefix": "default",
                    "hitCircleOverlap": -1.5,
                    "cursorCentre": true,
                    "cursorExpand": false,
                    "cursorRotate": true,
                    "cursorTrailRotate": false,
                    "hitCircleOverlayAboveNumber": true,
                    "spinnerFrequencyModulate": false,
                    "spinnerNoBlink": true,
                    "settings": { "Custom": "1" }
                },
                "fellBack": {
                    "requested": { "kind": "folder", "path": r"C:\gone" },
                    "reason": "no longer there"
                }
            })
        );

        // and the picker's row, whose `refusal` the ui reads directly
        let entry = SkinEntry {
            locator: SkinLocator::Bundled,
            name: "Argon".to_string(),
            author: "osu!".to_string(),
            source: SkinSource::Bundled,
            era: SkinEra::Lazer,
            refusal: None,
        };
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            serde_json::json!({
                "locator": { "kind": "bundled" },
                "name": "Argon",
                "author": "osu!",
                "source": "bundled",
                "era": "lazer",
                "refusal": null
            })
        );

        // the two enums' remaining wire strings, which nothing above reaches
        assert_eq!(serde_json::to_value(SkinSource::Folder).unwrap(), "folder");
        assert_eq!(serde_json::to_value(SkinSource::Imported).unwrap(), "imported");
    }

    #[test]
    fn the_frame_cap_covers_the_separatorless_family_too() {
        // the slider ball's frames are `sliderb0`..`sliderb9` -- no hyphen,
        // which is why the frontend's request builder passes an EMPTY
        // separator for it. charging only the hyphenated family would leave
        // this one bounded by the texture cap alone, ten times the frame
        // ceiling, on the very element the cap's documentation names
        let root = temp("cap-frames-flat");
        let skin = root.join("FlatFrames");
        std::fs::create_dir_all(&skin).unwrap();
        let budgets = SkinBudgets {
            max_animation_frames: 3,
            ..SkinBudgets::default()
        };
        for frame in 0..3 {
            write(&skin, &format!("sliderb{frame}.png"), b"x");
        }
        assert!(scan_skin_dir_with_budgets(&skin, &budgets).is_ok());

        write(&skin, "sliderb3.png", b"x");
        let error = scan_skin_dir_with_budgets(&skin, &budgets).expect_err("past the cap");
        assert!(matches!(&error, IpcError::ResourceLimit { cap, .. } if cap == "MAX_SKIN_ANIMATION_FRAMES"));
    }

    #[test]
    fn a_name_with_no_frame_index_is_not_an_animation_set() {
        // the widened rule must not turn every file into a one-frame set:
        // charging `hitcircle` against a set named `hitcircle` would be
        // harmless but wrong, and `sliderb` alone is the sprite fallback
        assert_eq!(animation_set_name("sliderb0"), Some("sliderb".to_string()));
        assert_eq!(animation_set_name("sliderb0@2x"), Some("sliderb".to_string()));
        assert_eq!(animation_set_name("followpoint-3"), Some("followpoint".to_string()));
        assert_eq!(animation_set_name("hitcircle"), None);
        assert_eq!(animation_set_name("sliderb"), None);
        // all digits and no element is not a set either
        assert_eq!(animation_set_name("0"), None);
    }

    #[test]
    fn skin_animation_frame_cap_boundary() {
        let root = temp("cap-frames");
        let skin = root.join("LongAnimation");
        std::fs::create_dir_all(&skin).unwrap();
        let budgets = SkinBudgets {
            max_animation_frames: 3,
            ..SkinBudgets::default()
        };
        for frame in 0..3 {
            write(&skin, &format!("followpoint-{frame}.png"), b"x");
        }
        // a different element's frames are counted separately -- the hazard is
        // one enormous animation, not many small ones
        write(&skin, "sliderb-0.png", b"x");
        assert!(scan_skin_dir_with_budgets(&skin, &budgets).is_ok());

        write(&skin, "followpoint-3.png", b"x");
        let error = scan_skin_dir_with_budgets(&skin, &budgets).expect_err("past the cap");
        assert!(matches!(&error, IpcError::ResourceLimit { cap, .. } if cap == "MAX_SKIN_ANIMATION_FRAMES"));
    }

    #[test]
    fn an_at_2x_frame_belongs_to_the_same_animation_set() {
        assert_eq!(animation_set_name("followpoint-3"), Some("followpoint".to_string()));
        assert_eq!(animation_set_name("followpoint-3@2x"), Some("followpoint".to_string()));
        // a single sprite is not an animation, and an element whose name ends
        // in a hyphen-word is not one either
        assert_eq!(animation_set_name("cursor"), None);
        assert_eq!(animation_set_name("cursor@2x"), None);
        assert_eq!(animation_set_name("normal-hitnormal"), None);
    }

    #[test]
    fn a_refused_skin_still_lists_with_its_named_reason() {
        let root = temp("refused-lists");
        let skin = root.join("Enormous");
        std::fs::create_dir_all(&skin).unwrap();
        let oversized = vec![0u8; (limits::MAX_SKIN_FILE_BYTES + 1) as usize];
        std::fs::write(skin.join("cursor.png"), &oversized).unwrap();

        let entry = entry_for(&skin, SkinSource::Folder);
        assert_eq!(entry.name, "Enormous");
        let refusal = entry.refusal.expect("refused");
        assert!(refusal.contains("MAX_SKIN_FILE_BYTES"), "unhelpful reason: {refusal}");
    }

    #[test]
    fn a_missing_individual_file_is_not_a_breach() {
        // the whole point of the two postures: an incomplete skin loads and
        // falls through per lookup; only a CAP refuses the skin whole
        let root = temp("incomplete");
        let skin = root.join("Incomplete");
        std::fs::create_dir_all(&skin).unwrap();
        write(&skin, "cursor.png", b"x");

        let manifest = load_skin(&SkinLocator::Folder {
            path: skin.to_string_lossy().into_owned(),
        })
        .expect("loads");
        assert_eq!(manifest.files.len(), 1);
        assert!(!manifest.files.contains_key("hitcircle.png"));
    }


    /// a 1x1 transparent png, the standard way a skinner removes an element
    fn blank_png() -> Vec<u8> {
        // signature + IHDR declaring 1x1, then a minimal IDAT/IEND. only the
        // header is read, but a real file keeps the fixture honest
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&[0, 0, 0, 13]);
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&1u32.to_be_bytes());
        bytes.extend_from_slice(&1u32.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes.extend_from_slice(&[0x1F, 0x15, 0xC4, 0x89]);
        bytes
    }

    fn sized_png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = blank_png();
        bytes[16..20].copy_from_slice(&width.to_be_bytes());
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        bytes
    }

    #[test]
    fn a_one_by_one_texture_is_listed_as_blank() {
        let root = temp("blank");
        let skin = root.join("Minimal");
        std::fs::create_dir_all(&skin).unwrap();
        std::fs::write(skin.join("hit300.png"), blank_png()).unwrap();
        std::fs::write(skin.join("hitcircle.png"), sized_png(128, 128)).unwrap();
        // a sample is never blank-checked -- silence is a decode-time property
        write(&skin, "normal-hitnormal.wav", b"x");

        let manifest = load_skin(&SkinLocator::Folder {
            path: skin.to_string_lossy().into_owned(),
        })
        .expect("loads");
        assert_eq!(manifest.blank, vec!["hit300.png".to_string()]);
    }

    #[test]
    fn a_real_vendored_asset_is_not_mistaken_for_a_blank_one() {
        // the classic floor's own art, read through the same header parse
        let cursor = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../public/skins/legacy/cursor@2x.png");
        assert!(cursor.is_file(), "the vendored floor is missing: {cursor:?}");
        assert!(!image_is_degenerate(&cursor));
    }

    #[test]
    fn image_dimensions_reads_png_and_jpeg_headers() {
        assert_eq!(image_dimensions(&sized_png(640, 480)), Some((640, 480)));
        // jpeg: SOI, an APP0 segment to skip, then a baseline SOF0
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00];
        jpeg.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        jpeg.extend_from_slice(&300u16.to_be_bytes());
        jpeg.extend_from_slice(&200u16.to_be_bytes());
        assert_eq!(image_dimensions(&jpeg), Some((200, 300)));
        // neither, and a truncated png: unreadable rather than a panic
        assert_eq!(image_dimensions(b"not an image"), None);
        assert_eq!(image_dimensions(&sized_png(1, 1)[..20]), None);
        assert_eq!(image_dimensions(&[]), None);
    }

    #[test]
    fn the_bundled_skin_needs_no_directory() {
        let manifest = load_skin(&SkinLocator::Bundled).expect("loads");
        assert_eq!(manifest.era, SkinEra::Lazer);
        assert!(manifest.files.is_empty());
        assert!(manifest.fell_back.is_none());
    }
}
