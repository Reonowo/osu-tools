//! `skin.ini` decoding -- a port of lazer's `LegacySkinDecoder` (and the
//! `LegacyDecoder<T>` line loop it derives from), pinned by the `fixtures/skin/`
//! golden dumps.
//!
//! it lives in the format layer with the other codecs because it is exactly
//! what that layer is for: deterministic, fixture-able, wanting the no-panic
//! guarantee and a resource cap. text encoding follows
//! [`crate::formats::beatmap`]'s posture exactly -- detect a byte-order mark,
//! otherwise decode as UTF-8 lossily. no charset guessing is added; it would be
//! the only heuristic in a layer that otherwise decodes deterministically, and
//! the display-name consequence is handled at the surface instead (a skin whose
//! declared name decodes to replacement characters is listed under its folder
//! name, which is the name the user recognises anyway).
//!
//! ## The two "no version declared" cases
//!
//! `[General] Version` is behavioural rather than informational: the osu!
//! pieces fork on `< 2.5`, `< 2` and `<= 1`. Two different defaults apply and
//! they are not interchangeable, which is why this module exposes both:
//!
//! - a **present** `skin.ini` with no `Version` key decodes to `1.0`, the
//!   decoder's template default (legacyskindecoder.cs:66-72), via
//!   [`decode_skin_ini`];
//! - an **absent** `skin.ini` is `LATEST_VERSION` with the latest flag set
//!   (skin.cs:108-113), via [`SkinIni::without_file`].
//!
//! ## Deliberate divergence: no `Section.Metadata` comment exemption in practice
//!
//! `LegacyDecoder.ParseStreamInto` skips comment stripping inside
//! `[Metadata]` (legacydecoder.cs:49-53). That branch is reproduced here for
//! fidelity even though a `skin.ini` has no meaningful metadata section, so a
//! reader comparing the two loops does not have to wonder whether it was
//! missed.

use std::borrow::Cow;
use std::collections::BTreeMap;

use rust_decimal::prelude::FromPrimitive;
use rust_decimal::Decimal;

use crate::error::{resource_limit, Result};
use crate::limits;

/// skinconfiguration.cs:17 -- the version an absent declaration resolves to
pub fn latest_version() -> Decimal {
    Decimal::from_i64(27).expect("27 is representable") / Decimal::from_i64(10).expect("10 is representable")
}

/// legacydecoder.cs:23 -- only `Combo1`..`Combo8` are combo colours; a
/// `Combo9` is an ordinary custom colour
pub const MAX_COMBO_COLOUR_COUNT: i32 = 8;

/// skinconfiguration.cs:47-53 -- the classic four, which a legacy skin
/// declaring no palette falls back to
pub const DEFAULT_COMBO_COLOURS: [[u8; 4]; 4] = [
    [255, 192, 0, 255],
    [0, 202, 0, 255],
    [18, 124, 255, 255],
    [242, 24, 57, 255],
];

/// a decoded `skin.ini`, in lazer's own `SkinConfiguration` shape.
///
/// the raw key/value dictionary is kept rather than being flattened into typed
/// fields because that is what lazer keeps: `LegacySkin.genericLookup` parses a
/// value at lookup time, under the type the caller asked for, and returns
/// nothing when the parse fails (legacyskin.cs:345-373). a decode-time
/// flattening would have to guess which type each key is read as, and would
/// turn a malformed value into a decode failure rather than the lookup miss
/// lazer treats it as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkinIni {
    /// `[General] Name`, or empty when undeclared -- `SkinInfo.Name` starts as
    /// the empty string, not null, so "undeclared" and "declared empty" are
    /// genuinely the same state here. the picker's folder-name fallback keys
    /// on that
    pub name: String,
    /// `[General] Author`, or empty when undeclared
    pub author: String,
    /// the declared version, modelled as lazer's `decimal?`. always `Some`
    /// after a decode (the template default fills it), and left `None` only
    /// for a configuration that never came from a legacy file at all
    pub legacy_version: Option<Decimal>,
    /// whether the version was declared as the literal `latest` rather than a
    /// number (legacyskindecoder.cs:39-42)
    pub is_latest_version: bool,
    /// `[Colours] Combo1..Combo8`, in declaration order
    pub combo_colours: Vec<[u8; 4]>,
    /// every other `[Colours]` entry -- `SliderBorder`, `SliderTrackOverride`,
    /// `InputOverlayText` and anything else the skin declared
    pub custom_colours: BTreeMap<String, [u8; 4]>,
    /// every non-`[Colours]` key/value pair, as declared. `Name`, `Author` and
    /// `Version` are deliberately absent: their `General` cases return before
    /// the dictionary insert (legacyskindecoder.cs:24-50)
    pub settings: BTreeMap<String, String>,
}

