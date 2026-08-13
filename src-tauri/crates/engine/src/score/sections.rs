//! per-combo-section derivation: geki, katu, and the perfect flag.
//!
//! deliberate divergence from the pinned lazer encoder: lazer writes literal
//! zeros for osu! geki/katu (`ScoreInfoExtensions.cs:71-141` returns null
//! outside taiko/mania, so `LegacyScoreEncoder.cs:109-110` writes 0). stable
//! populates them live, and a zeroed pair on an edited stable replay is
//! exactly the naive-editor signature TODO.md's case study documents -- so
//! this module ports stable's own accounting (engine parity pass, issue 14;
//! reference: danser-go ruleset.go:564-608 `processGekiKatu`, the
//! community-verified stable model), a TEMPORAL machine, not a per-section
//! grade fold:
//!
//! - two counters accumulate per object-level result in emission order --
//!   a 100 bumps the katu counter, a 50 or miss bumps the bad counter --
//!   regardless of which section the object belongs to. a slider aggregate
//!   landing after the next section already started poisons that section's
//!   counters, not its own's.
//! - the burst decision fires when the section-last object (next object
//!   carries the stable new-combo flag, or end of map) produces its result:
//!   geki if both counters are zero, katu if only the bad counter is zero --
//!   and only if the result itself is a base hit (a missed section-ender
//!   still resets the counters but can never award).
//! - allClicked: at that moment, every earlier still-alive object back to
//!   the nearest alive stable new-combo flag must already be hit; an
//!   in-flight slider (aggregate pending while the section's last object is
//!   judged early) withholds the burst entirely.
//!
//! section boundaries are stable's load-time flags
//! (`ProcessedObject::stable_new_combo` -- raw new-combo with the first
//! object after a spinner forced), never lazer's enforcement. the NoMod
//! corpus and the sweep are the oracles.

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

/// one object's resolution facts, read off the timeline: when its
/// object-level result was emitted (event index + time) and, for sliders,
/// when the head resolved -- the drain in `simulation::drain` requires both
struct Resolution {
    final_event: Option<usize>,
    final_time: f64,
    head_time: Option<f64>,
}

/// stable's geki/katu machine over the emitted timeline -- see the module
/// doc for the semantics and the danser citation. events are consumed in
/// emission order, which is the simulation's walk order (the same order
/// danser's SendResult fires in)
pub fn section_tally(processed: &ProcessedBeatmap, timeline: &JudgementTimeline) -> SectionTally {
    let objects = &processed.objects;
    // a never-resolved object (no object-level result in the timeline --
    // unreachable via simulate, which judges everything, but this is a
    // public api) stays alive forever: infinity keeps it on the walk's
    // list, where its missing final result blocks the burst exactly as
    // danser's unhit membership would
    let mut resolutions: Vec<Resolution> = objects
        .iter()
        .map(|_| Resolution {
            final_event: None,
            final_time: f64::INFINITY,
            head_time: None,
        })
        .collect();
    for (k, event) in timeline.events.iter().enumerate() {
        let Some(resolution) = resolutions.get_mut(event.object_index) else {
            continue;
        };
        match event.kind {
            JudgementKind::Circle(_) | JudgementKind::SliderAggregate(_) | JudgementKind::SpinnerFinal(_) => {
                resolution.final_event = Some(k);
                resolution.final_time = event.time;
            }
            JudgementKind::SliderHead { .. } => resolution.head_time = Some(event.time),
            _ => {}
        }
    }

    // sections are structural: one per section-last object. the identity
    // sections - (geki + katsu) = sections_without_burst holds by
    // construction, as before
    let is_section_last =
        |i: usize| i + 1 == objects.len() || objects[i + 1].stable_new_combo;
    let sections = (0..objects.len()).filter(|&i| is_section_last(i)).count() as u32;

    let mut tally = SectionTally {
        sections,
        count_geki: 0,
        count_katsu: 0,
        sections_without_burst: 0,
    };

    // ruleset.go:565-570 + 593-606 -- the counters and the trigger fold
    let mut current_katu = 0u32;
    let mut current_bad = 0u32;
    for (k, event) in timeline.events.iter().enumerate() {
        let grade = match event.kind {
            JudgementKind::Circle(grade)
            | JudgementKind::SliderAggregate(grade)
            | JudgementKind::SpinnerFinal(grade) => grade,
            _ => continue,
        };
        match grade {
            HitGrade::Ok => current_katu += 1,
            HitGrade::Meh | HitGrade::Miss => current_bad += 1,
            HitGrade::Great => {}
        }

        let index = event.object_index;
        if index >= objects.len() || !is_section_last(index) {
            continue;
        }
        // a missed section-ender resets the counters without awarding
        // (BaseHits excludes Miss, ruleset.go:593)
        if grade != HitGrade::Miss && all_clicked(processed, &resolutions, index, k, event.time) {
            if current_katu == 0 && current_bad == 0 {
                tally.count_geki += 1;
            } else if current_bad == 0 {
                tally.count_katsu += 1;
            }
        }
        current_katu = 0;
        current_bad = 0;
    }

    tally.sections_without_burst = tally
        .sections
        .saturating_sub(tally.count_geki + tally.count_katsu);
    tally
}

