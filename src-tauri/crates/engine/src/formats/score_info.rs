//! lazer's score-info block: the lzma-compressed json `LegacyReplaySoloScoreInfo`
//! a lazer-written `.osr` appends after the online score id from
//! [`FIRST_LAZER_SCORE_INFO_VERSION`] on (`legacyscoreencoder.cs:122`,
//! `legacyscoredecoder.cs:117-147`, `legacyreplaysoloscoreinfo.cs`).
//!
//! this is the half of a lazer replay that says how the play was configured:
//! the mods with their settings, the native statistics map, the maximum
//! statistics, the rank, the client version. the framing around it -- the
//! length-prefixed array and the bytes past it -- is [`super::osr`]'s
//! business; this module reads and writes the array's CONTENT.
//!
//! # the schema
//!
//! the parsed shape follows the pinned class exactly, json name for json
//! name. property order and formatting follow what lazer's serializer
//! (`JsonSerializableExtensions.CreateGlobalSettings`: indented, snake-case
//! keys, defaults omitted) actually wrote into the real fixture at
//! `fixtures/replays/local/lazer-export.osr`: the three FIELDS first
//! (`client_version`, `rank`, `user_id` -- newtonsoft serialises fields
//! before properties), then the properties in declaration order. a
//! statistics map is keyed by `HitResult`'s snake-case names, which are
//! both what `ToSnakeCase` produces for a dictionary key and what each
//! member's `[EnumMember]` value spells, so encode and decode agree by
//! construction. unknown top-level keys and unknown result names are KEPT
//! as opaque entries, never dropped and never errors: the value must
//! round-trip through this codec, and a lazer newer than the pin may write
//! a result this crate has never heard of.
//!
//! # what a bad block is
//!
//! two different things, and the difference is load-bearing. a block that
//! breaches a resource cap -- decompressed size, json depth, or one of the
//! collection caps -- is a typed [`EngineError::ResourceLimit`] in every
//! build profile, exactly as every other format boundary in [`crate::limits`]
//! is. a block that is merely unreadable (not lzma, not utf-8, not json, or
//! json of the wrong shape) is a [`ScoreInfoDecode::Malformed`] ANSWER
//! carrying the reader's reason, not an error: the header and the frames
//! decoded, the file plays back, and the play configuration is what reports
//! that its mods could not be resolved.
//!
//! the one place the two meet: a corrupt block whose garbage lzma header
//! happens to declare more than the size cap is refused as the cap breach it
//! claims to be, corrupt or not, because the declared size is the only thing
//! that can be checked before the decompression work is done and a real
//! bomb declares exactly the same thing. every other corruption lands on the
//! malformed answer
//!
//! # document order
//!
//! json objects are kept in document order ([`Json`]) rather than through
//! `serde_json::Value`, which sorts keys: lazer writes its dictionaries in
//! insertion order, and a decode-encode round trip has to be the identity on
//! the value so that a carried block and a regenerated one can be compared
//! entry for entry

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::Number;

/// a json value whose objects keep their keys in document order. only what
/// this codec needs of json: opaque values inside a block (a mod's settings,
/// an unknown top-level key) are carried as these and written back in the
/// same order they were read
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    /// an integral number as an i64. newtonsoft reads a `long` member from
    /// an integer token only, so a fraction or a string is the wrong type
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Json::Number(n) => n.as_i64(),
            _ => None,
        }
    }

    /// the same value as serde_json's own type, for callers that speak it --
    /// the app crate's wire, whose key order is nobody's contract
    pub fn to_value(&self) -> serde_json::Value {
        match self {
            Json::Null => serde_json::Value::Null,
            Json::Bool(b) => serde_json::Value::Bool(*b),
            Json::Number(n) => serde_json::Value::Number(n.clone()),
            Json::String(s) => serde_json::Value::String(s.clone()),
            Json::Array(items) => serde_json::Value::Array(items.iter().map(Json::to_value).collect()),
            Json::Object(entries) => serde_json::Value::Object(
                entries
                    .iter()
                    .map(|(k, v)| (k.clone(), v.to_value()))
                    .collect(),
            ),
        }
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> core::result::Result<Self, D::Error> {
        struct JsonVisitor;

        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = Json;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("any json value")
            }

            fn visit_bool<E>(self, v: bool) -> core::result::Result<Json, E> {
                Ok(Json::Bool(v))
            }

            fn visit_i64<E>(self, v: i64) -> core::result::Result<Json, E> {
                Ok(Json::Number(v.into()))
            }

            fn visit_u64<E>(self, v: u64) -> core::result::Result<Json, E> {
                Ok(Json::Number(v.into()))
            }

            fn visit_f64<E: de::Error>(self, v: f64) -> core::result::Result<Json, E> {
                Number::from_f64(v)
                    .map(Json::Number)
                    .ok_or_else(|| E::custom("non-finite number"))
            }

            fn visit_str<E>(self, v: &str) -> core::result::Result<Json, E> {
                Ok(Json::String(v.to_owned()))
            }

            fn visit_string<E>(self, v: String) -> core::result::Result<Json, E> {
                Ok(Json::String(v))
            }

            fn visit_none<E>(self) -> core::result::Result<Json, E> {
                Ok(Json::Null)
            }

            fn visit_unit<E>(self) -> core::result::Result<Json, E> {
                Ok(Json::Null)
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> core::result::Result<Json, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Json::Array(items))
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> core::result::Result<Json, A::Error> {
                let mut entries = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Json>()? {
                    entries.push((key, value));
                }
                Ok(Json::Object(entries))
            }
        }

        deserializer.deserialize_any(JsonVisitor)
    }
}

