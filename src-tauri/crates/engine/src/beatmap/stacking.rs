//! port of osu.game.rulesets.osu/beatmaps/osubeatmapprocessor.cs stacking
//! (pin 83b8a64): applystacking for format >= 6, applystackingold below.
//! runs over the full object range (start 0, end len-1), which makes two
//! pieces of the c# statically dead and they are not ported: the
//! extended-end-index block behind `endIndex < hitObjects.Count - 1`
//! (osubeatmapprocessor.cs:77-117), and the `n < extendedStartIndex` reset
//! inside the circle branch (:161-166), whose condition needs a negative
//! index when the range starts at zero

use crate::beatmap::processing::{ProcessedBeatmap, ProcessedKind, ProcessedObject};
use crate::math::{dotnet_double_to_i32_unchecked, Vec2};

/// osubeatmapprocessor.cs:22
pub const STACK_DISTANCE: f32 = 3.0;

pub fn apply_stacking(beatmap: &mut ProcessedBeatmap) {
    for obj in beatmap.objects.iter_mut() {
        obj.stack_height = 0;
    }
    if beatmap.objects.is_empty() {
        return;
    }

    // osubeatmapprocessor.cs:280-281 -- (int)-truncated preempt times the
    // leniency, kept as f32. every top-level object shares the map preempt, so
    // the per-object c# call collapses to one constant
    let stack_threshold = dotnet_double_to_i32_unchecked(beatmap.preempt) as f32 * beatmap.stack_leniency;

    if beatmap.format_version >= 6 {
        apply_stacking_new(&mut beatmap.objects, stack_threshold);
    } else {
        apply_stacking_old(&mut beatmap.objects, stack_threshold);
    }

    let scale = beatmap.scale;
    for obj in beatmap.objects.iter_mut() {
        let offset = stack_offset(obj, scale);
        obj.stacked_position = obj.position + offset;
        if let ProcessedKind::Slider(s) = &mut obj.kind {
            for nested in &mut s.nested {
                nested.stacked_position = nested.position + offset;
            }
        }
    }
}

/// osuhitobject.cs:92, with the spinner override from spinner.cs:59
fn stack_offset(obj: &ProcessedObject, scale: f32) -> Vec2 {
    if matches!(obj.kind, ProcessedKind::Spinner(_)) {
        return Vec2::ZERO;
    }
    let magnitude = obj.stack_height as f32 * scale * -6.4;
    Vec2::new(magnitude, magnitude)
}

fn is_spinner(obj: &ProcessedObject) -> bool {
    matches!(obj.kind, ProcessedKind::Spinner(_))
}

fn is_slider(obj: &ProcessedObject) -> bool {
    matches!(obj.kind, ProcessedKind::Slider(_))
}

/// osubeatmapprocessor.cs:119-222 with startIndex 0 / endIndex len-1
fn apply_stacking_new(objects: &mut [ProcessedObject], stack_threshold: f32) {
    for i in (1..objects.len()).rev() {
        let mut n = i;
        let mut object_i = i;
        if objects[object_i].stack_height != 0 || is_spinner(&objects[object_i]) {
            continue;
        }

        if !is_slider(&objects[object_i]) {
            // hit circle branch: osubeatmapprocessor.cs:145-199
            while n > 0 {
                n -= 1;
                if is_spinner(&objects[n]) {
                    continue;
                }
                let end_time = objects[n].end_time;
                // osubeatmapprocessor.cs:154-157 -- int truncation to match stable.
                // c#'s `(int)a - (int)b` is unchecked and wraps on overflow, so this
                // must use wrapping_sub rather than `-`: an ordinary subtract panics
                // in a debug build whenever one side lands on i32::MIN (the
                // dotnet_double_to_i32_unchecked sentinel for non-finite or
                // out-of-range times, which raw hit-object times are not bounded
                // against)
                let truncated_gap = dotnet_double_to_i32_unchecked(objects[object_i].start_time)
                    .wrapping_sub(dotnet_double_to_i32_unchecked(end_time));
                if truncated_gap as f32 > stack_threshold {
                    break;
                }
                if is_slider(&objects[n])
                    && Vec2::distance(objects[n].end_position(), objects[object_i].position) < STACK_DISTANCE
                {
                    let offset = objects[object_i].stack_height - objects[n].stack_height + 1;
                    for j in (n + 1)..=i {
                        if Vec2::distance(objects[n].end_position(), objects[j].position) < STACK_DISTANCE {
                            objects[j].stack_height -= offset;
                        }
                    }
                    break;
                }
                if Vec2::distance(objects[n].position, objects[object_i].position) < STACK_DISTANCE {
                    objects[n].stack_height = objects[object_i].stack_height + 1;
                    object_i = n;
                }
            }
        } else {
            // slider branch: osubeatmapprocessor.cs:200-220 -- always stacks
            // positive, compares start times without truncation
            while n > 0 {
                n -= 1;
                if is_spinner(&objects[n]) {
                    continue;
                }
                if objects[object_i].start_time - objects[n].start_time > stack_threshold as f64 {
                    break;
                }
                if Vec2::distance(objects[n].end_position(), objects[object_i].position) < STACK_DISTANCE {
                    objects[n].stack_height = objects[object_i].stack_height + 1;
                    object_i = n;
                }
            }
        }
    }
}