impl SkinIni {
    /// skin.cs:108-113 -- the configuration a skin gets when it ships no
    /// `skin.ini` at all. distinct from decoding an empty file, which lands on
    /// the decoder's `1.0` template default instead
    pub fn without_file() -> Self {
        Self {
            name: String::new(),
            author: String::new(),
            legacy_version: Some(latest_version()),
            is_latest_version: true,
            combo_colours: Vec::new(),
            custom_colours: BTreeMap::new(),
            settings: BTreeMap::new(),
        }
    }

    /// legacyskin.cs:334-335 -- what a `LegacySetting.Version` lookup answers:
    /// the declared version, or the latest. every version fork in the drawing
    /// code compares against this, never against [`Self::legacy_version`]
    pub fn effective_version(&self) -> Decimal {
        self.legacy_version.unwrap_or_else(latest_version)
    }

    /// [`Self::effective_version`] as an `f64`, for a caller that has to put it
    /// on a wire or compare it in a layer with no decimal type.
    ///
    /// **Deliberate divergence.** lazer's version is a `System.Decimal` and this
    /// is a binary float, so a version declared within about 1e-16 of one of the
    /// thresholds the drawing code forks on (`<= 1`, `< 2`, `< 2.5`) could round
    /// to the other side. the thresholds themselves are exactly representable
    /// and every version any real skin declares has at most two decimal places,
    /// so the divergence is unreachable in practice; it is recorded rather than
    /// engineered around because carrying a decimal across the wire would cost
    /// a wire type for a case no skin produces
    pub fn effective_version_f64(&self) -> f64 {
        use rust_decimal::prelude::ToPrimitive;
        // a decimal built from a version string cannot exceed f64's range, so
        // the fallback is unreachable; it is the oldest version rather than the
        // newest, which is the conservative side of every fork
        self.effective_version().to_f64().unwrap_or(1.0)
    }

    /// skinconfiguration.cs:57-66 -- the declared palette, or the classic four
    /// when none was declared. `None` is never returned here: the "refuse the
    /// fallback" branch belongs to a *beatmap* skin, which is a different
    /// source, and is applied by the caller that knows which it is holding
    pub fn combo_colours_or_default(&self) -> Vec<[u8; 4]> {
        if self.combo_colours.is_empty() {
            DEFAULT_COMBO_COLOURS.to_vec()
        } else {
            self.combo_colours.clone()
        }
    }

    /// legacyskin.cs:345-373, the string case: the raw declared value
    pub fn string_setting(&self, key: &str) -> Option<&str> {
        self.settings.get(key).map(String::as_str)
    }