use crate::error::{resource_limit, EngineError, Result};
use crate::formats::lzma::{compress_lzma_alone, decompress_lzma_alone};
use crate::limits;

pub use crate::score::ScoreRank;

/// legacyscoredecoder.cs:117 -- the first replay version whose framing
/// carries a length-prefixed score-info array after the online score id. at
/// or above it that array is read unconditionally, so it must be present
/// even when its payload is empty. one above
/// [`super::osr::FIRST_LAZER_VERSION`], which marks a play as lazer-native
/// without carrying the block
pub const FIRST_LAZER_SCORE_INFO_VERSION: u32 = 30_000_001;

/// legacyscoreencoder.cs:69 -- the version the pinned encoder stamps on
/// every replay it writes. a regenerating export under the native profile
/// stamps this, because the total score it carries was computed by the port
/// of this version's algorithm
pub const LATEST_LAZER_VERSION: u32 = 30_000_019;

/// `LegacyReplaySoloScoreInfo`, one field per json property, plus the
/// unknown keys kept beside them
#[derive(Debug, Clone, PartialEq)]
pub struct ScoreInfo {
    /// `online_id`: the `solo_scores` id, or -1 for a local play
    pub online_id: i64,
    /// `mods`: acronym plus a settings map, one entry per active mod
    pub mods: Vec<ScoreInfoMod>,
    /// `statistics`: the play's result counts, keyed by lazer's snake-case
    /// result names, only the nonzero ones written (`FromScore` filters)
    pub statistics: Vec<StatisticEntry>,
    /// `maximum_statistics`: the counts a perfect play would reach
    pub maximum_statistics: Vec<StatisticEntry>,
    /// `client_version`: the writing client's own version string
    pub client_version: String,
    /// `rank`: lazer's rank for the play, absent when the writer had none
    pub rank: Option<ScoreRank>,
    /// `user_id`: the player's online id, -1 when unknown
    pub user_id: i64,
    /// `total_score_without_mods`: absent when lazer had none to write
    /// (`FromScore` writes it only when positive)
    pub total_score_without_mods: Option<i64>,
    /// `pauses`: the play's pause instants
    pub pauses: Vec<i64>,
    /// every top-level key this schema does not name, verbatim and in
    /// document order, so a block written by a newer lazer survives a
    /// decode-encode round trip
    pub unknown: Vec<(String, Json)>,
}

/// `APIMod`: an acronym and the settings that differ from the mod's defaults
/// (`apimod.cs:39-49` writes only non-default bindables, as snake-case keys)
#[derive(Debug, Clone, PartialEq)]
pub struct ScoreInfoMod {
    pub acronym: String,
    /// kept as opaque json values in the writer's order: a setting's type is
    /// the mod's own business, and this crate resolves none of them yet
    pub settings: Vec<(String, Json)>,
}

/// one entry of a statistics map
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatisticEntry {
    /// lazer's snake-case result name (`great`, `large_tick_hit`,
    /// `slider_tail_hit`, ...), or a name this crate does not know, kept
    /// verbatim
    pub result: String,
    pub count: i64,
}

/// what decoding a framed block answers: the parsed value, or why the bytes
/// could not be read as one. a cap breach is neither -- it is the typed
/// error the entry point returns instead
#[derive(Debug, Clone, PartialEq)]
pub enum ScoreInfoDecode {
    Parsed(ScoreInfo),
    Malformed(String),
}