/// osubeatmapprocessor.cs:224-269 -- format < 6. note there is no spinner
/// exemption here; spinners take part exactly as stable's old code had it
fn apply_stacking_old(objects: &mut [ProcessedObject], stack_threshold: f32) {
    for i in 0..objects.len() {
        if objects[i].stack_height != 0 && !is_slider(&objects[i]) {
            continue;
        }

        let mut start_time = objects[i].end_time;
        let mut slider_stack = 0;

        // osubeatmapprocessor.cs:243-246 -- the slider comparison point is the
        // raw path end, not the span-aware end position
        let position2 = match &objects[i].kind {
            ProcessedKind::Slider(s) => objects[i].position + s.path.position_at(1.0),
            _ => objects[i].position,
        };

        for j in (i + 1)..objects.len() {
            if objects[j].start_time - stack_threshold as f64 > start_time {
                break;
            }
            if Vec2::distance(objects[j].position, objects[i].position) < STACK_DISTANCE {
                objects[i].stack_height += 1;
                start_time = objects[j].start_time;
            } else if Vec2::distance(objects[j].position, position2) < STACK_DISTANCE {
                slider_stack += 1;
                objects[j].stack_height -= slider_stack;
                start_time = objects[j].start_time;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::beatmap::processing::{process_beatmap, ProcessedKind};
    use crate::formats::beatmap::{
        Beatmap, HitObject, HitObjectKind, PathControlPoint, PathType, SliderData, TimingPoint,
    };
    use crate::formats::GameMode;
    use crate::math::Vec2;

    fn map_with(format_version: i32, hit_objects: Vec<HitObject>) -> Beatmap {
        Beatmap {
            format_version,
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
            approach_rate: 9.0, // preempt 600 -> stack threshold 420
            slider_multiplier: 1.4,
            slider_tick_rate: 1.0,
            combo_colors: Vec::new(),
            timing_points: vec![TimingPoint {
                time: 0.0,
                beat_len: 500.0,
            }],
            difficulty_points: Vec::new(),
            hit_objects,
        }
    }

    fn circle(start_time: f64, x: f32, y: f32) -> HitObject {
        HitObject {
            start_time,
            pos: Vec2::new(x, y),
            new_combo: false,
            combo_offset: 0,
            kind: HitObjectKind::Circle,
        }
    }

    fn slider(start_time: f64, x: f32, y: f32, length: f64) -> HitObject {
        HitObject {
            start_time,
            pos: Vec2::new(x, y),
            new_combo: false,
            combo_offset: 0,
            kind: HitObjectKind::Slider(SliderData {
                control_points: vec![
                    PathControlPoint {
                        pos: Vec2::ZERO,
                        path_type: Some(PathType::Linear),
                    },
                    PathControlPoint {
                        pos: Vec2::new(length as f32, 0.0),
                        path_type: None,
                    },
                ],
                expected_distance: Some(length),
                repeat_count: 0,
            }),
        }
    }

    fn spinner(start_time: f64) -> HitObject {
        HitObject {
            start_time,
            pos: Vec2::new(256.0, 192.0),
            new_combo: false,
            combo_offset: 0,
            kind: HitObjectKind::Spinner { duration: 50.0 },
        }
    }

    #[test]
    fn a_stack_of_circles_grows_toward_earlier_objects() {
        // osubeatmapprocessor.cs:190-197 -- the reverse pass hands the later
        // object height 0 and pushes earlier duplicates up
        let p = process_beatmap(&map_with(
            14,
            vec![
                circle(0.0, 256.0, 192.0),
                circle(100.0, 256.0, 192.0),
                circle(200.0, 256.0, 192.0),
            ],
        ))
        .unwrap();
        assert_eq!(p.objects[0].stack_height, 2);
        assert_eq!(p.objects[1].stack_height, 1);
        assert_eq!(p.objects[2].stack_height, 0);
        // osuhitobject.cs:92: offset = height * scale * -6.4 on both axes
        let offset = 2.0f32 * p.scale * -6.4;
        assert_eq!(
            p.objects[0].stacked_position,
            Vec2::new(256.0 + offset, 192.0 + offset)
        );
        assert_eq!(p.objects[2].stacked_position, Vec2::new(256.0, 192.0));
    }

    #[test]
    fn circles_under_a_slider_end_stack_negatively() {
        // osubeatmapprocessor.cs:168-188 -- circles sitting on the preceding
        // slider's end are pushed down-right instead
        let p = process_beatmap(&map_with(
            14,
            vec![
                slider(0.0, 100.0, 100.0, 100.0),
                circle(400.0, 200.0, 100.0),
                circle(500.0, 200.0, 100.0),
            ],
        ))
        .unwrap();
        assert_eq!(p.objects[0].stack_height, 0);
        assert_eq!(p.objects[1].stack_height, -1);
        assert_eq!(p.objects[2].stack_height, -2);
    }

    #[test]
    fn stack_threshold_truncates_times_like_stable() {
        // osubeatmapprocessor.cs:154-159 -- the circle branch compares
        // (int)startTime - (int)endTime. threshold is 420: the real gap here
        // is 420.09 (not stackable) but the truncated gap is 420 (stackable)
        let p = process_beatmap(&map_with(
            14,
            vec![circle(1000.9, 256.0, 192.0), circle(1420.99, 256.0, 192.0)],
        ))
        .unwrap();
        assert_eq!(p.objects[0].stack_height, 1);
        assert_eq!(p.objects[1].stack_height, 0);

        // one ms later the truncated gap is 421 and the stack breaks
        let p = process_beatmap(&map_with(
            14,
            vec![circle(1000.9, 256.0, 192.0), circle(1421.99, 256.0, 192.0)],
        ))
        .unwrap();
        assert_eq!(p.objects[0].stack_height, 0);
        assert_eq!(p.objects[1].stack_height, 0);
    }

    #[test]
    fn extreme_start_times_do_not_panic_the_truncated_gap_subtraction() {
        // dotnet_double_to_i32_unchecked saturates -3e9 (out of i32 range) to
        // i32::MIN while 1e9 truncates normally to a large positive value.
        // c#'s `(int)a - (int)b` is unchecked and wraps on overflow; an
        // ordinary rust `-` here would panic in a debug build instead. the
        // wrap sends the gap deeply negative (not positive), so the compare
        // against stack_threshold never breaks and this coincident pair
        // stacks exactly like an ordinary in-range pair would
        let p = process_beatmap(&map_with(
            14,
            vec![circle(-3.0e9, 256.0, 192.0), circle(1.0e9, 256.0, 192.0)],
        ))
        .unwrap();
        assert_eq!(p.objects[0].stack_height, 1);
        assert_eq!(p.objects[1].stack_height, 0);
    }

    #[test]
    fn spinners_do_not_participate_in_new_stacking() {
        let p = process_beatmap(&map_with(
            14,
            vec![
                circle(0.0, 256.0, 192.0),
                spinner(50.0),
                circle(200.0, 256.0, 192.0),
            ],
        ))
        .unwrap();
        // the spinner is skipped, so the two circles still stack across it
        assert_eq!(p.objects[0].stack_height, 1);
        assert_eq!(p.objects[1].stack_height, 0);
        assert_eq!(p.objects[2].stack_height, 0);
    }

    #[test]
    fn old_stacking_pushes_heights_upward_from_the_base() {
        // osubeatmapprocessor.cs:224-269 runs for format versions < 6
        let p = process_beatmap(&map_with(
            4,
            vec![
                circle(24.0, 256.0, 192.0),
                circle(124.0, 256.0, 192.0),
                circle(224.0, 256.0, 192.0),
            ],
        ))
        .unwrap();
        assert_eq!(p.objects[0].stack_height, 2);
        assert_eq!(p.objects[1].stack_height, 1);
        assert_eq!(p.objects[2].stack_height, 0);
    }

    #[test]
    fn old_stacking_uses_the_raw_path_end_for_slider_stacks() {
        // osubeatmapprocessor.cs:243-246 -- position2 is Path.PositionAt(1),
        // not the span-aware end position
        let p = process_beatmap(&map_with(
            5, // still old stacking (< 6), no early offset (>= 5)
            vec![
                slider(0.0, 100.0, 100.0, 100.0),
                circle(400.0, 200.0, 100.0),
                circle(500.0, 200.0, 100.0),
            ],
        ))
        .unwrap();
        assert_eq!(p.objects[1].stack_height, -1);
        assert_eq!(p.objects[2].stack_height, -2);
    }

    #[test]
    fn nested_objects_inherit_the_slider_stack_offset() {
        // stackheightbindable propagation (osuhitobject.cs:158-168): every
        // nested object moves with its slider
        let p = process_beatmap(&map_with(
            14,
            vec![
                slider(0.0, 100.0, 100.0, 100.0),
                circle(300.0, 100.0, 100.0), // stacks on the slider head
            ],
        ))
        .unwrap();
        let ProcessedKind::Slider(s) = &p.objects[0].kind else {
            panic!("expected slider")
        };
        assert_eq!(p.objects[0].stack_height, 1);
        let offset = 1.0f32 * p.scale * -6.4;
        assert_eq!(
            p.objects[0].stacked_position,
            Vec2::new(100.0 + offset, 100.0 + offset)
        );
        for nested in &s.nested {
            assert_eq!(
                nested.stacked_position,
                nested.position + Vec2::new(offset, offset)
            );
        }
    }
}
