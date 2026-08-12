//! `.osr` replay decoding: byte framing per `LegacyScoreDecoder.cs`, lazer
//! score-info trailer capture, and capped lzma-alone decompression.

use crate::error::{resource_limit, EngineError, Result};
use crate::formats::GameMode;
use crate::limits;
use crate::math::dotnet_double_to_i32_unchecked;

#[derive(Debug, Clone, PartialEq)]
pub struct OsrFile {
    pub header: OsrHeader,
    pub actions: Vec<ReplayAction>,
    pub compressed_payload: Vec<u8>,
    pub decompressed_payload: Vec<u8>,
    pub trailer: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OsrHeader {
    pub mode: GameMode,
    pub version: u32,
    pub beatmap_md5: Option<String>,
    pub player_name: Option<String>,
    pub replay_md5: Option<String>,
    pub count_300: u16,
    pub count_100: u16,
    pub count_50: u16,
    pub count_geki: u16,
    pub count_katsu: u16,
    pub count_miss: u16,
    pub total_score: u32,
    pub max_combo: u16,
    pub perfect: bool,
    pub mods: u32,
    pub life_graph: Option<String>,
    pub timestamp_ticks: i64,
    pub online_score_id: u64,
}

impl OsrHeader {
    /// the header's judged-object total: `300 + 100 + 50 + miss`. this is
    /// the quantity the corpus admission filter and the viewer's
    /// incompleteness marker compare against the map's object count -- one
    /// definition, so the two can never drift apart on what "complete"
    /// means
    pub fn judged_count(&self) -> u32 {
        u32::from(self.count_300)
            + u32::from(self.count_100)
            + u32::from(self.count_50)
            + u32::from(self.count_miss)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReplayAction {
    pub delta: i64,
    pub x: f32,
    pub y: f32,
    /// raw fourth field, integral because lazer reads it with
    /// `Parsing.ParseInt` (legacyscoredecoder.cs:312) and writes it back as
    /// `(int)legacyFrame.ButtonState` (legacyscoreencoder.cs:174) -- never as a
    /// float. on an ordinary frame it is the button bitfield (interpretation
    /// lands in plan 2); on the terminal `-12345` pseudo-frame the very same
    /// field carries the rng seed instead, and a seed is a full-range `int`.
    ///
    /// this is why the field cannot be `f32`: an f32 carries 24 bits of
    /// significand, so every seed above 2^24 -- which is most of them, seeds
    /// being effectively uniform over `int` -- would decode to a neighbouring
    /// representable value and reserialize as a *different number* than the
    /// replay was written with.
    ///
    /// # deliberate divergence on the terminal pseudo-frame
    ///
    /// lazer `continue`s the moment it sees a raw `-12345` delta token
    /// (legacyscoredecoder.cs:282-286), *before* parsing x, y or z at all, so it
    /// tolerates junk in those three fields on that one frame -- `-12345|0|0|1.5`
    /// decodes fine there and is rejected here. this port cannot copy that: it
    /// retains every frame verbatim for re-encoding, so it has to give the field
    /// a value, and no integer represents `1.5`. rejecting with a typed error is
    /// the honest outcome; the alternative this replaces silently rounded the
    /// value instead. no encoder -- stable's or lazer's -- writes a non-integral
    /// z, so this is unreachable outside hand-crafted input.
    ///
    /// in the other direction, `Parsing.ParseInt`'s bounds are `+-int.MaxValue`
    /// (parsing.cs:41-49), so lazer rejects exactly `i32::MIN` where this accepts
    /// it. both edges are one-sided and neither can turn a replay either encoder
    /// produced into one this crate refuses
    pub z: i32,
}

/// legacyscoreencoder.cs:181 — the delta token lazer hardcodes for the trailing
/// pseudo-frame that carries the rng seed.
///
/// compared as an integer here, where lazer compares the raw token *text*
/// before parsing anything (legacyscoredecoder.cs:282). the two therefore
/// disagree on non-canonical spellings: ` -12345 `, `-12345.0` and `-12345.4`
/// are all ordinary gameplay frames to lazer, whose string compare fails, but
/// all parse to `-12345` here.
///
/// this costs nothing extra, because such a frame is already lossy on the way
/// out regardless of how it is classified. `serialize_actions` writes the
/// canonical integer text for every frame, so lazer re-reading the export sees
/// `-12345` and skips the frame whether or not a comma follows it -- a trailing
/// comma only contributes an empty segment, which lazer drops on its
/// `split.Length < 4` check. lazer's own decode/encode cycle is lossy in exactly
/// the same way and for the same reason: it rounds the delta on the way in
/// (legacyscoredecoder.cs:305) and writes it back as a bare integer
/// (legacyscoreencoder.cs:174). no encoder emits a non-canonical spelling
pub const SEED_FRAME_DELTA: i64 = -12345;

/// legacyscoreencoder.cs:74 -- the first stable-compatible version number
/// lazer stamps on its own replays. distinct from the score-info trailer
/// threshold one above it: 30000000 marks the play as lazer-native,
/// 30000001+ additionally appends the score-info blob
pub const FIRST_LAZER_VERSION: u32 = 30_000_000;

/// legacyscoredecoder.cs:117 — the first replay version whose framing carries a
/// length-prefixed lazer score-info array after the online score id. at or above
/// it that array is read unconditionally, so it must be present even when its
/// payload is discarded
const FIRST_LAZER_SCORE_INFO_VERSION: u32 = 30000001;

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn fail(&self, what: &str) -> EngineError {
        EngineError::ReplayParse(format!(
            "unexpected end of file reading {what} at offset {}",
            self.pos
        ))
    }

    fn take(&mut self, n: usize, what: &str) -> Result<&'a [u8]> {
        let end = self
            .pos
            .checked_add(n)
            .filter(|&e| e <= self.bytes.len())
            .ok_or_else(|| self.fail(what))?;
        let slice = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn u8(&mut self, what: &str) -> Result<u8> {
        Ok(self.take(1, what)?[0])
    }

    fn u16(&mut self, what: &str) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take(2, what)?.try_into().unwrap()))
    }

    fn u32(&mut self, what: &str) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4, what)?.try_into().unwrap()))
    }

    fn u64(&mut self, what: &str) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8, what)?.try_into().unwrap()))
    }

    fn i32(&mut self, what: &str) -> Result<i32> {
        Ok(i32::from_le_bytes(self.take(4, what)?.try_into().unwrap()))
    }

    fn i64(&mut self, what: &str) -> Result<i64> {
        Ok(i64::from_le_bytes(self.take(8, what)?.try_into().unwrap()))
    }

    fn uleb128(&mut self, what: &str) -> Result<u64> {
        let oversized = || EngineError::ReplayParse(format!("oversized uleb128 reading {what}"));
        let mut result: u64 = 0;
        let mut shift = 0u32;
        loop {
            let byte = self.u8(what)?;
            let payload = u64::from(byte & 0x7f);
            // the tenth byte of an encoding lands at shift 63, where only the
            // lowest payload bit still fits in a u64. shifting a wider payload
            // in would discard the overflow silently -- `2u64 << 63` is `0`,
            // not a panic -- and hand back a truncated length that then
            // desynchronises every field read after it. the continuation-bit
            // check below never catches this on its own, because a tenth byte
            // that *terminates* returns before `shift` is ever incremented past
            // 63, so the width has to be checked here, before the shift
            if payload > (u64::MAX >> shift) {
                return Err(oversized());
            }
            result |= payload << shift;
            if byte & 0x80 == 0 {
                return Ok(result);
            }
            shift += 7;
            if shift >= 64 {
                return Err(oversized());
            }
        }
    }

    fn osu_string(&mut self, what: &str) -> Result<Option<String>> {
        match self.u8(what)? {
            0x00 => Ok(None),
            0x0b => {
                let len = self.uleb128(what)?;
                let len = usize::try_from(len).map_err(|_| self.fail(what))?;
                let bytes = self.take(len, what)?;
                // lossy, deliberately: a malformed header string must not fail
                // the whole decode. the cost is that such a string does not
                // survive a pristine byte round-trip, which is documented as a
                // deliberate divergence on PayloadSource::VerbatimCompressed
                Ok(Some(String::from_utf8_lossy(bytes).into_owned()))
            }
            other => Err(EngineError::ReplayParse(format!(
                "invalid string prefix 0x{other:02x} reading {what}"
            ))),
        }
    }

    fn remaining(&self) -> &'a [u8] {
        &self.bytes[self.pos..]
    }
}

