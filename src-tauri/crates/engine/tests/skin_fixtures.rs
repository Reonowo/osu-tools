//! `skin.ini` decoding against lazer's own `LegacySkinDecoder`, run through a
//! real `LegacySkin` so the two "no version declared" cases stay distinct: an
//! absent file answers `LATEST_VERSION`, a present file with no `Version` key
//! answers the decoder's `1.0` template default.
//!
//! this family pins what the CONFIGURATION says and nothing else. the
//! consumer-side defaults (`?? "default"`, `?? -2f`, `?? true`) belong to the
//! drawables that read them and are cited at their own sites; a `null` in a
//! dump's `settings` object means the skin did not answer, which is what makes
//! those defaults applicable at all.

mod fixture_util;

use std::collections::BTreeMap;

use engine::formats::skin_ini::{decode_skin_ini, latest_version, SkinIni};
use rust_decimal::Decimal;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct SkinDump {
    ini_present: bool,
    name: String,
    author: String,
    legacy_version: Option<f64>,
    effective_version: f64,
    custom_combo_colours: Vec<ColourDump>,
    combo_colours: Option<Vec<ColourDump>>,
    custom_colours: BTreeMap<String, ColourDump>,
    config_dictionary: BTreeMap<String, String>,
    settings: SettingsDump,
}

#[derive(Debug, Deserialize)]
struct ColourDump {
    r: u8,
    g: u8,
    b: u8,
    a: u8,
}

impl ColourDump {
    fn rgba(&self) -> [u8; 4] {
        [self.r, self.g, self.b, self.a]
    }
}

#[derive(Debug, Deserialize)]
struct SettingsDump {
    animation_framerate: Option<i32>,
    layered_hit_sounds: Option<bool>,
    allow_slider_ball_tint: Option<bool>,
    combo_prefix: Option<String>,
    combo_overlap: Option<f32>,
    hit_circle_prefix: Option<String>,
    hit_circle_overlap: Option<f32>,
    cursor_centre: Option<bool>,
    cursor_expand: Option<bool>,
    cursor_rotate: Option<bool>,
    cursor_trail_rotate: Option<bool>,
    hit_circle_overlay_above_number: Option<bool>,
    hit_circle_overlay_above_numer: Option<bool>,
    spinner_frequency_modulate: Option<bool>,
    spinner_no_blink: Option<bool>,
}

/// every scenario directory under `fixtures/skin/inputs/`, paired with its dump.
/// enumerated rather than listed so a scenario added to the generator cannot be
/// silently left unasserted here
fn scenarios() -> Vec<String> {
    let inputs = fixture_util::fixtures_dir().join("skin/inputs");
    let mut names: Vec<String> = std::fs::read_dir(&inputs)
        .unwrap_or_else(|e| panic!("missing skin scenario inputs {inputs:?}: {e}"))
        .map(|entry| entry.expect("readable dir entry"))
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert!(!names.is_empty(), "no skin scenarios found under {inputs:?}");
    names
}

fn decode_scenario(name: &str) -> SkinIni {
    let path = fixture_util::fixtures_dir().join("skin/inputs").join(name).join("skin.ini");
    match std::fs::read(&path) {
        Ok(bytes) => decode_skin_ini(&bytes).unwrap_or_else(|e| panic!("{name}: decode failed: {e}")),
        // the scenario that ships no configuration at all -- the app crate
        // reaches this branch by finding no file, and it is a DIFFERENT default
        // to decoding an empty one
        Err(_) => SkinIni::without_file(),
    }
}

fn to_f64(value: Decimal) -> f64 {
    use rust_decimal::prelude::ToPrimitive;
    value.to_f64().expect("a skin version is representable")
}

