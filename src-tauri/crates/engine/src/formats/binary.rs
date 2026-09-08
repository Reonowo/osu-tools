//! the byte-level reads osu!'s binary formats share: bounded takes, the
//! little-endian fixed-width numbers, ULEB128 and the tag-prefixed osu!
//! string. ports `osu.Game/IO/Legacy/SerializationReader.cs`, which is the
//! one reader stable's own `.osr` and `osu!.db` writers were built against.
//!
//! the error CONSTRUCTOR is injected rather than fixed, because these
//! primitives serve more than one codec and a failure has to keep the name
//! of the file it happened in: a truncated `osu!.db` is a listing-parse
//! error, never a replay-parse one. every variant it is used with is a
//! `fn(String) -> EngineError`, so callers pass the variant itself
//! (`Reader::new(bytes, EngineError::ReplayParse)`).
//!
//! no method here can panic on any input: every read goes through
//! [`Reader::take`], whose bounds check is `checked_add` against the slice
//! length, and the only slicing is of a range that check produced.

use crate::error::EngineError;
use crate::error::Result;

pub(crate) struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
    parse_error: fn(String) -> EngineError,
    exhausted: bool,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(bytes: &'a [u8], parse_error: fn(String) -> EngineError) -> Self {
        Self {
            bytes,
            pos: 0,
            parse_error,
            exhausted: false,
        }
    }

    /// whether a read has run past the end of the buffer. every other
    /// failure -- an unexpected tag, an oversized length, a count that
    /// cannot be right -- leaves this false, which is what lets a CHUNKED
    /// reader tell "hand me more bytes" from "this file is corrupt"
    /// (`formats::osr::scan_osr_header` is the one caller that needs the
    /// distinction; a whole-file codec has nothing more to hand over)
    pub(crate) fn exhausted(&self) -> bool {
        self.exhausted
    }

    /// how many bytes the walk has consumed. a codec that must account for
    /// the whole file reads this at the end; an error message reads it to
    /// say where the walk stopped
    pub(crate) fn pos(&self) -> usize {
        self.pos
    }

    /// raise this reader's own parse error with a message of the caller's
    /// choosing -- for the failures that are a codec's own rule rather than
    /// a primitive's (an unexpected tag, a count that cannot be right)
    pub(crate) fn error(&self, message: String) -> EngineError {
        (self.parse_error)(message)
    }

    pub(crate) fn fail(&self, what: &str) -> EngineError {
        self.error(format!(
            "unexpected end of file reading {what} at offset {}",
            self.pos
        ))
    }

    pub(crate) fn take(&mut self, n: usize, what: &str) -> Result<&'a [u8]> {
        let Some(end) = self.pos.checked_add(n).filter(|&e| e <= self.bytes.len()) else {
            self.exhausted = true;
            return Err(self.fail(what));
        };
        let slice = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    /// consumes `n` bytes without materialising them -- what a codec walking
    /// past a field it does not keep uses, so a large discarded block pads
    /// the file without costing memory
    pub(crate) fn skip(&mut self, n: usize, what: &str) -> Result<()> {
        self.take(n, what).map(|_| ())
    }

    pub(crate) fn u8(&mut self, what: &str) -> Result<u8> {
        Ok(self.take(1, what)?[0])
    }

    pub(crate) fn u16(&mut self, what: &str) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take(2, what)?.try_into().unwrap()))
    }

    pub(crate) fn u32(&mut self, what: &str) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4, what)?.try_into().unwrap()))
    }

    pub(crate) fn u64(&mut self, what: &str) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8, what)?.try_into().unwrap()))
    }

    pub(crate) fn i32(&mut self, what: &str) -> Result<i32> {
        Ok(i32::from_le_bytes(self.take(4, what)?.try_into().unwrap()))
    }

    pub(crate) fn i64(&mut self, what: &str) -> Result<i64> {
        Ok(i64::from_le_bytes(self.take(8, what)?.try_into().unwrap()))
    }

    pub(crate) fn f32(&mut self, what: &str) -> Result<f32> {
        Ok(f32::from_le_bytes(self.take(4, what)?.try_into().unwrap()))
    }

    pub(crate) fn f64(&mut self, what: &str) -> Result<f64> {
        Ok(f64::from_le_bytes(self.take(8, what)?.try_into().unwrap()))
    }

    pub(crate) fn uleb128(&mut self, what: &str) -> Result<u64> {
        // copied out of `self` so the closure does not hold a borrow across
        // the `u8` reads below; a constructor is a plain fn pointer
        let parse_error = self.parse_error;
        let oversized = move || parse_error(format!("oversized uleb128 reading {what}"));
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

    /// serializationreader.cs:59-70 -- a `0x00` tag is the null string and a
    /// `0x0b` tag introduces a ULEB128 length followed by that many utf-8
    /// bytes. consumes the tag and the length, and answers how many bytes of
    /// content follow, so the two readers below differ only in what they then
    /// do with them
    fn osu_string_len(&mut self, what: &str) -> Result<Option<usize>> {
        match self.u8(what)? {
            0x00 => Ok(None),
            0x0b => {
                let len = self.uleb128(what)?;
                Ok(Some(usize::try_from(len).map_err(|_| self.fail(what))?))
            }
            other => Err(self.error(format!("invalid string prefix 0x{other:02x} reading {what}"))),
        }
    }

    pub(crate) fn osu_string(&mut self, what: &str) -> Result<Option<String>> {
        let Some(len) = self.osu_string_len(what)? else {
            return Ok(None);
        };
        let bytes = self.take(len, what)?;
        // lossy, deliberately: a malformed header string must not fail the
        // whole decode. the cost is that such a string does not survive a
        // pristine byte round-trip, which is documented as a deliberate
        // divergence on PayloadSource::VerbatimCompressed
        Ok(Some(String::from_utf8_lossy(bytes).into_owned()))
    }

    /// walks an osu! string without keeping it -- the same framing as
    /// [`Reader::osu_string`], minus the allocation and the utf-8 pass
    pub(crate) fn skip_osu_string(&mut self, what: &str) -> Result<()> {
        match self.osu_string_len(what)? {
            Some(len) => self.skip(len, what),
            None => Ok(()),
        }
    }

    pub(crate) fn remaining(&self) -> &'a [u8] {
        &self.bytes[self.pos..]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// a second constructor beside `ReplayParse`, so the injection is
    /// exercised rather than assumed
    fn reader(bytes: &[u8]) -> Reader<'_> {
        Reader::new(bytes, EngineError::BeatmapParse)
    }

    #[test]
    fn the_injected_constructor_types_the_failure() {
        // the same short buffer through two constructors gives two different
        // variants: this is the whole reason the constructor is a parameter
        let short = [0u8; 2];
        match Reader::new(&short, EngineError::ReplayParse).u32("x") {
            Err(EngineError::ReplayParse(msg)) => assert!(msg.contains("at offset 0"), "{msg}"),
            other => panic!("expected ReplayParse, got {other:?}"),
        }
        match Reader::new(&short, EngineError::BeatmapParse).u32("x") {
            Err(EngineError::BeatmapParse(_)) => {}
            other => panic!("expected BeatmapParse, got {other:?}"),
        }
    }

    #[test]
    fn every_fixed_width_read_errors_one_byte_short_and_never_panics() {
        // each primitive gets exactly one byte less than it needs, so the
        // bounds check is the only thing standing between it and a panic
        macro_rules! one_short {
            ($width:expr, $call:ident) => {{
                let bytes = vec![0u8; $width - 1];
                assert!(reader(&bytes).$call("x").is_err(), "{} accepted a short buffer", $width);
                let bytes = vec![0u8; $width];
                assert!(reader(&bytes).$call("x").is_ok(), "{} rejected an exact buffer", $width);
            }};
        }
        one_short!(1, u8);
        one_short!(2, u16);
        one_short!(4, u32);
        one_short!(8, u64);
        one_short!(4, i32);
        one_short!(8, i64);
        one_short!(4, f32);
        one_short!(8, f64);
    }

    #[test]
    fn the_little_endian_reads_agree_with_the_wire() {
        let mut r = reader(&[0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
        assert_eq!(r.u16("x").unwrap(), 0x0201);
        assert_eq!(r.u16("x").unwrap(), 0x0403);
        assert_eq!(r.i32("x").unwrap(), 0x0807_0605);
        assert_eq!(r.pos(), 8);

        // the two float widths the listing's star-rating pairs need
        // the two star ratings the real listing slices carry, one per width
        let single = 7.7179942_f32.to_le_bytes();
        assert_eq!(reader(&single).f32("x").unwrap(), 7.7179942_f32);
        let double = 7.646780153940339_f64.to_le_bytes();
        assert_eq!(reader(&double).f64("x").unwrap(), 7.646780153940339_f64);
    }

    #[test]
    fn take_and_skip_are_bounded_by_the_slice() {
        let mut r = reader(&[1, 2, 3, 4]);
        assert_eq!(r.take(2, "x").unwrap(), &[1, 2]);
        assert!(r.skip(2, "x").is_ok());
        assert_eq!(r.remaining(), &[] as &[u8]);
        assert!(r.take(1, "x").is_err());

        // a length past usize's reach must fail the bounds check rather than
        // wrap it: `pos + n` is a checked_add
        let mut r = reader(&[1, 2, 3, 4]);
        assert!(r.skip(usize::MAX, "x").is_err());
    }

    #[test]
    fn uleb128_reads_the_multi_byte_encoding_and_rejects_an_oversized_one() {
        assert_eq!(reader(&[0x00]).uleb128("x").unwrap(), 0);
        assert_eq!(reader(&[0x7f]).uleb128("x").unwrap(), 127);
        assert_eq!(reader(&[0x80, 0x01]).uleb128("x").unwrap(), 128);
        assert_eq!(reader(&[0xe5, 0x8e, 0x26]).uleb128("x").unwrap(), 624_485);

        // an encoding that never terminates runs out of bytes rather than
        // spinning
        let unterminated = vec![0x80u8; 4];
        assert!(reader(&unterminated).uleb128("x").is_err());

        // nine continuation bytes put the tenth at shift 63, where only bit 0
        // still fits
        let mut wide = vec![0x80u8; 9];
        wide.push(0x02);
        match reader(&wide).uleb128("x") {
            Err(EngineError::BeatmapParse(msg)) => assert!(msg.contains("oversized uleb128"), "{msg}"),
            other => panic!("expected an oversized error, got {other:?}"),
        }
        let mut representable = vec![0x80u8; 9];
        representable.push(0x01);
        assert_eq!(reader(&representable).uleb128("x").unwrap(), 1 << 63);
    }

    #[test]
    fn osu_string_reads_both_tags_and_refuses_a_third() {
        assert_eq!(reader(&[0x00]).osu_string("x").unwrap(), None);
        assert_eq!(
            reader(&[0x0b, 0x02, b'h', b'i']).osu_string("x").unwrap().as_deref(),
            Some("hi")
        );
        match reader(&[0x0c]).osu_string("x") {
            Err(EngineError::BeatmapParse(msg)) => assert!(msg.contains("0x0c"), "{msg}"),
            other => panic!("expected an invalid-prefix error, got {other:?}"),
        }
        // a declared length past the end of the buffer is the truncation
        // check, not a short read
        assert!(reader(&[0x0b, 0x08, b'h', b'i']).osu_string("x").is_err());
        // invalid utf-8 is replaced rather than failing the decode
        assert_eq!(
            reader(&[0x0b, 0x01, 0xff]).osu_string("x").unwrap().as_deref(),
            Some("\u{fffd}")
        );
    }

    #[test]
    fn skip_osu_string_consumes_exactly_what_osu_string_does() {
        for bytes in [
            vec![0x00u8, 0xaa],
            vec![0x0b, 0x02, b'h', b'i', 0xaa],
            vec![0x0b, 0x00, 0xaa],
        ] {
            let mut kept = reader(&bytes);
            kept.osu_string("x").unwrap();
            let mut skipped = reader(&bytes);
            skipped.skip_osu_string("x").unwrap();
            assert_eq!(kept.pos(), skipped.pos(), "{bytes:?}");
        }
        match reader(&[0x0c]).skip_osu_string("x") {
            Err(EngineError::BeatmapParse(msg)) => assert!(msg.contains("0x0c"), "{msg}"),
            other => panic!("expected an invalid-prefix error, got {other:?}"),
        }
    }
}
