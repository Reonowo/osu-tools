//! the settings profile and per-invocation patch (spec, settings): danser
//! merges a partial settings file over its own defaults (verified against
//! the pinned binary -- a minimal profile renders correctly), so the shipped
//! profile carries ONLY the deviations the spec lists and a pin bump diffs
//! against upstream defaults trivially. the per-render values never live in
//! the profile: `OutputDir`, `OsuSkinsDir` and the frame geometry ride the
//! `-sPatch`, and the skin selection is the `-skin` cli flag.
//!
//! the dialog's danser section persists an opaque blob
//! (`settings.renderer_options["danser"]`); its `settings` key holds a
//! danser settings subtree that is merged into the patch verbatim, under the
//! per-render keys so no blob value can redirect the output or the songs
//! scan

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::video::{ResolvedRenderOptions, SkinSelection};

/// the profile's file stem under the install's `settings/` dir
pub const PROFILE_NAME: &str = "replay-viewer";

/// what `encoder: auto` falls back to when no probe winner is cached: the
/// one candidate that cannot depend on a GPU
pub const FALLBACK_ENCODER: &str = "libx264";

/// the user's encoder choice resolved against the blob's probe cache
pub fn resolve_encoder(options: &ResolvedRenderOptions) -> String {
    if options.encoder != "auto" {
        return options.encoder.clone();
    }
    options
        .renderer_options
        .get(crate::video::PROBED_ENCODER_KEY)
        .and_then(Value::as_str)
        .unwrap_or(FALLBACK_ENCODER)
        .to_string()
}

/// the shipped profile: danser defaults deviated only where required --
/// storyboard/video rendering off (never staged, and faster), no osz
/// unpacking (danser's default DELETES any .osz its scan finds), our private
/// staging songs dir, and the resolved encoder
pub fn build_profile(songs_dir: &Path, encoder: &str) -> Value {
    json!({
        "General": {
            "OsuSongsDir": songs_dir.display().to_string(),
            "UnpackOszFiles": false,
        },
        "Playfield": {
            "Background": {
                "LoadStoryboards": false,
                "LoadVideos": false,
            },
        },
        "Recording": {
            "Encoder": encoder,
        },
    })
}

/// the per-invocation patch: the blob's danser settings subtree first, our
/// per-render and safety keys merged over it -- ours win, so no blob value
/// can redirect `OutputDir` away from the job dir, the geometry away from the
/// prefs, or the songs scan away from the private staging dir
pub fn build_patch(options: &ResolvedRenderOptions, out_dir: &Path) -> Value {
    let mut patch = options
        .renderer_options
        .get("settings")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    strip_protected_aliases(&mut patch);

    let mut ours = json!({
        // the profile already sets these two, and they are reasserted here
        // because the patch outranks it: a blob carrying its own `General`
        // -- hand-edited, or left by a version whose section wrote one --
        // would otherwise point the scan at the user's osu! install, whose
        // .osz files danser's unpack DELETES. the safety keys are ours on
        // every render, never the blob's
        "General": {
            "OsuSongsDir": options.songs_dir.display().to_string(),
            "UnpackOszFiles": false,
        },
        "Recording": {
            "FrameWidth": options.width,
            "FrameHeight": options.height,
            "FPS": options.fps,
            "OutputDir": out_dir.display().to_string(),
            "Container": "mp4",
        },
    });
    if let SkinSelection::Folder { skins_dir, .. } = &options.skin {
        ours["General"]["OsuSkinsDir"] = json!(skins_dir.display().to_string());
    }
    deep_merge(&mut patch, ours);
    patch
}

/// the settings paths this app owns on every render, whatever the blob holds:
/// everything [`build_patch`] asserts AND everything [`build_profile`] does,
/// because the patch outranks the profile and a blob key left standing would
/// be the one danser read. the first two are the destructive pair -- danser
/// indexes whatever songs dir it is handed, and its unpack DELETES the `.osz`
/// files it finds there. `Encoder` is here because it is the typed core
/// pref's value resolved: letting the opaque blob shadow it would silently
/// ignore the encoder row the user set. the two `Playfield.Background` flags
/// are here because storyboards and videos are deliberately never staged, so
/// a blob re-enabling them only points danser at files that are not present.
/// `Container` is here because it is the one blob key that could make the
/// product disagree with its own NAME: danser accepts `mp4,mkv`, the save
/// dialog only ever collects an `.mp4` destination, and the orchestrator
/// moves whatever was produced to exactly that path -- so an mkv would be
/// published as an mp4 and play in nothing that trusts the extension
const PROTECTED_PATHS: &[&[&str]] = &[
    &["General", "OsuSongsDir"],
    &["General", "UnpackOszFiles"],
    &["General", "OsuSkinsDir"],
    &["Recording", "OutputDir"],
    &["Recording", "FrameWidth"],
    &["Recording", "FrameHeight"],
    &["Recording", "FPS"],
    &["Recording", "Encoder"],
    &["Recording", "Container"],
    &["Playfield", "Background", "LoadStoryboards"],
    &["Playfield", "Background", "LoadVideos"],
];