/// reads a block's content: lzma-alone over utf-8 json over the schema
/// above. `raw` is the array's payload exactly as framed in the file
pub fn decode_score_info(raw: &[u8]) -> Result<ScoreInfoDecode> {
    let decompressed = match decompress_lzma_alone(raw, limits::MAX_SCORE_INFO_BYTES, "MAX_SCORE_INFO_BYTES") {
        Ok(bytes) => bytes,
        Err(cap @ EngineError::ResourceLimit { .. }) => return Err(cap),
        Err(other) => return Ok(ScoreInfoDecode::Malformed(format!("score-info block is not lzma: {other}"))),
    };
    let text = match std::str::from_utf8(&decompressed) {
        Ok(text) => text,
        Err(e) => return Ok(ScoreInfoDecode::Malformed(format!("score-info json is not utf-8: {e}"))),
    };
    check_json_depth(text, limits::MAX_SCORE_INFO_JSON_DEPTH)?;
    let value: Json = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(e) => return Ok(ScoreInfoDecode::Malformed(format!("score-info json does not parse: {e}"))),
    };
    match parse_score_info(value) {
        Ok(Ok(info)) => Ok(ScoreInfoDecode::Parsed(info)),
        Ok(Err(reason)) => Ok(ScoreInfoDecode::Malformed(reason)),
        Err(cap) => Err(cap),
    }
}