pub fn decode_osr(bytes: &[u8]) -> Result<OsrFile> {
    if bytes.len() as u64 > limits::MAX_OSR_FILE_BYTES {
        return Err(resource_limit(
            "MAX_OSR_FILE_BYTES",
            limits::MAX_OSR_FILE_BYTES,
            bytes.len() as u64,
        ));
    }
    let mut r = Reader::new(bytes);
    let mode = match r.u8("mode")? {
        0 => GameMode::Osu,
        1 => GameMode::Taiko,
        2 => GameMode::Catch,
        3 => GameMode::Mania,
        other => {
            return Err(EngineError::ReplayParse(format!(
                "unknown game mode byte {other}"
            )))
        }
    };
    if mode != GameMode::Osu {
        return Err(EngineError::UnsupportedMode(mode));
    }
    let version = r.u32("version")?;
    let beatmap_md5 = r.osu_string("beatmap_md5")?;
    let player_name = r.osu_string("player_name")?;
    let replay_md5 = r.osu_string("replay_md5")?;
    let count_300 = r.u16("count_300")?;
    let count_100 = r.u16("count_100")?;
    let count_50 = r.u16("count_50")?;
    let count_geki = r.u16("count_geki")?;
    let count_katsu = r.u16("count_katsu")?;
    let count_miss = r.u16("count_miss")?;
    let total_score = r.u32("total_score")?;
    let max_combo = r.u16("max_combo")?;
    let perfect = r.u8("perfect")? != 0;
    let mods = r.u32("mods")?;
    let life_graph = r.osu_string("life_graph")?;
    let timestamp_ticks = r.i64("timestamp")?;
    let compressed_len = r.i32("compressed_length")?;
    // serializationreader.cs:37-43 -- `ReadByteArray` treats a negative length
    // as the null-array sentinel and a zero length as an empty array, and
    // consumes no further bytes for either. legacyscoredecoder.cs:120 then
    // guards decompression behind `compressedReplay?.Length > 0`, so both
    // shapes simply yield a replay with no frames. rejecting the negative case
    // and handing the empty case to the lzma decoder made `.osr` files lazer
    // opens without complaint fail to decode here
    let (compressed_payload, decompressed_payload, actions) = if compressed_len > 0 {
        let len = usize::try_from(compressed_len).expect("a positive i32 always fits usize");
        let compressed = r.take(len, "lzma payload")?.to_vec();
        let decompressed = decompress_lzma_capped(&compressed)?;
        let actions = parse_actions(&decompressed)?;
        (compressed, decompressed, actions)
    } else {
        (Vec::new(), Vec::new(), Vec::new())
    };
    let online_score_id = if version >= 20140721 {
        r.u64("online_score_id")?
    } else if version >= 20121008 {
        u64::from(r.u32("online_score_id")?)
    } else {
        0
    };
    let trailer = r.remaining().to_vec();

    Ok(OsrFile {
        header: OsrHeader {
            mode,
            version,
            beatmap_md5,
            player_name,
            replay_md5,
            count_300,
            count_100,
            count_50,
            count_geki,
            count_katsu,
            count_miss,
            total_score,
            max_combo,
            perfect,
            mods,
            life_graph,
            timestamp_ticks,
            online_score_id,
        },
        actions,
        compressed_payload,
        decompressed_payload,
        trailer,
    })
}

struct CappedWriter {
    buf: Vec<u8>,
    cap: usize,
}

impl std::io::Write for CappedWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if self.buf.len() + data.len() > self.cap {
            return Err(std::io::Error::other("lzma output cap exceeded"));
        }
        self.buf.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn decompress_lzma_capped(compressed: &[u8]) -> Result<Vec<u8>> {
    // lzma-alone header: u8 props, u32 dict size, u64 declared uncompressed
    // size (all-ones = "unknown, use end-of-payload marker instead"). lazer's own
    // encoder (LegacyScoreEncoder.compress) never writes that marker -- it always
    // writes the real content length -- but lazer's decode path tolerates it:
    // SharpCompress.Compressors.LZMA.LzmaStream treats a negative outputSize as
    // "unbounded, detect the end via the range decoder's marker instead" rather
    // than rejecting it. third-party encoders (including lzma-rs's own default
    // lzma_compress) can legitimately produce this shape, so skip the declared-size
    // precheck for it rather than rejecting outright -- the memlimit passed to
    // lzma_decompress_with_options below is what actually bounds this path, since
    // it is checked on every byte lzma-rs's internal buffer grows by, independent
    // of dict_size or when that buffer flushes to `writer`
    if compressed.len() >= 13 {
        let declared = u64::from_le_bytes(compressed[5..13].try_into().unwrap());
        if declared != u64::MAX && declared > limits::MAX_LZMA_DECOMPRESSED_BYTES {
            return Err(resource_limit(
                "MAX_LZMA_DECOMPRESSED_BYTES",
                limits::MAX_LZMA_DECOMPRESSED_BYTES,
                declared,
            ));
        }
    }
    let mut writer = CappedWriter {
        buf: Vec::new(),
        cap: limits::MAX_LZMA_DECOMPRESSED_BYTES as usize,
    };
    let mut reader = compressed;
    // this is what actually bounds the sentinel/oversized-dict_size path noted
    // above; the declared-size precheck and CappedWriter remain as defence in depth
    let options = lzma_rs::decompress::Options {
        memlimit: Some(limits::MAX_LZMA_DECOMPRESSED_BYTES as usize),
        ..Default::default()
    };
    lzma_rs::lzma_decompress_with_options(&mut reader, &mut writer, &options).map_err(|e| match e {
        lzma_rs::error::Error::IoError(io) if io.to_string().contains("cap exceeded") => resource_limit(
            "MAX_LZMA_DECOMPRESSED_BYTES",
            limits::MAX_LZMA_DECOMPRESSED_BYTES,
            limits::MAX_LZMA_DECOMPRESSED_BYTES + 1,
        ),
        lzma_rs::error::Error::LzmaError(msg) if msg.contains("exceeded memory limit") => resource_limit(
            "MAX_LZMA_DECOMPRESSED_BYTES",
            limits::MAX_LZMA_DECOMPRESSED_BYTES,
            limits::MAX_LZMA_DECOMPRESSED_BYTES + 1,
        ),
        other => EngineError::ReplayParse(format!("lzma decompress failed: {other:?}")),
    })?;
    Ok(writer.buf)
}

/// legacyscoredecoder.cs:302-306 — a frame's delta token is parsed as an
/// integer first and, only if that fails, re-parsed as a float and rounded.
/// lazer emitted fractional deltas for a stretch of its life (up to
/// ppy/osu#12583) and deliberately still reads them back; parsing the token as
/// an integer alone would make every one of those replays unopenable.
///
/// the c# comment at that call site is explicit that the two-step shape is
/// load-bearing rather than defensive: `(int)Parsing.ParseFloat(split[0])`
/// alone would lose information, because f32's 24-bit significand cannot
/// represent every `int`. so an exactly-integral token must go through the
/// integer path, and only a genuinely fractional one may take the float path.
///
/// two deliberate divergences, both in the accept-more direction (neither can
/// make a replay lazer opens fail to decode here):
/// - the integer fast path is `i64` where lazer's is `int.TryParse`, so a token
///   between `i32::MAX` and `i64::MAX` is taken verbatim here where lazer falls
///   through to `ParseFloat` and throws past its `int.MaxValue` parse limit
/// - `Parsing.ParseFloat`'s overflow and NaN rejection is not reproduced, the
///   same tolerant-decode posture `parse_actions` already takes for x/y/z
///
/// the caller trims the token first; see the whitespace note in `parse_actions`
fn parse_delta(token: &str) -> Option<i64> {
    if let Ok(exact) = token.parse::<i64>() {
        return Some(exact);
    }
    // `Parsing.ParseFloat` narrows to f32 before `Math.Round` widens it back to
    // double, so the rounding sees the f32-rounded value, not the token's full
    // decimal precision. `Math.Round(double)` breaks ties to even where rust's
    // `f64::round` breaks them away from zero, hence `round_ties_even`. the
    // `(int)` narrowing is the same unchecked cast modelled by
    // `dotnet_double_to_i32_unchecked`, which is why an out-of-range or
    // non-finite delta lands on `i32::MIN` rather than saturating
    let approximate = token.parse::<f32>().ok()?;
    Some(i64::from(dotnet_double_to_i32_unchecked(
        f64::from(approximate).round_ties_even(),
    )))
}

/// parsing.cs:14 — `Parsing.MAX_COORDINATE_VALUE`. crate-visible so
/// `replay::document` can refuse edits that this same bound would make
/// undecodable on re-open
pub(crate) const MAX_COORDINATE_VALUE: f32 = 131_072.0;

/// legacyscoredecoder.cs:308-309 reads both cursor coordinates through
/// `Parsing.ParseFloat(.., Parsing.MAX_COORDINATE_VALUE)`, which throws
/// `OverflowException` outside `+-131_072` and `FormatException` on NaN
/// (parsing.cs:18-27). accepting a wider range here would let a payload like
/// `0|1e30|0|0,` decode into cursor positions lazer refuses to load, so the
/// same bounds are applied.
///
/// the mania variant of this limit (`(1 << 20) - 1` for x, since mania packs
/// pressed keys into the low bits there) is deliberately not modelled:
/// `decode_osr` rejects every non-osu! ruleset before reaching this point.
///
/// one accepted-by-lazer spelling is not reproduced: .net's number parser
/// tolerates a trailing `U+0000`, so `float.Parse("1\0")` yields `1` where
/// rust's `FromStr` (and `trim`, which does not treat NUL as whitespace)
/// rejects it. no encoder emits an embedded NUL, and reproducing the quirk
/// would mean hand-rolling the grammar
fn parse_coordinate(token: &str) -> Option<f32> {
    let value: f32 = token.trim().parse().ok()?;

    // NaN fails every comparison, so the range test rejects it on its own --
    // spelled out rather than left implicit because it is a real branch of
    // `ParseFloat`, not an accident. infinities are rejected by the same test
    (!value.is_nan() && (-MAX_COORDINATE_VALUE..=MAX_COORDINATE_VALUE).contains(&value)).then_some(value)
}