    /// legacyskin.cs:352-360 -- the bool case, and it is not a plain parse.
    /// real skins write `1` and `0`, and at least one writes `2`
    /// (ppy/osu#18579), so lazer tries `bool.TryParse` first and falls back to
    /// an integer conversion whose result is compared against zero. a value
    /// that is neither throws inside lazer's `try` and the lookup answers
    /// nothing, which is `None` here
    pub fn bool_setting(&self, key: &str) -> Option<bool> {
        let raw = self.settings.get(key)?;
        // bool.TryParse: case-insensitive `true`/`false`, surrounding
        // whitespace allowed
        match raw.trim().to_ascii_lowercase().as_str() {
            "true" => return Some(true),
            "false" => return Some(false),
            _ => {}
        }
        // Convert.ToInt32(string) -- NumberStyles.Integer, so a leading sign
        // and surrounding whitespace are admitted and anything else throws
        parse_dotnet_i32(raw).map(|value| value != 0)
    }

    /// legacyskin.cs:361-366 -- `Bindable<int>.Parse` under the invariant
    /// culture, which is `int.Parse` with `NumberStyles.Integer`
    pub fn int_setting(&self, key: &str) -> Option<i32> {
        parse_dotnet_i32(self.settings.get(key)?)
    }

    /// legacyskin.cs:361-366 -- `Bindable<float>.Parse` under the invariant
    /// culture, which is `float.Parse` with `NumberStyles.Float |
    /// NumberStyles.AllowThousands`. thousands separators are not honoured
    /// here: no real skin writes one and admitting them would mean modelling
    /// group sizes for a value nobody declares that way
    pub fn float_setting(&self, key: &str) -> Option<f32> {
        let raw = self.settings.get(key)?.trim();
        if raw.is_empty() {
            return None;
        }
        raw.parse::<f32>().ok().filter(|value| value.is_finite())
    }

    /// a `[Colours]` entry that is not a combo colour
    pub fn custom_colour(&self, key: &str) -> Option<[u8; 4]> {
        self.custom_colours.get(key).copied()
    }
}

/// legacydecoder.cs:168-182 -- the sections the line loop recognises. an
/// unrecognised header does NOT keep the previous section: `Enum.TryParse`
/// writes `default(Section)` on failure, and the caller passes `out section`
/// directly, so the file silently reverts to `General`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Section {
    General,
    Editor,
    Metadata,
    Difficulty,
    Events,
    TimingPoints,
    Colours,
    HitObjects,
    Variables,
    Fonts,
    CatchTheBeat,
    Mania,
    /// a numeric header outside the enum's range. `Enum.TryParse` accepts any
    /// integer string and succeeds with an out-of-range value, so `[99]` is a
    /// section that matches none of the named cases rather than a parse failure
    /// that would have reverted to `General`
    OutOfRange,
}

fn parse_section(name: &str) -> Section {
    match name {
        // Enum.TryParse's non-ignoreCase overload: exact case only
        "General" => Section::General,
        "Editor" => Section::Editor,
        "Metadata" => Section::Metadata,
        "Difficulty" => Section::Difficulty,
        "Events" => Section::Events,
        "TimingPoints" => Section::TimingPoints,
        "Colours" => Section::Colours,
        "HitObjects" => Section::HitObjects,
        "Variables" => Section::Variables,
        "Fonts" => Section::Fonts,
        "CatchTheBeat" => Section::CatchTheBeat,
        "Mania" => Section::Mania,
        _ => match parse_dotnet_i32(name) {
            Some(0) => Section::General,
            Some(1) => Section::Editor,
            Some(2) => Section::Metadata,
            Some(3) => Section::Difficulty,
            Some(4) => Section::Events,
            Some(5) => Section::TimingPoints,
            Some(6) => Section::Colours,
            Some(7) => Section::HitObjects,
            Some(8) => Section::Variables,
            Some(9) => Section::Fonts,
            Some(10) => Section::CatchTheBeat,
            Some(11) => Section::Mania,
            Some(_) => Section::OutOfRange,
            // TryParse failed, so `out section` was written with default(T)
            None => Section::General,
        },
    }
}

