//! per-combo-section derivation: geki, katu, and the perfect flag.
//!
//! deliberate divergence from the pinned lazer encoder: lazer writes literal
//! zeros for osu! geki/katu (`ScoreInfoExtensions.cs:71-141` returns null
//! outside taiko/mania, so `LegacyScoreEncoder.cs:109-110` writes 0). stable
//! populates them per combo section, and a zeroed pair on an edited stable
//! replay is exactly the naive-editor signature TODO.md's case study
//! documents -- so this module implements the stable burst rule (geki = a
//! section judged entirely 300s; katu = a section of only 300s and 100s
//! with at least one 100; a section containing a miss OR a 50 earns
//! neither), with the NoMod corpus as the only oracle.

use crate::beatmap::difficulty::HitGrade;
use crate::beatmap::{ProcessedBeatmap, ProcessedKind};
use crate::simulation::score::JudgementKind;
use crate::simulation::{HitTotals, JudgementTimeline};

/// the per-combo-section aggregates: TODO.md's worked example turns
/// `sections - (geki + katsu) = sections that ended without a burst` (a
/// miss or a 50 present) into the header cross-check the integrity report
/// states outright
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SectionTally {
    pub sections: u32,
    pub count_geki: u32,
    pub count_katsu: u32,
    /// sections earning neither geki nor katu: at least one miss or 50
    pub sections_without_burst: u32,
}

#[derive(Clone, Copy)]
struct SectionState {
    all_great: bool,
    any_miss_or_meh: bool,
}

/// folds each object's final grade into its combo section. circle and
/// slider sections come from the processed objects' `combo_index` (the
/// new-combo groupings after lazer's enforcement pass); every spinner is
/// its own singleton section, because stable forces a new combo onto the
/// spinner itself at load where lazer's enforcement leaves it on the
/// previous combo for rendering. the stable rule is the one geki/katu are
/// derived under (docs/adr/0001 -- the headers are the oracle): the
/// 2026-08-12 sweep fit 824 of 825 spinner-map geki deltas exactly as the
/// count of spinners sharing a lazer combo with earlier objects
pub fn section_tally(processed: &ProcessedBeatmap, timeline: &JudgementTimeline) -> SectionTally {
    // an object's final grade is its one aggregate event; heads, ticks,
    // repeats, tails, and spins never grade a section
    let mut grades: Vec<Option<HitGrade>> = vec![None; processed.objects.len()];
    for event in &timeline.events {
        let grade = match event.kind {
            JudgementKind::Circle(grade)
            | JudgementKind::SliderAggregate(grade)
            | JudgementKind::SpinnerFinal(grade) => grade,
            _ => continue,
        };
        if let Some(slot) = grades.get_mut(event.object_index) {
            *slot = Some(grade);
        }
    }

    // combo_index only ever steps by one, so a plain vec keyed by it holds
    // every non-spinner section; a leading spinner keeps index 0, everything
    // else starts at 1. spinner singletons accumulate separately -- a lazer
    // combo emptied by removing its spinner contributes no section
    let mut states: Vec<Option<SectionState>> = Vec::new();
    let mut spinner_sections: Vec<SectionState> = Vec::new();
    for (object, grade) in processed.objects.iter().zip(&grades) {
        // an unjudged object cannot certify a 300; treat it as the miss it
        // would have decayed into (unreachable through simulate, which
        // judges every object)
        let grade = grade.unwrap_or(HitGrade::Miss);

        if matches!(object.kind, ProcessedKind::Spinner(_)) {
            spinner_sections.push(SectionState {
                all_great: grade == HitGrade::Great,
                any_miss_or_meh: matches!(grade, HitGrade::Miss | HitGrade::Meh),
            });
            continue;
        }

        let index = object.combo_index.max(0) as usize;
        if states.len() <= index {
            states.resize(index + 1, None);
        }
        let state = states[index].get_or_insert(SectionState {
            all_great: true,
            any_miss_or_meh: false,
        });
        state.all_great &= grade == HitGrade::Great;
        state.any_miss_or_meh |= matches!(grade, HitGrade::Miss | HitGrade::Meh);
    }

    let mut tally = SectionTally {
        sections: 0,
        count_geki: 0,
        count_katsu: 0,
        sections_without_burst: 0,
    };
    for state in states.into_iter().flatten().chain(spinner_sections) {
        tally.sections += 1;
        // stable's burst rule: a 50 forfeits the section's burst exactly
        // like a miss does -- katu is only-300s-and-100s, never "no miss"
        if state.any_miss_or_meh {
            tally.sections_without_burst += 1;
        } else if state.all_great {
            tally.count_geki += 1;
        } else {
            tally.count_katsu += 1;
        }
    }
    tally
}

