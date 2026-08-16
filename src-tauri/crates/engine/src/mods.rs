//! the mod pipeline seam. v1 ships NoMod only; the trait fixes the seam
//! shape -- difficulty adjust -> geometry transform -> rate -- so hr/ez
//! (difficulty + reflection), dt/ht (rate) and hd (fade curves, frontend
//! consumer) land as implementations rather than refactors. shapes and cited
//! lazer sources are catalogued in TODO.md's mod simulation entry.
//! flag values follow osu.game/beatmaps/legacy/legacymods.cs, which mirrors
//! the stable bitfield stored in .osr headers

use crate::beatmap::{process_beatmap, ProcessedBeatmap};
use crate::error::Result;
use crate::formats::beatmap::Beatmap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LegacyMods {
    pub raw: u32,
}

impl LegacyMods {
    pub const NO_FAIL: u32 = 1;
    pub const EASY: u32 = 2;
    pub const TOUCH_DEVICE: u32 = 4;
    pub const HIDDEN: u32 = 8;
    pub const HARD_ROCK: u32 = 16;
    pub const SUDDEN_DEATH: u32 = 32;
    pub const DOUBLE_TIME: u32 = 64;
    pub const RELAX: u32 = 128;
    pub const HALF_TIME: u32 = 256;
    pub const NIGHTCORE: u32 = 512;
    pub const FLASHLIGHT: u32 = 1024;
    pub const AUTOPLAY: u32 = 2048;
    pub const SPUN_OUT: u32 = 4096;
    pub const AUTOPILOT: u32 = 8192;
    pub const PERFECT: u32 = 16384;
    pub const SCORE_V2: u32 = 536_870_912;

    pub fn contains(self, flag: u32) -> bool {
        self.raw & flag != 0
    }

    /// v1 simulates exactly the unmodded ruleset; any set bit -- gameplay-
    /// affecting or not -- routes to the not-simulated path. deliberately
    /// strict: deciding which flags are judgement-neutral (nf? sd? v2?) is
    /// mod-simulation work, deferred with it
    pub fn is_nomod(self) -> bool {
        self.raw == 0
    }
}

pub trait ModPipeline {
    fn adjust_difficulty(&self, _beatmap: &mut Beatmap) {}
    fn transform_geometry(&self, _beatmap: &mut Beatmap) {}
    fn rate(&self) -> f64 {
        1.0
    }
}

pub struct NoMod;

impl ModPipeline for NoMod {}

pub fn pipeline_for(mods: LegacyMods) -> Option<Box<dyn ModPipeline>> {
    mods.is_nomod().then(|| Box::new(NoMod) as Box<dyn ModPipeline>)
}

pub fn process_with_mods(map: &Beatmap, pipeline: &dyn ModPipeline) -> Result<ProcessedBeatmap> {
    let mut adjusted = map.clone();
    pipeline.adjust_difficulty(&mut adjusted);
    pipeline.transform_geometry(&mut adjusted);
    process_beatmap(&adjusted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nomod_detection_is_exact() {
        assert!(LegacyMods { raw: 0 }.is_nomod());
        assert!(!LegacyMods {
            raw: LegacyMods::HIDDEN
        }
        .is_nomod());
        assert!(LegacyMods {
            raw: LegacyMods::HARD_ROCK | LegacyMods::DOUBLE_TIME
        }
        .contains(LegacyMods::HARD_ROCK));
    }

    #[test]
    fn only_nomod_gets_a_pipeline() {
        assert!(pipeline_for(LegacyMods { raw: 0 }).is_some());
        assert!(pipeline_for(LegacyMods {
            raw: LegacyMods::NO_FAIL
        })
        .is_none());
        assert!(pipeline_for(LegacyMods {
            raw: LegacyMods::SCORE_V2
        })
        .is_none());
    }

    #[test]
    fn nomod_pipeline_is_the_identity() {
        use crate::formats::beatmap::{Beatmap, HitObject, HitObjectKind, TimingPoint};
        use crate::formats::GameMode;
        use crate::math::Vec2;

        let map = Beatmap {
            format_version: 14,
            mode: GameMode::Osu,
            title: String::new(),
            artist: String::new(),
            creator: String::new(),
            version: String::new(),
            beatmap_id: 0,
            beatmap_set_id: 0,
            audio_file: String::new(),
            audio_lead_in: 0.0,
            background_file: String::new(),
            stack_leniency: 0.7,
            hp_drain_rate: 5.0,
            circle_size: 4.0,
            overall_difficulty: 5.0,
            approach_rate: 9.0,
            slider_multiplier: 1.4,
            slider_tick_rate: 1.0,
            combo_colors: Vec::new(),
            default_sample_bank: crate::formats::samples::SampleBank::Normal,
            default_sample_volume: 100,
            samples_match_playback_rate: false,
            breaks: Vec::new(),
            timing_points: vec![TimingPoint {
                time: 0.0,
                beat_len: 500.0,
            }],
            difficulty_points: Vec::new(),
            hit_objects: vec![HitObject {
                start_time: 1000.0,
                pos: Vec2::new(256.0, 192.0),
                new_combo: true,
                combo_offset: 0,
                samples: Vec::new(),
                kind: HitObjectKind::Circle,
            }],
        };
        let direct = crate::beatmap::process_beatmap(&map).unwrap();
        let piped = process_with_mods(&map, &NoMod).unwrap();
        assert_eq!(piped.objects.len(), direct.objects.len());
        assert_eq!(
            piped.objects[0].stacked_position,
            direct.objects[0].stacked_position
        );
        assert_eq!(NoMod.rate(), 1.0);
    }
}
