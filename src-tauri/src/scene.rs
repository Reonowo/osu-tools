//! the LoadedScene json contract (spec, tauri layer): everything the
//! frontend needs for one loaded replay, in one payload. engine types cross
//! this boundary as dtos so the engine's internal shapes can evolve without
//! breaking the frontend; the render plan serializes itself (its shape is
//! its contract). the simulation union makes an invalid state
//! unrepresentable: a judgement timeline exists only inside the
//! authoritative arm

use std::path::PathBuf;

use engine::beatmap::difficulty::HitGrade;
use engine::configuration::{
    Capabilities, Capability, ModProvenance, PlayConfiguration, RefusalReason, RulesProfile, SimulationSupport,
};
use engine::formats::beatmap::Beatmap;
use engine::formats::osr::{OsrHeader, OsrTrailer, ScoreInfoBlock};
use engine::formats::score_info::{ScoreInfo, ScoreInfoMod};
use engine::render_plan::RenderPlan;
use engine::replay::frames::ReplayFrame;
use engine::score::ScoreRank;
use engine::simulation::score::JudgementKind;
use engine::simulation::{JudgementEvent, JudgementTimeline};
use serde::{Deserialize, Serialize};

use crate::error::Warning;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedScene {
    /// session identity, stamped by install_scene; a plain json number
    /// (install counter, nowhere near 2^53)
    pub epoch: u64,
    pub beatmap: BeatmapMeta,
    pub replay: ReplayMeta,
    /// the play configuration the engine resolved for this file: the rules
    /// profile, the effective mods, where they came from, and what the app
    /// may do with the play -- the one source both edit gates read
    pub configuration: ConfigurationDto,
    pub frames: Vec<FrameDto>,
    pub render_plan: RenderPlan,
    pub simulation: SimulationDto,
    /// absolute path for tauri's convertFileSrc; the command layer has
    /// already allowed it on the asset protocol scope
    pub audio_path: Option<String>,
    pub background_path: Option<String>,
    /// the beatmap's OWN hit-sample files, keyed by the lookup name the
    /// frontend's chain asks for (a lowercased stem, or a full file name for
    /// an explicit `hitSample`). empty for a map that ships none, which is
    /// most of them -- the bundled default set answers those.
    ///
    /// resolved rust-side because the candidate names are derivable only from
    /// the engine's own resolution, which is also what lets the `.osz`
    /// extractor stay a targeted allow-list
    pub sample_files: std::collections::BTreeMap<String, String>,
    /// the beatmap's OWN image files, keyed by lowercased file NAME (extension
    /// included) rather than by lookup name -- which of `hitcircle@2x.png` and
    /// `hitcircle.png` answers a `hitcircle` lookup is an era rule, and era
    /// rules live in the frontend's lookup chain. the same shape a skin
    /// manifest's file map has, for the same reason.
    ///
    /// only files whose name matches a ruleset element prefix are enumerated
    /// (`media::BEATMAP_SKIN_PREFIXES`): a mapset's background and storyboard
    /// can answer no lookup, and putting them here would charge a byte cap
    /// against art nothing would ever draw
    pub texture_files: std::collections::BTreeMap<String, String>,
    pub warnings: Vec<Warning>,
    /// the file-vs-simulated comparison, shipped for authoritative scenes
    /// against whichever record is that profile's oracle: the header under
    /// the stable profile, the score-info block under the native one. always
    /// describes the loaded file, never in-session edits
    pub integrity: Option<IntegrityDto>,
    /// present when the play ended early: the header judged fewer objects
    /// than the map has (the corpus admission identity, computed at load
    /// from the header counts alone). the report keeps its rows but the
    /// panel stops rendering differences as verdicts, and the export
    /// dialog states what a regenerating export of such a play contains.
    /// withheld on a consented beatmap mismatch, where the object count
    /// describes the wrong map
    pub incompleteness: Option<IncompletenessDto>,
}

/// mirrors `engine::configuration::PlayConfiguration` field for field
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationDto {
    pub profile: RulesProfile,
    pub mods: Vec<EffectiveModDto>,
    pub provenance: ModProvenance,
    pub rate: f64,
    pub capabilities: CapabilitiesDto,
}

/// one effective mod: the acronym and the settings that differ from its
/// defaults, as opaque json
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveModDto {
    pub acronym: String,
    pub settings: serde_json::Map<String, serde_json::Value>,
}