/// whether `key` is a spelling danser's decoder would bind to `target`.
///
/// go's `encoding/json` matches struct fields under UNICODE case folding,
/// not ascii's, which is why go's own fold.go special-cases two runes:
/// `unicode.SimpleFold` puts U+017F (long s) in the same class as `s`, and
/// U+212A (kelvin sign) in the same class as `k`. those are the ONLY two
/// classes that mix a non-ascii rune with an ascii letter, so folding them
/// plus ascii case makes this exact -- not merely closer -- for the ascii
/// field names danser actually has. an ascii-only comparison would leave
/// `OſuSongsDir` standing for danser to read as `OsuSongsDir`
fn folds_to(key: &str, target: &str) -> bool {
    fn fold(c: char) -> char {
        match c {
            '\u{017F}' => 's',
            '\u{212A}' => 'k',
            other => other.to_ascii_lowercase(),
        }
    }
    key.chars().map(fold).eq(target.chars().map(fold))
}

/// removes every spelling danser would bind to a protected path from the
/// blob's subtree, so that merging ours over it actually wins.
///
/// merging alone only wins for keys spelled exactly as ours are, and the two
/// spellings do NOT collide in the emitted json: `serde_json`'s map is a
/// btree here (no `preserve_order`), so `"General"` and `"general"` are two
/// separate keys and `"General"` sorts first. danser is go, and go's
/// `encoding/json` matches struct fields case-INsensitively, taking each key
/// in document order -- so the later `"general"` would overwrite the
/// `"General"` we put there to be safe. stripping every binding spelling
/// first (see [`folds_to`]) is what makes "no blob value can redirect the
/// songs scan" true rather than nearly true
fn strip_protected_aliases(blob: &mut Value) {
    for path in PROTECTED_PATHS {
        strip_alias_path(blob, path);
    }
}

fn strip_alias_path(node: &mut Value, path: &[&str]) {
    let Some((head, rest)) = path.split_first() else {
        return;
    };
    let Some(object) = node.as_object_mut() else {
        return;
    };
    let spellings: Vec<String> = object
        .keys()
        .filter(|key| folds_to(key, head))
        .cloned()
        .collect();
    for key in spellings {
        if rest.is_empty() {
            object.remove(&key);
        } else if let Some(child) = object.get_mut(&key) {
            strip_alias_path(child, rest);
        }
    }
}

