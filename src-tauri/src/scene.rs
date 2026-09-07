//! the LoadedScene json contract (spec, tauri layer): everything the
//! frontend needs for one loaded replay, in one payload. engine types cross
//! this boundary as dtos so the engine's internal shapes can evolve without
//! breaking the frontend; the render plan serializes itself (its shape is
//! its contract). the simulation union makes an invalid state
//! unrepresentable: a judgement timeline exists only inside the
//! authoritative arm

use std::path::PathBuf;

use engine::beatmap::difficulty::HitGrade;
use engine::formats::beatmap::Beatmap;
use engine::formats::osr::OsrHeader;
use engine::render_plan::RenderPlan;
use engine::replay::frames::ReplayFrame;
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
    /// the header-vs-simulated comparison, shipped only for pre-lazer
    /// authoritative scenes; always describes the loaded file, never
    /// in-session edits
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
    pub rows: Vec<IntegrityRowDto>,
    pub cross_check: CrossCheckDto,
    pub life_bar_graph: LifeBarGraphDto,
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

/// one compared field; `perfect` rides as 0/1 so every row shares a shape
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityRowDto {
    pub field: &'static str,
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
    /// .net datetime ticks, verbatim from the header; a string because the
    /// value (~6.4e17 for any current date) exceeds json's 2^53 safe-integer
    /// range and would silently round in the webview's JSON.parse
    pub timestamp_ticks: String,
    /// string for the same reason as timestamp_ticks
    pub online_score_id: String,
    pub beatmap_md5: Option<String>,
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
    NotSimulated {
        reason: NotSimulatedReason,
    },
}