/// the nesting depth of a json text, counted before it is parsed so the cap
/// is this crate's own typed error rather than serde_json's recursion
/// limit. brackets inside strings do not nest, hence the string and escape
/// tracking; a text that is not json at all is left for the parser to
/// refuse -- this only has to bound what a parse would recurse into
fn check_json_depth(text: &str, cap: usize) -> Result<()> {
    let mut depth = 0usize;
    let mut deepest = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for byte in text.bytes() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' | b'[' => {
                depth += 1;
                deepest = deepest.max(depth);
                if deepest > cap {
                    return Err(resource_limit("MAX_SCORE_INFO_JSON_DEPTH", cap as u64, deepest as u64));
                }
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    Ok(())
}

/// the outer `Result` is a cap breach; the inner is the malformed reason
fn parse_score_info(value: Json) -> Result<core::result::Result<ScoreInfo, String>> {
    let Json::Object(object) = value else {
        return Ok(Err("score-info json is not an object".into()));
    };
    let mut info = ScoreInfo {
        online_id: -1,
        mods: Vec::new(),
        statistics: Vec::new(),
        maximum_statistics: Vec::new(),
        client_version: String::new(),
        rank: None,
        user_id: -1,
        total_score_without_mods: None,
        pauses: Vec::new(),
        unknown: Vec::new(),
    };
    for (key, value) in object {
        let field: core::result::Result<(), &str> = match key.as_str() {
            "online_id" => match integer(&value) {
                Some(id) => {
                    info.online_id = id;
                    continue;
                }
                None => Err("online_id"),
            },
            "user_id" => match integer(&value) {
                Some(id) => {
                    info.user_id = id;
                    continue;
                }
                None => Err("user_id"),
            },
            "client_version" => match value {
                Json::String(s) => {
                    info.client_version = s;
                    continue;
                }
                Json::Null => continue,
                _ => Err("client_version"),
            },
            "rank" => match value {
                Json::Null => continue,
                Json::String(ref name) => match ScoreRank::from_name(name) {
                    Some(rank) => {
                        info.rank = Some(rank);
                        continue;
                    }
                    None => Err("rank"),
                },
                ref other => match integer(other).and_then(ScoreRank::from_integer) {
                    Some(rank) => {
                        info.rank = Some(rank);
                        continue;
                    }
                    None => Err("rank"),
                },
            },
            "total_score_without_mods" => match value {
                Json::Null => continue,
                ref other => match integer(other) {
                    Some(total) => {
                        info.total_score_without_mods = Some(total);
                        continue;
                    }
                    None => Err("total_score_without_mods"),
                },
            },
            "mods" => match parse_mods(value)? {
                Ok(mods) => {
                    info.mods = mods;
                    continue;
                }
                Err(reason) => return Ok(Err(reason)),
            },
            "statistics" => match parse_statistics(value, "statistics")? {
                Ok(entries) => {
                    info.statistics = entries;
                    continue;
                }
                Err(reason) => return Ok(Err(reason)),
            },
            "maximum_statistics" => match parse_statistics(value, "maximum_statistics")? {
                Ok(entries) => {
                    info.maximum_statistics = entries;
                    continue;
                }
                Err(reason) => return Ok(Err(reason)),
            },
            "pauses" => match parse_pauses(value)? {
                Ok(pauses) => {
                    info.pauses = pauses;
                    continue;
                }
                Err(reason) => return Ok(Err(reason)),
            },
            _ => {
                info.unknown.push((key, value));
                continue;
            }
        };
        if let Err(name) = field {
            return Ok(Err(format!("score-info field {name} has the wrong json type")));
        }
    }
    Ok(Ok(info))
}

fn integer(value: &Json) -> Option<i64> {
    value.as_i64()
}

fn parse_mods(value: Json) -> Result<core::result::Result<Vec<ScoreInfoMod>, String>> {
    let entries = match value {
        Json::Array(entries) => entries,
        Json::Null => return Ok(Ok(Vec::new())),
        _ => return Ok(Err("score-info field mods is not an array".into())),
    };
    if entries.len() > limits::MAX_SCORE_INFO_MODS {
        return Err(resource_limit(
            "MAX_SCORE_INFO_MODS",
            limits::MAX_SCORE_INFO_MODS as u64,
            entries.len() as u64,
        ));
    }
    let mut mods = Vec::with_capacity(entries.len());
    for entry in entries {
        let Json::Object(object) = entry else {
            return Ok(Err("score-info mods entry is not an object".into()));
        };
        let mut acronym = String::new();
        let mut settings = Vec::new();
        for (key, value) in object {
            match key.as_str() {
                "acronym" => match value {
                    Json::String(s) => acronym = s,
                    Json::Null => {}
                    _ => return Ok(Err("score-info mod acronym is not a string".into())),
                },
                "settings" => match value {
                    Json::Object(map) => {
                        if map.len() > limits::MAX_SCORE_INFO_MOD_SETTINGS {
                            return Err(resource_limit(
                                "MAX_SCORE_INFO_MOD_SETTINGS",
                                limits::MAX_SCORE_INFO_MOD_SETTINGS as u64,
                                map.len() as u64,
                            ));
                        }
                        settings = map;
                    }
                    Json::Null => {}
                    _ => return Ok(Err("score-info mod settings is not an object".into())),
                },
                // apimod.cs declares exactly the two; anything else would be
                // a newer lazer's addition, and a mod is re-encoded from its
                // acronym and settings alone, so an extra key is dropped
                // rather than carried
                _ => {}
            }
        }
        mods.push(ScoreInfoMod { acronym, settings });
    }
    Ok(Ok(mods))
}

fn parse_statistics(value: Json, field: &str) -> Result<core::result::Result<Vec<StatisticEntry>, String>> {
    let map = match value {
        Json::Object(map) => map,
        Json::Null => return Ok(Ok(Vec::new())),
        _ => return Ok(Err(format!("score-info field {field} is not an object"))),
    };
    if map.len() > limits::MAX_SCORE_INFO_STATISTICS {
        return Err(resource_limit(
            "MAX_SCORE_INFO_STATISTICS",
            limits::MAX_SCORE_INFO_STATISTICS as u64,
            map.len() as u64,
        ));
    }
    let mut entries = Vec::with_capacity(map.len());
    for (result, count) in map {
        let Some(count) = integer(&count) else {
            return Ok(Err(format!("score-info {field} entry {result} is not an integer")));
        };
        entries.push(StatisticEntry { result, count });
    }
    Ok(Ok(entries))
}

fn parse_pauses(value: Json) -> Result<core::result::Result<Vec<i64>, String>> {
    let entries = match value {
        Json::Array(entries) => entries,
        Json::Null => return Ok(Ok(Vec::new())),
        _ => return Ok(Err("score-info field pauses is not an array".into())),
    };
    if entries.len() > limits::MAX_SCORE_INFO_PAUSES {
        return Err(resource_limit(
            "MAX_SCORE_INFO_PAUSES",
            limits::MAX_SCORE_INFO_PAUSES as u64,
            entries.len() as u64,
        ));
    }
    let mut pauses = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some(pause) = integer(&entry) else {
            return Ok(Err("score-info pauses entry is not an integer".into()));
        };
        pauses.push(pause);
    }
    Ok(Ok(pauses))
}

/// writes a block's content lazer's reader accepts: the json in the
/// serializer's own indented, snake-case, defaults-omitted shape, then lzma
/// with the declared size in the header, as `LegacyScoreEncoder.compress`
/// writes it (legacyscoreencoder.cs:134-152; the dictionary size differs,
/// which lazer's `LzmaStream` reads off the header and never checks)
pub fn encode_score_info(info: &ScoreInfo) -> Result<Vec<u8>> {
    compress_lzma_alone(score_info_json(info).as_bytes())
}