/// ruleset.go:573-591 -- the withholding walk: backward from the trigger
/// over objects still on stable's processed list at that moment, blocking
/// on any unhit one and stopping at the first alive stable new-combo flag.
/// membership is reconstructed from the timeline: an object has left the
/// list once it finished strictly before the trigger's millisecond (the
/// driver drains after each frame group); a drained object neither blocks
/// nor stops the walk -- its flag is invisible, exactly as in the reference
fn all_clicked(
    processed: &ProcessedBeatmap,
    resolutions: &[Resolution],
    trigger_index: usize,
    trigger_event: usize,
    trigger_time: f64,
) -> bool {
    for j in (0..trigger_index).rev() {
        let resolution = &resolutions[j];
        let finished_time = match processed.objects[j].kind {
            // slider drain waits for the head as well (slider.go:505-517)
            ProcessedKind::Slider(_) => resolution.final_time.max(
                resolution.head_time.unwrap_or(f64::INFINITY),
            ),
            _ => resolution.final_time,
        };
        if finished_time < trigger_time {
            continue;
        }
        // alive: hit only if its object-level result already fired
        let is_hit = resolution.final_event.is_some_and(|e| e <= trigger_event);
        if !is_hit {
            return false;
        }
        if processed.objects[j].stable_new_combo {
            break;
        }
    }
    true
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
    fn a_spinner_without_its_own_flag_merges_backward_and_forces_a_boundary_after() {
        // stable's load pass (danser parser.go:360-372) forces new-combo on
        // the object AFTER a spinner but leaves the spinner's own flag as
        // the file wrote it -- so an unflagged spinner belongs to the
        // preceding section and its result is that section's trigger, while
        // the next object always opens a fresh section. lazer's enforcement
        // (combo_index) is untouched by this
        let processed = map_of(vec![circle(1000.0, true), spinner(2000.0), circle(3000.0, false)]);
        assert!(processed.objects[0].stable_new_combo);
        assert!(!processed.objects[1].stable_new_combo, "spinner keeps its raw flag");
        assert!(processed.objects[2].stable_new_combo, "post-spinner force");
        assert_eq!(processed.objects[0].combo_index, processed.objects[1].combo_index);

        // a missed spinner ends its merged section without a burst; the
        // trailing circle's section is untouched
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
                sections: 2,
                count_geki: 1,
                count_katsu: 0,
                sections_without_burst: 1,
            }
        );
        assert_identity(&tally);

        // and an all-great merged section is one geki, not two
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
                sections: 2,
                count_geki: 2,
                count_katsu: 0,
                sections_without_burst: 0,
            }
        );
        assert_identity(&tally);
    }

    #[test]
    fn a_leading_spinner_forms_its_own_section() {
        // the spinner's successor carries the forced boundary, so the
        // spinner is section-last for the opening section
        let processed = map_of(vec![spinner(1000.0), circle(2000.0, false)]);
        assert_eq!(processed.objects[0].combo_index, 0);
        assert_eq!(processed.objects[1].combo_index, 1);
        assert!(processed.objects[1].stable_new_combo);

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

    /// a timeline with explicit event times, for the temporal behaviours
    /// timeline_of's index-derived times cannot express
    fn timeline_at(events: &[(usize, JudgementKind, f64)]) -> JudgementTimeline {
        JudgementTimeline {
            events: events
                .iter()
                .map(|&(object_index, kind, time)| JudgementEvent {
                    time,
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

    #[test]
    fn a_section_ending_before_its_slider_resolves_forfeits_the_burst() {
        // ruleset.go:573-591 (allClicked): the section's last object is
        // judged while an earlier slider of the same section is still in
        // flight -- stable walks the alive list, finds the unhit slider,
        // and withholds the burst even though every final grade is a 300
        let processed = map_of(vec![slider(1000.0, true), circle(2000.0, false), circle(3000.0, true)]);
        let tally = section_tally(
            &processed,
            &timeline_at(&[
                (0, JudgementKind::SliderHead { hit: true }, 1000.0),
                // the section-ending circle resolves early, mid-slider
                (1, JudgementKind::Circle(HitGrade::Great), 1900.0),
                (0, JudgementKind::SliderTail { hit: true }, 2100.0),
                (0, JudgementKind::SliderAggregate(HitGrade::Great), 2100.0),
                (2, JudgementKind::Circle(HitGrade::Great), 3000.0),
            ]),
        );
        // section [slider, circle]: withheld; section [circle]: geki
        assert_eq!(
            tally,
            SectionTally {
                sections: 2,
                count_geki: 1,
                count_katsu: 0,
                sections_without_burst: 1,
            }
        );
        assert_identity(&tally);
    }

    #[test]
    fn a_late_aggregate_poisons_the_section_it_lands_in_not_its_own() {
        // ruleset.go:565-570: the counters accumulate in emission order, so
        // a slider aggregate arriving after its section's trigger already
        // reset them charges the NEXT section -- the all-great trailing
        // section derives katu, not geki
        let processed = map_of(vec![slider(1000.0, true), circle(2000.0, false), circle(3000.0, true)]);
        let tally = section_tally(
            &processed,
            &timeline_at(&[
                (0, JudgementKind::SliderHead { hit: true }, 1000.0),
                (1, JudgementKind::Circle(HitGrade::Great), 1900.0),
                (0, JudgementKind::SliderTail { hit: false }, 2100.0),
                (0, JudgementKind::SliderAggregate(HitGrade::Ok), 2100.0),
                (2, JudgementKind::Circle(HitGrade::Great), 3000.0),
            ]),
        );
        // section [slider, circle]: withheld (in-flight slider at the
        // trigger); section [circle]: its counters carry the slider's
        // orphaned 100 -> katu
        assert_eq!(
            tally,
            SectionTally {
                sections: 2,
                count_geki: 0,
                count_katsu: 1,
                sections_without_burst: 1,
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