impl SimulationDto {
    pub fn authoritative(
        timeline: &JudgementTimeline,
        health: &engine::score::HealthCurve,
        score: Option<&[engine::score::ScoreStep]>,
    ) -> SimulationDto {
        SimulationDto::Authoritative {
            events: timeline.events.iter().map(JudgementEventDto::from).collect(),
            totals: TotalsDto {
                count_300: timeline.totals.count_300,
                count_100: timeline.totals.count_100,
                count_50: timeline.totals.count_50,
                count_miss: timeline.totals.count_miss,
                max_combo: timeline.totals.max_combo,
            },
            hp_curve: if health.search.converged {
                health.points.iter().map(|p| [p.time, p.fraction]).collect()
            } else {
                Vec::new()
            },
            score_curve: score.map(|steps| steps.iter().map(|step| (step.time, step.score)).collect()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotSimulatedReason {
    UnsupportedMods,
    BeatmapMismatch,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotalsDto {
    pub count_300: u32,
    pub count_100: u32,
    pub count_50: u32,
    pub count_miss: u32,
    pub max_combo: u32,
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
    /// whether the drain-rate search behind the regenerated life bar graph
    /// settled. the graph is written either way; this is what lets the
    /// export summary say so rather than claim more than it knows
    pub life_bar_converged: bool,
}

impl From<&engine::score::DerivedFields> for RegeneratedDto {
    fn from(fields: &engine::score::DerivedFields) -> Self {
        RegeneratedDto {
            count_300: fields.count_300,
            count_100: fields.count_100,
            count_50: fields.count_50,
            count_geki: fields.count_geki,
            count_katsu: fields.count_katsu,
            count_miss: fields.count_miss,
            max_combo: fields.max_combo,
            perfect: fields.perfect,
            total_score: fields.total_score,
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

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JudgementKindDto {
    Circle { grade: GradeDto },
    SliderHead { hit: bool },
    SliderTick { hit: bool },
    /// `repeat_index` is 0-based: the repeat that ends span `repeat_index`,
    /// i.e. lazer's node `repeat_index + 1`. it crosses the wire because a
    /// consumer picking a repeat's samples must not have to recover the node
    /// by counting repeat events (engine `simulation::score::JudgementKind`)
    SliderRepeat { hit: bool, repeat_index: u32 },
    SliderTail { hit: bool },
    SliderAggregate { grade: GradeDto },
    SpinnerSpin,
    SpinnerBonus,
    SpinnerFinal { grade: GradeDto },
}

impl From<&JudgementKind> for JudgementKindDto {
    fn from(kind: &JudgementKind) -> JudgementKindDto {
        match *kind {
            JudgementKind::Circle(g) => JudgementKindDto::Circle { grade: g.into() },
            JudgementKind::SliderHead { hit } => JudgementKindDto::SliderHead { hit },
            JudgementKind::SliderTick { hit } => JudgementKindDto::SliderTick { hit },
            JudgementKind::SliderRepeat { hit, repeat_index } => {
                JudgementKindDto::SliderRepeat { hit, repeat_index }
            }
            JudgementKind::SliderTail { hit } => JudgementKindDto::SliderTail { hit },
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
            field,
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
            rows,
            cross_check: CrossCheckDto {
                sections: derived.sections,
                geki_katsu,
                sections_without_burst: i64::from(derived.sections) - i64::from(geki_katsu),
                count_miss: header.count_miss,
                count_50: header.count_50,
            },
            life_bar_graph: header.life_graph.as_deref().map_or(LifeBarGraphDto::Absent, |graph| {
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
            }),
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn assemble_scene(
    map: &Beatmap,
    map_md5: &str,
    header: &OsrHeader,
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
            timestamp_ticks: header.timestamp_ticks.to_string(),
            online_score_id: header.online_score_id.to_string(),
            beatmap_md5: header.beatmap_md5.clone(),
        },
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

        let kind = JudgementKindDto::from(&JudgementKind::SliderHead { hit: false });
        assert_eq!(
            serde_json::to_value(&kind).unwrap(),
            json!({ "type": "sliderHead", "hit": false })
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
        });
        assert_eq!(
            serde_json::to_value(&kind).unwrap(),
            json!({ "type": "sliderRepeat", "hit": true, "repeatIndex": 2 })
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
            totals: HitTotals {
                count_300: 0,
                count_100: 0,
                count_50: 1,
                count_miss: 0,
                max_combo: 1,
            },
            spinner_scoring: Vec::new(),
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
        assert_eq!(
            v["totals"],
            json!({ "count300": 0, "count100": 0, "count50": 1, "countMiss": 0, "maxCombo": 1 })
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
            reason: NotSimulatedReason::UnsupportedMods,
        })
        .unwrap();
        assert_eq!(
            v,
            json!({ "status": "notSimulated", "reason": "unsupportedMods" })
        );
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
            &frames,
            render_plan,
            SimulationDto::NotSimulated {
                reason: NotSimulatedReason::BeatmapMismatch,
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
        assert_eq!(v["replay"]["timestampTicks"], "638712000000000001");
        assert_eq!(v["replay"]["onlineScoreId"], "18446744073709551615");
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
        assert_eq!(fields, ["rows", "crossCheck", "lifeBarGraph"].into_iter().collect());

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
            serde_json::to_value(&IntegrityDto::compare(&header, &derived).life_bar_graph).unwrap(),
            serde_json::json!({ "status": "compared", "matched": 0, "total": 1, "headerFailed": false })
        );

        // a header whose graph ends at zero carries stable's own record of a
        // fail, whatever the samples say
        header.life_graph = Some("0|1,1000|0,".into());
        assert_eq!(
            serde_json::to_value(&IntegrityDto::compare(&header, &derived).life_bar_graph).unwrap()["headerFailed"],
            serde_json::json!(true)
        );

        // present-but-unreadable and absent are their own states, neither
        // pretending to a count
        header.life_graph = Some(String::new());
        assert_eq!(IntegrityDto::compare(&header, &derived).life_bar_graph, LifeBarGraphDto::Empty);
        header.life_graph = Some(",,".into());
        assert_eq!(IntegrityDto::compare(&header, &derived).life_bar_graph, LifeBarGraphDto::Empty);
        header.life_graph = None;
        assert_eq!(IntegrityDto::compare(&header, &derived).life_bar_graph, LifeBarGraphDto::Absent);
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
