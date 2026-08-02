use thiserror::Error;

use crate::formats::GameMode;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("failed to parse beatmap: {0}")]
    BeatmapParse(String),
    #[error("failed to parse replay: {0}")]
    ReplayParse(String),
    #[error("resource limit exceeded: {cap} (limit {limit}, actual {actual})")]
    ResourceLimit {
        cap: &'static str,
        limit: u64,
        actual: u64,
    },
    /// a caller-supplied argument violates a documented precondition. mirrors
    /// .net's `ArgumentOutOfRangeException`/`ArgumentException` semantics: a
    /// catchable validation failure rather than undefined behaviour, so ports
    /// of lazer code that throws on bad arguments return this instead of
    /// panicking
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("unsupported game mode: {0:?}")]
    UnsupportedMode(GameMode),
    /// an encode-side failure in `formats::osr::encode_osr`: the file could not
    /// be written out, as opposed to [`EngineError::ReplayParse`]'s "the file
    /// could not be read in". kept a separate variant rather than folded into
    /// `ReplayParse` because the two reach a user through entirely different
    /// actions -- a `ReplayParse` message surfaced during an export would tell
    /// someone their replay failed to *parse*, which is simply untrue
    #[error("failed to encode replay: {0}")]
    ReplayEncode(String),
}

pub type Result<T> = std::result::Result<T, EngineError>;

pub(crate) fn resource_limit(cap: &'static str, limit: u64, actual: u64) -> EngineError {
    EngineError::ResourceLimit { cap, limit, actual }
}
