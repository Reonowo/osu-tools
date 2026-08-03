//! `.osu` beatmap decoding, wrapped behind engine-owned domain types so the
//! rest of the engine never touches rosu-map's shapes directly.

use std::borrow::Cow;
use std::io::Read;
use std::path::Path;

use crate::error::{resource_limit, EngineError, Result};
use crate::formats::GameMode;
use crate::limits;
use crate::math::Vec2;

/// legacybeatmapdecoder.cs:30 -- baked into object and control point times for
/// format versions < 5, and mirrored into replay frame times by replay::frames
pub const EARLY_VERSION_TIMING_OFFSET: f64 = 24.0;

#[derive(Debug, Clone, PartialEq)]
pub struct TimingPoint {
    pub time: f64,
    /// rosu-map clamps to 6..60000 at parse, matching lazer's
    /// TimingControlPoint.BeatLengthBindable (timingcontrolpoint.cs:65-69)
    pub beat_len: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DifficultyPoint {
    pub time: f64,
    /// rosu-map clamps to 0.1..10 at parse, matching lazer's
    /// SliderVelocityMultiplierBindable (slider.cs:128-132)
    pub slider_velocity: f64,
    /// false when the inherited point's beat length parsed as NaN
    pub generate_ticks: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Beatmap {
    pub format_version: i32,
    pub mode: GameMode,
    pub title: String,
    pub artist: String,
    pub creator: String,
    pub version: String,
    pub beatmap_id: i32,
    pub beatmap_set_id: i32,
    pub audio_file: String,
    pub audio_lead_in: f64,
    pub background_file: String,
    pub stack_leniency: f32,
    pub hp_drain_rate: f32,
    pub circle_size: f32,
    pub overall_difficulty: f32,
    pub approach_rate: f32,
    pub slider_multiplier: f64,
    pub slider_tick_rate: f64,
    pub combo_colors: Vec<[u8; 4]>,
    pub timing_points: Vec<TimingPoint>,
    pub difficulty_points: Vec<DifficultyPoint>,
    pub hit_objects: Vec<HitObject>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HitObject {
    pub start_time: f64,
    pub pos: Vec2,
    pub new_combo: bool,
    pub combo_offset: i32,
    pub kind: HitObjectKind,
}

#[derive(Debug, Clone, PartialEq)]
pub enum HitObjectKind {
    Circle,
    Slider(SliderData),
    Spinner { duration: f64 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct SliderData {
    pub control_points: Vec<PathControlPoint>,
    pub expected_distance: Option<f64>,
    pub repeat_count: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PathControlPoint {
    pub pos: Vec2,
    pub path_type: Option<PathType>,
}

/// `Bezier` is lazer's `Degree == null` b-spline; `BSpline(d)` always has `d > 0`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathType {
    Bezier,
    BSpline(i32),
    Linear,
    Catmull,
    PerfectCurve,
}

pub fn decode_beatmap_path(path: &Path) -> Result<Beatmap> {
    // `std::fs::read` sizes its buffer from the file's metadata and reads all of
    // it, so leaving MAX_OSU_FILE_BYTES to `decode_beatmap_bytes` alone would
    // mean a 40 GiB file named `*.osu` had already been materialised in memory
    // by the time the cap was consulted -- an allocation failure instead of a
    // ResourceLimit. the declared length is checked first, so the error reports
    // the file's real size, and the read itself is additionally bounded by
    // `take` so a file that grows between the two steps still cannot outrun the
    // cap (the extra byte lets `decode_beatmap_bytes` reject that race normally)
    let file = std::fs::File::open(path)?;
    let declared_len = file.metadata()?.len();
    if declared_len > limits::MAX_OSU_FILE_BYTES {
        return Err(resource_limit(
            "MAX_OSU_FILE_BYTES",
            limits::MAX_OSU_FILE_BYTES,
            declared_len,
        ));
    }
    let mut bytes = Vec::new();
    file.take(limits::MAX_OSU_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    decode_beatmap_bytes(&bytes)
}

pub fn decode_beatmap_bytes(bytes: &[u8]) -> Result<Beatmap> {
    if bytes.len() as u64 > limits::MAX_OSU_FILE_BYTES {
        return Err(resource_limit(
            "MAX_OSU_FILE_BYTES",
            limits::MAX_OSU_FILE_BYTES,
            bytes.len() as u64,
        ));
    }
    reject_oversized_slider_paths(bytes)?;
    let raw = rosu_map::Beatmap::from_bytes(bytes).map_err(|e| EngineError::BeatmapParse(e.to_string()))?;
    convert(raw)
}

// cheap pre-parse scan that enforces a declared-point-count policy on every
// slider before rosu_map::Beatmap::from_bytes gets a chance to run --
// rosu-map eagerly computes each slider's curve while parsing, and for a
// curved path that work is superlinear in point count (quadratic for
// bezier/b-spline, and a fixed 100 vertices per knot for catmull), so the
// post-parse check in convert() runs far too late to bound the cost of
// getting there. see limits::MAX_NONLINEAR_SLIDER_CONTROL_POINTS for the
// per-family breakdown and the measurements behind it
//
// policy, not prediction: a slider may not *declare* more than
// MAX_SLIDER_CONTROL_POINTS path points, regardless of how many rosu-map's
// duplicate-point collapsing later dedups away. this scan does not model
// segments, duplicate-adjacency, or embedded path-type letters the way
// rosu-map's real parser does -- it only counts declared points, which is
// enough to bound parse cost without needing to stay in sync with
// rosu-map's internals. convert()'s check against rosu-map's actual
// (deduped) control points remains the authoritative count and is not
// removed
fn reject_oversized_slider_paths(bytes: &[u8]) -> Result<()> {
    let mut in_hit_objects = false;

    // mirrors rosu_map::reader::decoder::Decoder::curr_line: every decoded
    // line is trim_end()'d before section/content inspection, so a section
    // header with trailing whitespace (e.g. "[HitObjects] ") is still
    // recognized -- matching that here is required or the guard can be
    // bypassed by a header rosu-map itself would still honor
    for raw_line in precheck_lines(bytes) {
        let line = raw_line.trim_end();

        if is_skipped_line(line) {
            continue;
        }

        if let Some(name) = recognized_section_name(line) {
            in_hit_objects = name == "HitObjects";
            continue;
        }

        if !in_hit_objects {
            continue;
        }

        check_slider_declared_point_count(line)?;
    }

    Ok(())
}

// mirrors rosu_map::decode::DecodeBeatmap::should_skip_line exactly
// (`line.is_empty() || line.trim_start().starts_with("//")`), applied by
// rosu-map to the already-trim_end()'d line and *before* section detection
// or any section parser sees it. without this a `//`-commented line inside
// [HitObjects] that happens to be shaped like a slider -- 6+ comma fields
// with piped coordinate tokens -- would be checked by this scan and could
// falsely reject a file rosu-map parses without ever looking at the line
fn is_skipped_line(line: &str) -> bool {
    line.is_empty() || line.trim_start().starts_with("//")
}

// mirrors rosu_map::section::Section::try_from_line exactly: these are the
// only bracketed names rosu-map treats as section transitions. a bracketed
// line that isn't one of them (stray junk, or anything else shaped like
// "[...]") does NOT end the current section for rosu-map, so the scan must
// not treat it as one either -- doing so would silently stop guarding the
// rest of [HitObjects]
const RECOGNIZED_SECTIONS: &[&str] = &[
    "General",
    "Editor",
    "Metadata",
    "Difficulty",
    "Events",
    "TimingPoints",
    "Colours",
    "HitObjects",
    "Variables",
    "CatchTheBeat",
    "Mania",
];

fn recognized_section_name(line: &str) -> Option<&str> {
    let name = line.strip_prefix('[')?.strip_suffix(']')?;
    RECOGNIZED_SECTIONS.contains(&name).then_some(name)
}

// mirrors rosu_map::reader::encoding::Encoding::from_bom / Decoder::new: a
// beatmap's encoding is detected once, from a BOM at the very start of the
// file, and every line is decoded under that encoding before rosu-map ever
// looks at section headers or field contents. the pre-scan has to decode
// under the same encoding or it is simply reading different bytes than the
// parser it is meant to guard
#[derive(Clone, Copy, PartialEq, Eq)]
enum PrecheckEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
}

fn detect_bom(bytes: &[u8]) -> (PrecheckEncoding, usize) {
    match bytes {
        [0xEF, 0xBB, 0xBF, ..] => (PrecheckEncoding::Utf8, 3),
        [0xFF, 0xFE, ..] => (PrecheckEncoding::Utf16Le, 2),
        [0xFE, 0xFF, ..] => (PrecheckEncoding::Utf16Be, 2),
        _ => (PrecheckEncoding::Utf8, 0),
    }
}

// splits on the raw byte 0x0A *before* decoding, then decodes each line, which
// is the order rosu_map::reader::decoder::Decoder works in: `read_line` calls
// `BufRead::read_until(b'\n', ..)` on the undecoded stream
// (reader/decoder.rs:52) and only then hands the bytes to the encoding.
//
// the distinction is invisible for utf-8 but load-bearing for utf-16, where a
// code unit can *contain* 0x0A without being a newline: U+010A encodes as the
// bytes `0A 01` in little-endian, so rosu-map breaks a line in the middle of
// that character while decoded-then-`str::lines()` sees no break at all.
// placing one immediately before `[HitObjects]` is enough to make rosu-map
// enter the section while a decode-first scan never does -- and an oversized
// curved slider then sails past the guard into the quadratic parser
fn precheck_lines(bytes: &[u8]) -> impl Iterator<Item = Cow<'_, str>> {
    let (encoding, bom_len) = detect_bom(bytes);
    let mut pos = bom_len;

    std::iter::from_fn(move || {
        if pos >= bytes.len() {
            return None;
        }

        let start = pos;
        let mut end = match bytes[start..].iter().position(|&byte| byte == b'\n') {
            Some(offset) => start + offset + 1,
            None => bytes.len(),
        };

        // reader/decoder.rs:57-62 -- for UTF-16LE *only*, the 0x0A that
        // `read_until` stopped on is the LOW byte of the newline code unit, so
        // rosu-map pulls one more byte to pick up the 0x00 high byte and keep
        // every subsequent code unit aligned. skipping this shifts the whole
        // rest of the file by one byte and turns it into mojibake -- which is
        // its own silent guard bypass, not a fix for the original one.
        // UTF-16BE needs no such correction: there the newline is `00 0A`, so
        // stopping after the 0x0A already lands on an even boundary, and
        // rosu-map's condition is likewise LE-only
        if encoding == PrecheckEncoding::Utf16Le && bytes.get(end - 1) == Some(&b'\n') && end < bytes.len() {
            end += 1;
        }

        let line = &bytes[start..end];
        pos = end;

        // the terminator stays in the slice, exactly as `read_until` leaves it;
        // `curr_line`'s trim_end (mirrored by the caller) is what removes the
        // decoded "\n" or "\r\n"
        Some(match encoding {
            // lossy: invalid byte sequences become U+FFFD, same posture as
            // rosu-map's own utf-8 decode path. valid utf-8 (the common case)
            // is returned borrowed with no copy
            PrecheckEncoding::Utf8 => String::from_utf8_lossy(line),
            PrecheckEncoding::Utf16Le => Cow::Owned(decode_utf16(line, u16::from_le_bytes)),
            PrecheckEncoding::Utf16Be => Cow::Owned(decode_utf16(line, u16::from_be_bytes)),
        })
    })
}

fn decode_utf16(body: &[u8], from_bytes: fn([u8; 2]) -> u16) -> String {
    // trailing odd byte (an incomplete code unit) is silently dropped,
    // matching rosu_map::reader::u16_iter::DoubleByteIterator
    let units = body.chunks_exact(2).map(|pair| from_bytes([pair[0], pair[1]]));
    char::decode_utf16(units)
        .map(|result| result.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

// x,y,time,type,hitSound,curveType|curvePoints,slides,length,edgeSounds,edgeSets,hitSample
// the curve field is comma-field index 5; edgeSounds/edgeSets (indices 8/9)
// also contain '|' on high-repeat sliders and must not be counted, so only
// field 5 is ever inspected. circles/spinners/short or malformed lines have
// no such field and are skipped without error
//
// the selection is by field POSITION only -- the type field (index 3) is never
// consulted, so on a circle this returns the hitSample field instead, and a
// crafted sample filename stuffed with '|'-separated coordinate-shaped tokens
// would be counted as slider points and over-reject a file rosu-map parses.
// that is deliberate and stays deliberate: reading the type bit to narrow the
// scope means a misread type SKIPS a real slider, which reopens the very
// parse-cost bypass this guard exists to close, and the asymmetry is not close
// -- over-rejecting a crafted circle is harmless where under-rejecting a
// crafted slider is not. (the risk is not hypothetical: an earlier attempt at
// path-type classification in this same file did misjudge exactly that
// direction; see declares_only_linear_segments.) real filenames cannot reach
// it either, since '|' is not a legal path character on windows
fn slider_curve_field(line: &str) -> Option<&str> {
    let mut fields = line.split(',');
    fields.next()?; // x
    fields.next()?; // y
    fields.next()?; // time
    fields.next()?; // type
    fields.next()?; // hitSound
    fields.next()
}

// mirrors the acceptance behaviour of rosu_map's read_point
// (section/hit_objects/decode.rs:236-247): it splits the token on *every*
// ':' and lazily takes only the first two segments via `v.next().zip(v.next())`,
// so a third-and-beyond segment is never parsed at all -- "101:100:99" is a
// perfectly valid (101, 100) point there. requiring the whole remainder
// after the first colon to parse would under-count exactly those tokens and
// let an arbitrarily expensive slider past the guard
//
// each segment is compared with a plain trimmed f64 parse, matching
// rosu-map's `s.trim().parse()` inside parse_with_limits but without its
// extra NaN and MAX_COORDINATE_VALUE range rejections. that makes this test
// a strict superset of rosu-map's: every token rosu-map reads as a point is
// counted here, while a handful rosu-map would reject (nan, inf, huge
// magnitudes) are counted too -- over-counting only over-rejects, which the
// declared-count policy already sanctions, whereas under-counting reopens
// the bypass this guard exists to close
fn is_coordinate_token(token: &str) -> bool {
    let mut segments = token.split(':');
    let (Some(x), Some(y)) = (segments.next(), segments.next()) else {
        return false;
    };
    x.trim().parse::<f64>().is_ok() && y.trim().parse::<f64>().is_ok()
}

// mirrors rosu_map::util::str_ext::StrExt::trim_comment: cut the line at the
// first `//` and trim what trailing whitespace that exposes. rosu-map applies
// this inside its [HitObjects] parser (section/hit_objects/decode.rs:558) --
// *after* the whole-line skip and section detection, never before them -- so
// the scan applies it at exactly the same point and nowhere earlier. doing it
// earlier would diverge the opposite way, since `Section::try_from_line` sees
// the untrimmed line
fn trim_comment(line: &str) -> &str {
    // `//` is ascii, so the byte index `find` returns is always a char boundary
    line.find("//").map_or(line, |i| &line[..i]).trim_end()
}

// true only when EVERY segment rosu-map would build is linear.
//
// the direction of this default is the whole point. over-classifying a linear
// slider as curved costs nothing (it only lowers an already-generous ceiling on
// a shape that parses in O(n) anyway), while under-classifying a curved one as
// linear hands it the 100,000-point budget and reopens the quadratic parse this
// guard exists to prevent. so the segment model has to match rosu-map's exactly
// rather than approximate it:
//
//   - the FIRST token is always a path type, whatever it looks like
//     (section/hit_objects/decode.rs:254-258 maps `points.first()` through
//     `PathType::new_from_str` unconditionally). a slider written
//     `1:1|2:2|L|3:3` therefore opens with a CATMULL segment, even though its
//     only letter is an `L` -- reading past a coordinate-shaped first token to
//     find the "real" type is exactly how a catmull path sneaks into the
//     generous budget
//   - after that, a new segment starts at every token whose first character is
//     ascii-alphabetic (decode.rs:197-201)
//   - a segment is linear iff its leading token's FIRST CHARACTER is `L`
//     (path_type.rs:35-51 matches `Some('L')` and falls through to
//     `_ => CATMULL` for everything else, lowercase `l` and a leading space
//     included). the token is deliberately not trimmed here: rosu-map does not
//     trim it either, so `" L"` is catmull to it and must be to us
fn declares_only_linear_segments(curve_field: &str) -> bool {
    let mut tokens = curve_field.split('|');

    let leads_a_linear_segment = |token: &str| token.starts_with('L');

    // the first token types the first segment, coordinate-shaped or not
    let Some(first) = tokens.next() else {
        return false;
    };
    if !leads_a_linear_segment(first) {
        return false;
    }

    tokens.all(|token| match token.chars().next() {
        // starts a new segment, so it types that segment
        Some(character) if character.is_ascii_alphabetic() => leads_a_linear_segment(token),
        // an ordinary coordinate token, carrying no type of its own
        Some(_) => true,
        // rosu-map raises InvalidLine on an empty token rather than parsing on,
        // so the file never decodes; classify conservatively regardless
        None => false,
    })
}

fn check_slider_declared_point_count(line: &str) -> Result<()> {
    // an inline comment is not slider data: rosu-map cuts it off before it ever
    // splits the hit-object fields, so counting coordinate-shaped tokens inside
    // one would reject a file rosu-map parses without complaint
    let Some(curve_field) = slider_curve_field(trim_comment(line)) else {
        return Ok(());
    };

    // +1 for the head point, which precedes the curveType prefix and is
    // never itself a piped token. path-type letters -- leading or embedded
    // mid-field, e.g. the second "B" in "B|1:1|2:2|B|3:3|4:4" -- never
    // parse as an x:y pair, so they fall out of the count on their own
    // without needing any special-case handling
    let declared_points = 1 + curve_field
        .split('|')
        .filter(|token| is_coordinate_token(token))
        .count();

    // only the linear family is genuinely O(n) in rosu-map; every other one is
    // superlinear in points or in emitted vertices, so the two cases cannot
    // share one ceiling without either starving legitimate linear sliders or
    // admitting a slider that takes minutes to parse. see
    // limits::MAX_NONLINEAR_SLIDER_CONTROL_POINTS
    // for the measured cost curve behind the second number
    let (cap_name, cap) = if declares_only_linear_segments(curve_field) {
        ("MAX_SLIDER_CONTROL_POINTS", limits::MAX_SLIDER_CONTROL_POINTS)
    } else {
        (
            "MAX_NONLINEAR_SLIDER_CONTROL_POINTS",
            limits::MAX_NONLINEAR_SLIDER_CONTROL_POINTS,
        )
    };

    if declared_points > cap {
        return Err(resource_limit(cap_name, cap as u64, declared_points as u64));
    }

    Ok(())
}

fn convert(raw: rosu_map::Beatmap) -> Result<Beatmap> {
    let mode = convert_mode(raw.mode);
    if mode != GameMode::Osu {
        return Err(EngineError::UnsupportedMode(mode));
    }
    if raw.hit_objects.len() > limits::MAX_HIT_OBJECTS {
        return Err(resource_limit(
            "MAX_HIT_OBJECTS",
            limits::MAX_HIT_OBJECTS as u64,
            raw.hit_objects.len() as u64,
        ));
    }

    let offset = if raw.format_version < 5 {
        EARLY_VERSION_TIMING_OFFSET
    } else {
        0.0
    };

    use rosu_map::section::hit_objects::HitObjectKind as RosuKind;

    let mut hit_objects = Vec::with_capacity(raw.hit_objects.len());
    for obj in &raw.hit_objects {
        let converted = match &obj.kind {
            RosuKind::Circle(c) => HitObject {
                start_time: obj.start_time + offset,
                pos: Vec2::new(c.pos.x, c.pos.y),
                new_combo: c.new_combo,
                combo_offset: c.combo_offset,
                kind: HitObjectKind::Circle,
            },
            RosuKind::Slider(s) => {
                // rosu-map already stores control points relative to the
                // slider head, matching lazer semantics consumed by task 9
                let raw_cps = s.path.control_points();
                if raw_cps.len() > limits::MAX_SLIDER_CONTROL_POINTS {
                    return Err(resource_limit(
                        "MAX_SLIDER_CONTROL_POINTS",
                        limits::MAX_SLIDER_CONTROL_POINTS as u64,
                        raw_cps.len() as u64,
                    ));
                }
                HitObject {
                    start_time: obj.start_time + offset,
                    pos: Vec2::new(s.pos.x, s.pos.y),
                    new_combo: s.new_combo,
                    combo_offset: s.combo_offset,
                    kind: HitObjectKind::Slider(SliderData {
                        control_points: raw_cps
                            .iter()
                            .map(|cp| PathControlPoint {
                                pos: Vec2::new(cp.pos.x, cp.pos.y),
                                path_type: cp.path_type.map(convert_path_type),
                            })
                            .collect(),
                        expected_distance: s.path.expected_dist(),
                        repeat_count: s.repeat_count,
                    }),
                }
            }
            RosuKind::Spinner(s) => HitObject {
                start_time: obj.start_time + offset,
                pos: Vec2::new(s.pos.x, s.pos.y),
                new_combo: s.new_combo,
                combo_offset: 0,
                kind: HitObjectKind::Spinner { duration: s.duration },
            },
            RosuKind::Hold(_) => {
                return Err(EngineError::BeatmapParse("hold object in an osu! beatmap".into()))
            }
        };
        hit_objects.push(converted);
    }

    let timing_points = raw
        .control_points
        .timing_points
        .iter()
        .map(|tp| TimingPoint { time: tp.time + offset, beat_len: tp.beat_len })
        .collect();
    let difficulty_points = raw
        .control_points
        .difficulty_points
        .iter()
        .map(|dp| DifficultyPoint {
            time: dp.time + offset,
            slider_velocity: dp.slider_velocity,
            generate_ticks: dp.generate_ticks,
        })
        .collect();

    Ok(Beatmap {
        format_version: raw.format_version,
        mode,
        title: raw.title,
        artist: raw.artist,
        creator: raw.creator,
        version: raw.version,
        beatmap_id: raw.beatmap_id,
        beatmap_set_id: raw.beatmap_set_id,
        audio_file: raw.audio_file,
        audio_lead_in: raw.audio_lead_in,
        background_file: raw.background_file,
        stack_leniency: raw.stack_leniency,
        // legacybeatmapdecoder.cs:118-132 (applydifficultyrestrictions) --
        // lazer clamps difficulty settings to their allowed ranges after
        // parsing; rosu-map clamps slider_multiplier and slider_tick_rate
        // itself but stores these four raw, so deriving scale/preempt/windows
        // from them unclamped would diverge (e.g. cs 20 yields a negative
        // circle scale instead of behaving as cs 10)
        hp_drain_rate: raw.hp_drain_rate.clamp(0.0, 10.0),
        circle_size: raw.circle_size.clamp(0.0, 10.0),
        overall_difficulty: raw.overall_difficulty.clamp(0.0, 10.0),
        approach_rate: raw.approach_rate.clamp(0.0, 10.0),
        slider_multiplier: raw.slider_multiplier,
        slider_tick_rate: raw.slider_tick_rate,
        combo_colors: raw.custom_combo_colors.iter().map(|c| c.0).collect(),
        timing_points,
        difficulty_points,
        hit_objects,
    })
}

fn convert_mode(mode: rosu_map::section::general::GameMode) -> GameMode {
    use rosu_map::section::general::GameMode as RosuMode;
    match mode {
        RosuMode::Osu => GameMode::Osu,
        RosuMode::Taiko => GameMode::Taiko,
        RosuMode::Catch => GameMode::Catch,
        RosuMode::Mania => GameMode::Mania,
    }
}

fn convert_path_type(pt: rosu_map::section::hit_objects::PathType) -> PathType {
    use rosu_map::section::hit_objects::SplineType;
    match pt.kind {
        SplineType::Linear => PathType::Linear,
        SplineType::Catmull => PathType::Catmull,
        SplineType::PerfectCurve => PathType::PerfectCurve,
        SplineType::BSpline => match pt.degree {
            Some(d) => PathType::BSpline(d.get()),
            None => PathType::Bezier,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL_OSU: &str = "osu file format v14

[General]
AudioFilename: audio.mp3
AudioLeadIn: 500
Mode: 0

[Metadata]
Title:Test Song
Artist:Test Artist
Creator:mapper
Version:Insane
BeatmapID:12345
BeatmapSetID:678

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:8
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
500,344.827586206897,4,2,1,60,1,0

[HitObjects]
256,192,1000,5,0,0:0:0:0:
100,100,2000,2,0,B|200:100|200:200,2,141.9
";

    #[test]
    fn decodes_minimal_beatmap() {
        let map = decode_beatmap_bytes(MINIMAL_OSU.as_bytes()).unwrap();
        assert_eq!(map.format_version, 14);
        assert_eq!(map.mode, GameMode::Osu);
        assert_eq!(map.title, "Test Song");
        assert_eq!(map.audio_file, "audio.mp3");
        assert_eq!(map.audio_lead_in, 500.0);
        assert_eq!(map.circle_size, 4.0);
        assert_eq!(map.approach_rate, 9.0);
        assert_eq!(map.slider_multiplier, 1.4);
        assert_eq!(map.hit_objects.len(), 2);

        let circle = &map.hit_objects[0];
        assert_eq!(circle.start_time, 1000.0);
        assert_eq!(circle.pos, Vec2::new(256.0, 192.0));
        assert!(circle.new_combo);
        assert!(matches!(circle.kind, HitObjectKind::Circle));

        let slider = &map.hit_objects[1];
        let HitObjectKind::Slider(data) = &slider.kind else {
            panic!("expected slider")
        };
        // lazer stores slider control points relative to the head position
        assert_eq!(slider.pos, Vec2::new(100.0, 100.0));
        assert_eq!(data.control_points.len(), 3);
        assert_eq!(data.control_points[0].pos, Vec2::ZERO);
        assert_eq!(data.control_points[0].path_type, Some(PathType::Bezier));
        assert_eq!(data.control_points[1].pos, Vec2::new(100.0, 0.0));
        assert_eq!(data.control_points[2].pos, Vec2::new(100.0, 100.0));
        assert_eq!(data.expected_distance, Some(141.9));
        assert_eq!(data.repeat_count, 1); // slides=2 -> one repeat
    }

    #[test]
    fn out_of_range_difficulty_settings_clamp_like_lazer() {
        // legacybeatmapdecoder.cs:118-132: hp/cs/od/ar clamp to [0, 10];
        // rosu-map stores them raw, so the clamp is convert's responsibility
        let wild = MINIMAL_OSU
            .replace("HPDrainRate:5", "HPDrainRate:99")
            .replace("CircleSize:4", "CircleSize:20")
            .replace("OverallDifficulty:8", "OverallDifficulty:-3")
            .replace("ApproachRate:9", "ApproachRate:10.7");
        let map = decode_beatmap_bytes(wild.as_bytes()).unwrap();
        assert_eq!(map.hp_drain_rate, 10.0);
        assert_eq!(map.circle_size, 10.0);
        assert_eq!(map.overall_difficulty, 0.0);
        assert_eq!(map.approach_rate, 10.0);

        // in-range values pass through untouched
        let map = decode_beatmap_bytes(MINIMAL_OSU.as_bytes()).unwrap();
        assert_eq!(map.hp_drain_rate, 5.0);
        assert_eq!(map.circle_size, 4.0);
        assert_eq!(map.overall_difficulty, 8.0);
        assert_eq!(map.approach_rate, 9.0);
    }

    #[test]
    fn rejects_non_osu_mode() {
        let taiko = MINIMAL_OSU.replace("Mode: 0", "Mode: 1");
        match decode_beatmap_bytes(taiko.as_bytes()) {
            Err(EngineError::UnsupportedMode(GameMode::Taiko)) => {}
            other => panic!("expected UnsupportedMode(Taiko), got {other:?}"),
        }
    }

    #[test]
    fn malformed_inputs_never_panic() {
        // tolerant-decoder posture: rosu-map mirrors lazer, so junk decodes to
        // defaults rather than erroring; the guarantee under test is no panic
        let corpus: &[&[u8]] = &[
            b"",
            b"garbage\x00\xff\xfe",
            b"osu file format v14",
            &MINIMAL_OSU.as_bytes()[..MINIMAL_OSU.len() / 2],
            b"osu file format v3\n\n[HitObjects]\n256,192,1000",
        ];
        for bytes in corpus {
            let _ = decode_beatmap_bytes(bytes); // ok or err both fine, panic is failure
        }
    }

    #[test]
    fn precheck_never_panics_on_malformed_hit_object_lines() {
        // every one of these exercises a shape the pre-parse scan has to
        // walk before rosu-map ever runs: CRLF line endings, a section
        // header sitting at EOF, lines with fewer than the six comma fields
        // a curve field needs, empty and colon-only and non-numeric piped
        // tokens, a bare comment, and a truncated final line
        let corpus: &[&[u8]] = &[
            b"osu file format v14\r\n\r\n[HitObjects]\r\n100,100,1000,2,0,B|110:100|120:100,1,100\r\n",
            b"osu file format v14\n\n[HitObjects]",
            b"osu file format v14\n\n[HitObjects]\n",
            b"osu file format v14\n\n[HitObjects]\n100,100",
            b"osu file format v14\n\n[HitObjects]\n,,,,,",
            b"osu file format v14\n\n[HitObjects]\n100,100,1000,2,0,B||||,1,100\n",
            b"osu file format v14\n\n[HitObjects]\n100,100,1000,2,0,B|:|::|:::|110:,1,100\n",
            b"osu file format v14\n\n[HitObjects]\n100,100,1000,2,0,B|abc:def|110:xyz|:100,1,100\n",
            b"osu file format v14\n\n[HitObjects]\n100,100,1000,2,0,B|1e999:100|nan:inf,1,100\n",
            b"osu file format v14\n\n[HitObjects]\n//\n//,,,,,\n100,100,1000,2,0,B|110:100",
            b"\xff\xfe[HitObjects]\x00",
            b"\xef\xbb\xbfosu file format v14\n[HitObjects]\n100,100,1000,2,0,B|\xff\xfe:100,1,100\n",
        ];
        for bytes in corpus {
            let _ = decode_beatmap_bytes(bytes); // ok or err both fine, panic is failure
        }
    }

    #[test]
    fn osu_byte_size_cap_boundary() {
        let mut at_limit = MINIMAL_OSU.as_bytes().to_vec();
        at_limit.resize(limits::MAX_OSU_FILE_BYTES as usize, b' ');
        assert!(decode_beatmap_bytes(&at_limit).is_ok());

        at_limit.push(b' ');
        match decode_beatmap_bytes(&at_limit) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_OSU_FILE_BYTES",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn osu_byte_size_cap_boundary_through_the_path_entry_point() {
        // the same boundary as osu_byte_size_cap_boundary, but through
        // decode_beatmap_path -- the entry point that used to reach the cap only
        // after `std::fs::read` had already allocated a buffer sized from the
        // file's metadata, so an oversized file aborted on allocation instead of
        // returning ResourceLimit. the oversized case is deliberately only one
        // byte past the cap rather than genuinely huge: what is being proven is
        // that the length is consulted before the read, and a test that needed a
        // 40 GiB file on disk to prove it would be untestable
        let dir = std::env::temp_dir().join("engine-osu-path-cap-boundary");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("boundary.osu");

        let mut at_limit = MINIMAL_OSU.as_bytes().to_vec();
        at_limit.resize(limits::MAX_OSU_FILE_BYTES as usize, b' ');
        std::fs::write(&path, &at_limit).expect("write at-limit file");
        assert!(decode_beatmap_path(&path).is_ok());

        at_limit.push(b' ');
        std::fs::write(&path, &at_limit).expect("write past-limit file");
        let past = decode_beatmap_path(&path);
        let _ = std::fs::remove_file(&path);
        match past {
            Err(EngineError::ResourceLimit {
                cap: "MAX_OSU_FILE_BYTES",
                limit: limits::MAX_OSU_FILE_BYTES,
                actual,
            }) => assert_eq!(actual, limits::MAX_OSU_FILE_BYTES + 1),
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn hit_object_count_cap_boundary() {
        let build = |count: usize| {
            let mut s = String::from("osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n");
            for i in 0..count {
                s.push_str(&format!("256,192,{},1,0,0:0:0:0:\n", 1000 + i));
            }
            s
        };
        let at_limit = build(limits::MAX_HIT_OBJECTS);
        assert!(decode_beatmap_bytes(at_limit.as_bytes()).is_ok());

        let past = build(limits::MAX_HIT_OBJECTS + 1);
        match decode_beatmap_bytes(past.as_bytes()) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_HIT_OBJECTS",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn slider_control_point_count_cap_boundary() {
        // path type "L" (linear) so rosu-map's curve approximation stays
        // O(n) during parsing; a "B" bezier of this size would drive the
        // library's De Casteljau subdivision quadratic and hang the test
        //
        // start coordinates at 101 (not 100) so no piped point coincides
        // with the slider head at (100,100) -- a coincident point gets
        // silently collapsed by rosu-map's duplicate-vertex handling,
        // which would throw off the exact-boundary count this test relies on
        let build = |piped_points: usize| {
            let mut path = String::from("L");
            for i in 0..piped_points {
                let x = 101 + i as i32;
                path.push_str(&format!("|{}:{}", x, 100));
            }
            format!(
                "osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n100,100,1000,2,0,{},1,100\n",
                path
            )
        };
        // head point + piped points = total control points
        let at_limit = build(limits::MAX_SLIDER_CONTROL_POINTS - 1);
        assert!(decode_beatmap_bytes(at_limit.as_bytes()).is_ok());

        let past = build(limits::MAX_SLIDER_CONTROL_POINTS);
        match decode_beatmap_bytes(past.as_bytes()) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_SLIDER_CONTROL_POINTS",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn slider_control_point_precheck_rejects_large_bezier_quickly() {
        // this is the pathological case the pre-parse scan exists for: a
        // genuine "B" (bezier) slider comfortably past the cap. rosu-map's
        // curve computation for bezier paths is effectively quadratic in
        // point count
        //
        // this test only proves anything if rejection happens fast -- a
        // regression back to post-parse-only checking would hang here
        // rather than fail
        let piped_points = limits::MAX_SLIDER_CONTROL_POINTS + 200_000;
        let mut path = String::from("B");
        for i in 0..piped_points {
            path.push_str(&format!("|{}:{}", 101 + i as i32, 100));
        }
        let osu = format!(
            "osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n100,100,1000,2,0,{},1,100\n",
            path
        );

        let start = std::time::Instant::now();
        match decode_beatmap_bytes(osu.as_bytes()) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_NONLINEAR_SLIDER_CONTROL_POINTS",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "rejection should be near-instant via the pre-parse scan, took {elapsed:?}"
        );
    }

    #[test]
    fn precheck_recognizes_hit_objects_header_with_trailing_whitespace() {
        // rosu-map's line reader trim_end()s every decoded line before
        // section detection, so "[HitObjects] " (trailing space) is still
        // recognized as the HitObjects section header there -- the pre-scan
        // must match that or a trailing-whitespace header silently bypasses
        // the cap guard while rosu-map parses the file normally
        let piped_points = limits::MAX_SLIDER_CONTROL_POINTS + 50_000;
        let mut path = String::from("B");
        for i in 0..piped_points {
            path.push_str(&format!("|{}:{}", 101 + i as i32, 100));
        }
        let osu = format!(
            "osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects] \n100,100,1000,2,0,{},1,100\n",
            path
        );

        match decode_beatmap_bytes(osu.as_bytes()) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_NONLINEAR_SLIDER_CONTROL_POINTS",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    fn curved_slider_osu(piped_points: usize) -> String {
        let mut path = String::from("B");
        for i in 0..piped_points {
            path.push_str(&format!(
                "|{}:{}",
                101 + (i % 130000) as i32,
                100 + (i / 130000) as i32
            ));
        }
        format!("osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n100,100,1000,2,0,{path},1,100\n")
    }

    #[test]
    fn a_coordinate_shaped_first_token_does_not_buy_the_linear_budget() {
        // rosu-map types the first segment from the FIRST token unconditionally
        // (decode.rs:254-258 -> path_type.rs:35-51), so "1:1" leads a CATMULL
        // segment here despite the only letter in the field being an "L".
        // classifying this as linear would hand a catmull path the 100,000-point
        // budget -- catmull reserves (points - 1) * 100 vertices in rosu-map
        let mut path = String::from("1:1|2:2|L");
        for i in 0..limits::MAX_NONLINEAR_SLIDER_CONTROL_POINTS {
            path.push_str(&format!("|{}:100", 101 + (i % 130000) as i32));
        }
        let osu = format!(
            "osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n100,100,1000,2,0,{path},1,100\n"
        );

        match decode_beatmap_bytes(osu.as_bytes()) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_NONLINEAR_SLIDER_CONTROL_POINTS",
                ..
            }) => {}
            other => panic!("expected the strict cap, got {other:?}"),
        }
    }

    #[test]
    fn linear_classification_matches_rosu_maps_first_character_rule() {
        // path_type.rs:35-51 matches on the leading character only, with
        // `_ => CATMULL`. an untrimmed leading space, a lowercase letter, or a
        // curved type anywhere in a compound path all mean "not linear"
        assert!(declares_only_linear_segments("L|1:1|2:2"));
        assert!(declares_only_linear_segments("L|1:1|L|2:2"));
        assert!(declares_only_linear_segments("Lfoo|1:1"));

        assert!(!declares_only_linear_segments(" L|1:1")); // leading space -> catmull
        assert!(!declares_only_linear_segments("l|1:1")); // lowercase -> catmull
        assert!(!declares_only_linear_segments("1:1|2:2|L|3:3")); // first segment catmull
        assert!(!declares_only_linear_segments("L|1:1|B|2:2")); // compound with bezier
        assert!(!declares_only_linear_segments("L|1:1|P|2:2")); // compound with perfect
        assert!(!declares_only_linear_segments("B|1:1"));
        assert!(!declares_only_linear_segments(""));
    }

    #[test]
    fn nonlinear_slider_cap_boundary() {
        // head point + piped points = declared total
        let at_limit = curved_slider_osu(limits::MAX_NONLINEAR_SLIDER_CONTROL_POINTS - 1);
        assert!(decode_beatmap_bytes(at_limit.as_bytes()).is_ok());

        let past = curved_slider_osu(limits::MAX_NONLINEAR_SLIDER_CONTROL_POINTS);
        match decode_beatmap_bytes(past.as_bytes()) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_NONLINEAR_SLIDER_CONTROL_POINTS",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn a_curved_slider_at_the_linear_cap_is_rejected_before_the_quadratic_parse() {
        // the hazard MAX_NONLINEAR_SLIDER_CONTROL_POINTS exists for: this
        // slider sits at the *linear* cap, so the shared 100,000 ceiling let it
        // through to rosu-map, whose bezier subdivision is quadratic. measured
        // at this size it costs >1s in release and ~45s in debug for a single
        // slider, and a 32 MiB file has room for roughly 45 of them
        let osu = curved_slider_osu(limits::MAX_SLIDER_CONTROL_POINTS - 1);

        let start = std::time::Instant::now();
        match decode_beatmap_bytes(osu.as_bytes()) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_NONLINEAR_SLIDER_CONTROL_POINTS",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "must be rejected by the pre-parse scan, not after the quadratic parse; took {elapsed:?}"
        );
    }

    #[test]
    fn utf16_code_unit_containing_0x0a_cannot_hide_the_hit_objects_header() {
        // U+010A encodes as the bytes `0A 01` in UTF-16LE. rosu-map splits
        // lines on the raw byte 0x0A *before* decoding, so it breaks there and
        // enters [HitObjects]; a scan that decoded first and then split on
        // char boundaries would see one unbroken line, never enter the section,
        // and wave the oversized slider through to the quadratic parser
        let osu = format!(
            "osu file format v14\n\n[General]\nMode: 0\u{010A}[HitObjects]\n100,100,1000,2,0,{},1,100\n",
            {
                let mut path = String::from("B");
                for i in 0..limits::MAX_SLIDER_CONTROL_POINTS {
                    path.push_str(&format!("|{}:100", 101 + (i % 130000) as i32));
                }
                path
            }
        );
        // the header is genuinely not on a line of its own in the decoded text
        assert!(!osu.lines().any(|line| line.trim_end() == "[HitObjects]"));

        let mut utf16le = vec![0xFFu8, 0xFE]; // BOM
        for unit in osu.encode_utf16() {
            utf16le.extend_from_slice(&unit.to_le_bytes());
        }

        match decode_beatmap_bytes(&utf16le) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_NONLINEAR_SLIDER_CONTROL_POINTS",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn precheck_handles_utf16_bom_encoded_files() {
        // rosu-map explicitly detects and decodes UTF-16LE/BE beatmaps via
        // a BOM before any line splitting; the pre-scan must decode under
        // the same encoding or it never sees "[HitObjects]" at all in the
        // raw undecoded bytes and the guard is silently skipped
        let piped_points = limits::MAX_SLIDER_CONTROL_POINTS + 50_000;
        let mut path = String::from("B");
        for i in 0..piped_points {
            path.push_str(&format!("|{}:{}", 101 + i as i32, 100));
        }
        let osu = format!(
            "osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n100,100,1000,2,0,{},1,100\n",
            path
        );

        let mut utf16le = vec![0xFFu8, 0xFE]; // BOM
        for unit in osu.encode_utf16() {
            utf16le.extend_from_slice(&unit.to_le_bytes());
        }

        match decode_beatmap_bytes(&utf16le) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_NONLINEAR_SLIDER_CONTROL_POINTS",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn precheck_ignores_unrecognized_bracketed_lines_inside_hit_objects() {
        // rosu-map only transitions section on its known section names
        // (Section::try_from_line); a bracketed line that isn't one of them
        // does not end [HitObjects] for rosu-map, so the scan must not
        // treat it as ending the section either -- otherwise an oversized
        // slider right after it would slip through unchecked
        let piped_points = limits::MAX_SLIDER_CONTROL_POINTS + 50_000;
        let mut path = String::from("B");
        for i in 0..piped_points {
            path.push_str(&format!("|{}:{}", 101 + i as i32, 100));
        }
        let osu = format!(
            "osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n[NotASection]\n100,100,1000,2,0,{},1,100\n",
            path
        );

        match decode_beatmap_bytes(osu.as_bytes()) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_NONLINEAR_SLIDER_CONTROL_POINTS",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn precheck_counts_trailing_duplicate_point_toward_declared_total() {
        // rosu-map exempts a duplicate landing on the very last vertex from
        // splitting the segment there, so a segment-aware guard could be
        // fooled into treating this file as safe while rosu-map spends real
        // quadratic time on it. the declared-count policy has no notion of
        // segments or exemptions at all: every token that looks like a
        // coordinate counts, including a trailing duplicate
        let distinct_points = limits::MAX_SLIDER_CONTROL_POINTS;
        let mut path = String::from("L");
        let mut last = (0, 0);
        for i in 0..distinct_points {
            let x = 101 + i as i32;
            path.push_str(&format!("|{x}:100"));
            last = (x, 100);
        }
        path.push_str(&format!("|{}:{}", last.0, last.1)); // trailing duplicate

        let osu = format!(
            "osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n100,100,1000,2,0,{path},1,100\n"
        );

        match decode_beatmap_bytes(osu.as_bytes()) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_SLIDER_CONTROL_POINTS",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn precheck_rejects_declared_count_over_cap_even_when_dedup_would_pass() {
        // documents the ruled policy: MAX_SLIDER_CONTROL_POINTS bounds the
        // DECLARED point count, not the post-dedup total rosu-map would
        // eventually compute. this slider's final deduped size would be
        // well under the cap (rosu-map would collapse each
        // duplicate-anchored pair down to a single point), but the pre-scan
        // rejects it anyway -- that is what the policy says, not a guess
        // about rosu-map's dedup behavior
        let pairs = 60_000;
        let mut path = String::from("L");
        let mut x = 101;
        for _ in 0..pairs {
            path.push_str(&format!("|{x}:100"));
            path.push_str(&format!("|{x}:100")); // duplicate of the point above
            x += 1;
        }
        let declared_points = 1 + pairs * 2; // head + every piped token, no dedup
        assert!(declared_points > limits::MAX_SLIDER_CONTROL_POINTS);

        let osu = format!(
            "osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n100,100,1000,2,0,{path},1,100\n"
        );

        match decode_beatmap_bytes(osu.as_bytes()) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_SLIDER_CONTROL_POINTS",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn precheck_accepts_duplicate_anchored_slider_under_the_cap() {
        // same duplicate-anchor mapper pattern as the policy test above,
        // but with a declared count comfortably under the cap -- this one
        // must decode normally, proving the policy only rejects sliders
        // that actually declare too many points
        let pairs = 1_000; // declared = 1 + 2_000, comfortably under the cap
        let mut path = String::from("B");
        let mut x = 101;
        for _ in 0..pairs {
            path.push_str(&format!("|{x}:100"));
            path.push_str(&format!("|{x}:100"));
            x += 1;
        }
        let osu = format!(
            "osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n100,100,1000,2,0,{path},1,100\n"
        );

        let map =
            decode_beatmap_bytes(osu.as_bytes()).expect("small duplicate-anchored slider should decode");
        assert_eq!(map.hit_objects.len(), 1);
    }

    #[test]
    fn precheck_counts_multi_colon_coordinate_tokens_like_rosu_map_does() {
        // rosu-map's read_point splits a curve token on every ':' but only
        // ever pulls the first two segments out of a lazy iterator, so
        // "110:100:99" is a genuine (110, 100) control point there and the
        // trailing ":99" is never parsed at all -- asserted first so this
        // test fails loudly rather than silently if that ever changes
        let small = "osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n100,100,1000,2,0,B|110:100:99|120:100:99,1,100\n";
        let map = decode_beatmap_bytes(small.as_bytes()).expect("multi-colon points should decode");
        assert_eq!(map.hit_objects.len(), 1);
        let HitObjectKind::Slider(data) = &map.hit_objects[0].kind else {
            panic!("expected slider")
        };
        assert_eq!(data.control_points.len(), 3);
        assert_eq!(data.control_points[1].pos, Vec2::new(10.0, 0.0));
        assert_eq!(data.control_points[2].pos, Vec2::new(20.0, 0.0));

        // so the pre-scan has to count them too. a whole-remainder float
        // check would count zero of these tokens and hand rosu-map a
        // 100,001-point bezier, whose curve computation is quadratic -- the
        // timing assertion is what distinguishes the pre-scan rejection
        // from the post-parse one, since convert() would eventually reject
        // this too, just 60+ seconds later
        let piped_points = limits::MAX_SLIDER_CONTROL_POINTS;
        let mut path = String::from("B");
        for i in 0..piped_points {
            path.push_str(&format!("|{}:100:99", 101 + i as i32));
        }
        let osu = format!(
            "osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n100,100,1000,2,0,{path},1,100\n"
        );

        let start = std::time::Instant::now();
        match decode_beatmap_bytes(osu.as_bytes()) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_NONLINEAR_SLIDER_CONTROL_POINTS",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "multi-colon tokens must be caught by the pre-parse scan, took {elapsed:?}"
        );
    }

    #[test]
    fn precheck_skips_comment_lines_inside_hit_objects() {
        // rosu-map drops every line whose trim_start() begins with "//"
        // before section detection and before any section parser runs
        // (DecodeBeatmap::should_skip_line), so a commented-out slider
        // costs it nothing no matter how many points it declares. a
        // pre-scan that inspected the line anyway would reject a file
        // rosu-map decodes without complaint
        let piped_points = limits::MAX_SLIDER_CONTROL_POINTS + 10;
        let mut path = String::from("B");
        for i in 0..piped_points {
            path.push_str(&format!("|{}:100", 101 + i as i32));
        }
        let osu = format!(
            "osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n\
             //100,100,1000,2,0,{path},1,100\n\
             \t  //100,100,1000,2,0,{path},1,100\n\
             256,192,1000,1,0,0:0:0:0:\n"
        );

        let map =
            decode_beatmap_bytes(osu.as_bytes()).expect("a commented-out slider must not trip the cap guard");
        assert_eq!(map.hit_objects.len(), 1);
        assert!(matches!(map.hit_objects[0].kind, HitObjectKind::Circle));
    }

    #[test]
    fn precheck_ignores_inline_comments_on_hit_object_lines() {
        // rosu-map's [HitObjects] parser cuts each line at the first "//"
        // (StrExt::trim_comment, applied at section/hit_objects/decode.rs:558)
        // before it splits any fields, so coordinate-shaped tokens living in a
        // trailing comment are never slider points. counting them would reject
        // a file rosu-map parses without complaint -- and unlike a whole-line
        // comment this one carries a real, small slider in front of it
        let commented_points = limits::MAX_SLIDER_CONTROL_POINTS + 10;
        let mut noise = String::new();
        for i in 0..commented_points {
            noise.push_str(&format!("|{}:100", 101 + i as i32));
        }
        let osu = format!(
            "osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n\
             100,100,1000,2,0,B|110:100|120:100,1,100 // B{noise}\n"
        );

        let map = decode_beatmap_bytes(osu.as_bytes())
            .expect("coordinate tokens inside an inline comment must not trip the cap guard");
        assert_eq!(map.hit_objects.len(), 1);
        let HitObjectKind::Slider(data) = &map.hit_objects[0].kind else {
            panic!("expected slider")
        };
        // the comment contributed nothing: head + the two real piped points
        assert_eq!(data.control_points.len(), 3);
    }

    #[test]
    fn precheck_still_counts_points_before_an_inline_comment() {
        // trimming the comment must not become a way to smuggle an oversized
        // slider past the guard -- everything left of the "//" is still counted
        let piped_points = limits::MAX_SLIDER_CONTROL_POINTS + 10;
        let mut path = String::from("B");
        for i in 0..piped_points {
            path.push_str(&format!("|{}:100", 101 + i as i32));
        }
        let osu = format!(
            "osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n\
             100,100,1000,2,0,{path},1,100 // trailing note\n"
        );

        match decode_beatmap_bytes(osu.as_bytes()) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_NONLINEAR_SLIDER_CONTROL_POINTS",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {:?}", other.map(|_| "ok")),
        }
    }

    #[test]
    fn precheck_excludes_embedded_path_type_letters_from_declared_count() {
        // a compound slider re-declares its path type mid-field; rosu-map
        // starts a fresh segment at each such letter and never reads it as
        // a point, so it must not count toward the declared total either
        let compound = "osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n100,100,1000,2,0,B|110:100|120:100|B|130:100|140:100,1,100\n";
        let map = decode_beatmap_bytes(compound.as_bytes()).expect("compound slider should decode");
        assert_eq!(map.hit_objects.len(), 1);
        let HitObjectKind::Slider(data) = &map.hit_objects[0].kind else {
            panic!("expected slider")
        };
        assert_eq!(data.control_points.len(), 5);
        assert_eq!(data.control_points[0].path_type, Some(PathType::Bezier));
        assert_eq!(data.control_points[3].path_type, Some(PathType::Bezier));
        assert_eq!(data.control_points[4].pos, Vec2::new(40.0, 0.0));

        // scaled to the boundary: exactly MAX - 1 coordinate tokens, broken
        // into two-point segments by ~50,000 embedded "L" letters. declared
        // = head + MAX - 1 = the cap exactly, so this must decode; counting
        // the letters as points would put it at ~150,000 and reject it
        let coordinate_tokens = limits::MAX_SLIDER_CONTROL_POINTS - 1;
        let mut path = String::from("L");
        let mut embedded_letters = 0;
        for i in 0..coordinate_tokens {
            // never let a letter be the field's last token, and never leave
            // a trailing segment with no points of its own
            if i > 0 && i % 2 == 0 && coordinate_tokens - i >= 2 {
                path.push_str("|L");
                embedded_letters += 1;
            }
            path.push_str(&format!("|{}:100", 101 + i as i32));
        }
        assert!(1 + coordinate_tokens + embedded_letters > limits::MAX_SLIDER_CONTROL_POINTS);

        let osu = format!(
            "osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n100,100,1000,2,0,{path},1,100\n"
        );

        let map = decode_beatmap_bytes(osu.as_bytes())
            .expect("compound slider at the declared-point cap should decode");
        let HitObjectKind::Slider(data) = &map.hit_objects[0].kind else {
            panic!("expected slider")
        };
        assert_eq!(data.control_points.len(), limits::MAX_SLIDER_CONTROL_POINTS);
    }

    #[test]
    fn decodes_timing_and_difficulty_points() {
        let map = decode_beatmap_bytes(MINIMAL_OSU.as_bytes()).unwrap();
        assert_eq!(map.timing_points.len(), 1);
        assert_eq!(map.timing_points[0].time, 500.0);
        assert!((map.timing_points[0].beat_len - 344.827586206897).abs() < 1e-9);
        assert!(map.difficulty_points.is_empty());
    }

    #[test]
    fn inherited_point_decodes_to_clamped_slider_velocity() {
        // -50 -> sv 2.0; -5 -> raw sv 20 clamped to 10 (difficulty.rs:18 in
        // rosu-map mirrors lazer's SliderVelocityBindable 0.1..10 clamp)
        let osu = MINIMAL_OSU.replace(
            "500,344.827586206897,4,2,1,60,1,0",
            "500,344.827586206897,4,2,1,60,1,0\n1000,-50,4,2,1,60,0,0\n2000,-5,4,2,1,60,0,0",
        );
        let map = decode_beatmap_bytes(osu.as_bytes()).unwrap();
        assert_eq!(map.difficulty_points.len(), 2);
        assert_eq!(map.difficulty_points[0].time, 1000.0);
        assert_eq!(map.difficulty_points[0].slider_velocity, 2.0);
        assert!(map.difficulty_points[0].generate_ticks);
        assert_eq!(map.difficulty_points[1].slider_velocity, 10.0);
    }

    #[test]
    fn nan_beat_length_disables_tick_generation() {
        // legacybeatmapdecoder parses inherited beat lengths with allowNaN and
        // LegacyDifficultyControlPoint sets GenerateTicks = !double.IsNaN;
        // rosu-map's DifficultyPoint::new mirrors it (difficulty.rs:19-20)
        let osu = MINIMAL_OSU.replace(
            "500,344.827586206897,4,2,1,60,1,0",
            "500,344.827586206897,4,2,1,60,1,0\n1000,NaN,4,2,1,60,0,0",
        );
        let map = decode_beatmap_bytes(osu.as_bytes()).unwrap();
        assert_eq!(map.difficulty_points.len(), 1);
        assert!(!map.difficulty_points[0].generate_ticks);
    }

    #[test]
    fn early_format_versions_shift_all_times_by_24ms() {
        // legacybeatmapdecoder.cs:30,75 -- v4 and lower bake +24ms into every
        // object and control point time. rosu-map does not do this, so convert
        // must. the replay side mirrors it in replay::frames
        let v4 = MINIMAL_OSU.replace("osu file format v14", "osu file format v4");
        let map = decode_beatmap_bytes(v4.as_bytes()).unwrap();
        assert_eq!(map.format_version, 4);
        assert_eq!(map.hit_objects[0].start_time, 1024.0);
        assert_eq!(map.timing_points[0].time, 524.0);

        let v14 = decode_beatmap_bytes(MINIMAL_OSU.as_bytes()).unwrap();
        assert_eq!(v14.hit_objects[0].start_time, 1000.0);
    }
}