/// the json text, in the member order newtonsoft emits for the pinned class
/// (the three fields, then the properties) and with the members lazer omits
/// when they sit at their default: a null rank, an absent
/// `total_score_without_mods`, an empty settings map on a mod
/// (`apimod.cs:82 ShouldSerializeSettings`)
pub fn score_info_json(info: &ScoreInfo) -> String {
    let mut out = String::from("{\n");
    let mut members: Vec<String> = Vec::new();
    members.push(format!("  \"client_version\": {}", json_string(&info.client_version)));
    if let Some(rank) = info.rank {
        members.push(format!("  \"rank\": {}", json_string(rank.as_str())));
    }
    members.push(format!("  \"user_id\": {}", info.user_id));
    members.push(format!("  \"online_id\": {}", info.online_id));
    members.push(format!("  \"mods\": {}", mods_json(&info.mods)));
    members.push(format!("  \"statistics\": {}", statistics_json(&info.statistics, 1)));
    members.push(format!(
        "  \"maximum_statistics\": {}",
        statistics_json(&info.maximum_statistics, 1)
    ));
    if let Some(total) = info.total_score_without_mods {
        members.push(format!("  \"total_score_without_mods\": {total}"));
    }
    members.push(format!("  \"pauses\": {}", integers_json(&info.pauses, 1)));
    for (key, value) in &info.unknown {
        members.push(format!("  {}: {}", json_string(key), pretty_value(value, 1)));
    }
    out.push_str(&members.join(",\n"));
    out.push_str("\n}");
    out
}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).expect("a string always serialises")
}

fn indent(level: usize) -> String {
    "  ".repeat(level)
}

fn mods_json(mods: &[ScoreInfoMod]) -> String {
    if mods.is_empty() {
        return "[]".into();
    }
    let entries: Vec<String> = mods
        .iter()
        .map(|m| {
            let mut lines = vec![format!("{}\"acronym\": {}", indent(3), json_string(&m.acronym))];
            if !m.settings.is_empty() {
                let settings: Vec<String> = m
                    .settings
                    .iter()
                    .map(|(key, value)| format!("{}{}: {}", indent(4), json_string(key), pretty_value(value, 4)))
                    .collect();
                lines.push(format!(
                    "{}\"settings\": {{\n{}\n{}}}",
                    indent(3),
                    settings.join(",\n"),
                    indent(3)
                ));
            }
            format!("{}{{\n{}\n{}}}", indent(2), lines.join(",\n"), indent(2))
        })
        .collect();
    format!("[\n{}\n{}]", entries.join(",\n"), indent(1))
}

fn statistics_json(entries: &[StatisticEntry], level: usize) -> String {
    if entries.is_empty() {
        return "{}".into();
    }
    let lines: Vec<String> = entries
        .iter()
        .map(|e| format!("{}{}: {}", indent(level + 1), json_string(&e.result), e.count))
        .collect();
    format!("{{\n{}\n{}}}", lines.join(",\n"), indent(level))
}

fn integers_json(values: &[i64], level: usize) -> String {
    if values.is_empty() {
        return "[]".into();
    }
    let lines: Vec<String> = values.iter().map(|v| format!("{}{v}", indent(level + 1))).collect();
    format!("[\n{}\n{}]", lines.join(",\n"), indent(level))
}