/// decode a `skin.ini`'s bytes.
///
/// never panics and never allocates unboundedly: the only input-sized
/// allocations are the decoded lines and the two maps, all bounded by
/// [`limits::MAX_SKIN_INI_BYTES`]. a malformed line is skipped exactly as
/// lazer's per-line `try`/`catch` skips it (legacydecoder.cs:66-73), so this
/// returns `Err` only for the size cap -- there is no such thing as an
/// undecodable `skin.ini`
pub fn decode_skin_ini(bytes: &[u8]) -> Result<SkinIni> {
    if bytes.len() as u64 > limits::MAX_SKIN_INI_BYTES {
        return Err(resource_limit(
            "MAX_SKIN_INI_BYTES",
            limits::MAX_SKIN_INI_BYTES,
            bytes.len() as u64,
        ));
    }

    let mut config = SkinIni {
        name: String::new(),
        author: String::new(),
        // legacyskindecoder.cs:66-72 -- CreateTemplateObject's default, which
        // is what a file that declares no version resolves to
        legacy_version: Some(Decimal::ONE),
        is_latest_version: false,
        combo_colours: Vec::new(),
        custom_colours: BTreeMap::new(),
        settings: BTreeMap::new(),
    };

    let mut section = Section::General;

    for raw_line in decoded_lines(bytes) {
        // legacydecoder.cs:77 -- blank lines and comment lines are dropped
        // before anything else looks at them
        if raw_line.trim().is_empty() || raw_line.trim_start().starts_with("//") {
            continue;
        }

        // legacydecoder.cs:49-53 -- comments are stripped everywhere except
        // [Metadata], where "//" can be valid song metadata
        let stripped = if section == Section::Metadata {
            raw_line.as_ref()
        } else {
            strip_comments(raw_line.as_ref())
        };
        let line = stripped.trim_end();

        if line.starts_with('[') && line.ends_with(']') {
            // trimmed for the same reason `parse_dotnet_i32` trims: this is one
            // `Enum.TryParse` call and it trims its input once, before deciding
            // whether the text is a name or a number. without it `[Colours ]`
            // fails the name match, falls through to the numeric arm, and lands
            // on `default(Section)` -- reading the whole rest of the file as
            // `[General]` where lazer reads it as `[Colours]`
            section = parse_section(line[1..line.len() - 1].trim());
            continue;
        }

        parse_line(&mut config, section, line);
    }

    Ok(config)
}

fn parse_line(config: &mut SkinIni, section: Section, line: &str) {
    // legacyskindecoder.cs:18 -- the [Colours] section skips the whole
    // key/value branch and goes straight to the base decoder's colour handling
    if section == Section::Colours {
        handle_colours(config, line, false);
        return;
    }

    let (key, value) = split_key_val(line);

    match section {
        Section::General => match key {
            "Name" => {
                config.name = value.to_owned();
                return;
            }
            "Author" => {
                config.author = value.to_owned();
                return;
            }
            "Version" => {
                if value == "latest" {
                    config.legacy_version = Some(latest_version());
                    config.is_latest_version = true;
                } else if let Some(version) = parse_dotnet_decimal(value) {
                    config.legacy_version = Some(version);
                    config.is_latest_version = false;
                }
                // an unparseable version is neither an error nor a reset: the
                // case simply returns, leaving whatever was there before
                return;
            }
            _ => {}
        },
        // legacyskindecoder.cs:53-57 -- osu!catch's section holds nothing but
        // colours, so the whole section is handled as colours, with alpha
        // allowed. reproduced for fidelity; this app draws no catch objects
        Section::CatchTheBeat => {
            handle_colours(config, line, true);
            return;
        }
        _ => {}
    }

    if !key.is_empty() {
        config.settings.insert(key.to_owned(), value.to_owned());
    }
}