/// overlays `over` onto `base`, object keys recursively, everything else by
/// replacement
fn deep_merge(base: &mut Value, over: Value) {
    match (base, over) {
        (Value::Object(base), Value::Object(over)) => {
            for (key, value) in over {
                match base.get_mut(&key) {
                    Some(slot) => deep_merge(slot, value),
                    None => {
                        base.insert(key, value);
                    }
                }
            }
        }
        (base, over) => *base = over,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn options(encoder: &str, blob: Value) -> ResolvedRenderOptions {
        ResolvedRenderOptions {
            width: 1920,
            height: 1080,
            fps: 60,
            encoder: encoder.into(),
            skin: SkinSelection::RendererDefault,
            songs_dir: PathBuf::from(r"C:\data\danser-songs"),
            renderer_options: blob,
        }
    }

    #[test]
    fn the_profile_deviates_from_danser_defaults_only_at_the_spec_listed_keys() {
        let profile = build_profile(Path::new(r"C:\data\danser-songs"), "h264_nvenc");
        assert_eq!(
            profile,
            json!({
                "General": {
                    "OsuSongsDir": r"C:\data\danser-songs",
                    "UnpackOszFiles": false,
                },
                "Playfield": {
                    "Background": { "LoadStoryboards": false, "LoadVideos": false },
                },
                "Recording": { "Encoder": "h264_nvenc" },
            }),
            "every key here is a deliberate deviation; danser fills the rest from its own defaults"
        );
    }

    #[test]
    fn auto_resolves_to_the_probe_cache_and_falls_back_to_software() {
        let probed = options("auto", json!({ "probedEncoder": "h264_nvenc" }));
        assert_eq!(resolve_encoder(&probed), "h264_nvenc");

        let unprobed = options("auto", Value::Null);
        assert_eq!(resolve_encoder(&unprobed), FALLBACK_ENCODER);

        // an explicit id wins over any cache
        let explicit = options("h264_amf", json!({ "probedEncoder": "h264_nvenc" }));
        assert_eq!(resolve_encoder(&explicit), "h264_amf");
    }

    #[test]
    fn the_patch_carries_the_per_render_keys_over_the_blobs_subtree() {
        let mut opts = options(
            "auto",
            json!({
                "settings": {
                    "Recording": {
                        "MotionBlur": { "Enabled": true },
                        // a blob trying to redirect the output loses
                        "OutputDir": r"D:\somewhere\else",
                    },
                    "Playfield": { "Background": { "Dim": { "Normal": 0.8 } } },
                },
            }),
        );
        opts.skin = SkinSelection::Folder {
            skins_dir: PathBuf::from(r"D:\osu!\Skins"),
            name: "Rafis 2016".into(),
        };

        let patch = build_patch(&opts, Path::new(r"C:\data\danser-jobs\job-1"));
        assert_eq!(patch["Recording"]["FrameWidth"], json!(1920));
        assert_eq!(patch["Recording"]["FrameHeight"], json!(1080));
        assert_eq!(patch["Recording"]["FPS"], json!(60));
        assert_eq!(
            patch["Recording"]["OutputDir"],
            json!(r"C:\data\danser-jobs\job-1"),
            "the job dir wins over anything the blob wrote"
        );
        // the blob's own controls survive beside them
        assert_eq!(patch["Recording"]["MotionBlur"]["Enabled"], json!(true));
        assert_eq!(patch["Playfield"]["Background"]["Dim"]["Normal"], json!(0.8));
        // the folder skin's parent rides the patch; the name is the cli flag
        assert_eq!(patch["General"]["OsuSkinsDir"], json!(r"D:\osu!\Skins"));
    }

    #[test]
    fn a_renderer_default_skin_leaves_the_skins_dir_untouched() {
        let opts = options("auto", Value::Null);
        let patch = build_patch(&opts, Path::new(r"C:\jobs\job-2"));
        assert_eq!(
            patch["General"].get("OsuSkinsDir"),
            None,
            "no folder skin, so danser keeps its own skins dir"
        );
    }

    #[test]
    fn a_blob_cannot_change_the_container_out_from_under_the_mp4_destination() {
        // danser's Container is `combo:"mp4,mkv"` (recording.go), the save
        // dialog only ever collects an `.mp4` path, and the orchestrator moves
        // whatever was produced to exactly that path -- so a blob winning this
        // key publishes matroska bytes under an .mp4 name
        let blob = json!({
            "settings": {
                "Recording": { "Container": "mkv" },
            },
        });
        let opts = options("auto", blob);
        let patch = build_patch(&opts, Path::new(r"C:\data\danser-jobs\job-1"));
        assert_eq!(
            patch["Recording"]["Container"],
            json!("mp4"),
            "the container the destination name promises wins over the blob"
        );

        // the spelling that actually needs PROTECTED_PATHS: an exact-key blob
        // is beaten by the merge alone, so it proves nothing about the alias
        // stripping. a DISTINCT key that Go's case-insensitive field matching
        // still binds would otherwise survive beside ours -- and neither
        // `Recording` nor `Container` holds an s or a k, so ascii case is the
        // whole alias space here
        let aliased = json!({
            "settings": {
                "recording": { "container": "mkv" },
            },
        });
        let opts = options("auto", aliased);
        let patch = build_patch(&opts, Path::new(r"C:\data\danser-jobs\job-1"));
        assert_eq!(patch["Recording"]["Container"], json!("mp4"));
        let serialized = patch.to_string();
        assert!(
            !serialized.contains("\"container\""),
            "no alias may survive beside ours for danser to bind instead: {serialized}"
        );

        // deliberately NOT added to the profile: danser's own default is
        // already mp4, so asserting it there would be a non-deviation and
        // would break the profile's "diffs cleanly against upstream defaults"
        // contract. the patch outranks the profile, so this is the layer that
        // settles it
        let profile = build_profile(Path::new(r"C:\data\danser-songs"), "libx264");
        assert_eq!(
            profile["Recording"].get("Container"),
            None,
            "the profile carries deviations only"
        );
    }

    #[test]
    fn a_hostile_blob_cannot_point_the_songs_scan_at_the_users_install() {
        // the blob is opaque and persisted, so it can hold a `General` no
        // section here ever wrote -- hand-edited, or a version skew. danser's
        // unpack DELETES the .osz files it finds, so these two keys are the
        // one thing a blob must never win
        let hostile = json!({
            "settings": {
                "General": {
                    "OsuSongsDir": r"D:\osu!\Songs",
                    "UnpackOszFiles": true,
                },
            },
        });

        // both skin shapes, because only one of them used to write `General`
        for skin in [
            SkinSelection::RendererDefault,
            SkinSelection::Folder {
                skins_dir: PathBuf::from(r"D:\osu!\Skins"),
                name: "Rafis 2016".into(),
            },
        ] {
            let mut opts = options("auto", hostile.clone());
            opts.skin = skin.clone();
            let patch = build_patch(&opts, Path::new(r"C:\data\danser-jobs\job-1"));
            assert_eq!(
                patch["General"]["OsuSongsDir"],
                json!(r"C:\data\danser-songs"),
                "the private staging dir wins over the blob ({skin:?})"
            );
            assert_eq!(
                patch["General"]["UnpackOszFiles"],
                json!(false),
                "unpacking stays off whatever the blob says ({skin:?})"
            );
        }
    }

    #[test]
    fn a_protected_key_spelled_in_another_case_is_stripped_not_merged_around() {
        // go's json decoder matches struct fields case-insensitively and lets
        // the last spelling in the document win, and "General" sorts before
        // "general" in serde_json's btree map -- so an alias left in place
        // would be the one danser actually read
        let opts = options(
            "auto",
            json!({
                "settings": {
                    "general": {
                        "osusongsdir": r"D:\osu!\Songs",
                        "unpackoszfiles": true,
                        // a key we do not own survives, in its own casing
                        "VSync": true,
                    },
                    "RECORDING": { "outputdir": r"D:\somewhere\else" },
                },
            }),
        );

        let patch = build_patch(&opts, Path::new(r"C:\data\danser-jobs\job-1"));
        let text = serde_json::to_string(&patch).unwrap();
        for alias in ["osusongsdir", "unpackoszfiles", "outputdir"] {
            assert!(
                !text.contains(alias),
                "no case-variant of a protected key may reach danser: {alias} in {text}"
            );
        }
        assert_eq!(patch["General"]["OsuSongsDir"], json!(r"C:\data\danser-songs"));
        assert_eq!(patch["General"]["UnpackOszFiles"], json!(false));
        assert_eq!(
            patch["Recording"]["OutputDir"],
            json!(r"C:\data\danser-jobs\job-1")
        );
        // stripping is surgical: an unprotected key keeps its own spelling
        assert_eq!(patch["general"]["VSync"], json!(true));
    }

    #[test]
    fn a_unicode_folded_alias_danser_would_bind_is_stripped_too() {
        // go's field matching folds by unicode, not ascii: U+017F (long s)
        // shares a fold class with 's' and U+212A (kelvin sign) with 'k', the
        // two classes go's own fold.go special-cases. an ascii-only strip
        // left these standing, and they sort AFTER the safe ascii keys
        let opts = options(
            "auto",
            json!({
                "settings": {
                    "General": {
                        "O\u{017F}uSongsDir": r"D:\osu!\Songs",
                        "Unpac\u{212A}OszFiles": true,
                    },
                },
            }),
        );

        let patch = build_patch(&opts, Path::new(r"C:\data\danser-jobs\job-1"));
        let general = patch["General"].as_object().unwrap();
        assert_eq!(
            general.len(),
            2,
            "only our two keys survive, no folded alias beside them: {general:?}"
        );
        assert_eq!(general["OsuSongsDir"], json!(r"C:\data\danser-songs"));
        assert_eq!(general["UnpackOszFiles"], json!(false));
    }

    #[test]
    fn the_profiles_own_invariants_are_protected_from_the_blob_too() {
        // the patch outranks the profile, so a key the profile asserts is only
        // safe if the blob cannot carry it: the resolved encoder is the typed
        // core pref's value, and storyboards/videos are never staged
        let opts = options(
            "h264_nvenc",
            json!({
                "settings": {
                    "Recording": { "Encoder": "libx264", "MotionBlur": { "Enabled": true } },
                    "Playfield": {
                        "Background": { "LoadStoryboards": true, "LoadVideos": true, "Blur": 0.3 },
                    },
                },
            }),
        );

        let patch = build_patch(&opts, Path::new(r"C:\data\danser-jobs\job-1"));
        assert_eq!(
            patch["Recording"].get("Encoder"),
            None,
            "stripped, so the profile's resolved encoder stands"
        );
        assert_eq!(patch["Playfield"]["Background"].get("LoadStoryboards"), None);
        assert_eq!(patch["Playfield"]["Background"].get("LoadVideos"), None);
        // and the blob's legitimate neighbours in those same sections survive
        assert_eq!(patch["Recording"]["MotionBlur"]["Enabled"], json!(true));
        assert_eq!(patch["Playfield"]["Background"]["Blur"], json!(0.3));
    }
}