#[test]
fn every_scenario_decodes_to_lazers_configuration() {
    for name in scenarios() {
        let expected: SkinDump = fixture_util::load_json(&format!("skin/{name}.json"));
        let actual = decode_scenario(&name);

        assert_eq!(
            expected.ini_present,
            fixture_util::fixtures_dir()
                .join("skin/inputs")
                .join(&name)
                .join("skin.ini")
                .exists(),
            "{name}: the dump and the input tree disagree about whether a skin.ini exists"
        );

        assert_eq!(actual.name, expected.name, "{name}: name");
        assert_eq!(actual.author, expected.author, "{name}: author");
        assert_eq!(
            actual.legacy_version.map(to_f64),
            expected.legacy_version,
            "{name}: legacy version"
        );
        assert_eq!(
            to_f64(actual.effective_version()),
            expected.effective_version,
            "{name}: effective version"
        );

        assert_eq!(
            actual.combo_colours,
            expected
                .custom_combo_colours
                .iter()
                .map(ColourDump::rgba)
                .collect::<Vec<_>>(),
            "{name}: declared combo colours"
        );

        // SkinConfiguration.ComboColours applies the classic-four fallback; the
        // fallback is only ever null for a beatmap skin, which is a different
        // source and not what this family decodes
        let expected_effective = expected
            .combo_colours
            .as_ref()
            .expect("a user skin's palette is never null")
            .iter()
            .map(ColourDump::rgba)
            .collect::<Vec<_>>();
        assert_eq!(
            actual.combo_colours_or_default(),
            expected_effective,
            "{name}: effective combo colours"
        );

        assert_eq!(
            actual.custom_colours,
            expected
                .custom_colours
                .iter()
                .map(|(key, colour)| (key.clone(), colour.rgba()))
                .collect::<BTreeMap<_, _>>(),
            "{name}: custom colours"
        );

        assert_eq!(actual.settings, expected.config_dictionary, "{name}: config dictionary");

        let settings = &expected.settings;
        assert_eq!(
            actual.int_setting("AnimationFramerate"),
            settings.animation_framerate,
            "{name}: AnimationFramerate"
        );
        assert_eq!(
            actual.bool_setting("LayeredHitSounds"),
            settings.layered_hit_sounds,
            "{name}: LayeredHitSounds"
        );
        assert_eq!(
            actual.bool_setting("AllowSliderBallTint"),
            settings.allow_slider_ball_tint,
            "{name}: AllowSliderBallTint"
        );
        assert_eq!(
            actual.string_setting("ComboPrefix"),
            settings.combo_prefix.as_deref(),
            "{name}: ComboPrefix"
        );
        assert_eq!(
            actual.float_setting("ComboOverlap"),
            settings.combo_overlap,
            "{name}: ComboOverlap"
        );
        assert_eq!(
            actual.string_setting("HitCirclePrefix"),
            settings.hit_circle_prefix.as_deref(),
            "{name}: HitCirclePrefix"
        );
        assert_eq!(
            actual.float_setting("HitCircleOverlap"),
            settings.hit_circle_overlap,
            "{name}: HitCircleOverlap"
        );
        assert_eq!(
            actual.bool_setting("CursorCentre"),
            settings.cursor_centre,
            "{name}: CursorCentre"
        );
        assert_eq!(
            actual.bool_setting("CursorExpand"),
            settings.cursor_expand,
            "{name}: CursorExpand"
        );
        assert_eq!(
            actual.bool_setting("CursorRotate"),
            settings.cursor_rotate,
            "{name}: CursorRotate"
        );
        assert_eq!(
            actual.bool_setting("CursorTrailRotate"),
            settings.cursor_trail_rotate,
            "{name}: CursorTrailRotate"
        );
        assert_eq!(
            actual.bool_setting("HitCircleOverlayAboveNumber"),
            settings.hit_circle_overlay_above_number,
            "{name}: HitCircleOverlayAboveNumber"
        );
        assert_eq!(
            actual.bool_setting("HitCircleOverlayAboveNumer"),
            settings.hit_circle_overlay_above_numer,
            "{name}: HitCircleOverlayAboveNumer (lazer honours the typo)"
        );
        assert_eq!(
            actual.bool_setting("SpinnerFrequencyModulate"),
            settings.spinner_frequency_modulate,
            "{name}: SpinnerFrequencyModulate"
        );
        assert_eq!(
            actual.bool_setting("SpinnerNoBlink"),
            settings.spinner_no_blink,
            "{name}: SpinnerNoBlink"
        );
    }
}

#[test]
fn the_version_forks_the_drawing_code_uses_land_on_the_right_side() {
    // the three thresholds the osu! pieces compare against, asserted through
    // the fixtures rather than through hand-written input, so a decoder drift
    // shows up here as well as in the field-by-field comparison above
    let at = |name: &str| to_f64(decode_scenario(name).effective_version());

    assert!(at("version-1") <= 1.0, "reverse arrow rotation forks at <= 1");
    assert!(at("version-2") >= 2.0 && at("version-2") < 2.5);
    assert!(at("version-2-4") < 2.5, "the 2.5 fork must not admit 2.4");
    assert!(at("version-2-5") >= 2.5);
    assert_eq!(at("version-latest"), to_f64(latest_version()));
    // a file with no Version declares the OLDEST behaviour, while no file at
    // all declares the newest -- the pair this whole family exists to keep apart
    assert_eq!(at("version-absent"), 1.0);
    assert_eq!(at("absent-ini"), to_f64(latest_version()));
}