/// legacydecoder.cs:126-149 -- a `[Colours]` line. a malformed one throws
/// inside lazer's per-line `try` and is skipped, which is what returning
/// early does here
fn handle_colours(config: &mut SkinIni, line: &str, allow_alpha: bool) {
    let (key, value) = split_key_val(line);

    let components: Vec<&str> = value.split(',').collect();
    if components.len() != 3 && components.len() != 4 {
        return;
    }

    let mut channels = [0u8; 3];
    for (index, raw) in components.iter().take(3).enumerate() {
        match parse_dotnet_u8(raw) {
            Some(byte) => channels[index] = byte,
            None => return,
        }
    }

    let alpha = if allow_alpha && components.len() == 4 {
        match parse_dotnet_u8(components[3]) {
            Some(byte) => byte,
            None => return,
        }
    } else {
        // note the asymmetry, which is lazer's: a fourth component is PARSED
        // only when alpha is allowed, so a `[Colours]` entry with four
        // components is accepted at full opacity rather than rejected
        255
    };

    let colour = [channels[0], channels[1], channels[2], alpha];

    // legacydecoder.cs:133-135 -- `Combo` followed by an integer in 1..=8
    let combo_index = key
        .strip_prefix("Combo")
        .and_then(parse_dotnet_i32)
        .filter(|index| *index >= 1 && *index <= MAX_COMBO_COLOUR_COUNT);

    match combo_index {
        Some(_) => config.combo_colours.push(colour),
        None => {
            config.custom_colours.insert(key.to_owned(), colour);
        }
    }
}

/// legacydecoder.cs:151-160 -- split on the first `:`, trimming both halves.
/// a line with no separator yields an empty value, not an error
fn split_key_val(line: &str) -> (&str, &str) {
    match line.split_once(':') {
        Some((key, value)) => (key.trim(), value.trim()),
        None => (line.trim(), ""),
    }
}

/// legacydecoder.cs:97-104 -- everything from the first `//` onward, but only
/// when it is not at the very start of the line (`index > 0`). a line starting
/// with `//` never reaches here anyway, having been skipped as a comment
fn strip_comments(line: &str) -> &str {
    match line.find("//") {
        Some(index) if index > 0 => &line[..index],
        _ => line,
    }
}

/// `decimal.TryParse(value, NumberStyles.AllowDecimalPoint, InvariantCulture)`
/// -- and the style set is the whole point. `AllowDecimalPoint` alone admits
/// **no** leading sign, no whitespace, no exponent and no thousands separator,
/// so `Version: -1` is a parse *failure* that leaves the template default in
/// place rather than a negative version. `fixtures/skin/version-signed.json`
/// pins that
fn parse_dotnet_decimal(value: &str) -> Option<Decimal> {
    if value.is_empty() {
        return None;
    }
    let mut seen_point = false;
    for character in value.chars() {
        match character {
            '0'..='9' => {}
            '.' if !seen_point => seen_point = true,
            _ => return None,
        }
    }
    // a bare "." has no digits and is not a number
    if value.chars().all(|character| character == '.') {
        return None;
    }
    value.parse::<Decimal>().ok()
}

/// `int.Parse(value, NumberStyles.Integer, InvariantCulture)` -- leading and
/// trailing whitespace and a leading sign are admitted, nothing else is
fn parse_dotnet_i32(value: &str) -> Option<i32> {
    let trimmed = value.trim();
    let digits = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    trimmed.parse::<i32>().ok()
}

/// `byte.Parse(component)` inside `convertSettingStringToColor4`: same integer
/// style as above, and out-of-range throws, which is a skipped line
fn parse_dotnet_u8(value: &str) -> Option<u8> {
    let parsed = parse_dotnet_i32(value)?;
    u8::try_from(parsed).ok()
}

// mirrors `formats::beatmap`'s precheck decoder, and for the same reason: the
// encoding is decided once from a byte-order mark at the very start of the
// file and every line is decoded under it. lazer reaches this through
// `StreamReader`'s own BOM detection rather than through rosu-map, but the
// three marks and the lossy UTF-8 default are the same
#[derive(Clone, Copy, PartialEq, Eq)]
enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
}