fn parse_actions(payload: &[u8]) -> Result<Vec<ReplayAction>> {
    let text = std::str::from_utf8(payload)
        .map_err(|e| EngineError::ReplayParse(format!("frame payload is not utf-8: {e}")))?;
    let mut actions = Vec::new();
    for segment in text.split(',') {
        let mut parts = segment.split('|');
        let (Some(d), Some(x), Some(y), Some(z)) = (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            // lazer skips segments with fewer than four parts; the trailing
            // comma's empty segment lands here
            continue;
        };
        let parse_err =
            |field: &str, v: &str| EngineError::ReplayParse(format!("bad frame {field} value {v:?}"));
        // every field lazer reads goes through a .net numeric parse whose style
        // includes AllowLeadingWhite | AllowTrailingWhite -- `int.TryParse` and
        // `int.Parse`/`float.Parse` under NumberStyles.Integer/Float -- so a
        // token padded with spaces or tabs is perfectly readable there. rust's
        // `FromStr` accepts no surrounding whitespace at all, so it is trimmed
        // here or a replay lazer opens would fail to decode. (the two
        // whitespace *sets* differ at a handful of exotic code points; no
        // encoder emits padding of any kind, so the overlap that matters --
        // ascii spaces and tabs -- is exact)
        actions.push(ReplayAction {
            delta: parse_delta(d.trim()).ok_or_else(|| parse_err("delta", d))?,
            x: parse_coordinate(x).ok_or_else(|| parse_err("x", x))?,
            y: parse_coordinate(y).ok_or_else(|| parse_err("y", y))?,
            z: z.trim().parse().map_err(|_| parse_err("z", z))?,
        });
        if actions.len() > limits::MAX_REPLAY_FRAMES {
            return Err(resource_limit(
                "MAX_REPLAY_FRAMES",
                limits::MAX_REPLAY_FRAMES as u64,
                actions.len() as u64,
            ));
        }
    }
    Ok(actions)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadSource {
    /// pass [`OsrFile::compressed_payload`] through byte for byte, exactly as it
    /// was read. paired with [`EncodeOptions::include_trailer`] this is the
    /// "pristine" export: re-encoding a freshly decoded file reproduces the
    /// original file's bytes exactly for any canonically-written file; the two
    /// deliberate divergences documented below are the ones specific to this
    /// variant, and [`encode_osr`] lists the full set.
    ///
    /// # deliberate divergence: header strings that are not valid utf-8
    ///
    /// `.osr` header strings are decoded with `String::from_utf8_lossy`, so a
    /// byte sequence that is not valid utf-8 is replaced by `U+FFFD` on the way
    /// in, and re-encoding writes the *replaced* string -- different bytes, and
    /// a different byte length (`U+FFFD` occupies three bytes where the invalid
    /// input may have occupied one). a player name of `b"pl\x80ayer"` decodes to
    /// `"pl\u{FFFD}ayer"` and re-encodes two bytes longer, and `encode_osr`
    /// returns `Ok` while doing it -- it does not detect or report the change.
    ///
    /// this is a deliberate divergence from the byte-identical round-trip, not
    /// a guarantee that holds for all input. osu!(stable) and lazer both write
    /// these fields as utf-8, so it is unreachable for any file either of them
    /// produced; it is reachable for a hand-crafted or corrupted file. fixing it
    /// properly means [`OsrHeader`] keeping raw bytes rather than `String`,
    /// which is a larger change than this divergence currently justifies. the
    /// behaviour is pinned by
    /// `formats::osr::tests::non_utf8_header_string_breaks_the_pristine_byte_roundtrip`
    /// so it cannot drift unnoticed
    ///
    /// # deliberate divergence: the null compressed-payload sentinel
    ///
    /// `SerializationReader.ReadByteArray` (serializationreader.cs:37-43) spells
    /// "null array" as a *negative* declared length and "empty array" as a zero
    /// one, and consumes no payload bytes for either. [`decode_osr`] accepts
    /// both -- lazer does, so refusing them would make readable files
    /// unopenable -- but [`OsrFile`] has nowhere to record which of the two it
    /// saw, since both produce an empty `compressed_payload`. re-encoding
    /// therefore writes `0` for both, turning a `-1` null sentinel into an
    /// empty-array sentinel: same meaning to every decoder, four different
    /// bytes. as with the utf-8 case above, no osu!(stable) or lazer encoder
    /// emits it
    VerbatimCompressed,
    /// rebuild the compressed payload from [`OsrFile::actions`] via
    /// [`serialize_actions`] and a fresh lzma pass. byte equality with the
    /// original file is explicitly not expected here -- the point of this mode
    /// is to write edited frames back out
    Reserialize,
}

#[derive(Debug, Clone, Copy)]
pub struct EncodeOptions {
    pub payload: PayloadSource,
    pub include_trailer: bool,
}

/// writes an `.osr` back out, using the same framing [`decode_osr`] reads.
///
/// with [`PayloadSource::VerbatimCompressed`] and
/// [`EncodeOptions::include_trailer`] set, encoding a file that came straight
/// out of [`decode_osr`] reproduces the original bytes exactly **for any file
/// written in canonical form** -- which is every file osu!(stable) or lazer has
/// ever produced.
///
/// the guarantee is shaped that way because [`decode_osr`] is deliberately more
/// permissive than either encoder: where the format admits two spellings of the
/// same value, decode accepts both and stores the meaning, so encode can only
/// write the canonical one back. the known cases:
///
/// - header strings whose bytes are not valid utf-8 are lossily replaced during
///   decode and re-encoded in their replaced form (see
///   [`PayloadSource::VerbatimCompressed`])
/// - a *negative* compressed length -- `SerializationReader`'s null-array
///   sentinel -- collapses into the same empty payload a zero length gives, and
///   re-encodes as `0` (also on [`PayloadSource::VerbatimCompressed`])
/// - `perfect` is read as "any nonzero byte is true" and written back as `1`,
///   so a file storing e.g. `2` there re-encodes as `1`
/// - a non-minimal uleb128 string length, e.g. `81 00` for 1, decodes to the
///   value it denotes and re-encodes minimally as `01`
///
/// none of these is reachable from an encoder-produced file; all are reachable
/// from a hand-crafted or corrupted one. they are limitations of the round-trip,
/// not guarantees about it
pub fn encode_osr(file: &OsrFile, opts: &EncodeOptions) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    out.push(match file.header.mode {
        GameMode::Osu => 0u8,
        GameMode::Taiko => 1,
        GameMode::Catch => 2,
        GameMode::Mania => 3,
    });
    out.extend(file.header.version.to_le_bytes());
    write_osu_string(&mut out, file.header.beatmap_md5.as_deref());
    write_osu_string(&mut out, file.header.player_name.as_deref());
    write_osu_string(&mut out, file.header.replay_md5.as_deref());
    for v in [
        file.header.count_300,
        file.header.count_100,
        file.header.count_50,
        file.header.count_geki,
        file.header.count_katsu,
        file.header.count_miss,
    ] {
        out.extend(v.to_le_bytes());
    }
    out.extend(file.header.total_score.to_le_bytes());
    out.extend(file.header.max_combo.to_le_bytes());
    out.push(file.header.perfect as u8);
    out.extend(file.header.mods.to_le_bytes());
    write_osu_string(&mut out, file.header.life_graph.as_deref());
    out.extend(file.header.timestamp_ticks.to_le_bytes());

    let compressed = match opts.payload {
        PayloadSource::VerbatimCompressed => file.compressed_payload.clone(),
        PayloadSource::Reserialize => {
            let payload = serialize_actions_capped(&file.actions, limits::MAX_OSR_SERIALIZED_PAYLOAD_BYTES)?;
            compress_lzma(&payload)?
        }
    };
    let compressed_len = i32::try_from(compressed.len())
        .map_err(|_| EngineError::ReplayEncode("compressed payload exceeds i32 length".into()))?;
    out.extend(compressed_len.to_le_bytes());
    out.extend(&compressed);

    if file.header.version >= 20140721 {
        out.extend(file.header.online_score_id.to_le_bytes());
    } else if file.header.version >= 20121008 {
        // this era's header has only 32 bits for the id. a decoded file can
        // never overflow it (the id was read from that same 32-bit field), but a
        // hand-built `OsrFile`, or one whose `version` was edited down into this
        // range, can -- and silently writing the low half would corrupt the id
        // while still returning Ok
        let id = u32::try_from(file.header.online_score_id).map_err(|_| {
            EngineError::ReplayEncode(format!(
                "online score id {} exceeds the 32-bit field replay version {} uses",
                file.header.online_score_id, file.header.version
            ))
        })?;
        out.extend(id.to_le_bytes());
    }
    if opts.include_trailer {
        out.extend(&file.trailer);
    } else if file.header.version >= FIRST_LAZER_SCORE_INFO_VERSION {
        // legacyscoredecoder.cs:115-118 reads the score-info array
        // *unconditionally* for these versions -- the version gate decides
        // whether to read it, not whether it has to be there. so a dirty export
        // that simply stops after the online score id leaves lazer's
        // `ReadByteArray` calling `ReadInt32` at EOF, and the replay fails to
        // load. discarding the payload therefore means writing an EMPTY framed
        // array rather than nothing at all: `ReadByteArray` sees length 0 and
        // returns `Array.Empty`, the `compressedScoreInfo?.Length > 0` guard at
        // line 123 skips the deserialize, and the file opens
        out.extend(0i32.to_le_bytes());
    }
    Ok(out)
}

fn write_osu_string(out: &mut Vec<u8>, s: Option<&str>) {
    match s {
        None => out.push(0x00),
        Some(s) => {
            out.push(0x0b);
            write_uleb128(out, s.len() as u64);
            out.extend(s.as_bytes());
        }
    }
}

fn write_uleb128(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let mut byte = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if v == 0 {
            break;
        }
    }
}

