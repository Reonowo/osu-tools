//! the replay hash the pinned lazer encoder writes:
//! `md5(utf8("lazer-{username}-{date}"))` lowercase-hex
//! (legacyscoreencoder.cs:105, ExtensionMethods.cs:289). the hash covers
//! neither the beatmap hash nor the frames -- on the decode -> re-encode
//! path it is a pure function of the player name and the header's timestamp
//! ticks, which decode as utc (serializationreader.cs:62) and format through
//! .net's invariant default `DateTimeOffset` pattern. the exact formatting
//! is pinned by `fixtures/score/replay_hash.json`, dumped by lazer's own
//! runtime rather than transcribed.

use std::fmt::Write as _;

use md5::{Digest, Md5};

use crate::error::{EngineError, Result};

/// DateTime.MaxValue.Ticks -- the .net constructor lazer decodes through
/// throws beyond this, so out-of-range header ticks fail typed here instead
const MAX_DOTNET_TICKS: i64 = 3_155_378_975_999_999_999;

const TICKS_PER_SECOND: i64 = 10_000_000;
const SECONDS_PER_DAY: i64 = 86_400;
/// days from 0001-01-01 (tick zero) to 1970-01-01 (the civil-from-days epoch)
const DAYS_TO_UNIX_EPOCH: i64 = 719_162;

/// proleptic-gregorian date from days since 1970-01-01 (howard hinnant's
/// civil_from_days, the standard branchless conversion)
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, month as u32, day as u32)
}

/// the date leg of the hash input: .net's invariant default for a utc
/// `DateTimeOffset` -- `MM/dd/yyyy HH:mm:ss +00:00`, sub-second ticks
/// truncated. errors on ticks the .net `DateTime` constructor would throw
/// for (negative, or beyond year 9999)
pub fn invariant_date_string(timestamp_ticks: i64) -> Result<String> {
    if !(0..=MAX_DOTNET_TICKS).contains(&timestamp_ticks) {
        return Err(EngineError::InvalidArgument(format!(
            "timestamp ticks {timestamp_ticks} outside the .net DateTime range"
        )));
    }

    let total_seconds = timestamp_ticks / TICKS_PER_SECOND;
    let (days, time_of_day) = (total_seconds / SECONDS_PER_DAY, total_seconds % SECONDS_PER_DAY);
    let (year, month, day) = civil_from_days(days - DAYS_TO_UNIX_EPOCH);
    let (hours, minutes, seconds) = (time_of_day / 3600, time_of_day % 3600 / 60, time_of_day % 60);

    Ok(format!(
        "{month:02}/{day:02}/{year:04} {hours:02}:{minutes:02}:{seconds:02} +00:00"
    ))
}

/// the full replay hash for a dirty export's header
pub fn replay_hash(username: &str, timestamp_ticks: i64) -> Result<String> {
    let date = invariant_date_string(timestamp_ticks)?;
    let digest = Md5::digest(format!("lazer-{username}-{date}").as_bytes());
    let mut hex = String::with_capacity(32);
    for byte in digest {
        write!(hex, "{byte:02x}").expect("writing hex into a string cannot fail");
    }
    Ok(hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn out_of_range_ticks_fail_typed() {
        assert!(invariant_date_string(-1).is_err());
        assert!(invariant_date_string(MAX_DOTNET_TICKS + 1).is_err());
        assert!(replay_hash("x", i64::MIN).is_err());
        assert!(replay_hash("x", i64::MAX).is_err());
    }

    #[test]
    fn sub_second_ticks_truncate_out_of_the_date_string() {
        // two tick values a fraction of a second apart hash identically:
        // the default DateTimeOffset format stops at whole seconds
        let base = 638_500_000_000_000_000;
        assert_eq!(
            invariant_date_string(base).unwrap(),
            invariant_date_string(base + 9_999_999).unwrap()
        );
        assert_eq!(
            replay_hash("peppy", base).unwrap(),
            replay_hash("peppy", base + 1_234_567).unwrap()
        );
    }

    #[test]
    fn tick_zero_is_the_year_one_epoch() {
        assert_eq!(invariant_date_string(0).unwrap(), "01/01/0001 00:00:00 +00:00");
        assert_eq!(
            invariant_date_string(MAX_DOTNET_TICKS).unwrap(),
            "12/31/9999 23:59:59 +00:00"
        );
    }
}
