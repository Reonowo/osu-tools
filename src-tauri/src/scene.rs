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
use serde::Serialize;

use crate::error::Warning;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedScene {
    pub beatmap: BeatmapMeta,
    pub replay: ReplayMeta,
    pub frames: Vec<FrameDto>,
    pub render_plan: RenderPlan,
    pub simulation: SimulationDto,
    /// absolute path for tauri's convertFileSrc; the command layer has
    /// already allowed it on the asset protocol scope
    pub audio_path: Option<String>,
    pub background_path: Option<String>,
    pub warnings: Vec<Warning>,
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

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDto {
    pub time: f64,
    pub x: f32,
    pub y: f32,
    /// raw button bitfield (left1=1, right1=2, left2=4, right2=8, smoke=16)
    pub buttons: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SimulationDto {
    Authoritative { events: Vec<JudgementEventDto>, totals: TotalsDto },
    NotSimulated { reason: NotSimulatedReason },
}

impl SimulationDto {
    pub fn authoritative(timeline: &JudgementTimeline) -> SimulationDto {
        SimulationDto::Authoritative {
            events: timeline.events.iter().map(JudgementEventDto::from).collect(),
            totals: TotalsDto {
                count_300: timeline.totals.count_300,
                count_100: timeline.totals.count_100,
                count_50: timeline.totals.count_50,
                count_miss: timeline.totals.count_miss,
                max_combo: timeline.totals.max_combo,
            },
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
    SliderRepeat { hit: bool },
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
            JudgementKind::SliderRepeat { hit } => JudgementKindDto::SliderRepeat { hit },
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
    warnings: Vec<Warning>,
) -> LoadedScene {
    LoadedScene {
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
        frames: frames
            .iter()
            .map(|f| FrameDto { time: f.time, x: f.pos.x, y: f.pos.y, buttons: f.buttons.raw })
            .collect(),
        render_plan,
        simulation,
        audio_path: audio_path.map(|p| p.to_string_lossy().into_owned()),
        background_path: background_path.map(|p| p.to_string_lossy().into_owned()),
        warnings,
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
        assert_eq!(serde_json::to_value(&kind).unwrap(), json!({ "type": "circle", "grade": "great" }));

        let kind = JudgementKindDto::from(&JudgementKind::SliderHead { hit: false });
        assert_eq!(serde_json::to_value(&kind).unwrap(), json!({ "type": "sliderHead", "hit": false }));

        let kind = JudgementKindDto::from(&JudgementKind::SliderAggregate(HitGrade::Ok));
        assert_eq!(
            serde_json::to_value(&kind).unwrap(),
            json!({ "type": "sliderAggregate", "grade": "ok" })
        );

        let kind = JudgementKindDto::from(&JudgementKind::SpinnerBonus);
        assert_eq!(serde_json::to_value(&kind).unwrap(), json!({ "type": "spinnerBonus" }));
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
            totals: HitTotals { count_300: 0, count_100: 0, count_50: 1, count_miss: 0, max_combo: 1 },
        };
        let v = serde_json::to_value(SimulationDto::authoritative(&timeline)).unwrap();
        assert_eq!(v["status"], "authoritative");
        assert_eq!(v["totals"], json!({ "count300": 0, "count100": 0, "count50": 1, "countMiss": 0, "maxCombo": 1 }));
        assert_eq!(v["events"][0]["objectIndex"], 0);
        assert_eq!(v["events"][0]["comboAfter"], 1);
        assert_eq!(v["events"][0]["kind"]["grade"], "meh");

        let v = serde_json::to_value(SimulationDto::NotSimulated {
            reason: NotSimulatedReason::UnsupportedMods,
        })
        .unwrap();
        assert_eq!(v, json!({ "status": "notSimulated", "reason": "unsupportedMods" }));
    }

    #[test]
    fn assembled_scenes_carry_the_full_camel_case_contract() {
        let map = engine::formats::beatmap::decode_beatmap_bytes(
            &std::fs::read(crate::testutil::fixtures_dir().join("beatmaps").join("stacking-v14.osu"))
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
            SimulationDto::NotSimulated { reason: NotSimulatedReason::BeatmapMismatch },
            Some(std::path::PathBuf::from(r"C:\somewhere\audio.mp3")),
            None,
            vec![crate::error::Warning::AudioMissing],
        );
        let v = serde_json::to_value(&scene).unwrap();

        assert_eq!(v["beatmap"]["title"], "Stacking Fixture");
        assert_eq!(v["beatmap"]["md5"], "abc123");
        assert_eq!(v["beatmap"]["audioLeadIn"], map.audio_lead_in);
        assert_eq!(v["replay"]["mods"], 0);
        assert_eq!(v["replay"]["playerName"], "test");
        assert_eq!(v["replay"]["timestampTicks"], "638712000000000001");
        assert_eq!(v["replay"]["onlineScoreId"], "18446744073709551615");
        assert_eq!(v["frames"][0], json!({ "time": 16.0, "x": 100.0, "y": 200.0, "buttons": 1 }));
        assert_eq!(v["renderPlan"]["playfield"]["width"], 512.0);
        assert_eq!(v["simulation"]["status"], "notSimulated");
        assert_eq!(v["audioPath"], r"C:\somewhere\audio.mp3");
        assert_eq!(v["backgroundPath"], serde_json::Value::Null);
        assert_eq!(v["warnings"][0]["kind"], "audioMissing");
    }
}