/// reproduces `LegacyScoreEncoder.replayStringContent`
/// (legacyscoreencoder.cs:155-183) byte for byte, including its asymmetric
/// separator placement -- see [`write_action`].
pub fn serialize_actions(actions: &[ReplayAction]) -> Vec<u8> {
    let mut out = String::new();
    for (i, action) in actions.iter().enumerate() {
        write_action(&mut out, action, ends_at_seed_frame(actions, i));
    }
    out.into_bytes()
}

/// [`serialize_actions`] with the payload cap enforced as the text grows rather
/// than after the whole thing exists. `encode_osr` has no frame-count cap of its
/// own -- `MAX_REPLAY_FRAMES` bounds *decoding*, and a hand-built [`OsrFile`]
/// never went through a decode -- so an unbounded action list is reachable, and
/// checking only the finished `String` would mean allocating it in full (many
/// GiB for a crafted list) purely to measure it and throw it away
fn serialize_actions_capped(actions: &[ReplayAction], cap: u64) -> Result<Vec<u8>> {
    let mut out = String::new();
    for (i, action) in actions.iter().enumerate() {
        write_action(&mut out, action, ends_at_seed_frame(actions, i));
        if out.len() as u64 > cap {
            // the reported `actual` is the length reached when the cap was
            // first exceeded, not the length the full list would have produced;
            // measuring the latter is exactly the allocation this avoids
            return Err(resource_limit(
                "MAX_OSR_SERIALIZED_PAYLOAD_BYTES",
                cap,
                out.len() as u64,
            ));
        }
    }
    Ok(out.into_bytes())
}

/// true when `index` addresses the last action and that action is the terminal
/// rng-seed pseudo-frame
fn ends_at_seed_frame(actions: &[ReplayAction], index: usize) -> bool {
    index + 1 == actions.len() && actions[index].delta == SEED_FRAME_DELTA
}

/// legacyscoreencoder.cs:174 gives every real frame a *trailing* comma, and then
/// line 181 appends the `-12345|0|0|0` seed frame with no comma at all. a
/// payload lazer wrote therefore ends at the seed frame's last digit, with no
/// separator after it -- so appending a comma unconditionally would add one byte
/// to every current lazer replay that came back through
/// [`PayloadSource::Reserialize`].
///
/// only a *terminal* seed frame is written bare: a `-12345` frame appearing
/// mid-payload is a real separator-delimited entry and keeps its comma. an
/// action list that does not end in a seed frame also keeps its trailing comma
/// rather than having one synthesised, because this layer round-trips the frames
/// a file actually contains and does not invent the one lazer's encoder would
/// have appended
fn write_action(out: &mut String, action: &ReplayAction, is_terminal_seed_frame: bool) {
    use std::fmt::Write;
    // x and y go through .net's float formatting (they are `float?` fields
    // interpolated directly); z is written as a plain integer, matching
    // `{(int)legacyFrame.ButtonState}`
    let _ = write!(
        out,
        "{}|{}|{}|{}",
        action.delta,
        format_dotnet_f32(action.x),
        format_dotnet_f32(action.y),
        action.z
    );
    if !is_terminal_seed_frame {
        out.push(',');
    }
}

/// matches modern .net's default `float.ToString()` / string-interpolation
/// formatting exactly -- the call `LegacyScoreEncoder.replayStringContent` uses
/// for every replay frame coordinate. both rust's `{}`/`{:e}` and .net's default
/// formatter compute the shortest decimal that round-trips back to the same f32
/// bits, so they agree everywhere except at a genuine tie: a value sitting
/// exactly halfway between the two shortest-length decimal neighbors. rust
/// breaks such ties away from zero; .net breaks them to the nearest even last
/// digit. `apply_dotnet_tie_break` corrects for that. separately, .net switches
/// from fixed to scientific notation outside roughly `[1e-4, 1e9)` and spells
/// the non-finite cases `Infinity`/`-Infinity`/`NaN` where rust says
/// `inf`/`-inf`/`NaN`; both are reproduced here too. verified byte-for-byte
/// against real dotnet 8 output in `format_dotnet_f32_matches_dotnet_fixture`
pub fn format_dotnet_f32(v: f32) -> String {
    if v.is_nan() {
        return "NaN".to_string();
    }
    if v.is_infinite() {
        return if v > 0.0 {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        };
    }
    if v == 0.0 {
        return if v.is_sign_negative() {
            "-0".to_string()
        } else {
            "0".to_string()
        };
    }

    let sign = if v.is_sign_negative() { "-" } else { "" };
    let abs = v.abs();

    // rust's exponential formatter shares its shortest-round-trip digit
    // generation with `{}`, but always normalizes to one leading digit before
    // the point, which is a much easier shape to parse back out than `{}`'s
    // notation-dependent rendering
    let exp_form = format!("{abs:e}");
    let (mantissa, exp_str) = exp_form.split_once('e').expect("lowerexp always contains 'e'");
    let exponent: i32 = exp_str
        .parse()
        .expect("lowerexp exponent is always a valid integer");
    let mut digits: String = mantissa.chars().filter(|&c| c != '.').collect();

    apply_dotnet_tie_break(&mut digits, exponent, abs);

    let body = if (-4..=8).contains(&exponent) {
        format_fixed(&digits, exponent)
    } else {
        format_scientific(&digits, exponent)
    };
    format!("{sign}{body}")
}

/// rewrites `digits` in place from rust's away-from-zero tie pick to .net's
/// round-to-even pick, if and only if `digits` (at decimal weight `exponent`)
/// is a genuine tie for `target`. the last digit of an away-from-zero pick is
/// always odd when a tie was actually resolved that way (round-to-even's pick
/// is the adjacent, smaller-magnitude, even digit) -- so an even last digit
/// never needs correction, whether or not it came from a tie
fn apply_dotnet_tie_break(digits: &mut String, exponent: i32, target: f32) {
    let last_digit = digits.as_bytes()[digits.len() - 1];
    if (last_digit - b'0').is_multiple_of(2) {
        return;
    }
    // decimal weight of the last digit, e.g. digits="256", exponent=2 (256.)
    // means the last digit is in the units place, candidate_exp=0
    let candidate_exp = exponent - (digits.len() as i32 - 1);
    // a genuine tie requires f32's 24-bit mantissa to exactly supply a 5^|k|
    // factor (see `is_exact_half_ulp_tie`'s doc comment), which bounds |k| to
    // at most 10; this fast-path skip avoids the exact check's u128 arithmetic
    // for the overwhelming majority of calls, which aren't anywhere close
    if candidate_exp.abs() > 15 {
        return;
    }
    if is_exact_half_ulp_tie(target, digits, candidate_exp) {
        let mut bytes = digits.clone().into_bytes();
        let last_idx = bytes.len() - 1;
        bytes[last_idx] -= 1;
        *digits = String::from_utf8(bytes).expect("decrementing an ascii digit stays ascii");
    }
}

/// exact (non-approximate) test for whether `target`'s true binary value sits
/// precisely halfway between the decimal value `(hi_digits - 1) * 10^k` and
/// `hi_digits * 10^k`. this can't be answered by checking whether both
/// neighbors merely round-trip through `str::parse` -- they can both round-trip
/// without being equidistant, since the "parses back to this float" interval is
/// wider than a single decimal unit at these digit counts (this is exactly the
/// bug an earlier version of this function had, which spuriously "corrected"
/// f32::MAX even though rust's own answer for it is already the unique closest
/// decimal, not one side of a tie).
///
/// instead this is computed as an exact integer equality. `target`'s value is
/// `mantissa * 2^bin_exp` for an integer mantissa (f32's 24-bit significand,
/// implicit leading bit included), so doubling it gives `mantissa * 2^a` for
/// `a = bin_exp + 1`. `hi_digits` is rust's own (away-from-zero) pick, which is
/// always the larger-magnitude of the two tied candidates, so equidistance is:
///
/// `mantissa * 2^a == (2*hi_digits - 1) * 10^k`
///
/// every exponent used below is shifted to be non-negative so the arithmetic
/// fits u128 without needing an arbitrary-precision type. a genuine tie
/// requires the mantissa to supply a full `5^|k|` factor, which bounds `|k|` to
/// at most 10 (`5^11` already exceeds the mantissa's 24-bit range) -- callers
/// only reach this function once `k` is already known to be small, and that
/// smallness in turn keeps every shift here within a couple hundred bits
fn is_exact_half_ulp_tie(target: f32, hi_digits: &str, k: i32) -> bool {
    let bits = target.to_bits();
    let exp_field = i32::try_from((bits >> 23) & 0xff).expect("8-bit field fits i32");
    let frac = u128::from(bits & 0x7f_ffff);
    let (mantissa, a): (u128, i32) = if exp_field == 0 {
        (frac, -148) // subnormal: target = frac * 2^-149, so a = bin_exp+1 = -148
    } else {
        (frac | (1 << 23), exp_field - 149) // normal: a = (exp_field-127-23) + 1
    };

    let Ok(hi) = hi_digits.parse::<u128>() else {
        return false;
    };
    let Some(two_hi_minus_one) = hi.checked_mul(2).and_then(|v| v.checked_sub(1)) else {
        return false;
    };

    let pow2 = |e: i32| -> Option<u128> { u32::try_from(e).ok().and_then(|e| 1u128.checked_shl(e)) };
    let pow5 = |e: i32| -> Option<u128> { u32::try_from(e).ok().and_then(|e| 5u128.checked_pow(e)) };

    // shift both sides of `mantissa * 2^a == (2*hi-1) * 2^k * 5^k` by the same
    // (2^base2 * 5^base5) so every remaining exponent is >= 0
    let base2 = a.min(k);
    let base5 = k.min(0);
    let lhs = (|| -> Option<u128> {
        mantissa
            .checked_mul(pow2(a - base2)?)?
            .checked_mul(pow5(0 - base5)?)
    })();
    let rhs = (|| -> Option<u128> {
        two_hi_minus_one
            .checked_mul(pow2(k - base2)?)?
            .checked_mul(pow5(k - base5)?)
    })();

    matches!((lhs, rhs), (Some(l), Some(r)) if l == r)
}