fn detect_bom(bytes: &[u8]) -> (Encoding, usize) {
    match bytes {
        [0xEF, 0xBB, 0xBF, ..] => (Encoding::Utf8, 3),
        [0xFF, 0xFE, ..] => (Encoding::Utf16Le, 2),
        [0xFE, 0xFF, ..] => (Encoding::Utf16Be, 2),
        _ => (Encoding::Utf8, 0),
    }
}

fn decoded_lines(bytes: &[u8]) -> Vec<Cow<'_, str>> {
    let (encoding, bom_len) = detect_bom(bytes);
    let body = &bytes[bom_len..];

    match encoding {
        // lossy: invalid byte sequences become U+FFFD, which is what a
        // `StreamReader` over a UTF8Encoding does and what the beatmap codec
        // already does. `fixtures/skin/name-mojibake.json` pins the resulting
        // display name
        Encoding::Utf8 => String::from_utf8_lossy(body)
            .split('\n')
            .map(|line| Cow::Owned(line.to_owned()))
            .collect(),
        Encoding::Utf16Le => decode_utf16(body, u16::from_le_bytes),
        Encoding::Utf16Be => decode_utf16(body, u16::from_be_bytes),
    }
}

fn decode_utf16(body: &[u8], from_bytes: fn([u8; 2]) -> u16) -> Vec<Cow<'_, str>> {
    // a trailing odd byte is an incomplete code unit and is dropped
    let units = body.chunks_exact(2).map(|pair| from_bytes([pair[0], pair[1]]));
    let decoded: String = char::decode_utf16(units)
        .map(|result| result.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect();
    decoded.split('\n').map(|line| Cow::Owned(line.to_owned())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(text: &str) -> SkinIni {
        decode_skin_ini(text.as_bytes()).expect("decodes")
    }

    #[test]
    fn an_absent_file_and_an_undeclared_version_are_different_defaults() {
        // the whole reason both entry points exist
        assert_eq!(SkinIni::without_file().legacy_version, Some(latest_version()));
        assert!(SkinIni::without_file().is_latest_version);

        let declared_nothing = decode("[General]\nName: x\n");
        assert_eq!(declared_nothing.legacy_version, Some(Decimal::ONE));
        assert!(!declared_nothing.is_latest_version);
    }

    #[test]
    fn latest_is_a_literal_and_sets_the_flag() {
        let config = decode("[General]\nVersion: latest\n");
        assert_eq!(config.effective_version(), latest_version());
        assert!(config.is_latest_version);
    }

    #[test]
    fn a_signed_version_fails_to_parse_and_leaves_the_template_default() {
        // NumberStyles.AllowDecimalPoint alone admits no sign
        assert_eq!(decode("[General]\nVersion: -1\n").effective_version(), Decimal::ONE);
        assert_eq!(decode("[General]\nVersion: +2\n").effective_version(), Decimal::ONE);
        assert_eq!(decode("[General]\nVersion: 1e2\n").effective_version(), Decimal::ONE);
        assert_eq!(decode("[General]\nVersion: nonsense\n").effective_version(), Decimal::ONE);
        assert_eq!(decode("[General]\nVersion: .\n").effective_version(), Decimal::ONE);
    }

    #[test]
    fn name_author_and_version_stay_out_of_the_settings_map() {
        let config = decode("[General]\nName: n\nAuthor: a\nVersion: 2.5\nCursorExpand: 0\n");
        assert_eq!(config.name, "n");
        assert_eq!(config.author, "a");
        assert_eq!(config.settings.keys().collect::<Vec<_>>(), vec!["CursorExpand"]);
    }

    #[test]
    fn bools_accept_one_zero_and_the_word_forms() {
        let config = decode(
            "[General]\nA: 1\nB: 0\nC: true\nD: FALSE\nE: 2\nF: nonsense\nG: \n",
        );
        assert_eq!(config.bool_setting("A"), Some(true));
        assert_eq!(config.bool_setting("B"), Some(false));
        assert_eq!(config.bool_setting("C"), Some(true));
        assert_eq!(config.bool_setting("D"), Some(false));
        // ppy/osu#18579 -- a skin in the wild writes 2
        assert_eq!(config.bool_setting("E"), Some(true));
        // neither a bool nor an integer: the lookup answers nothing, and the
        // caller's own default applies
        assert_eq!(config.bool_setting("F"), None);
        assert_eq!(config.bool_setting("G"), None);
        assert_eq!(config.bool_setting("absent"), None);
    }

    #[test]
    fn combo_colours_stop_at_eight_and_the_rest_are_custom_colours() {
        let mut text = String::from("[Colours]\n");
        for index in 1..=9 {
            text.push_str(&format!("Combo{index}: {index},{index},{index}\n"));
        }
        text.push_str("SliderBorder: 1,2,3\n");
        let config = decode(&text);
        assert_eq!(config.combo_colours.len(), 8);
        assert_eq!(config.combo_colours[0], [1, 1, 1, 255]);
        assert_eq!(config.custom_colour("Combo9"), Some([9, 9, 9, 255]));
        assert_eq!(config.custom_colour("SliderBorder"), Some([1, 2, 3, 255]));
    }

    #[test]
    fn a_colours_alpha_component_is_accepted_but_not_honoured() {
        // convertSettingStringToColor4 takes four components whatever
        // allowAlpha says; only [CatchTheBeat] actually reads the fourth
        let config = decode("[Colours]\nSliderBorder: 1,2,3,4\n");
        assert_eq!(config.custom_colour("SliderBorder"), Some([1, 2, 3, 255]));

        let catch = decode("[CatchTheBeat]\nHyperDash: 1,2,3,4\n");
        assert_eq!(catch.custom_colour("HyperDash"), Some([1, 2, 3, 4]));
    }

    #[test]
    fn a_malformed_colour_line_is_skipped_not_fatal() {
        let config = decode("[Colours]\nCombo1: 1,2\nCombo2: 300,0,0\nCombo3: 9,9,9\n");
        assert_eq!(config.combo_colours, vec![[9, 9, 9, 255]]);
    }

    #[test]
    fn comments_are_stripped_outside_metadata() {
        let config = decode("[General]\nCursorExpand: 0 // off\n// whole line\n");
        assert_eq!(config.string_setting("CursorExpand"), Some("0"));
        assert_eq!(config.settings.len(), 1);
    }

    #[test]
    fn an_unrecognised_section_header_reverts_to_general() {
        // Enum.TryParse writes default(Section) on failure and the caller
        // passes `out section` straight through
        let config = decode("[Colours]\n[Nonsense]\nCursorExpand: 0\n");
        assert_eq!(config.string_setting("CursorExpand"), Some("0"));
    }

    #[test]
    fn a_section_header_padded_inside_its_brackets_still_resolves() {
        // one `Enum.TryParse` call, and it trims its input once before deciding
        // whether the text names a member or an ordinal. without the trim the
        // name match fails, the numeric arm fails too, and `default(Section)`
        // reads the rest of the file as [General] -- silently dropping a
        // declared palette rather than misreading one line
        assert_eq!(decode("[Colours ]
Combo1: 1,2,3
").combo_colours, vec![[1, 2, 3, 255]]);
        assert_eq!(decode("[ Colours]
Combo1: 1,2,3
").combo_colours, vec![[1, 2, 3, 255]]);
        // the ordinal form trims through the same call
        assert_eq!(decode("[ 6 ]
Combo1: 1,2,3
").combo_colours, vec![[1, 2, 3, 255]]);
        // and case is still exact: TryParse's non-ignoreCase overload
        assert!(decode("[colours]
Combo1: 1,2,3
").combo_colours.is_empty());
    }

    #[test]
    fn a_numeric_section_header_selects_by_ordinal() {
        // [6] is Section.Colours
        let config = decode("[6]\nCombo1: 1,2,3\n");
        assert_eq!(config.combo_colours, vec![[1, 2, 3, 255]]);
        // out of range: a section matching none of the named cases, so the
        // line lands in the settings map as an ordinary key/value pair
        let out_of_range = decode("[99]\nCombo1: 1,2,3\n");
        assert!(out_of_range.combo_colours.is_empty());
        assert_eq!(out_of_range.string_setting("Combo1"), Some("1,2,3"));
    }

    #[test]
    fn a_byte_order_mark_is_consumed_before_the_first_section() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"[General]\nName: BOM Skin\n");
        assert_eq!(decode_skin_ini(&bytes).expect("decodes").name, "BOM Skin");
    }

    #[test]
    fn invalid_utf8_decodes_to_replacement_characters_rather_than_failing() {
        let mut bytes = Vec::from(&b"[General]\nName: "[..]);
        bytes.extend_from_slice(&[0x82, 0xA0]);
        bytes.extend_from_slice(b" skin\n");
        let config = decode_skin_ini(&bytes).expect("decodes");
        assert_eq!(config.name, "\u{fffd}\u{fffd} skin");
    }

    #[test]
    fn carriage_returns_are_trimmed_with_the_rest_of_the_line_end() {
        let config = decode("[General]\r\nName: crlf\r\nCursorExpand: 0\r\n");
        assert_eq!(config.name, "crlf");
        assert_eq!(config.string_setting("CursorExpand"), Some("0"));
    }

    #[test]
    fn floats_and_ints_answer_nothing_when_the_value_does_not_parse() {
        let config = decode("[General]\nHitCircleOverlap: -2.5\nAnimationFramerate: 30\nBad: x\n");
        assert_eq!(config.float_setting("HitCircleOverlap"), Some(-2.5));
        assert_eq!(config.int_setting("AnimationFramerate"), Some(30));
        assert_eq!(config.float_setting("Bad"), None);
        assert_eq!(config.int_setting("Bad"), None);
        assert_eq!(config.float_setting("absent"), None);
    }

    #[test]
    fn skin_ini_byte_size_cap_boundary() {
        let mut at_limit = Vec::from(&b"[General]\nName: x\n"[..]);
        at_limit.resize(limits::MAX_SKIN_INI_BYTES as usize, b'\n');
        assert!(decode_skin_ini(&at_limit).is_ok());

        let mut past_limit = at_limit;
        past_limit.push(b'\n');
        let error = decode_skin_ini(&past_limit).expect_err("past the cap");
        assert!(
            matches!(
                error,
                crate::error::EngineError::ResourceLimit {
                    cap: "MAX_SKIN_INI_BYTES",
                    ..
                }
            ),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn hostile_and_truncated_input_is_refused_rather_than_panicking() {
        // a lone BOM, a lone bracket, an unterminated section, a colon-only
        // line, a key with no value, a utf-16 stream cut mid code unit
        for bytes in [
            &b""[..],
            &[0xEF, 0xBB][..],
            &b"["[..],
            &b"[General"[..],
            &b":"[..],
            &b"Name:"[..],
            &[0xFF, 0xFE, 0x5B, 0x00, 0x47][..],
            &[0xFE, 0xFF, 0x00][..],
        ] {
            assert!(decode_skin_ini(bytes).is_ok(), "should not fail: {bytes:?}");
        }
    }

    #[test]
    fn an_undeclared_palette_falls_back_to_the_classic_four() {
        assert_eq!(decode("[General]\n").combo_colours_or_default(), DEFAULT_COMBO_COLOURS.to_vec());
        assert_eq!(
            decode("[Colours]\nCombo1: 1,2,3\n").combo_colours_or_default(),
            vec![[1, 2, 3, 255]]
        );
    }
}
