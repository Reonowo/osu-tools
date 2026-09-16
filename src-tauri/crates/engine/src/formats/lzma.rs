//! the lzma-alone stream both halves of a lazer `.osr` are compressed with:
//! the frame payload and the score-info block (`legacyscoreencoder.cs:134-152`
//! writes both through the same `compress`). shared here so the two codecs
//! bound decompression the same three ways and neither re-derives the
//! tolerance notes.
//!
//! decompression is capped per caller, because the two payloads have
//! different ceilings: a frame payload of a long play runs to megabytes
//! ([`crate::limits::MAX_LZMA_DECOMPRESSED_BYTES`]), a score-info block to a
//! few hundred bytes ([`crate::limits::MAX_SCORE_INFO_BYTES`]).

use crate::error::{resource_limit, EngineError, Result};

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

/// decompresses one lzma-alone stream, bounding its output three ways: a
/// precheck against the header's declared uncompressed size, a capped
/// writer on the bytes actually produced, and lzma-rs's own `memlimit`
/// guarding its internal dictionary buffer. every breach is a
/// [`EngineError::ResourceLimit`] naming `cap_name`; any other failure is a
/// [`EngineError::ReplayParse`] the caller may reword
pub(crate) fn decompress_lzma_alone(compressed: &[u8], cap: u64, cap_name: &'static str) -> Result<Vec<u8>> {
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
        if declared != u64::MAX && declared > cap {
            return Err(resource_limit(cap_name, cap, declared));
        }
    }
    let mut writer = CappedWriter {
        buf: Vec::new(),
        cap: cap as usize,
    };
    let mut reader = compressed;
    // this is what actually bounds the sentinel/oversized-dict_size path noted
    // above; the declared-size precheck and CappedWriter remain as defence in depth
    let options = lzma_rs::decompress::Options {
        memlimit: Some(cap as usize),
        ..Default::default()
    };
    lzma_rs::lzma_decompress_with_options(&mut reader, &mut writer, &options).map_err(|e| match e {
        lzma_rs::error::Error::IoError(io) if io.to_string().contains("cap exceeded") => {
            resource_limit(cap_name, cap, cap + 1)
        }
        lzma_rs::error::Error::LzmaError(msg) if msg.contains("exceeded memory limit") => {
            resource_limit(cap_name, cap, cap + 1)
        }
        other => EngineError::ReplayParse(format!("lzma decompress failed: {other:?}")),
    })?;
    Ok(writer.buf)
}

/// compresses one lzma-alone stream with the real content length declared
/// in the header, as `LegacyScoreEncoder.compress` writes it
/// (legacyscoreencoder.cs:144-146). the dictionary size is lzma-rs's own
/// rather than lazer's 2 MiB; lazer's reader takes it off the header and
/// never checks it
pub(crate) fn compress_lzma_alone(payload: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let options = lzma_rs::compress::Options {
        unpacked_size: lzma_rs::compress::UnpackedSize::WriteToHeader(Some(payload.len() as u64)),
    };
    lzma_rs::lzma_compress_with_options(&mut &payload[..], &mut out, &options)
        .map_err(|e| EngineError::ReplayEncode(format!("lzma compress failed: {e:?}")))?;
    Ok(out)
}