fn format_fixed(digits: &str, exponent: i32) -> String {
    if exponent >= 0 {
        let int_len = exponent as usize + 1;
        if digits.len() <= int_len {
            let mut out = digits.to_string();
            out.extend(std::iter::repeat_n('0', int_len - digits.len()));
            out
        } else {
            format!("{}.{}", &digits[..int_len], &digits[int_len..])
        }
    } else {
        let leading_zeros = (-exponent - 1) as usize;
        format!("0.{}{}", "0".repeat(leading_zeros), digits)
    }
}

fn format_scientific(digits: &str, exponent: i32) -> String {
    let mantissa = if digits.len() > 1 {
        format!("{}.{}", &digits[..1], &digits[1..])
    } else {
        digits.to_string()
    };
    let exp_sign = if exponent < 0 { '-' } else { '+' };
    format!("{mantissa}E{exp_sign}{:02}", exponent.abs())
}

fn compress_lzma(payload: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    lzma_rs::lzma_compress(&mut &payload[..], &mut out)
        .map_err(|e| EngineError::ReplayEncode(format!("lzma compress failed: {e:?}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uleb(out: &mut Vec<u8>, mut v: u64) {
        loop {
            let mut byte = (v & 0x7f) as u8;
            v >>= 7;
            if v != 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if v == 0 {
                break;
            }
        }
    }

    fn osu_str(out: &mut Vec<u8>, s: Option<&str>) {
        match s {
            None => out.push(0x00),
            Some(s) => {
                out.push(0x0b);
                uleb(out, s.len() as u64);
                out.extend(s.as_bytes());
            }
        }
    }

    fn compress(payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        // real .osr files always declare a concrete uncompressed size in the
        // lzma-alone header -- lazer's LegacyScoreDecoder.readCompressedData reads
        // outSize as a plain value with no branch for lzma-rs's default all-ones
        // "unknown size" marker, so write a concrete size to match that shape
        // (lzma_rs::lzma_compress with no options would write the marker instead)
        let options = lzma_rs::compress::Options {
            unpacked_size: lzma_rs::compress::UnpackedSize::WriteToHeader(Some(payload.len() as u64)),
        };
        lzma_rs::lzma_compress_with_options(&mut &payload[..], &mut out, &options).unwrap();
        out
    }

    // shaped exactly as `LegacyScoreEncoder.replayStringContent` writes one:
    // every real frame carries a trailing comma and the terminal `-12345` seed
    // frame carries none. the seed is deliberately larger than 2^24 -- real
    // seeds are effectively uniform over `int`, and an f32 `z` would silently
    // round this one to 1_737_356_416
    const PAYLOAD: &str = "0|256|192|0,16|300.5|200.25|1,1|300.5|200.25|0,-12345|0|0|1737356431";
    const SEED: i32 = 1_737_356_431;

    fn build_osr(version: u32, payload: &[u8], trailer: &[u8]) -> Vec<u8> {
        build_osr_with_player_name(version, b"player one", payload, trailer)
    }

    // the player name is taken as raw bytes rather than a &str so a test can
    // hand it a sequence that is not valid utf-8
    fn build_osr_with_player_name(
        version: u32,
        player_name: &[u8],
        payload: &[u8],
        trailer: &[u8],
    ) -> Vec<u8> {
        let mut b = Vec::new();
        b.push(0u8); // osu! standard
        b.extend(version.to_le_bytes());
        osu_str(&mut b, Some("aabbccddeeff00112233445566778899"));
        b.push(0x0b);
        uleb(&mut b, player_name.len() as u64);
        b.extend(player_name);
        osu_str(&mut b, Some("99887766554433221100ffeeddccbbaa"));
        for c in [285u16, 12, 3, 40, 1, 2] {
            b.extend(c.to_le_bytes());
        }
        b.extend(1_234_567u32.to_le_bytes()); // total score
        b.extend(432u16.to_le_bytes()); // max combo
        b.push(0); // perfect
        b.extend(0u32.to_le_bytes()); // nomod
        osu_str(&mut b, None); // life graph absent
        b.extend(638_712_000_000_000_000i64.to_le_bytes()); // ticks
        let compressed = compress(payload);
        b.extend((compressed.len() as i32).to_le_bytes());
        b.extend(&compressed);
        b.extend(0u64.to_le_bytes()); // online score id (version >= 20140721)
        b.extend(trailer);
        b
    }

    #[test]
    fn decodes_stable_osr() {
        let file = decode_osr(&build_osr(20240101, PAYLOAD.as_bytes(), &[])).unwrap();
        assert_eq!(file.header.mode, GameMode::Osu);
        assert_eq!(file.header.version, 20240101);
        assert_eq!(file.header.player_name.as_deref(), Some("player one"));
        assert_eq!(file.header.count_300, 285);
        assert_eq!(file.header.count_miss, 2);
        assert_eq!(file.header.max_combo, 432);
        assert_eq!(file.header.life_graph, None);
        assert_eq!(file.header.timestamp_ticks, 638_712_000_000_000_000);
        assert_eq!(file.decompressed_payload, PAYLOAD.as_bytes());
        assert!(file.trailer.is_empty());

        assert_eq!(file.actions.len(), 4);
        assert_eq!(
            file.actions[0],
            ReplayAction {
                delta: 0,
                x: 256.0,
                y: 192.0,
                z: 0
            }
        );
        assert_eq!(
            file.actions[1],
            ReplayAction {
                delta: 16,
                x: 300.5,
                y: 200.25,
                z: 1
            }
        );
        // rng seed pseudo-frame flows through as a plain action at this layer
        assert_eq!(file.actions[3].delta, -12345);
        // exact, not rounded to the nearest f32 (which would be 1_737_356_416)
        assert_eq!(file.actions[3].z, SEED);
    }

    #[test]
    fn captures_lazer_trailer_verbatim() {
        let trailer = [0x07u8, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03];
        let file = decode_osr(&build_osr(30000001, PAYLOAD.as_bytes(), &trailer)).unwrap();
        assert_eq!(file.trailer, trailer);
    }

    #[test]
    fn rejects_non_osu_replay() {
        let mut bytes = build_osr(20240101, PAYLOAD.as_bytes(), &[]);
        bytes[0] = 3; // mania
        match decode_osr(&bytes) {
            Err(EngineError::UnsupportedMode(GameMode::Mania)) => {}
            other => panic!("expected UnsupportedMode, got {other:?}"),
        }
    }

    #[test]
    fn truncation_at_every_offset_never_panics() {
        let bytes = build_osr(20240101, PAYLOAD.as_bytes(), &[]);
        for len in 0..bytes.len() {
            // every prefix must produce a typed error or (for trailer-less
            // prefixes past the score id) possibly ok — never a panic
            let _ = decode_osr(&bytes[..len]);
        }
    }

    #[test]
    fn osr_file_size_cap_boundary() {
        // pad with trailer bytes, which are captured verbatim without being
        // parsed, so the file can be grown to exactly the cap with no other
        // framing changes
        let unpadded = build_osr(20240101, PAYLOAD.as_bytes(), &[]);
        let pad_len = limits::MAX_OSR_FILE_BYTES as usize - unpadded.len();
        let at_limit = build_osr(20240101, PAYLOAD.as_bytes(), &vec![0u8; pad_len]);
        assert_eq!(at_limit.len() as u64, limits::MAX_OSR_FILE_BYTES);
        assert!(decode_osr(&at_limit).is_ok());

        let past = build_osr(20240101, PAYLOAD.as_bytes(), &vec![0u8; pad_len + 1]);
        match decode_osr(&past) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_OSR_FILE_BYTES",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn lzma_bomb_declared_size_hits_cap() {
        let mut bytes = build_osr(20240101, PAYLOAD.as_bytes(), &[]);
        // the lzma-alone header sits right after the i32 length; bytes 5..13 of
        // it declare the uncompressed size. find it by rebuilding the prefix.
        let compressed = compress(PAYLOAD.as_bytes());
        let lzma_start = bytes.len() - 8 - compressed.len();
        let declared = (limits::MAX_LZMA_DECOMPRESSED_BYTES + 1).to_le_bytes();
        bytes[lzma_start + 5..lzma_start + 13].copy_from_slice(&declared);
        match decode_osr(&bytes) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_LZMA_DECOMPRESSED_BYTES",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn lzma_decompressed_size_cap_boundary() {
        // exercise decompress_lzma_capped directly at the true boundary: a real
        // payload whose declared and actual uncompressed size is exactly the cap,
        // so this proves the header precheck, CappedWriter, and lzma-rs's own
        // memlimit all accept a legitimate stream sitting right at the limit
        // (not just that oversized streams get rejected, which the bomb test
        // above already covers). all-zero content keeps the encoder/decoder fast
        // regardless of the input size
        let at_limit = vec![0u8; limits::MAX_LZMA_DECOMPRESSED_BYTES as usize];
        let compressed = compress(&at_limit);
        let decompressed = decompress_lzma_capped(&compressed).expect("exactly-at-cap decode should succeed");
        assert_eq!(decompressed.len() as u64, limits::MAX_LZMA_DECOMPRESSED_BYTES);
    }

    #[test]
    fn lzma_unknown_size_sentinel_decodes_via_end_marker() {
        // lazer's own encoder (LegacyScoreEncoder.compress) never writes the
        // lzma-alone "unknown size" marker (0xff * 8) -- it always writes the real
        // content length as a plain long -- but lazer's decode path tolerates a
        // stream that does: SharpCompress.Compressors.LZMA.LzmaStream treats a
        // negative outputSize as "detect the end via the range decoder's marker
        // instead of a byte count", not as an error. third-party encoders can and
        // do produce this shape -- lzma_rs::lzma_compress with no options writes
        // exactly this marker by default, which is what this crate's own compress()
        // test helper did before it was pointed at a concrete size -- so decoding
        // must accept it too, matching lazer's actual tolerance rather than
        // lazer's own narrower encoder behaviour
        let mut reader = PAYLOAD.as_bytes();
        let mut compressed = Vec::new();
        lzma_rs::lzma_compress(&mut reader, &mut compressed).unwrap();
        let declared = u64::from_le_bytes(compressed[5..13].try_into().unwrap());
        assert_eq!(
            declared,
            u64::MAX,
            "test setup assumes lzma_rs's default write emits the unknown-size marker"
        );

        let decompressed = decompress_lzma_capped(&compressed)
            .expect("a sentinel-declared stream with a real end marker should decode successfully");
        assert_eq!(decompressed, PAYLOAD.as_bytes());
    }

    #[test]
    fn lzma_inflated_dict_size_hits_internal_memlimit() {
        // reproduces the exact mechanism the Critical finding described: lzma-rs's
        // encoder always declares an 8 MiB dict_size (hardcoded in dumbencoder.rs),
        // so a normal stream flushes to CappedWriter well before our cap and never
        // touches lzma-rs's own memlimit. patching the header's dict_size field
        // (bytes 1..5) past the cap reproduces a stream whose internal circular
        // buffer must grow past the cap before its first flush -- CappedWriter
        // never sees a single byte in that case, so this only stays bounded
        // because of the memlimit passed to lzma_decompress_with_options. a
        // sentinel declared size (see the test above) keeps the header precheck
        // from short-circuiting this before the real mechanism gets exercised
        let over_limit = vec![0u8; limits::MAX_LZMA_DECOMPRESSED_BYTES as usize + 1];
        let mut reader = &over_limit[..];
        let mut compressed = Vec::new();
        lzma_rs::lzma_compress(&mut reader, &mut compressed).unwrap();
        let original_dict_size = u32::from_le_bytes(compressed[1..5].try_into().unwrap());
        assert!(
            u64::from(original_dict_size) <= limits::MAX_LZMA_DECOMPRESSED_BYTES,
            "test setup assumes lzma_rs's default dict_size is under the cap, so inflating it below is the actual test"
        );
        let inflated_dict_size = limits::MAX_LZMA_DECOMPRESSED_BYTES as u32 + 1;
        compressed[1..5].copy_from_slice(&inflated_dict_size.to_le_bytes());

        match decompress_lzma_capped(&compressed) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_LZMA_DECOMPRESSED_BYTES",
                ..
            }) => {}
            other => panic!("expected ResourceLimit from lzma-rs's own memlimit, got {other:?}"),
        }
    }

    #[test]
    fn lzma_capped_writer_is_the_sole_guard_for_small_dict_sentinel_streams() {
        // the one stream shape where CappedWriter is the *only* thing bounding
        // output, so its reject branch needs its own coverage:
        //   (a) the unknown-size sentinel in the header skips the declared-size
        //       precheck (see lzma_unknown_size_sentinel_decodes_via_end_marker), and
        //   (b) a small dict_size keeps lzma-rs's circular buffer -- the thing its
        //       memlimit actually guards -- far below the cap, so the internal
        //       memlimit never fires either (the inverse of
        //       lzma_inflated_dict_size_hits_internal_memlimit, which inflates
        //       dict_size to reach that guard on purpose).
        // the shape fits inside MAX_OSR_FILE_BYTES with room to spare: all-zero
        // content compresses to roughly 130 KB per 128 MiB. shrinking dict_size
        // after the fact is safe for this payload specifically because lzma-rs's
        // encoder emits literals only -- there are no back-references for a
        // smaller window to invalidate
        let over_limit = vec![0u8; limits::MAX_LZMA_DECOMPRESSED_BYTES as usize + 1];
        let mut reader = &over_limit[..];
        let mut compressed = Vec::new();
        lzma_rs::lzma_compress(&mut reader, &mut compressed).unwrap();
        assert_eq!(
            u64::from_le_bytes(compressed[5..13].try_into().unwrap()),
            u64::MAX,
            "test setup assumes lzma_rs's default write emits the unknown-size marker"
        );
        compressed[1..5].copy_from_slice(&4096u32.to_le_bytes());
        assert!(
            (compressed.len() as u64) < limits::MAX_OSR_FILE_BYTES,
            "the crafted stream must fit inside a decodable .osr, not just inside this test"
        );

        match decompress_lzma_capped(&compressed) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_LZMA_DECOMPRESSED_BYTES",
                ..
            }) => {}
            // the ok arm is summarised rather than printed: this test's whole
            // point is a payload past a 128 MiB cap, and `{other:?}` on it would
            // dump every byte
            Ok(out) => panic!(
                "expected ResourceLimit from CappedWriter, got Ok({} bytes)",
                out.len()
            ),
            Err(other) => panic!("expected ResourceLimit from CappedWriter, got {other:?}"),
        }
    }

    #[test]
    fn frame_count_cap_boundary() {
        let at_limit: String = "1|0|0|0,".repeat(limits::MAX_REPLAY_FRAMES);
        assert!(decode_osr(&build_osr(20240101, at_limit.as_bytes(), &[])).is_ok());
        let past: String = "1|0|0|0,".repeat(limits::MAX_REPLAY_FRAMES + 1);
        match decode_osr(&build_osr(20240101, past.as_bytes(), &[])) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_REPLAY_FRAMES",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn header_parse_agrees_with_osu_db() {
        let bytes = build_osr(20240101, PAYLOAD.as_bytes(), &[]);
        let ours = decode_osr(&bytes).unwrap();
        let theirs = osu_db::Replay::from_bytes(&bytes).expect("osu-db decode");
        assert_eq!(ours.header.beatmap_md5, theirs.beatmap_hash);
        assert_eq!(ours.header.player_name, theirs.player_name);
        assert_eq!(ours.header.count_300, theirs.count_300);
        assert_eq!(ours.header.count_miss, theirs.count_miss);
        assert_eq!(ours.header.total_score, theirs.score);
        assert_eq!(ours.header.max_combo, theirs.max_combo);
        assert_eq!(ours.header.mods, theirs.mods.bits());
        assert_eq!(ours.header.online_score_id, theirs.online_score_id);
    }

    fn full_opts() -> EncodeOptions {
        EncodeOptions {
            payload: PayloadSource::VerbatimCompressed,
            include_trailer: true,
        }
    }

    #[test]
    fn pristine_roundtrip_is_byte_identical() {
        // whole-file byte equality holds for a pristine decode -> encode with
        // verbatim payload + trailer; this subsumes the trailer-survival test
        let trailer = [0x11u8, 0x22, 0x33, 0x44, 0x55];
        for version in [20240101u32, 30000001] {
            let original = build_osr(version, PAYLOAD.as_bytes(), &trailer);
            let decoded = decode_osr(&original).unwrap();
            let encoded = encode_osr(&decoded, &full_opts()).unwrap();
            assert_eq!(encoded, original, "version {version}");
        }
    }

    #[test]
    fn non_utf8_header_string_breaks_the_pristine_byte_roundtrip() {
        // pins the deliberate divergence documented on PayloadSource::VerbatimCompressed.
        // Reader::osu_string decodes header strings with String::from_utf8_lossy
        // and write_osu_string writes the *lossy* string's byte length, so a
        // header string carrying bytes that are not valid utf-8 comes back out
        // as different bytes -- and encode_osr returns Ok while doing it, rather
        // than detecting or reporting the change. this is asserted as it is,
        // divergence and all, so that fixing it (which means OsrHeader holding
        // raw bytes instead of String) is a deliberate, visible change rather
        // than something that quietly starts or stops happening
        let original = build_osr_with_player_name(20240101, b"pl\x80ayer", PAYLOAD.as_bytes(), &[]);
        let decoded = decode_osr(&original).unwrap();

        // the invalid byte became U+FFFD, which is three bytes where the input
        // spent one
        assert_eq!(decoded.header.player_name.as_deref(), Some("pl\u{FFFD}ayer"));

        let encoded = encode_osr(&decoded, &full_opts()).expect("encode reports success despite the change");
        assert_ne!(encoded, original, "the divergence is that these bytes differ");
        assert_eq!(encoded.len(), original.len() + 2);

        // for contrast, the identical file with a utf-8 player name does round
        // trip byte for byte -- the divergence is specific to the invalid bytes
        let utf8 = build_osr_with_player_name(20240101, b"pl\xc3\xa5ayer", PAYLOAD.as_bytes(), &[]);
        let utf8_decoded = decode_osr(&utf8).unwrap();
        assert_eq!(encode_osr(&utf8_decoded, &full_opts()).unwrap(), utf8);
    }

    #[test]
    fn old_version_score_id_widths_roundtrip() {
        // < 20121008: no score id at all; the builder always writes a u64, so
        // craft these by hand off a truncated build
        let mut base = build_osr(20130000, PAYLOAD.as_bytes(), &[]);
        base.truncate(base.len() - 8);
        base.extend(77u32.to_le_bytes()); // u32 id era
        let decoded = decode_osr(&base).unwrap();
        assert_eq!(decoded.header.online_score_id, 77);
        assert_eq!(encode_osr(&decoded, &full_opts()).unwrap(), base);

        let mut ancient = build_osr(20100101, PAYLOAD.as_bytes(), &[]);
        ancient.truncate(ancient.len() - 8); // no id era
        let decoded = decode_osr(&ancient).unwrap();
        assert_eq!(encode_osr(&decoded, &full_opts()).unwrap(), ancient);
    }

    #[test]
    fn reserialized_payload_is_byte_identical() {
        let file = decode_osr(&build_osr(20240101, PAYLOAD.as_bytes(), &[])).unwrap();
        assert_eq!(serialize_actions(&file.actions), PAYLOAD.as_bytes());
    }

    #[test]
    fn terminal_seed_frame_is_written_without_a_trailing_comma() {
        // legacyscoreencoder.cs:174 vs :181 -- real frames get a trailing comma,
        // the appended seed frame gets none. a stray comma here would add one
        // byte to every current lazer replay put through Reserialize
        let actions = vec![
            ReplayAction {
                delta: 16,
                x: 1.0,
                y: 2.0,
                z: 5,
            },
            ReplayAction {
                delta: SEED_FRAME_DELTA,
                x: 0.0,
                y: 0.0,
                z: SEED,
            },
        ];
        assert_eq!(
            serialize_actions(&actions),
            format!("16|1|2|5,-12345|0|0|{SEED}").as_bytes()
        );
    }

    #[test]
    fn a_seed_delta_keeps_its_comma_unless_it_is_last() {
        // only a *terminal* seed frame is written bare; one appearing mid-payload
        // is an ordinary separator-delimited entry
        let actions = vec![
            ReplayAction {
                delta: SEED_FRAME_DELTA,
                x: 0.0,
                y: 0.0,
                z: 7,
            },
            ReplayAction {
                delta: 4,
                x: 1.0,
                y: 2.0,
                z: 3,
            },
        ];
        assert_eq!(serialize_actions(&actions), b"-12345|0|0|7,4|1|2|3,");
    }

    #[test]
    fn large_rng_seeds_survive_a_payload_roundtrip_exactly() {
        // the whole reason `z` is an i32: every one of these is outside f32's
        // 24-bit significand, so an f32 field would round it to a neighbour and
        // reserialize a different number than the replay was written with
        for seed in [1_737_356_431i32, i32::MAX, i32::MIN, -16_777_217, 16_777_217] {
            let payload = format!("0|256|192|0,-12345|0|0|{seed}");
            let file = decode_osr(&build_osr(20240101, payload.as_bytes(), &[])).unwrap();
            assert_eq!(file.actions[1].z, seed, "seed {seed} did not survive decode");
            assert_eq!(
                serialize_actions(&file.actions),
                payload.as_bytes(),
                "seed {seed} did not survive reserialization"
            );
        }
    }

    #[test]
    fn fractional_deltas_from_legacy_lazer_replays_are_accepted() {
        // legacyscoredecoder.cs:302-306 -- lazer emitted fractional deltas until
        // ppy/osu#12583 and still reads them back, integer parse first and only
        // then a float parse rounded with .net's round-half-to-even
        let payload = "0|256|192|0,16.5|1|2|0,17.5|1|2|0,-3.5|1|2|0,-12345|0|0|1";
        let file = decode_osr(&build_osr(20240101, payload.as_bytes(), &[])).unwrap();
        let deltas: Vec<i64> = file.actions.iter().map(|a| a.delta).collect();
        // 16.5 -> 16 and 17.5 -> 18 are ties resolved to even, not away from
        // zero (which would give 17 and 18); -3.5 -> -4 is a tie to even too
        assert_eq!(deltas, vec![0, 16, 18, -4, -12345]);
    }

    #[test]
    fn an_exactly_integral_delta_never_loses_precision_to_the_float_path() {
        // the c# comment at legacyscoredecoder.cs:303 is explicit that the
        // integer attempt has to come first: this value is not representable in
        // f32, so routing it through the float path would corrupt it
        let payload = "16777217|1|2|0,-12345|0|0|1";
        let file = decode_osr(&build_osr(20240101, payload.as_bytes(), &[])).unwrap();
        assert_eq!(file.actions[0].delta, 16_777_217);
    }

    #[test]
    fn whitespace_padded_frame_fields_decode_like_lazer() {
        // every .net parse lazer uses on these fields allows leading and
        // trailing whitespace (NumberStyles.Integer / NumberStyles.Float), so a
        // padded token is readable there and must be readable here too
        let payload = " 16 |\t256 | 192\t|  0 ,-12345|0|0|1";
        let file = decode_osr(&build_osr(20240101, payload.as_bytes(), &[])).unwrap();
        assert_eq!(
            file.actions[0],
            ReplayAction {
                delta: 16,
                x: 256.0,
                y: 192.0,
                z: 0
            }
        );

        // the fractional fallback sees a trimmed token too
        let fractional = " 16.5 |1|2|0,-12345|0|0|1";
        let file = decode_osr(&build_osr(20240101, fractional.as_bytes(), &[])).unwrap();
        assert_eq!(file.actions[0].delta, 16);
    }

    #[test]
    fn empty_and_null_compressed_payloads_decode_to_an_empty_replay() {
        // serializationreader.cs:37-43 + legacyscoredecoder.cs:120 -- a zero
        // length is an empty array and a negative one is the null sentinel;
        // neither consumes further bytes and lazer skips decompression for both
        for declared_len in [0i32, -1] {
            let mut bytes = build_osr(20240101, PAYLOAD.as_bytes(), &[]);
            // rebuild the tail: replace the length + payload with just a length
            let compressed = compress(PAYLOAD.as_bytes());
            let length_at = bytes.len() - 8 - compressed.len() - 4;
            bytes.truncate(length_at);
            bytes.extend(declared_len.to_le_bytes());
            bytes.extend(0u64.to_le_bytes()); // online score id

            let file = decode_osr(&bytes)
                .unwrap_or_else(|e| panic!("declared length {declared_len} should decode, got {e:?}"));
            assert!(file.actions.is_empty());
            assert!(file.decompressed_payload.is_empty());
            assert!(file.compressed_payload.is_empty());
        }
    }

    #[test]
    fn out_of_range_and_nan_cursor_coordinates_are_rejected() {
        // legacyscoredecoder.cs:308-309 bounds both coordinates by
        // Parsing.MAX_COORDINATE_VALUE and rejects NaN
        for payload in [
            "0|1e30|0|0,-12345|0|0|1",
            "0|0|1e30|0,-12345|0|0|1",
            "0|-131073|0|0,-12345|0|0|1",
            "0|NaN|0|0,-12345|0|0|1",
            "0|inf|0|0,-12345|0|0|1",
        ] {
            match decode_osr(&build_osr(20240101, payload.as_bytes(), &[])) {
                Err(EngineError::ReplayParse(_)) => {}
                other => panic!("expected ReplayParse for {payload:?}, got {other:?}"),
            }
        }

        // exactly at the bound is accepted, as ParseFloat's inclusive test is
        let at_bound = "0|131072|-131072|0,-12345|0|0|1";
        let file = decode_osr(&build_osr(20240101, at_bound.as_bytes(), &[])).unwrap();
        assert_eq!(file.actions[0].x, 131_072.0);
        assert_eq!(file.actions[0].y, -131_072.0);
    }

    #[test]
    fn an_oversized_score_id_fails_encoding_instead_of_being_truncated() {
        let mut header = sample_header();
        header.version = 20130000; // the 32-bit score id era
        header.online_score_id = u64::from(u32::MAX) + 1;
        let file = OsrFile {
            header,
            actions: Vec::new(),
            compressed_payload: Vec::new(),
            decompressed_payload: Vec::new(),
            trailer: Vec::new(),
        };
        let opts = EncodeOptions {
            payload: PayloadSource::Reserialize,
            include_trailer: false,
        };
        match encode_osr(&file, &opts) {
            Err(EngineError::ReplayEncode(msg)) => assert!(msg.contains("32-bit")),
            other => panic!("expected ReplayEncode, got {other:?}"),
        }
    }

    #[test]
    fn a_non_numeric_delta_is_still_rejected() {
        let payload = "abc|1|2|0,";
        match decode_osr(&build_osr(20240101, payload.as_bytes(), &[])) {
            Err(EngineError::ReplayParse(_)) => {}
            other => panic!("expected ReplayParse, got {other:?}"),
        }
    }

    #[test]
    fn a_ten_byte_uleb128_rejects_a_payload_wider_than_one_bit() {
        // nine 0x80 continuation bytes put the tenth byte at shift 63, where
        // only bit 0 still fits. 0x02 there used to shift straight off the top
        // of the u64 and yield a silently truncated length
        let mut bytes = vec![0u8; 5];
        bytes[0] = 0; // osu! standard
        bytes[1..5].copy_from_slice(&20240101u32.to_le_bytes());
        bytes.push(0x0b); // beatmap_md5 is present
        bytes.extend(std::iter::repeat_n(0x80u8, 9));
        bytes.push(0x02);
        match decode_osr(&bytes) {
            Err(EngineError::ReplayParse(msg)) if msg.contains("oversized uleb128") => {}
            other => panic!("expected an oversized uleb128 error, got {other:?}"),
        }

        // a terminating 0x01 at shift 63 is exactly representable and must stay
        // accepted -- it is a (gigantic) length, so the failure that follows is
        // the truncation check, not the uleb decode
        let mut representable = bytes.clone();
        let last = representable.len() - 1;
        representable[last] = 0x01;
        match decode_osr(&representable) {
            Err(EngineError::ReplayParse(msg)) => assert!(
                !msg.contains("oversized uleb128"),
                "0x01 at shift 63 fits and must not be rejected as oversized: {msg}"
            ),
            other => panic!("expected a ReplayParse error, got {other:?}"),
        }
    }

    #[test]
    fn semantic_roundtrip_through_recompression() {
        let file = decode_osr(&build_osr(20240101, PAYLOAD.as_bytes(), &[])).unwrap();
        let opts = EncodeOptions {
            payload: PayloadSource::Reserialize,
            include_trailer: false,
        };
        let redecoded = decode_osr(&encode_osr(&file, &opts).unwrap()).unwrap();
        assert_eq!(redecoded.header, file.header);
        assert_eq!(redecoded.actions, file.actions);
        assert_eq!(redecoded.decompressed_payload, file.decompressed_payload);
    }

    #[test]
    fn dirty_export_drops_the_score_info_payload_but_keeps_its_framing() {
        // legacyscoredecoder.cs:115-118 reads the score-info array
        // unconditionally at this version, so the array has to still BE there --
        // as an empty one. ending the file after the online score id instead
        // would leave lazer's ReadInt32 at EOF and the replay would not load
        let trailer = [0x02u8, 0x00, 0x00, 0x00, 0xde, 0xad];
        let file = decode_osr(&build_osr(30000001, PAYLOAD.as_bytes(), &trailer)).unwrap();
        let opts = EncodeOptions {
            payload: PayloadSource::Reserialize,
            include_trailer: false,
        };
        let bytes = encode_osr(&file, &opts).unwrap();

        let redecoded = decode_osr(&bytes).unwrap();
        // the payload is gone, but the length prefix that frames it remains
        assert_eq!(redecoded.trailer, 0i32.to_le_bytes());
    }

    #[test]
    fn dirty_export_adds_no_framing_below_the_lazer_score_info_version() {
        // the array is version-gated: a stable-era replay has no score-info
        // field at all, so inventing an empty one would corrupt the framing
        let file = decode_osr(&build_osr(20240101, PAYLOAD.as_bytes(), &[0xde, 0xad])).unwrap();
        let opts = EncodeOptions {
            payload: PayloadSource::Reserialize,
            include_trailer: false,
        };
        let bytes = encode_osr(&file, &opts).unwrap();
        assert!(decode_osr(&bytes).unwrap().trailer.is_empty());
    }

    #[test]
    fn a_pristine_export_still_reproduces_the_original_score_info_payload() {
        // the empty-framing substitution must apply ONLY to the dirty path
        let trailer = [0x02u8, 0x00, 0x00, 0x00, 0xde, 0xad];
        let original = build_osr(30000001, PAYLOAD.as_bytes(), &trailer);
        let file = decode_osr(&original).unwrap();
        assert_eq!(encode_osr(&file, &full_opts()).unwrap(), original);
    }

    #[test]
    fn dotnet_float_formatting() {
        // rust's shortest-round-trip display matches modern .net in the fixed
        // notation range replay values live in
        for (v, expected) in [
            (256.0f32, "256"),
            (256.5, "256.5"),
            (0.1, "0.1"),
            (328.80002, "328.80002"),
            (-1.5, "-1.5"),
            (0.0, "0"),
        ] {
            assert_eq!(format_dotnet_f32(v), expected);
        }
    }

    #[test]
    fn local_replay_corpus_roundtrips() {
        // optional corpus: real .osr files dropped in fixtures/replays/local
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/replays/local");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return;
        };
        for entry in entries.flatten() {
            if entry.path().extension().is_none_or(|e| e != "osr") {
                continue;
            }
            let bytes = std::fs::read(entry.path()).unwrap();
            let decoded = match decode_osr(&bytes) {
                Ok(decoded) => decoded,
                // a non-osu! ruleset is the only legitimate reason to skip a
                // file in this corpus. swallowing every error instead would let
                // a decoder regression turn the whole corpus into no-ops while
                // the test stayed green -- the one failure mode a corpus test
                // must not have
                Err(EngineError::UnsupportedMode(_)) => continue,
                Err(err) => panic!("failed to decode corpus replay {:?}: {err:?}", entry.path()),
            };
            let encoded = encode_osr(&decoded, &full_opts()).unwrap();
            assert_eq!(
                encoded,
                bytes,
                "pristine byte round-trip failed for {:?}",
                entry.path()
            );
            // osu!(stable) appends a trailing comma after the terminal
            // `-12345` seed frame; lazer's encoder writes that frame bare
            // (legacyscoreencoder.cs:181, which `write_action` ports). the two
            // spell the same action list, and this corpus is necessarily
            // stable-*written* -- only a replay the stable client wrote itself
            // still carries geki/katu -- so every file in it ends in stable's
            // separator. compare modulo that one byte rather than holding
            // stable's files to lazer's spelling; every earlier byte, which is
            // where a real reserialization regression would land, still has to
            // match exactly
            let reserialized = serialize_actions(&decoded.actions);
            let expected = match decoded.decompressed_payload.strip_suffix(b",") {
                Some(without_separator) if without_separator == reserialized => without_separator,
                _ => decoded.decompressed_payload.as_slice(),
            };
            assert_eq!(
                reserialized,
                expected,
                "payload reserialization diverged for {:?}",
                entry.path()
            );
        }
    }

    #[derive(serde::Deserialize)]
    struct FloatFormatFixtureEntry {
        bits: u32,
        expected: String,
    }

    #[test]
    fn format_dotnet_f32_matches_dotnet_fixture() {
        // ground truth dumped straight from dotnet 8 by tools/fixture-gen, using
        // the exact call lazer's LegacyScoreEncoder.replayStringContent uses
        // (FormattableString.Invariant($"{value}")): playfield-range samples,
        // deliberate integral/zero/sign cases, extreme magnitudes near f32's
        // dynamic range limits, and a batch of confirmed round-half-to-even ties
        // -- regenerate via `dotnet run --project tools/fixture-gen -- --out fixtures`
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/replays/float_format.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("missing fixture {path:?}: {e}; run `dotnet run --project tools/fixture-gen -- --out fixtures` from the repo root"));
        let entries: Vec<FloatFormatFixtureEntry> =
            serde_json::from_str(&raw).expect("fixture is valid json");
        assert!(!entries.is_empty(), "fixture must contain at least one case");

        let mut tie_cases = 0u32;
        for entry in &entries {
            let v = f32::from_bits(entry.bits);
            assert_eq!(
                format_dotnet_f32(v),
                entry.expected,
                "bits 0x{:08x} ({v})",
                entry.bits
            );
            if format_dotnet_f32(v) != format!("{v}") {
                tie_cases += 1;
            }
        }
        // sanity check on the fixture itself: it should actually be exercising
        // the round-half-to-even correction, not just notation-switch cases
        assert!(
            tie_cases > 0,
            "fixture should include at least one genuine tie case"
        );
    }

    #[test]
    fn reserialized_payload_size_cap_boundary() {
        // each all-zero frame serializes to exactly "0|0|0|0," (8 bytes), so the
        // cap divides evenly and the boundary sits at an exact frame count
        let frames_at_limit = (limits::MAX_OSR_SERIALIZED_PAYLOAD_BYTES / 8) as usize;
        let action = ReplayAction {
            delta: 0,
            x: 0.0,
            y: 0.0,
            z: 0,
        };
        let opts = EncodeOptions {
            payload: PayloadSource::Reserialize,
            include_trailer: false,
        };

        let file_at_limit = OsrFile {
            header: sample_header(),
            actions: vec![action.clone(); frames_at_limit],
            compressed_payload: Vec::new(),
            decompressed_payload: Vec::new(),
            trailer: Vec::new(),
        };
        assert_eq!(
            serialize_actions(&file_at_limit.actions).len() as u64,
            limits::MAX_OSR_SERIALIZED_PAYLOAD_BYTES
        );
        assert!(encode_osr(&file_at_limit, &opts).is_ok());

        let file_past_limit = OsrFile {
            actions: vec![action; frames_at_limit + 1],
            ..file_at_limit
        };
        match encode_osr(&file_past_limit, &opts) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_OSR_SERIALIZED_PAYLOAD_BYTES",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    fn sample_header() -> OsrHeader {
        OsrHeader {
            mode: GameMode::Osu,
            version: 20240101,
            beatmap_md5: Some("aabbccddeeff00112233445566778899".to_string()),
            player_name: Some("player one".to_string()),
            replay_md5: Some("99887766554433221100ffeeddccbbaa".to_string()),
            count_300: 285,
            count_100: 12,
            count_50: 3,
            count_geki: 40,
            count_katsu: 1,
            count_miss: 2,
            total_score: 1_234_567,
            max_combo: 432,
            perfect: false,
            mods: 0,
            life_graph: None,
            timestamp_ticks: 638_712_000_000_000_000,
            online_score_id: 0,
        }
    }
}