/// the map's maximum achievable combo, counted stable-style: circles and
/// spinners contribute one each, a slider contributes every nested element
/// (head + ticks + repeats + tail), and the slider aggregate itself nothing
/// -- the same elements `simulation::score` increments combo for
pub fn max_achievable_combo(processed: &ProcessedBeatmap) -> u32 {
    processed
        .objects
        .iter()
        .map(|object| match &object.kind {
            ProcessedKind::Slider(slider) => slider.nested.len() as u32,
            ProcessedKind::Circle | ProcessedKind::Spinner(_) => 1,
        })
        .fold(0u32, u32::saturating_add)
}

/// legacyscoreencoder.cs:114 -- perfect is `max combo == maximum achievable
/// combo`, strictly stronger than "no combo break": a dropped slider tail
/// neither breaks combo nor reaches the maximum, and forfeits the flag
pub fn is_perfect(processed: &ProcessedBeatmap, totals: &HitTotals) -> bool {
    totals.max_combo == max_achievable_combo(processed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::beatmap::process_beatmap;
    use crate::formats::beatmap::{
        Beatmap, HitObject, HitObjectKind, PathControlPoint, PathType, SliderData, TimingPoint,
    };
    use crate::formats::GameMode;
    use crate::math::Vec2;
    use crate::simulation::JudgementEvent;

    fn map_of(hit_objects: Vec<HitObject>) -> ProcessedBeatmap {
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
            breaks: Vec::new(),
            timing_points: vec![TimingPoint {
                time: 0.0,
                beat_len: 500.0,
            }],
            difficulty_points: Vec::new(),
            hit_objects,
        };
        process_beatmap(&map).unwrap()
    }

    fn circle(start_time: f64, new_combo: bool) -> HitObject {
        HitObject {
            start_time,
            pos: Vec2::new(256.0, 192.0),
            new_combo,
            combo_offset: 0,
            kind: HitObjectKind::Circle,
        }
    }

    fn slider(start_time: f64, new_combo: bool) -> HitObject {
        HitObject {
            start_time,
            pos: Vec2::new(100.0, 100.0),
            new_combo,
            combo_offset: 0,
            kind: HitObjectKind::Slider(SliderData {
                control_points: vec![
                    PathControlPoint {
                        pos: Vec2::ZERO,
                        path_type: Some(PathType::Linear),
                    },
                    PathControlPoint {
                        pos: Vec2::new(100.0, 0.0),
                        path_type: None,
                    },
                ],
                expected_distance: Some(100.0),
                repeat_count: 0,
            }),
        }
    }

    fn spinner(start_time: f64) -> HitObject {
        HitObject {
            start_time,
            pos: Vec2::ZERO,
            new_combo: false,
            combo_offset: 0,
            kind: HitObjectKind::Spinner { duration: 500.0 },
        }
    }

    /// a timeline holding only final-grade events; sections ignore the rest
    fn timeline_of(grades: &[(usize, JudgementKind)]) -> JudgementTimeline {
        JudgementTimeline {
            events: grades
                .iter()
                .map(|&(object_index, kind)| JudgementEvent {
                    time: object_index as f64 * 1000.0,
                    object_index,
                    kind,
                    combo_after: 0,
                    accuracy_after: 1.0,
                })
                .collect(),
            totals: HitTotals::default(),
            spinner_scoring: Vec::new(),
        }
    }

    fn assert_identity(tally: &SectionTally) {
        assert_eq!(
            tally.sections - (tally.count_geki + tally.count_katsu),
            tally.sections_without_burst,
            "sections - (geki + katsu) must equal the sections that ended without a burst"
        );
    }

    #[test]
    fn all_great_sections_are_geki() {
        let processed = map_of(vec![
            circle(1000.0, true),
            circle(1500.0, false),
            circle(2000.0, true),
            circle(2500.0, true),
        ]);
        let tally = section_tally(
            &processed,
            &timeline_of(&[
                (0, JudgementKind::Circle(HitGrade::Great)),
                (1, JudgementKind::Circle(HitGrade::Great)),
                (2, JudgementKind::Circle(HitGrade::Great)),
                (3, JudgementKind::Circle(HitGrade::Great)),
            ]),
        );
        assert_eq!(
            tally,
            SectionTally {
                sections: 3,
                count_geki: 3,
                count_katsu: 0,
                sections_without_burst: 0,
            }
        );
        assert_identity(&tally);
    }

    #[test]
    fn a_katu_needs_only_greats_and_oks_and_a_miss_or_meh_earns_neither() {
        // stable's burst rule: geki = all 300s; katu = no misses AND no 50s
        // (at least one 100, rest 300/100); a section containing a 50 --
        // even miss-free -- earns neither. oracle: the 2026-08-12 sweep's
        // katu deltas are overwhelmingly negative (we counted 50-carrying
        // sections as katu where headers do not), at a rate independent of
        // spinners
        let processed = map_of(vec![
            circle(1000.0, true),
            circle(1500.0, false),
            circle(2000.0, true),
            circle(2500.0, false),
            circle(3000.0, true),
        ]);
        let tally = section_tally(
            &processed,
            &timeline_of(&[
                (0, JudgementKind::Circle(HitGrade::Great)),
                (1, JudgementKind::Circle(HitGrade::Ok)),
                (2, JudgementKind::Circle(HitGrade::Miss)),
                (3, JudgementKind::Circle(HitGrade::Great)),
                (4, JudgementKind::Circle(HitGrade::Meh)),
            ]),
        );
        // section 1 (300, 100) -> katu; section 2 (miss, 300) -> neither;
        // section 3 (50) -> neither, despite carrying no miss
        assert_eq!(
            tally,
            SectionTally {
                sections: 3,
                count_geki: 0,
                count_katsu: 1,
                sections_without_burst: 2,
            }
        );
        assert_identity(&tally);
    }

    #[test]
    fn slider_aggregates_grade_their_section_and_part_events_do_not() {
        let processed = map_of(vec![circle(1000.0, true), slider(2000.0, false)]);
        // the tail was dropped (no combo, no grade effect) yet the aggregate
        // still came out Ok: the section reads the aggregate alone
        let tally = section_tally(
            &processed,
            &timeline_of(&[
                (0, JudgementKind::Circle(HitGrade::Great)),
                (1, JudgementKind::SliderHead { hit: true }),
                (1, JudgementKind::SliderTail { hit: false }),
                (1, JudgementKind::SliderAggregate(HitGrade::Ok)),
            ]),
        );
        assert_eq!(
            tally,
            SectionTally {
                sections: 1,
                count_geki: 0,
                count_katsu: 1,
                sections_without_burst: 0,
            }
        );
        assert_identity(&tally);
    }

    #[test]
    fn spinners_form_their_own_stable_section() {
        // lazer's combo enforcement leaves the spinner on the previous
        // combo_index (rendering semantics), but stable forces a new combo
        // onto the spinner itself at load, so for geki/katu accounting the
        // spinner is always a singleton section: the objects before it
        // grade on their own, and the spinner's grade grades its own
        // section. oracle: the 2026-08-12 sweep -- 824/825 spinner-map geki
        // deltas equal exactly the count of spinners sharing a lazer combo
        // with earlier objects
        let processed = map_of(vec![circle(1000.0, true), spinner(2000.0), circle(3000.0, false)]);
        assert_eq!(processed.objects[0].combo_index, processed.objects[1].combo_index);
        assert_ne!(processed.objects[0].combo_index, processed.objects[2].combo_index);

        // a missed spinner no longer poisons the interrupted section: the
        // circle before it keeps its geki, the spinner is its own
        // miss-section
        let tally = section_tally(
            &processed,
            &timeline_of(&[
                (0, JudgementKind::Circle(HitGrade::Great)),
                (1, JudgementKind::SpinnerFinal(HitGrade::Miss)),
                (2, JudgementKind::Circle(HitGrade::Great)),
            ]),
        );
        assert_eq!(
            tally,
            SectionTally {
                sections: 3,
                count_geki: 2,
                count_katsu: 0,
                sections_without_burst: 1,
            }
        );
        assert_identity(&tally);

        // and a great spinner is its own geki
        let tally = section_tally(
            &processed,
            &timeline_of(&[
                (0, JudgementKind::Circle(HitGrade::Great)),
                (1, JudgementKind::SpinnerFinal(HitGrade::Great)),
                (2, JudgementKind::Circle(HitGrade::Great)),
            ]),
        );
        assert_eq!(
            tally,
            SectionTally {
                sections: 3,
                count_geki: 3,
                count_katsu: 0,
                sections_without_burst: 0,
            }
        );
        assert_identity(&tally);
    }

    #[test]
    fn a_leading_spinner_forms_its_own_section() {
        // nothing precedes it, so the spinner keeps combo_index 0 while the
        // forced new combo after it starts section 1
        let processed = map_of(vec![spinner(1000.0), circle(2000.0, false)]);
        assert_eq!(processed.objects[0].combo_index, 0);
        assert_eq!(processed.objects[1].combo_index, 1);

        let tally = section_tally(
            &processed,
            &timeline_of(&[
                (0, JudgementKind::SpinnerFinal(HitGrade::Great)),
                (1, JudgementKind::Circle(HitGrade::Ok)),
            ]),
        );
        assert_eq!(
            tally,
            SectionTally {
                sections: 2,
                count_geki: 1,
                count_katsu: 1,
                sections_without_burst: 0,
            }
        );
        assert_identity(&tally);
    }

    #[test]
    fn achievable_combo_counts_slider_parts_stable_style() {
        let processed = map_of(vec![circle(1000.0, true), slider(2000.0, false), spinner(4000.0)]);
        let ProcessedKind::Slider(s) = &processed.objects[1].kind else {
            panic!("expected a slider");
        };
        // circle 1 + every nested slider element + spinner 1
        assert_eq!(
            max_achievable_combo(&processed),
            1 + s.nested.len() as u32 + 1,
        );
    }

    #[test]
    fn a_dropped_slider_tail_forfeits_perfect_without_breaking_combo() {
        let processed = map_of(vec![slider(1000.0, true)]);
        let achievable = max_achievable_combo(&processed);

        // full combo: perfect
        let full = HitTotals {
            count_300: 1,
            max_combo: achievable,
            ..HitTotals::default()
        };
        assert!(is_perfect(&processed, &full));

        // tail dropped: one short of achievable with zero misses -- combo
        // never broke, and perfect is still forfeited
        let dropped_tail = HitTotals {
            count_300: 1,
            max_combo: achievable - 1,
            ..HitTotals::default()
        };
        assert!(!is_perfect(&processed, &dropped_tail));
    }
}