/// an opaque value in the same indented style, so an unknown key reads like
/// the rest of the block
fn pretty_value(value: &Json, level: usize) -> String {
    match value {
        Json::Null => "null".into(),
        Json::Bool(b) => b.to_string(),
        Json::Number(n) => n.to_string(),
        Json::String(s) => json_string(s),
        Json::Array(items) if items.is_empty() => "[]".into(),
        Json::Object(entries) if entries.is_empty() => "{}".into(),
        Json::Array(items) => {
            let lines: Vec<String> = items
                .iter()
                .map(|v| format!("{}{}", indent(level + 1), pretty_value(v, level + 1)))
                .collect();
            format!("[\n{}\n{}]", lines.join(",\n"), indent(level))
        }
        Json::Object(entries) => {
            let lines: Vec<String> = entries
                .iter()
                .map(|(k, v)| format!("{}{}: {}", indent(level + 1), json_string(k), pretty_value(v, level + 1)))
                .collect();
            format!("{{\n{}\n{}}}", lines.join(",\n"), indent(level))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// a json value from its text, in document order
    fn json(text: &str) -> Json {
        serde_json::from_str(text).unwrap()
    }

    fn sample() -> ScoreInfo {
        ScoreInfo {
            online_id: -1,
            mods: vec![
                ScoreInfoMod {
                    acronym: "DT".into(),
                    settings: vec![("speed_change".into(), json("1.3"))],
                },
                ScoreInfoMod {
                    acronym: "HD".into(),
                    settings: Vec::new(),
                },
            ],
            statistics: vec![
                StatisticEntry {
                    result: "great".into(),
                    count: 114,
                },
                StatisticEntry {
                    result: "slider_tail_hit".into(),
                    count: 13,
                },
                StatisticEntry {
                    result: "a_result_this_crate_never_heard_of".into(),
                    count: 2,
                },
            ],
            maximum_statistics: vec![StatisticEntry {
                result: "great".into(),
                count: 419,
            }],
            client_version: "2026.401.0-lazer".into(),
            rank: Some(ScoreRank::SH),
            user_id: 10_119_933,
            total_score_without_mods: Some(147_051),
            pauses: vec![1000, 2000],
            unknown: vec![("a_newer_field".to_string(), json("{ \"nested\": [1, 2] }"))],
        }
    }

    fn decode(raw: &[u8]) -> ScoreInfo {
        match decode_score_info(raw).unwrap() {
            ScoreInfoDecode::Parsed(info) => info,
            ScoreInfoDecode::Malformed(reason) => panic!("expected a parsed block, got malformed: {reason}"),
        }
    }

    fn malformed(raw: &[u8]) -> String {
        match decode_score_info(raw).unwrap() {
            ScoreInfoDecode::Malformed(reason) => reason,
            ScoreInfoDecode::Parsed(info) => panic!("expected malformed, got {info:?}"),
        }
    }

    #[test]
    fn a_block_round_trips_through_the_encoder_value_for_value() {
        let info = sample();
        let encoded = encode_score_info(&info).unwrap();
        assert_eq!(decode(&encoded), info);
    }

    #[test]
    fn object_keys_keep_their_document_order() {
        // the real fixture writes its statistics in the order the play
        // produced them, and that order must come back out
        let raw = compress_lzma_alone(b"{\"statistics\": {\"miss\": 7, \"ok\": 5, \"great\": 114}, \"mods\": [{\"acronym\": \"DA\", \"settings\": {\"overall_difficulty\": 9.5, \"circle_size\": 3.0}}]}").unwrap();
        let info = decode(&raw);
        let names: Vec<&str> = info.statistics.iter().map(|e| e.result.as_str()).collect();
        assert_eq!(names, ["miss", "ok", "great"]);
        let settings: Vec<&str> = info.mods[0].settings.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(settings, ["overall_difficulty", "circle_size"]);
        assert_eq!(decode(&encode_score_info(&info).unwrap()), info);
    }

    #[test]
    fn a_bomb_shaped_header_is_refused_as_the_breach_it_claims() {
        // thirteen-plus bytes of garbage whose bytes 5..13 happen to spell
        // a size past the cap: indistinguishable from a bomb before the
        // work is done, so it is refused as one (see the module doc)
        match decode_score_info(b"not lzma at all, and long enough to declare a size") {
            Err(EngineError::ResourceLimit {
                cap: "MAX_SCORE_INFO_BYTES",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn the_json_follows_lazers_member_order_and_omits_its_defaults() {
        // the shape the real fixture's block has: fields first, then the
        // properties in declaration order, empty settings omitted, an
        // absent rank and total omitted
        let mut info = sample();
        info.rank = None;
        info.total_score_without_mods = None;
        info.unknown.clear();
        let text = score_info_json(&info);
        assert_eq!(
            text,
            "{\n  \"client_version\": \"2026.401.0-lazer\",\n  \"user_id\": 10119933,\n  \"online_id\": -1,\n  \"mods\": [\n    {\n      \"acronym\": \"DT\",\n      \"settings\": {\n        \"speed_change\": 1.3\n      }\n    },\n    {\n      \"acronym\": \"HD\"\n    }\n  ],\n  \"statistics\": {\n    \"great\": 114,\n    \"slider_tail_hit\": 13,\n    \"a_result_this_crate_never_heard_of\": 2\n  },\n  \"maximum_statistics\": {\n    \"great\": 419\n  },\n  \"pauses\": [\n    1000,\n    2000\n  ]\n}"
        );
        // and the empty collections spell as newtonsoft spells them
        info.mods.clear();
        info.pauses.clear();
        info.statistics.clear();
        let text = score_info_json(&info);
        assert!(text.contains("\"mods\": [],"));
        assert!(text.contains("\"statistics\": {},"));
        assert!(text.ends_with("\"pauses\": []\n}"));
    }

    #[test]
    fn a_nomod_block_with_defaults_decodes_to_the_defaults() {
        let raw = compress_lzma_alone(b"{}").unwrap();
        let info = decode(&raw);
        assert_eq!(info.online_id, -1);
        assert_eq!(info.user_id, -1);
        assert!(info.mods.is_empty());
        assert!(info.rank.is_none());
        assert!(info.total_score_without_mods.is_none());
        assert!(info.pauses.is_empty());
    }

    #[test]
    fn ranks_read_by_name_and_by_integer() {
        for (text, rank) in [("\"F\"", ScoreRank::F), ("\"XH\"", ScoreRank::XH), ("-1", ScoreRank::F), ("7", ScoreRank::XH)] {
            let raw = compress_lzma_alone(format!("{{\"rank\": {text}}}").as_bytes()).unwrap();
            assert_eq!(decode(&raw).rank, Some(rank), "{text}");
        }
        let raw = compress_lzma_alone(b"{\"rank\": null}").unwrap();
        assert_eq!(decode(&raw).rank, None);
        let raw = compress_lzma_alone(b"{\"rank\": \"Z\"}").unwrap();
        assert!(malformed(&raw).contains("rank"));
    }

    #[test]
    fn unreadable_blocks_are_malformed_answers_not_errors() {
        // too short to carry an lzma header at all
        assert!(malformed(b"not lzma").contains("not lzma"));
        // a real header with garbage behind it: declares a small size, so
        // the cap precheck passes and the range decoder is what refuses
        let mut torn = compress_lzma_alone(b"{}").unwrap();
        for byte in torn.iter_mut().skip(13) {
            *byte ^= 0xff;
        }
        assert!(malformed(&torn).contains("not lzma"));
        let raw = compress_lzma_alone(b"\xff\xfe").unwrap();
        assert!(malformed(&raw).contains("utf-8"));
        let raw = compress_lzma_alone(b"{ not json").unwrap();
        assert!(malformed(&raw).contains("parse"));
        let raw = compress_lzma_alone(b"[1, 2]").unwrap();
        assert!(malformed(&raw).contains("not an object"));
        let raw = compress_lzma_alone(b"{\"mods\": 5}").unwrap();
        assert!(malformed(&raw).contains("mods"));
        let raw = compress_lzma_alone(b"{\"statistics\": {\"great\": \"many\"}}").unwrap();
        assert!(malformed(&raw).contains("great"));
        let raw = compress_lzma_alone(b"{\"online_id\": 1.5}").unwrap();
        assert!(malformed(&raw).contains("online_id"));
    }

    #[test]
    fn unknown_keys_and_result_names_survive_and_extra_mod_keys_do_not() {
        let raw = compress_lzma_alone(
            b"{\"future\": {\"x\": [1, {\"y\": null}]}, \"statistics\": {\"legacy_combo_increase\": 3}, \"mods\": [{\"acronym\": \"CL\", \"unheard\": 1}]}",
        )
        .unwrap();
        let info = decode(&raw);
        assert_eq!(info.unknown[0].0, "future");
        assert_eq!(info.unknown[0].1, json("{ \"x\": [1, { \"y\": null }] }"));
        assert_eq!(info.statistics[0].result, "legacy_combo_increase");
        assert_eq!(info.mods[0].acronym, "CL");
        assert!(info.mods[0].settings.is_empty());
        // and the whole thing still round-trips
        assert_eq!(decode(&encode_score_info(&info).unwrap()), info);
    }

    fn cap_error(result: Result<ScoreInfoDecode>, cap: &'static str) {
        match result {
            Err(EngineError::ResourceLimit { cap: actual, .. }) if actual == cap => {}
            other => panic!("expected ResourceLimit {cap}, got {other:?}"),
        }
    }

    #[test]
    fn decompressed_size_cap_boundary() {
        // an unknown key padded to land the json exactly on the cap; one
        // more byte of padding trips it. the cap measures the json, and the
        // compressed array is a few kilobytes either way
        let body = |padding: usize| format!("{{\"pad\": \"{}\"}}", "x".repeat(padding));
        let overhead = body(0).len();
        let at_limit = body(limits::MAX_SCORE_INFO_BYTES as usize - overhead);
        assert_eq!(at_limit.len() as u64, limits::MAX_SCORE_INFO_BYTES);
        assert!(decode_score_info(&compress_lzma_alone(at_limit.as_bytes()).unwrap()).is_ok());
        let past = body(limits::MAX_SCORE_INFO_BYTES as usize - overhead + 1);
        cap_error(
            decode_score_info(&compress_lzma_alone(past.as_bytes()).unwrap()),
            "MAX_SCORE_INFO_BYTES",
        );
    }

    #[test]
    fn json_depth_cap_boundary() {
        let nested = |depth: usize| {
            format!(
                "{{\"pad\": {}1{}}}",
                "[".repeat(depth - 1),
                "]".repeat(depth - 1)
            )
        };
        let at_limit = compress_lzma_alone(nested(limits::MAX_SCORE_INFO_JSON_DEPTH).as_bytes()).unwrap();
        assert!(decode_score_info(&at_limit).is_ok());
        let past = compress_lzma_alone(nested(limits::MAX_SCORE_INFO_JSON_DEPTH + 1).as_bytes()).unwrap();
        cap_error(decode_score_info(&past), "MAX_SCORE_INFO_JSON_DEPTH");
        // brackets inside a string never nest
        let text = format!("{{\"pad\": \"{}\"}}", "[".repeat(limits::MAX_SCORE_INFO_JSON_DEPTH * 2));
        assert!(decode_score_info(&compress_lzma_alone(text.as_bytes()).unwrap()).is_ok());
    }

    #[test]
    fn mods_cap_boundary() {
        let mods = |n: usize| format!("{{\"mods\": [{}]}}", vec!["{\"acronym\": \"HD\"}"; n].join(","));
        let at_limit = compress_lzma_alone(mods(limits::MAX_SCORE_INFO_MODS).as_bytes()).unwrap();
        assert!(decode_score_info(&at_limit).is_ok());
        let past = compress_lzma_alone(mods(limits::MAX_SCORE_INFO_MODS + 1).as_bytes()).unwrap();
        cap_error(decode_score_info(&past), "MAX_SCORE_INFO_MODS");
    }

    #[test]
    fn mod_settings_cap_boundary() {
        let settings = |n: usize| {
            let entries: Vec<String> = (0..n).map(|i| format!("\"s{i}\": 1")).collect();
            format!(
                "{{\"mods\": [{{\"acronym\": \"DA\", \"settings\": {{{}}}}}]}}",
                entries.join(",")
            )
        };
        let at_limit = compress_lzma_alone(settings(limits::MAX_SCORE_INFO_MOD_SETTINGS).as_bytes()).unwrap();
        assert!(decode_score_info(&at_limit).is_ok());
        let past = compress_lzma_alone(settings(limits::MAX_SCORE_INFO_MOD_SETTINGS + 1).as_bytes()).unwrap();
        cap_error(decode_score_info(&past), "MAX_SCORE_INFO_MOD_SETTINGS");
    }

    #[test]
    fn statistics_cap_boundary() {
        let stats = |field: &str, n: usize| {
            let entries: Vec<String> = (0..n).map(|i| format!("\"r{i}\": 1")).collect();
            format!("{{\"{field}\": {{{}}}}}", entries.join(","))
        };
        for field in ["statistics", "maximum_statistics"] {
            let at_limit = compress_lzma_alone(stats(field, limits::MAX_SCORE_INFO_STATISTICS).as_bytes()).unwrap();
            assert!(decode_score_info(&at_limit).is_ok(), "{field}");
            let past = compress_lzma_alone(stats(field, limits::MAX_SCORE_INFO_STATISTICS + 1).as_bytes()).unwrap();
            cap_error(decode_score_info(&past), "MAX_SCORE_INFO_STATISTICS");
        }
    }

    #[test]
    fn pauses_cap_boundary() {
        let pauses = |n: usize| format!("{{\"pauses\": [{}]}}", vec!["1"; n].join(","));
        let at_limit = compress_lzma_alone(pauses(limits::MAX_SCORE_INFO_PAUSES).as_bytes()).unwrap();
        assert!(decode_score_info(&at_limit).is_ok());
        let past = compress_lzma_alone(pauses(limits::MAX_SCORE_INFO_PAUSES + 1).as_bytes()).unwrap();
        cap_error(decode_score_info(&past), "MAX_SCORE_INFO_PAUSES");
    }

    #[test]
    fn the_encoder_declares_the_content_length_in_the_lzma_header() {
        // legacyscoreencoder.cs:144-146 writes the real content length;
        // lazer's reader takes it as the output size
        let encoded = encode_score_info(&sample()).unwrap();
        let declared = u64::from_le_bytes(encoded[5..13].try_into().unwrap());
        assert_eq!(declared, score_info_json(&sample()).len() as u64);
    }
}