impl From<&ScoreInfoMod> for EffectiveModDto {
    fn from(m: &ScoreInfoMod) -> EffectiveModDto {
        EffectiveModDto {
            acronym: m.acronym.clone(),
            settings: m.settings.iter().map(|(k, v)| (k.clone(), v.to_value())).collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesDto {
    pub simulate: SimulateCapabilityDto,
    pub edit_frames: CapabilityDto,
    pub regenerate_export: CapabilityDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SimulateCapabilityDto {
    Authoritative { profile: RulesProfile },
    Approximate { profile: RulesProfile },
    Refused { reason: RefusalReason },
}

/// allowed, or refused with the engine's own reason -- the string a gate
/// shows in its tooltip and the command layer returns as `NotEditable`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDto {
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl From<&Capability> for CapabilityDto {
    fn from(c: &Capability) -> CapabilityDto {
        CapabilityDto {
            allowed: c.is_allowed(),
            reason: c.refusal().map(str::to_owned),
        }
    }
}

impl From<&Capabilities> for CapabilitiesDto {
    fn from(c: &Capabilities) -> CapabilitiesDto {
        CapabilitiesDto {
            simulate: match &c.simulate {
                SimulationSupport::Authoritative { profile } => {
                    SimulateCapabilityDto::Authoritative { profile: *profile }
                }
                SimulationSupport::Approximate { profile } => SimulateCapabilityDto::Approximate { profile: *profile },
                SimulationSupport::Refused { reason } => SimulateCapabilityDto::Refused {
                    reason: reason.clone(),
                },
            },
            edit_frames: CapabilityDto::from(&c.edit_frames),
            regenerate_export: CapabilityDto::from(&c.regenerate_export),
        }
    }
}

impl From<&PlayConfiguration> for ConfigurationDto {
    fn from(c: &PlayConfiguration) -> ConfigurationDto {
        ConfigurationDto {
            profile: c.profile,
            mods: c.mods.iter().map(EffectiveModDto::from).collect(),
            provenance: c.provenance,
            rate: c.rate,
            capabilities: CapabilitiesDto::from(&c.capabilities),
        }
    }
}

/// the file's own score-info record, in the five states the codec tells
/// apart: what the replay panel's recorded-in-file card shows and the
/// native integrity report compares against
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ScoreInfoDto {
    /// a stable-versioned file: nothing lazer wrote
    Opaque,
    /// lazer's first replay version, before the block existed
    Absent,
    /// the framed empty array
    Empty,
    Present {
        statistics: Vec<StatisticDto>,
        maximum_statistics: Vec<StatisticDto>,
        /// the file's OWN accuracy, folded from the two maps above by lazer's
        /// rule (`engine::score::accuracy_from_statistics`). lazer stores the
        /// maps and not the fraction, and a stable header's four counts cannot
        /// stand in for it -- the native rule weighs slider tails and large
        /// ticks the projection does not carry -- so the panel's "was" reads
        /// this rather than `ReplayMeta::accuracy`. null when the block's
        /// maximum map weighs nothing, which says nothing rather than 100%
        accuracy: Option<f64>,
        rank: Option<ScoreRank>,
        total_score_without_mods: Option<i64>,
        client_version: String,
        /// a string for `ReplayMeta::online_score_id`'s reason
        online_id: String,
        user_id: i64,
        pause_count: usize,
    },
    Malformed {
        reason: String,
    },
}

/// one statistics entry, in the block's own order and vocabulary
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticDto {
    pub result: String,
    pub count: i64,
}

impl ScoreInfoDto {
    pub fn from_trailer(trailer: &OsrTrailer) -> ScoreInfoDto {
        let entries = |entries: &[engine::formats::score_info::StatisticEntry]| {
            entries
                .iter()
                .map(|e| StatisticDto {
                    result: e.result.clone(),
                    count: e.count,
                })
                .collect()
        };
        match &trailer.block {
            ScoreInfoBlock::Opaque => ScoreInfoDto::Opaque,
            ScoreInfoBlock::Absent => ScoreInfoDto::Absent,
            ScoreInfoBlock::Empty => ScoreInfoDto::Empty,
            ScoreInfoBlock::Present { value, .. } => {
                let ScoreInfo {
                    online_id,
                    statistics,
                    maximum_statistics,
                    client_version,
                    rank,
                    user_id,
                    total_score_without_mods,
                    pauses,
                    ..
                } = value;
                fn pairs(entries: &[engine::formats::score_info::StatisticEntry]) -> Vec<(&str, i64)> {
                    entries.iter().map(|e| (e.result.as_str(), e.count)).collect()
                }
                ScoreInfoDto::Present {
                    statistics: entries(statistics),
                    maximum_statistics: entries(maximum_statistics),
                    accuracy: engine::score::accuracy_from_statistics(
                        &pairs(statistics),
                        &pairs(maximum_statistics),
                    ),
                    rank: *rank,
                    total_score_without_mods: *total_score_without_mods,
                    client_version: client_version.clone(),
                    online_id: online_id.to_string(),
                    user_id: *user_id,
                    pause_count: pauses.len(),
                }
            }
            ScoreInfoBlock::Malformed { reason, .. } => ScoreInfoDto::Malformed {
                reason: reason.clone(),
            },
        }
    }
}

/// judged-vs-total identity carried on the wire; `judged < total` by
/// construction (a header claiming more than the map has is not "ended
/// early" and keeps the ordinary mismatch verdicts)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncompletenessDto {
    pub judged: u32,
    pub total: u32,
}

/// the integrity report (spec, integrity report section): per-field
/// header-vs-simulated rows, the combo-section cross-check triple, and the
/// life bar graph comparison. the replay hash is deliberately excluded --
/// its formula varies across client generations, so a mismatch there would
/// not distinguish tampering from version skew
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityDto {
    /// the profile the comparison ran under, which decides which of the
    /// sections below carry an answer: stable's oracle is the header (the
    /// cross-check and the life bar graph read it), the native profile's
    /// is the block lazer wrote beside it
    pub profile: RulesProfile,
    pub rows: Vec<IntegrityRowDto>,
    /// stable's section identity; the native profile has no sections
    pub cross_check: Option<CrossCheckDto>,
    /// the header's graph scored against the simulated samples; a lazer
    /// client writes none, so the native profile has nothing to score
    pub life_bar_graph: Option<LifeBarGraphDto>,
    /// the native profile's comparison against the block: the rank, and
    /// the truncation a failed source is compared under
    pub block: Option<BlockCheckDto>,
}

/// the native profile's block comparison beyond the rows. a source whose
/// block records rank F failed in lazer, whose score processor stopped
/// counting at the failing result -- so the rows compare the engine's own
/// fold up to its own fail point, stated here, and a disagreement past
/// that rule is a parity finding rather than something to absorb
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockCheckDto {
    pub rank_block: Option<ScoreRank>,
    pub rank_simulated: ScoreRank,
    pub rank_match: bool,
    pub truncated_at: Option<f64>,
}

/// the header's life bar graph scored against the loaded file's own
/// simulated samples (`engine::score::compare_life_bar_graph`).
///
/// named for the GRAPH throughout, never "life bar" alone: that reads as the
/// HUD element, which since the HP bar landed is a real thing on screen
/// (`CONTEXT.md` -- life bar graph).
///
/// a COUNT and never a verdict: genuine plays land one sample short on a
/// katu placement the corpus already records, so "48 of 51" is information
/// about the header, not an accusation about it
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LifeBarGraphDto {
    /// the header carried no graph field at all
    Absent,
    /// it carried one, and no sample could be read out of it -- which is
    /// what a lazer-written replay leaves behind
    Empty,
    Compared {
        matched: u32,
        total: u32,
        /// the header's last value is `0`: stable's own record of a fail
        header_failed: bool,
    },
}

/// one compared field; `perfect` rides as 0/1 so every row shares a shape.
/// under the native profile a row is a statistics entry named by its
/// result (`great`, `large_tick_hit`), a `maximum:`-prefixed entry of the
/// maximum statistics, or one of the two header fields the block does not
/// carry (`maxCombo`, `totalScore`)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityRowDto {
    pub field: String,
    pub header: u64,
    pub simulated: u64,
    #[serde(rename = "match")]
    pub matches: bool,
}

/// TODO.md's identity stated outright: `sections - (geki + katsu)` is the
/// number of sections the header claims ended without a burst -- stable
/// awards neither geki nor katu to a section containing a miss OR a 50.
/// `geki_katsu` reads the header's own fields (the analyst's view of the
/// loaded file), and the implied count is signed so a header claiming more
/// geki+katu than the map has sections reads as the inconsistency it is
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossCheckDto {
    pub sections: u32,
    pub geki_katsu: u32,
    pub sections_without_burst: i64,
    /// the header's miss and 50 counts, restated beside the implication
    /// they bound: each burst-free section holds at least one of them
    pub count_miss: u16,
    pub count_50: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatmapMeta {
    pub title: String,
    pub artist: String,
    pub creator: String,
    pub version: String,
    pub beatmap_id: i32,
    pub beatmap_set_id: i32,
    pub format_version: i32,
    /// plan 4's signed clock needs this before audio zero
    pub audio_lead_in: f64,
    pub circle_size: f32,
    pub approach_rate: f32,
    pub overall_difficulty: f32,
    pub hp_drain_rate: f32,
    pub md5: String,
}

/// standard accuracy over judged counts: the weighting every surface in the
/// app shows, in one place so the recents card, the replay panel and the
/// browser row can never disagree about what a play scored. the rule itself
/// is the engine's (`score::standard_accuracy`), the same one a simulated
/// timeline's totals carry, so a header and a simulation compare like for
/// like.
///
/// takes the four counts rather than a header, because the two callers hold
/// different shapes of the same numbers -- a `.osr` header and a `scores.db`
/// row -- and neither should have to build the other's struct to ask
pub fn standard_accuracy(count_300: u16, count_100: u16, count_50: u16, count_miss: u16) -> f64 {
    engine::score::standard_accuracy(
        u32::from(count_300),
        u32::from(count_100),
        u32::from(count_50),
        u32::from(count_miss),
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayMeta {
    pub player_name: Option<String>,
    pub version: u32,
    pub mods: u32,
    pub count_300: u16,
    pub count_100: u16,
    pub count_50: u16,
    pub count_geki: u16,
    pub count_katsu: u16,
    pub count_miss: u16,
    pub total_score: u32,
    pub max_combo: u16,
    pub perfect: bool,
    /// the header's own accuracy over its four counts and lazer's rank for
    /// it, computed here by the same rule the simulated totals use so the
    /// panel's "was" reference and its live value can never disagree on
    /// the arithmetic. the file's OWN recorded rank, for a lazer play, is
    /// the score-info block's and rides separately
    pub accuracy: f64,
    pub rank: ScoreRank,
    /// .net datetime ticks, verbatim from the header; a string because the
    /// value (~6.4e17 for any current date) exceeds json's 2^53 safe-integer
    /// range and would silently round in the webview's JSON.parse
    pub timestamp_ticks: String,
    /// string for the same reason as timestamp_ticks
    pub online_score_id: String,
    pub beatmap_md5: Option<String>,
    /// the file's own score-info record; see `ScoreInfoDto`
    pub score_info: ScoreInfoDto,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDto {
    pub time: f64,
    pub x: f32,
    pub y: f32,
    /// raw button bitfield (left1=1, right1=2, left2=4, right2=8, smoke=16)
    pub buttons: u32,
}

impl FrameDto {
    pub fn from_frame(f: &ReplayFrame) -> FrameDto {
        FrameDto {
            time: f.time,
            x: f.pos.x,
            y: f.pos.y,
            buttons: f.buttons.raw,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SimulationDto {
    Authoritative {
        events: Vec<JudgementEventDto>,
        totals: TotalsDto,
        /// the HP curve as `[time, fraction]` breakpoints -- the engine's
        /// own piecewise-linear fold, in pairs rather than objects because
        /// a long play carries thousands of them and the frontend reads
        /// them positionally either way (`lib/hp.ts`).
        ///
        /// EMPTY when the drain-rate search did not settle, which only a
        /// crafted map reaches: the escape result's zero rate and unit
        /// multipliers make the curve a record of the play's misses rather
        /// than of its HP, and an empty curve reads as a full bar
        /// everywhere -- which is what the HP surfaces should draw when
        /// there is no drain rate to draw. the export dialog is where the
        /// unsettled search is reported
        hp_curve: Vec<[f64; 2]>,
        /// the running scorev1 total as `[time, score]` steps -- one per
        /// judgement that scored and one per scoring half spin at its own
        /// increment's time, so the watch HUD's number ticks during a
        /// spinner as the player saw it. pairs rather than objects for the
        /// reason the HP curve is (`lib/score.ts` reads them positionally).
        ///
        /// unlike the HP curve this never depends on the drain-rate search:
        /// a search that did not settle leaves the score intact.
        ///
        /// EMPTY and NULL are different answers, and the difference is why
        /// this is nullable where the HP curve is not: an empty curve is a
        /// play that scored nothing, which reads as 0 throughout, while null
        /// is a curve that could not be folded at all (`load::score_curve_for`
        /// -- a refused star count, which no decoded beatmap reaches) and the
        /// surfaces fall back to the header's own total for it
        score_curve: Option<Vec<(f64, u64)>>,
    },
    /// the same payload computed under a profile other than the play's
    /// own, which `profile` names: every surface that displays a timeline
    /// reads it, nothing that must be exact does
    Approximate {
        profile: RulesProfile,
        events: Vec<JudgementEventDto>,
        totals: TotalsDto,
        hp_curve: Vec<[f64; 2]>,
        score_curve: Option<Vec<(f64, u64)>>,
    },
    NotSimulated {
        reason: RefusalReason,
    },
}

impl SimulationDto {
    /// the timeline under the support the configuration resolved:
    /// authoritative or approximate, never refused (a refusing
    /// configuration never reaches a simulation)
    pub fn simulated(
        support: &SimulationSupport,
        timeline: &JudgementTimeline,
        hp_curve: Vec<[f64; 2]>,
        score: Option<&[engine::score::ScoreStep]>,
    ) -> SimulationDto {
        let events = timeline.events.iter().map(JudgementEventDto::from).collect();
        let totals = TotalsDto {
            count_300: timeline.totals.count_300,
            count_100: timeline.totals.count_100,
            count_50: timeline.totals.count_50,
            count_miss: timeline.totals.count_miss,
            max_combo: timeline.totals.max_combo,
            accuracy: timeline.totals.accuracy,
            rank: timeline.totals.rank,
            statistics: timeline.native.as_ref().map(|native| {
                native
                    .statistics
                    .iter()
                    .map(|(result, count)| StatisticDto {
                        result: result.snake_name().to_owned(),
                        count: i64::from(*count),
                    })
                    .collect()
            }),
        };
        let score_curve = score.map(|steps| steps.iter().map(|step| (step.time, step.score)).collect());
        match support {
            SimulationSupport::Approximate { profile } => SimulationDto::Approximate {
                profile: *profile,
                events,
                totals,
                hp_curve,
                score_curve,
            },
            SimulationSupport::Authoritative { .. } => SimulationDto::Authoritative {
                events,
                totals,
                hp_curve,
                score_curve,
            },
            // a refused configuration never reaches a simulation; were one
            // handed here, publishing its timeline as authoritative would be
            // the one lie this union exists to prevent, so the refusal is
            // what goes out -- the load pipeline and the commands only ever
            // pass the two support kinds that carry a profile
            SimulationSupport::Refused { reason } => SimulationDto::NotSimulated {
                reason: reason.clone(),
            },
        }
    }

    /// the authoritative arm, for a test that builds one directly
    #[cfg(test)]
    pub fn authoritative(
        timeline: &JudgementTimeline,
        health: &engine::score::HealthCurve,
        score: Option<&[engine::score::ScoreStep]>,
    ) -> SimulationDto {
        SimulationDto::simulated(
            &SimulationSupport::Authoritative {
                profile: RulesProfile::Stable,
            },
            timeline,
            stable_hp_curve(health),
            score,
        )
    }
}

/// the stable fold's curve in the wire shape, withheld (empty) when its
/// drain-rate search never settled: the frontend reads an empty curve as
/// "no HP known" rather than as a bar that never moved
pub fn stable_hp_curve(health: &engine::score::HealthCurve) -> Vec<[f64; 2]> {
    if health.search.converged {
        health.points.iter().map(|p| [p.time, p.fraction]).collect()
    } else {
        Vec::new()
    }
}

/// the native fold's curve in the same wire shape: lazer's own 0..1
/// health, whose search always settles (it halves its step to exhaustion)
pub fn native_hp_curve(health: &engine::score::NativeHealth) -> Vec<[f64; 2]> {
    health.points.iter().map(|p| [p.time, p.fraction]).collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotalsDto {
    pub count_300: u32,
    pub count_100: u32,
    pub count_50: u32,
    pub count_miss: u32,
    pub max_combo: u32,
    /// 0..1, the engine's own fold under the play's profile; the frontend
    /// displays it and never recomputes it from the counts
    pub accuracy: f64,
    /// lazer's rank vocabulary, lowercase; the native profile can answer
    /// `f` where the stable one never does
    pub rank: ScoreRank,
    /// the native profile's statistics map, in the block's own vocabulary
    /// and order -- every result kind lazer counts, the ignore kinds
    /// included. `None` under the stable profile, which has no such map:
    /// distinguishable from an empty one, which no judged play produces
    pub statistics: Option<Vec<StatisticDto>>,
}

/// the answer `export_replay` returns: where the file landed, how big it is,
/// and -- for regenerating exports only -- the nine derived values the
/// written header now claims. passthrough and carried exports ship `None`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub bytes: u64,
    pub regenerated: Option<RegeneratedDto>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegeneratedDto {
    pub count_300: u16,
    pub count_100: u16,
    pub count_50: u16,
    pub count_geki: u16,
    pub count_katsu: u16,
    pub count_miss: u16,
    pub max_combo: u16,
    pub perfect: bool,
    pub total_score: u32,
    /// the instant the regenerated fields stop at, when the play failed:
    /// lazer's score processor counted nothing past the failing result, so a
    /// failed native play's header and block carry the fold up to that point
    /// and NOT the whole-timeline fold the panels display. null on every
    /// other export, including every stable one -- the stable path's own
    /// "ended early" answer is the scene's incompleteness marker
    pub truncated_at: Option<f64>,
    /// whether a life bar graph was written at all. the stable projection
    /// always writes one; the native projection never does, because a lazer
    /// client writes none -- and the export summary must not offer
    /// "regenerated" over an empty field
    pub life_bar_written: bool,
    /// whether the drain-rate search behind a written life bar graph settled.
    /// meaningless when none was written; this is what lets the export
    /// summary say so rather than claim more than it knows
    pub life_bar_converged: bool,
}

impl RegeneratedDto {
    /// the native path's summary, which alone can be truncated
    pub fn native(fields: &engine::score::DerivedFields, truncated_at: Option<f64>) -> RegeneratedDto {
        RegeneratedDto {
            truncated_at,
            ..RegeneratedDto::from(fields)
        }
    }
}

impl From<&engine::score::DerivedFields> for RegeneratedDto {
    fn from(fields: &engine::score::DerivedFields) -> Self {
        RegeneratedDto {
            truncated_at: None,
            count_300: fields.count_300,
            count_100: fields.count_100,
            count_50: fields.count_50,
            count_geki: fields.count_geki,
            count_katsu: fields.count_katsu,
            count_miss: fields.count_miss,
            max_combo: fields.max_combo,
            perfect: fields.perfect,
            total_score: fields.total_score,
            life_bar_written: !fields.life_bar.is_empty(),
            life_bar_converged: fields.life_bar_converged,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgementEventDto {
    pub time: f64,
    pub object_index: usize,
    pub kind: JudgementKindDto,
    pub combo_after: u32,
    pub accuracy_after: f64,
}

impl From<&JudgementEvent> for JudgementEventDto {
    fn from(e: &JudgementEvent) -> JudgementEventDto {
        JudgementEventDto {
            time: e.time,
            object_index: e.object_index,
            kind: JudgementKindDto::from(&e.kind),
            combo_after: e.combo_after,
            accuracy_after: e.accuracy_after,
        }
    }
}

/// mirrors the engine's `JudgementKind` field for field, so every identity
/// a judgement carries there -- the head's grade, a nested element's index,
/// the slider's completion -- reaches the frontend under a frozen name
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JudgementKindDto {
    Circle { grade: GradeDto },
    /// the head's timing grade: great or miss under the stable profile
    SliderHead { grade: GradeDto },
    /// `nested_index` names the element in the render plan's nested list;
    /// null for a stable score point with no lazer counterpart
    SliderTick { hit: bool, nested_index: Option<u32> },
    /// `repeat_index` is 0-based: the repeat that ends span `repeat_index`,
    /// i.e. lazer's node `repeat_index + 1`. it crosses the wire because a
    /// consumer picking a repeat's samples must not have to recover the node
    /// by counting repeat events (engine `simulation::score::JudgementKind`)
    SliderRepeat { hit: bool, repeat_index: u32, nested_index: Option<u32> },
    SliderTail { hit: bool, nested_index: Option<u32> },
    /// the slider's lifecycle end in both profiles: complete when any
    /// nested element was hit, which is what gates the end sound
    SliderEnd { complete: bool },
    /// stable's whole-slider grade; the stable profile only
    SliderAggregate { grade: GradeDto },
    SpinnerSpin,
    SpinnerBonus,
    SpinnerFinal { grade: GradeDto },
}

impl From<&JudgementKind> for JudgementKindDto {
    fn from(kind: &JudgementKind) -> JudgementKindDto {
        match *kind {
            JudgementKind::Circle(g) => JudgementKindDto::Circle { grade: g.into() },
            JudgementKind::SliderHead { grade } => JudgementKindDto::SliderHead { grade: grade.into() },
            JudgementKind::SliderTick { hit, nested_index } => JudgementKindDto::SliderTick { hit, nested_index },
            JudgementKind::SliderRepeat {
                hit,
                repeat_index,
                nested_index,
            } => JudgementKindDto::SliderRepeat {
                hit,
                repeat_index,
                nested_index,
            },
            JudgementKind::SliderTail { hit, nested_index } => JudgementKindDto::SliderTail { hit, nested_index },
            JudgementKind::SliderEnd { complete } => JudgementKindDto::SliderEnd { complete },
            JudgementKind::SliderAggregate(g) => JudgementKindDto::SliderAggregate { grade: g.into() },
            JudgementKind::SpinnerSpin => JudgementKindDto::SpinnerSpin,
            JudgementKind::SpinnerBonus => JudgementKindDto::SpinnerBonus,
            JudgementKind::SpinnerFinal(g) => JudgementKindDto::SpinnerFinal { grade: g.into() },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GradeDto {
    Great,
    Ok,
    Meh,
    Miss,
}

impl From<HitGrade> for GradeDto {
    fn from(g: HitGrade) -> GradeDto {
        match g {
            HitGrade::Great => GradeDto::Great,
            HitGrade::Ok => GradeDto::Ok,
            HitGrade::Meh => GradeDto::Meh,
            HitGrade::Miss => GradeDto::Miss,
        }
    }
}

impl IntegrityDto {
    /// compares the loaded header against the load-time derivation. the
    /// derivation is the same one export overlays, so the viewer surfaces in
    /// reverse exactly the constraints its own exports satisfy
    pub fn compare(header: &OsrHeader, derived: &engine::score::DerivedScore) -> IntegrityDto {
        let row = |field: &'static str, header: u64, simulated: u64| IntegrityRowDto {
            field: field.to_owned(),
            header,
            simulated,
            matches: header == simulated,
        };
        let rows = vec![
            row("count300", u64::from(header.count_300), u64::from(derived.count_300)),
            row("count100", u64::from(header.count_100), u64::from(derived.count_100)),
            row("count50", u64::from(header.count_50), u64::from(derived.count_50)),
            row("countGeki", u64::from(header.count_geki), u64::from(derived.count_geki)),
            row(
                "countKatsu",
                u64::from(header.count_katsu),
                u64::from(derived.count_katsu),
            ),
            row("countMiss", u64::from(header.count_miss), u64::from(derived.count_miss)),
            row("maxCombo", u64::from(header.max_combo), u64::from(derived.max_combo)),
            row("perfect", u64::from(header.perfect), u64::from(derived.perfect)),
            row("totalScore", u64::from(header.total_score), derived.total_score),
        ];
        let geki_katsu = u32::from(header.count_geki) + u32::from(header.count_katsu);
        IntegrityDto {
            profile: RulesProfile::Stable,
            rows,
            block: None,
            cross_check: Some(CrossCheckDto {
                sections: derived.sections,
                geki_katsu,
                sections_without_burst: i64::from(derived.sections) - i64::from(geki_katsu),
                count_miss: header.count_miss,
                count_50: header.count_50,
            }),
            life_bar_graph: Some(header.life_graph.as_deref().map_or(LifeBarGraphDto::Absent, |graph| {
                let comparison = engine::score::compare_life_bar_graph(graph, &derived.health.samples);
                // a graph carrying no readable pair says nothing either way,
                // whether it is the empty string a lazer client writes or a
                // torn one -- either way there is nothing to count
                if comparison.total() == 0 {
                    return LifeBarGraphDto::Empty;
                }
                LifeBarGraphDto::Compared {
                    // both are bounded by the header string's own length,
                    // which the decode caps well inside u32
                    matched: comparison.matched as u32,
                    total: comparison.total() as u32,
                    header_failed: comparison.header_failed,
                }
            })),
        }
    }

    /// the native profile's comparison: the simulation against the block
    /// lazer wrote and the two header fields the block does not carry.
    /// `fail` is the health fold's fail point (event index and time); a
    /// block recording rank F is compared up to it, since lazer's own score
    /// processor counted nothing past the failing result
    pub fn compare_native(
        header: &OsrHeader,
        block: &engine::formats::score_info::ScoreInfo,
        processed: &engine::beatmap::ProcessedBeatmap,
        timeline: &JudgementTimeline,
        fail: Option<(usize, f64)>,
    ) -> IntegrityDto {
        use engine::score::HitResult;
        let mut rows = Vec::new();
        let Some(native) = timeline.native.as_ref() else {
            return IntegrityDto {
                profile: RulesProfile::Native,
                rows,
                cross_check: None,
                life_bar_graph: None,
                block: None,
            };
        };
        let (statistics, maximum, max_combo, total_score, truncated_at) = match (block.rank, fail) {
            (Some(ScoreRank::F), Some((fail_event_index, fail_time))) => {
                match engine::simulation::outcome_up_to(processed, timeline, fail_event_index) {
                    Some(truncated) => (
                        truncated.statistics,
                        truncated.maximum_statistics,
                        truncated.max_combo,
                        truncated.total_score,
                        Some(fail_time),
                    ),
                    None => (
                        native.statistics.clone(),
                        native.maximum_statistics.clone(),
                        timeline.totals.max_combo,
                        native.total_score,
                        None,
                    ),
                }
            }
            _ => (
                native.statistics.clone(),
                native.maximum_statistics.clone(),
                timeline.totals.max_combo,
                native.total_score,
                None,
            ),
        };

        // a count the block wrote negative is kept as a difference: it reads
        // as zero on the row and can never match, since no fold counts below
        // zero
        let count_of = |entries: &[engine::formats::score_info::StatisticEntry], name: &str| -> Option<i64> {
            entries.iter().find(|e| e.result == name).map(|e| e.count)
        };
        let push_map = |prefix: &str,
                            block_entries: &[engine::formats::score_info::StatisticEntry],
                            simulated: &[(HitResult, u32)],
                            rows: &mut Vec<IntegrityRowDto>| {
            // every result the engine knows, in lazer's own order, wherever
            // either side counts it; then whatever the block names that the
            // engine does not know, so an unknown result reads as a
            // difference rather than vanishing
            for result in HitResult::ALL {
                let name = result.snake_name();
                let in_block = count_of(block_entries, name);
                let in_simulation = simulated.iter().find(|(r, _)| *r == result).map(|(_, c)| u64::from(*c));
                if in_block.is_none() && in_simulation.is_none() {
                    continue;
                }
                let block_count = in_block.unwrap_or(0);
                let (header, simulated) = (u64::try_from(block_count).unwrap_or(0), in_simulation.unwrap_or(0));
                rows.push(IntegrityRowDto {
                    field: format!("{prefix}{name}"),
                    header,
                    simulated,
                    matches: block_count >= 0 && header == simulated,
                });
            }
            for entry in block_entries {
                if HitResult::from_snake_name(&entry.result).is_none() {
                    rows.push(IntegrityRowDto {
                        field: format!("{prefix}{}", entry.result),
                        header: u64::try_from(entry.count).unwrap_or(0),
                        simulated: 0,
                        matches: false,
                    });
                }
            }
        };
        push_map("", &block.statistics, &statistics, &mut rows);
        let row = |field: &str, header: u64, simulated: u64| IntegrityRowDto {
            field: field.to_owned(),
            header,
            simulated,
            matches: header == simulated,
        };
        rows.push(row("maxCombo", u64::from(header.max_combo), u64::from(max_combo)));
        rows.push(row(
            "totalScore",
            u64::from(header.total_score),
            u64::try_from(total_score).unwrap_or(0),
        ));
        push_map("maximum:", &block.maximum_statistics, &maximum, &mut rows);

        IntegrityDto {
            profile: RulesProfile::Native,
            rows,
            cross_check: None,
            life_bar_graph: None,
            block: Some(BlockCheckDto {
                rank_block: block.rank,
                rank_simulated: timeline.totals.rank,
                rank_match: block.rank == Some(timeline.totals.rank),
                truncated_at,
            }),
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn assemble_scene(
    map: &Beatmap,
    map_md5: &str,
    header: &OsrHeader,
    trailer: &OsrTrailer,
    configuration: &PlayConfiguration,
    frames: &[ReplayFrame],
    render_plan: RenderPlan,
    simulation: SimulationDto,
    audio_path: Option<PathBuf>,
    background_path: Option<PathBuf>,
    sample_files: std::collections::BTreeMap<String, PathBuf>,
    texture_files: std::collections::BTreeMap<String, PathBuf>,
    warnings: Vec<Warning>,
    integrity: Option<IntegrityDto>,
    incompleteness: Option<IncompletenessDto>,
) -> LoadedScene {
    let header_accuracy = standard_accuracy(
        header.count_300,
        header.count_100,
        header.count_50,
        header.count_miss,
    );
    LoadedScene {
        epoch: 0,
        beatmap: BeatmapMeta {
            title: map.title.clone(),
            artist: map.artist.clone(),
            creator: map.creator.clone(),
            version: map.version.clone(),
            beatmap_id: map.beatmap_id,
            beatmap_set_id: map.beatmap_set_id,
            format_version: map.format_version,
            audio_lead_in: map.audio_lead_in,
            circle_size: map.circle_size,
            approach_rate: map.approach_rate,
            overall_difficulty: map.overall_difficulty,
            hp_drain_rate: map.hp_drain_rate,
            md5: map_md5.to_string(),
        },
        replay: ReplayMeta {
            player_name: header.player_name.clone(),
            version: header.version,
            mods: header.mods,
            count_300: header.count_300,
            count_100: header.count_100,
            count_50: header.count_50,
            count_geki: header.count_geki,
            count_katsu: header.count_katsu,
            count_miss: header.count_miss,
            total_score: header.total_score,
            max_combo: header.max_combo,
            perfect: header.perfect,
            accuracy: header_accuracy,
            rank: engine::score::rank_from_accuracy(header_accuracy, u32::from(header.count_miss)),
            timestamp_ticks: header.timestamp_ticks.to_string(),
            online_score_id: header.online_score_id.to_string(),
            beatmap_md5: header.beatmap_md5.clone(),
            score_info: ScoreInfoDto::from_trailer(trailer),
        },
        configuration: ConfigurationDto::from(configuration),
        frames: frames.iter().map(FrameDto::from_frame).collect(),
        render_plan,
        simulation,
        audio_path: audio_path.map(|p| p.to_string_lossy().into_owned()),
        background_path: background_path.map(|p| p.to_string_lossy().into_owned()),
        sample_files: sample_files
            .into_iter()
            .map(|(name, path)| (name, path.to_string_lossy().into_owned()))
            .collect(),
        texture_files: texture_files
            .into_iter()
            .map(|(name, path)| (name, path.to_string_lossy().into_owned()))
            .collect(),
        warnings,
        integrity,
        incompleteness,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::beatmap::difficulty::HitGrade;
    use engine::simulation::score::JudgementKind;
    use engine::simulation::{HitTotals, JudgementEvent, JudgementTimeline};
    use serde_json::json;

    #[test]
    fn judgement_kinds_serialize_type_tagged() {
        let kind = JudgementKindDto::from(&JudgementKind::Circle(HitGrade::Great));
        assert_eq!(
            serde_json::to_value(&kind).unwrap(),
            json!({ "type": "circle", "grade": "great" })
        );

        let kind = JudgementKindDto::from(&JudgementKind::SliderHead {
            grade: HitGrade::Miss,
        });
        assert_eq!(
            serde_json::to_value(&kind).unwrap(),
            json!({ "type": "sliderHead", "grade": "miss" })
        );

        // the nested kinds name their element; the one without a lazer
        // counterpart crosses as null rather than being dropped
        let kind = JudgementKindDto::from(&JudgementKind::SliderTick {
            hit: true,
            nested_index: Some(3),
        });
        assert_eq!(
            serde_json::to_value(&kind).unwrap(),
            json!({ "type": "sliderTick", "hit": true, "nestedIndex": 3 })
        );
        let kind = JudgementKindDto::from(&JudgementKind::SliderTail {
            hit: false,
            nested_index: None,
        });
        assert_eq!(
            serde_json::to_value(&kind).unwrap(),
            json!({ "type": "sliderTail", "hit": false, "nestedIndex": null })
        );
        let kind = JudgementKindDto::from(&JudgementKind::SliderEnd { complete: true });
        assert_eq!(
            serde_json::to_value(&kind).unwrap(),
            json!({ "type": "sliderEnd", "complete": true })
        );

        let kind = JudgementKindDto::from(&JudgementKind::SliderAggregate(HitGrade::Ok));
        assert_eq!(
            serde_json::to_value(&kind).unwrap(),
            json!({ "type": "sliderAggregate", "grade": "ok" })
        );

        let kind = JudgementKindDto::from(&JudgementKind::SpinnerBonus);
        assert_eq!(
            serde_json::to_value(&kind).unwrap(),
            json!({ "type": "spinnerBonus" })
        );

        // the repeat's node identity crosses as its own field, never implied
        // by the event's position among the other repeats
        let kind = JudgementKindDto::from(&JudgementKind::SliderRepeat {
            hit: true,
            repeat_index: 2,
            nested_index: Some(5),
        });
        assert_eq!(
            serde_json::to_value(&kind).unwrap(),
            json!({ "type": "sliderRepeat", "hit": true, "repeatIndex": 2, "nestedIndex": 5 })
        );
    }

    /// a health curve carrying only what the wire reads: the search's
    /// converged flag and the breakpoints
    fn test_health(converged: bool, points: &[(f64, f64)]) -> engine::score::HealthCurve {
        engine::score::HealthCurve {
            search: engine::score::DrainRateSearch {
                rate: 0.03,
                normal_multiplier: 1.0,
                combo_end_multiplier: 1.0,
                hp_after_perfect_play: vec![200.0],
                max_combo: 1,
                iterations: 4,
                converged,
            },
            samples: vec![engine::score::LifeBarSample { time: 0.0, value: 1.0 }],
            points: points
                .iter()
                .map(|&(time, fraction)| engine::score::HealthPoint { time, fraction })
                .collect(),
        }
    }

    #[test]
    fn the_simulation_union_is_status_tagged() {
        let timeline = JudgementTimeline {
            events: vec![JudgementEvent {
                time: 1030.0,
                object_index: 0,
                kind: JudgementKind::Circle(HitGrade::Meh),
                combo_after: 1,
                accuracy_after: 50.0 / 300.0,
            }],
            totals: HitTotals::from_counts(0, 0, 1, 0, 1),
            spinner_scoring: Vec::new(),
            native: None,
        };
        let health = test_health(true, &[(0.0, 1.0), (1030.0, 1.0), (1030.0, 0.8)]);
        let score = [engine::score::ScoreStep {
            time: 1030.0,
            score: 50,
        }];
        let v = serde_json::to_value(SimulationDto::authoritative(&timeline, &health, Some(&score))).unwrap();
        assert_eq!(v["status"], "authoritative");
        let fields: std::collections::HashSet<&str> =
            v.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            fields,
            ["status", "events", "totals", "hpCurve", "scoreCurve"]
                .into_iter()
                .collect()
        );
        // accuracy and rank ride on the totals: one meh is a sixth, a D; the
        // statistics map is the native profile's and reads null here
        assert_eq!(
            v["totals"],
            json!({ "count300": 0, "count100": 0, "count50": 1, "countMiss": 0, "maxCombo": 1, "accuracy": 50.0 / 300.0, "rank": "d", "statistics": null })
        );
        assert_eq!(v["events"][0]["objectIndex"], 0);
        assert_eq!(v["events"][0]["comboAfter"], 1);
        assert_eq!(v["events"][0]["kind"]["grade"], "meh");
        // the curve rides as [time, fraction] pairs, the jump's two points
        // sharing their millisecond
        assert_eq!(v["hpCurve"], json!([[0.0, 1.0], [1030.0, 1.0], [1030.0, 0.8]]));
        // the score rides as [time, score] pairs on the same terms, the score
        // being the RUNNING total after that step
        assert_eq!(v["scoreCurve"], json!([[1030.0, 50]]));
        assert_eq!(
            v["scoreCurve"][0][1], 50,
            "the first step carries a running total"
        );

        // an unsettled search ships no HP curve at all: the escape result's
        // zero rate would draw a bar that only misses move. the score is
        // untouched by it -- the curve depends on the timeline and the map,
        // never on the drain search
        let unsettled = test_health(false, &[(0.0, 1.0), (1030.0, 0.8)]);
        let v =
            serde_json::to_value(SimulationDto::authoritative(&timeline, &unsettled, Some(&score))).unwrap();
        assert_eq!(v["hpCurve"], json!([]));
        assert_eq!(v["scoreCurve"], json!([[1030.0, 50]]));

        // an empty curve and a withheld one are different answers on the wire:
        // the first is a play that scored nothing, the second a fold that never
        // ran. an empty HP curve has no such partner state, which is why only
        // this one is nullable
        let v = serde_json::to_value(SimulationDto::authoritative(&timeline, &health, Some(&[]))).unwrap();
        assert_eq!(v["scoreCurve"], json!([]));
        let v = serde_json::to_value(SimulationDto::authoritative(&timeline, &health, None)).unwrap();
        assert_eq!(v["scoreCurve"], json!(null));

        let v = serde_json::to_value(SimulationDto::NotSimulated {
            reason: RefusalReason::UnsupportedMods {
                acronyms: vec!["HD".into(), "ZZ".into()],
            },
        })
        .unwrap();
        assert_eq!(
            v,
            json!({ "status": "notSimulated", "reason": { "kind": "unsupportedMods", "acronyms": ["HD", "ZZ"] } })
        );
        let v = serde_json::to_value(SimulationDto::NotSimulated {
            reason: RefusalReason::UnreadableScoreInfo {
                reason: "not lzma".into(),
            },
        })
        .unwrap();
        assert_eq!(
            v["reason"],
            json!({ "kind": "unreadableScoreInfo", "reason": "not lzma" })
        );
        let v = serde_json::to_value(SimulationDto::NotSimulated {
            reason: RefusalReason::BeatmapMismatch,
        })
        .unwrap();
        assert_eq!(v["reason"], json!({ "kind": "beatmapMismatch" }));

        // the approximate arm carries the authoritative payload plus the
        // profile it ran under
        let v = serde_json::to_value(SimulationDto::simulated(
            &SimulationSupport::Approximate {
                profile: RulesProfile::Stable,
            },
            &timeline,
            stable_hp_curve(&health),
            Some(&score),
        ))
        .unwrap();
        assert_eq!(v["status"], "approximate");
        assert_eq!(v["profile"], "stable");
        let fields: std::collections::HashSet<&str> =
            v.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            fields,
            ["status", "profile", "events", "totals", "hpCurve", "scoreCurve"]
                .into_iter()
                .collect()
        );
        assert_eq!(v["events"][0]["comboAfter"], 1);
    }

    #[test]
    fn the_configuration_and_the_score_info_record_serialize_with_frozen_names() {
        use engine::formats::score_info::{encode_score_info, ScoreInfo, ScoreInfoMod, StatisticEntry};
        let info = ScoreInfo {
            online_id: 12,
            mods: vec![ScoreInfoMod {
                acronym: "DA".into(),
                settings: vec![("circle_size".into(), serde_json::from_str("7.5").unwrap())],
            }],
            statistics: vec![
                StatisticEntry {
                    result: "great".into(),
                    count: 3,
                },
                StatisticEntry {
                    result: "slider_tail_hit".into(),
                    count: 1,
                },
            ],
            maximum_statistics: vec![StatisticEntry {
                result: "great".into(),
                count: 4,
            }],
            client_version: "2026.401.0-lazer".into(),
            rank: Some(ScoreRank::F),
            user_id: 99,
            total_score_without_mods: Some(147_051),
            pauses: vec![1000, 2000],
            unknown: Vec::new(),
        };
        let trailer = OsrTrailer::present(encode_score_info(&info).unwrap(), info);
        let v = serde_json::to_value(ScoreInfoDto::from_trailer(&trailer)).unwrap();
        assert_eq!(
            v,
            json!({
                "status": "present",
                "statistics": [{ "result": "great", "count": 3 }, { "result": "slider_tail_hit", "count": 1 }],
                "maximumStatistics": [{ "result": "great", "count": 4 }],
                // lazer's own rule over the two maps: (3x300 + 1x150) / (4x300).
                // the tail weighs 150 and the legacy projection cannot carry it,
                // which is why this rides the wire instead of being folded above
                "accuracy": 0.875,
                "rank": "f",
                "totalScoreWithoutMods": 147051,
                "clientVersion": "2026.401.0-lazer",
                "onlineId": "12",
                "userId": 99,
                "pauseCount": 2
            })
        );
        // the other four states are distinguishable on the wire
        assert_eq!(
            serde_json::to_value(ScoreInfoDto::from_trailer(&OsrTrailer::none())).unwrap(),
            json!({ "status": "opaque" })
        );
        assert_eq!(
            serde_json::to_value(ScoreInfoDto::from_trailer(&OsrTrailer::absent())).unwrap(),
            json!({ "status": "absent" })
        );
        assert_eq!(
            serde_json::to_value(ScoreInfoDto::from_trailer(&OsrTrailer::empty_block())).unwrap(),
            json!({ "status": "empty" })
        );
        let malformed = OsrTrailer {
            block: ScoreInfoBlock::Malformed {
                raw: vec![1],
                reason: "not lzma".into(),
            },
            trailing: Vec::new(),
        };
        assert_eq!(
            serde_json::to_value(ScoreInfoDto::from_trailer(&malformed)).unwrap(),
            json!({ "status": "malformed", "reason": "not lzma" })
        );

        // the configuration: profile, mods with settings, provenance, rate,
        // and the three capabilities with their reasons
        let file = engine::formats::osr::OsrFile {
            header: crate::testutil::test_header("abc", 0),
            actions: Vec::new(),
            compressed_payload: Vec::new(),
            decompressed_payload: Vec::new(),
            trailer: trailer.clone(),
        };
        let mut file = file;
        file.header.version = 30000016;
        let configuration = engine::configuration::resolve_play_configuration(&file, false);
        let v = serde_json::to_value(ConfigurationDto::from(&configuration)).unwrap();
        assert_eq!(v["profile"], "native");
        assert_eq!(v["provenance"], "block");
        assert_eq!(v["rate"], 1.0);
        assert_eq!(v["mods"], json!([{ "acronym": "DA", "settings": { "circle_size": 7.5 } }]));
        assert_eq!(
            v["capabilities"]["simulate"],
            json!({ "status": "refused", "reason": { "kind": "unsupportedMods", "acronyms": ["DA"] } })
        );
        assert_eq!(v["capabilities"]["editFrames"]["allowed"], false);
        assert!(v["capabilities"]["editFrames"]["reason"]
            .as_str()
            .unwrap()
            .contains("DA"));
        assert_eq!(v["capabilities"]["regenerateExport"]["allowed"], false);

        // and a play the app can edit carries no reason at all
        let stable = engine::configuration::PlayConfiguration::nomod(RulesProfile::Stable);
        let v = serde_json::to_value(ConfigurationDto::from(&stable)).unwrap();
        assert_eq!(v["capabilities"]["simulate"], json!({ "status": "authoritative", "profile": "stable" }));
        assert_eq!(v["capabilities"]["editFrames"], json!({ "allowed": true }));
        // a lazer file with an empty block infers its mods from the bitfield
        // and, with the native walk landed, is authoritative under native
        let native = engine::configuration::resolve_play_configuration(
            &engine::formats::osr::OsrFile {
                trailer: OsrTrailer::empty_block(),
                ..file.clone()
            },
            false,
        );
        let v = serde_json::to_value(ConfigurationDto::from(&native)).unwrap();
        assert_eq!(v["provenance"], "inferredFromBitfield");
        assert_eq!(v["capabilities"]["simulate"], json!({ "status": "authoritative", "profile": "native" }));
        // the approximate arm's wire shape stays frozen through the
        // resolver's staged branch
        let approximate = engine::configuration::resolve_with(
            &engine::formats::osr::OsrFile {
                trailer: OsrTrailer::empty_block(),
                ..file
            },
            false,
            engine::configuration::ImplementedProfiles { native: false },
        );
        let v = serde_json::to_value(ConfigurationDto::from(&approximate)).unwrap();
        assert_eq!(v["capabilities"]["simulate"], json!({ "status": "approximate", "profile": "stable" }));
    }

    #[test]
    fn assembled_scenes_carry_the_full_camel_case_contract() {
        let map = engine::formats::beatmap::decode_beatmap_bytes(
            &std::fs::read(
                crate::testutil::fixtures_dir()
                    .join("beatmaps")
                    .join("stacking-v14.osu"),
            )
            .unwrap(),
        )
        .unwrap();
        let processed = engine::beatmap::process_beatmap(&map).unwrap();
        let render_plan = engine::render_plan::build_render_plan(&map, &processed);
        let mut header = crate::testutil::test_header("abc123", 0);
        // both values sit past 2^53: they must cross as lossless strings
        header.timestamp_ticks = 638_712_000_000_000_001;
        header.online_score_id = u64::MAX;
        let frames = vec![engine::replay::frames::ReplayFrame {
            time: 16.0,
            pos: engine::math::Vec2::new(100.0, 200.0),
            buttons: engine::replay::frames::Buttons::new(1),
        }];

        let scene = assemble_scene(
            &map,
            "abc123",
            &header,
            &OsrTrailer::none(),
            &PlayConfiguration::nomod(RulesProfile::Stable),
            &frames,
            render_plan,
            SimulationDto::NotSimulated {
                reason: RefusalReason::BeatmapMismatch,
            },
            Some(std::path::PathBuf::from(r"C:\somewhere\audio.mp3")),
            None,
            [(
                "normal-hitnormal".to_string(),
                std::path::PathBuf::from(r"C:\somewhere\normal-hitnormal.wav"),
            )]
            .into_iter()
            .collect(),
            [(
                "hitcircle@2x.png".to_string(),
                std::path::PathBuf::from(r"C:\somewhere\hitcircle@2x.png"),
            )]
            .into_iter()
            .collect(),
            vec![crate::error::Warning::AudioMissing],
            None,
            None,
        );
        let v = serde_json::to_value(&scene).unwrap();

        assert_eq!(v["epoch"], 0);
        assert_eq!(v["beatmap"]["title"], "Stacking Fixture");
        assert_eq!(v["beatmap"]["md5"], "abc123");
        assert_eq!(v["beatmap"]["audioLeadIn"], map.audio_lead_in);
        assert_eq!(v["replay"]["mods"], 0);
        assert_eq!(v["replay"]["playerName"], "test");
        // the header's one great reads as a full-accuracy X, by the same rule
        // the simulated totals use
        assert_eq!(v["replay"]["accuracy"], 1.0);
        assert_eq!(v["replay"]["rank"], "x");
        assert_eq!(v["replay"]["timestampTicks"], "638712000000000001");
        assert_eq!(v["replay"]["onlineScoreId"], "18446744073709551615");
        assert_eq!(v["replay"]["scoreInfo"], json!({ "status": "opaque" }));
        assert_eq!(v["configuration"]["profile"], "stable");
        assert_eq!(
            v["frames"][0],
            json!({ "time": 16.0, "x": 100.0, "y": 200.0, "buttons": 1 })
        );
        assert_eq!(v["renderPlan"]["playfield"]["width"], 512.0);
        assert_eq!(v["simulation"]["status"], "notSimulated");
        assert_eq!(v["audioPath"], r"C:\somewhere\audio.mp3");
        assert_eq!(v["backgroundPath"], serde_json::Value::Null);
        assert_eq!(v["warnings"][0]["kind"], "audioMissing");
        assert_eq!(v["integrity"], serde_json::Value::Null);
        assert_eq!(v["incompleteness"], serde_json::Value::Null);
    }

    /// the native report: rows named by result in lazer's order, the two
    /// header fields, the maximum entries, and the block's rank beside the
    /// simulated one -- with no cross-check and no graph to score
    #[test]
    fn a_native_integrity_report_compares_the_block_and_freezes_its_shape() {
        use engine::formats::score_info::{ScoreInfo, StatisticEntry};
        use engine::score::HitResult;
        use engine::simulation::{HitTotals, JudgementTimeline, NativeOutcome};

        let mut header = crate::testutil::test_header("abc123", 0);
        header.max_combo = 3;
        header.total_score = 700_000;
        let block = ScoreInfo {
            online_id: -1,
            mods: Vec::new(),
            statistics: vec![
                StatisticEntry { result: "great".into(), count: 2 },
                StatisticEntry { result: "slider_tail_hit".into(), count: 1 },
                StatisticEntry { result: "ignore_hit".into(), count: 1 },
                StatisticEntry { result: "future_result".into(), count: 4 },
            ],
            maximum_statistics: vec![
                StatisticEntry { result: "great".into(), count: 2 },
                StatisticEntry { result: "slider_tail_hit".into(), count: 1 },
                StatisticEntry { result: "ignore_hit".into(), count: 1 },
            ],
            client_version: "2026.401.0-lazer".into(),
            rank: Some(ScoreRank::S),
            user_id: 7,
            total_score_without_mods: Some(700_000),
            pauses: Vec::new(),
            unknown: Vec::new(),
        };
        let timeline = JudgementTimeline {
            events: Vec::new(),
            totals: HitTotals {
                count_300: 2,
                count_100: 0,
                count_50: 0,
                count_miss: 0,
                max_combo: 3,
                accuracy: 1.0,
                rank: ScoreRank::X,
            },
            spinner_scoring: Vec::new(),
            native: Some(NativeOutcome {
                statistics: vec![(HitResult::Great, 2), (HitResult::IgnoreHit, 1), (HitResult::SliderTailHit, 1)],
                maximum_statistics: vec![(HitResult::Great, 2), (HitResult::IgnoreHit, 1), (HitResult::SliderTailHit, 1)],
                total_score: 700_000,
                score_curve: Vec::new(),
                applied: Vec::new(),
            }),
        };
        let processed = engine::beatmap::process_beatmap(
            &engine::formats::beatmap::decode_beatmap_path(
                &crate::testutil::fixtures_dir().join("beatmaps").join("stacking-v14.osu"),
            )
            .unwrap(),
        )
        .unwrap();
        let report = IntegrityDto::compare_native(&header, &block, &processed, &timeline, None);
        let v = serde_json::to_value(&report).unwrap();
        assert_eq!(v["profile"], "native");
        assert_eq!(v["crossCheck"], serde_json::Value::Null);
        assert_eq!(v["lifeBarGraph"], serde_json::Value::Null);
        let row_fields: Vec<&str> = v["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["field"].as_str().unwrap())
            .collect();
        assert_eq!(
            row_fields,
            [
                "great",
                "ignore_hit",
                "slider_tail_hit",
                "future_result",
                "maxCombo",
                "totalScore",
                "maximum:great",
                "maximum:ignore_hit",
                "maximum:slider_tail_hit",
            ]
        );
        assert_eq!(
            v["rows"][3],
            serde_json::json!({ "field": "future_result", "header": 4, "simulated": 0, "match": false }),
            "a result the engine does not know reads as a difference"
        );
        assert_eq!(v["rows"][0]["match"], true);
        assert_eq!(
            v["block"],
            serde_json::json!({ "rankBlock": "s", "rankSimulated": "x", "rankMatch": false, "truncatedAt": null })
        );

        // a count the block wrote negative never matches, even against a
        // simulated zero
        let mut corrupt = block.clone();
        corrupt.statistics.push(StatisticEntry {
            result: "meh".into(),
            count: -5,
        });
        let report = IntegrityDto::compare_native(&header, &corrupt, &processed, &timeline, None);
        let meh = report.rows.iter().find(|r| r.field == "meh").expect("the negative count still rows");
        assert_eq!((meh.header, meh.simulated, meh.matches), (0, 0, false));

        // a rank-F block is compared up to the fail: the fold refolds the
        // applied results up to and including the failing event, and the
        // block line states the truncation
        use engine::simulation::AppliedResult;
        let mut failed_block = block.clone();
        failed_block.rank = Some(ScoreRank::F);
        failed_block.statistics = vec![StatisticEntry {
            result: "great".into(),
            count: 1,
        }];
        let mut failed_timeline = timeline.clone();
        failed_timeline.events = vec![
            engine::simulation::JudgementEvent {
                time: 1000.0,
                object_index: 0,
                kind: engine::simulation::score::JudgementKind::Circle(engine::beatmap::difficulty::HitGrade::Great),
                combo_after: 1,
                accuracy_after: 1.0,
            },
            engine::simulation::JudgementEvent {
                time: 2000.0,
                object_index: 1,
                kind: engine::simulation::score::JudgementKind::Circle(engine::beatmap::difficulty::HitGrade::Great),
                combo_after: 2,
                accuracy_after: 1.0,
            },
        ];
        failed_timeline.native.as_mut().unwrap().applied = vec![
            AppliedResult {
                time: 1000.0,
                result: HitResult::Great,
                max_result: HitResult::Great,
                event_index: Some(0),
                count: 1,
            },
            AppliedResult {
                time: 2000.0,
                result: HitResult::Great,
                max_result: HitResult::Great,
                event_index: Some(1),
                count: 1,
            },
        ];
        failed_timeline.totals.rank = ScoreRank::F;
        let report = IntegrityDto::compare_native(&header, &failed_block, &processed, &failed_timeline, Some((0, 1000.0)));
        let great = report.rows.iter().find(|r| r.field == "great").unwrap();
        assert_eq!((great.header, great.simulated, great.matches), (1, 1, true), "only the first event counts");
        let block_check = report.block.as_ref().unwrap();
        assert_eq!(block_check.truncated_at, Some(1000.0));
        assert!(block_check.rank_match);
    }

    #[test]
    fn incompleteness_serializes_with_the_frozen_wire_field_names() {
        let v = serde_json::to_value(IncompletenessDto {
            judged: 480,
            total: 1544,
        })
        .unwrap();
        assert_eq!(v, json!({ "judged": 480, "total": 1544 }));
    }

    #[test]
    fn integrity_reports_serialize_with_the_frozen_wire_field_names() {
        let mut header = crate::testutil::test_header("abc123", 0);
        header.count_geki = 100;
        header.count_katsu = 3;
        header.count_miss = 2;
        header.life_graph = Some("0|1".into());
        let derived = engine::score::DerivedScore {
            count_300: 1,
            count_100: 0,
            count_50: 0,
            count_geki: 99,
            count_katsu: 3,
            count_miss: 2,
            max_combo: 1,
            perfect: true,
            total_score: 300,
            sections: 105,
            sections_without_burst: 2,
            health: test_health(true, &[(0.0, 1.0)]),
        };
        let report = IntegrityDto::compare(&header, &derived);
        let v = serde_json::to_value(&report).unwrap();

        let fields: std::collections::HashSet<&str> =
            v.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            fields,
            ["profile", "rows", "crossCheck", "lifeBarGraph", "block"]
                .into_iter()
                .collect()
        );
        assert_eq!(v["profile"], "stable");
        assert_eq!(v["block"], serde_json::Value::Null);

        // rows cover every compared field, in a fixed render order, with the
        // hash deliberately absent
        let row_fields: Vec<&str> = v["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["field"].as_str().unwrap())
            .collect();
        assert_eq!(
            row_fields,
            [
                "count300",
                "count100",
                "count50",
                "countGeki",
                "countKatsu",
                "countMiss",
                "maxCombo",
                "perfect",
                "totalScore",
            ]
        );
        assert_eq!(
            v["rows"][3],
            serde_json::json!({ "field": "countGeki", "header": 100, "simulated": 99, "match": false })
        );
        assert_eq!(v["rows"][0]["match"], true);
        // perfect rides as 0/1 under the shared row shape
        assert_eq!(v["rows"][7]["header"], 1);

        assert_eq!(
            v["crossCheck"],
            serde_json::json!({ "sections": 105, "gekiKatsu": 103, "sectionsWithoutBurst": 2, "countMiss": 2, "count50": 0 })
        );
        // the header's one pair scores against the one simulated sample: both
        // read `1` at t=0, so the graph matches in full and records no fail
        assert_eq!(
            v["lifeBarGraph"],
            serde_json::json!({ "status": "compared", "matched": 1, "total": 1, "headerFailed": false })
        );

        // a header describing a different play than the frames reads as fewer
        // matched than total, never as a verdict
        header.life_graph = Some("0|0.4,".into());
        assert_eq!(
            serde_json::to_value(&IntegrityDto::compare(&header, &derived).life_bar_graph.unwrap()).unwrap(),
            serde_json::json!({ "status": "compared", "matched": 0, "total": 1, "headerFailed": false })
        );

        // a header whose graph ends at zero carries stable's own record of a
        // fail, whatever the samples say
        header.life_graph = Some("0|1,1000|0,".into());
        assert_eq!(
            serde_json::to_value(&IntegrityDto::compare(&header, &derived).life_bar_graph.unwrap()).unwrap()["headerFailed"],
            serde_json::json!(true)
        );

        // present-but-unreadable and absent are their own states, neither
        // pretending to a count
        header.life_graph = Some(String::new());
        assert_eq!(IntegrityDto::compare(&header, &derived).life_bar_graph, Some(LifeBarGraphDto::Empty));
        header.life_graph = Some(",,".into());
        assert_eq!(IntegrityDto::compare(&header, &derived).life_bar_graph, Some(LifeBarGraphDto::Empty));
        header.life_graph = None;
        assert_eq!(IntegrityDto::compare(&header, &derived).life_bar_graph, Some(LifeBarGraphDto::Absent));
    }

    #[test]
    fn export_results_serialize_with_the_frozen_wire_field_names() {
        let result = ExportResult {
            path: r"C:\somewhere\replay (edited).osr".into(),
            bytes: 1234,
            regenerated: Some(RegeneratedDto {
                count_300: 100,
                count_100: 5,
                count_50: 1,
                count_geki: 20,
                count_katsu: 3,
                count_miss: 2,
                max_combo: 250,
                perfect: false,
                total_score: 1_234_567,
                truncated_at: None,
                life_bar_written: true,
                life_bar_converged: true,
            }),
        };
        let v = serde_json::to_value(&result).unwrap();
        let fields: std::collections::HashSet<&str> =
            v.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(fields, ["path", "bytes", "regenerated"].into_iter().collect());
        let regenerated: std::collections::HashSet<&str> = v["regenerated"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            regenerated,
            [
                "count300",
                "count100",
                "count50",
                "countGeki",
                "countKatsu",
                "countMiss",
                "maxCombo",
                "perfect",
                "totalScore",
                "truncatedAt",
                "lifeBarWritten",
                "lifeBarConverged",
            ]
            .into_iter()
            .collect()
        );

        let passthrough = ExportResult {
            path: "x".into(),
            bytes: 9,
            regenerated: None,
        };
        assert_eq!(serde_json::to_value(&passthrough).unwrap()["regenerated"], serde_json::Value::Null);
    }
}
