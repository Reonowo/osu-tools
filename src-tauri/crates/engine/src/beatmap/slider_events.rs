//! port of osu.game/rulesets/objects/slidereventgenerator.cs (pin 83b8a64).
//! the LegacyLastTick descriptor is deliberately not emitted: lazer keeps it
//! only for osu!catch conversion (slidereventgenerator.cs:21-23); its -36ms
//! tail leniency reaches the osu! ruleset through TAIL_LENIENCY, which the
//! simulator's tail judgement consumes directly (sliderinputmanager.cs:154)

use crate::error::{resource_limit, Result, EngineError};
use crate::limits;

/// slidereventgenerator.cs:24
pub const TAIL_LENIENCY: f64 = -36.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SliderEventKind {
    Head,
    Tick,
    Repeat,
    Tail,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SliderEvent {
    pub kind: SliderEventKind,
    pub span_index: i32,
    pub span_start_time: f64,
    pub time: f64,
    /// progress along the path measured from the path start, independent of
    /// span direction (slidereventgenerator.cs:148-149)
    pub path_progress: f64,
}

pub fn generate_slider_events(
    start_time: f64,
    span_duration: f64,
    velocity: f64,
    tick_distance: f64,
    total_distance: f64,
    span_count: i32,
) -> Result<Vec<SliderEvent>> {
    if total_distance < 0.0 {
        return Err(EngineError::InvalidArgument(
            "total_distance must be non-negative".to_string(),
        ));
    }
    if span_count < 1 {
        return Err(EngineError::InvalidArgument(
            "span_count must be at least 1; lazer's converter always clamps repeat count >= 1"
                .to_string(),
        ));
    }

    // slidereventgenerator.cs:31-36
    const MAX_LENGTH: f64 = 100_000.0;
    let length = f64::min(MAX_LENGTH, total_distance);
    let tick_distance = tick_distance.clamp(0.0, length);
    let min_distance_from_end = velocity * 10.0;

    let mut events: Vec<SliderEvent> = Vec::new();
    let push = |events: &mut Vec<SliderEvent>, event: SliderEvent| -> Result<()> {
        if events.len() >= limits::MAX_SLIDER_NESTED_OBJECTS {
            return Err(resource_limit(
                "MAX_SLIDER_NESTED_OBJECTS",
                limits::MAX_SLIDER_NESTED_OBJECTS as u64,
                events.len() as u64 + 1,
            ));
        }
        events.push(event);
        Ok(())
    };

    push(&mut events, SliderEvent {
        kind: SliderEventKind::Head,
        span_index: 0,
        span_start_time: start_time,
        time: start_time,
        path_progress: 0.0,
    })?;

    for span in 0..span_count {
        let span_start_time = start_time + span as f64 * span_duration;
        let reversed = span % 2 == 1;

        if tick_distance != 0.0 {
            let tick_start = events.len();
            let mut d = tick_distance;
            while d <= length {
                if d >= length - min_distance_from_end {
                    break;
                }
                let path_progress = d / length;
                let time_progress = if reversed { 1.0 - path_progress } else { path_progress };
                push(&mut events, SliderEvent {
                    kind: SliderEventKind::Tick,
                    span_index: span,
                    span_start_time,
                    time: span_start_time + time_progress * span_duration,
                    path_progress,
                })?;
                d += tick_distance;
            }
            // slidereventgenerator.cs:58-62 -- reversed spans yield ticks in
            // reverse time order, undone here so events stay time-sorted
            if reversed {
                events[tick_start..].reverse();
            }
        }

        if span < span_count - 1 {
            push(&mut events, SliderEvent {
                kind: SliderEventKind::Repeat,
                span_index: span,
                span_start_time,
                time: span_start_time + span_duration,
                path_progress: ((span + 1) % 2) as f64,
            })?;
        }
    }

    let total_duration = span_count as f64 * span_duration;
    push(&mut events, SliderEvent {
        kind: SliderEventKind::Tail,
        span_index: span_count - 1,
        span_start_time: start_time + (span_count - 1) as f64 * span_duration,
        time: start_time + total_duration,
        path_progress: (span_count % 2) as f64,
    })?;

    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits;
    use crate::EngineError;

    fn kinds(events: &[SliderEvent]) -> Vec<SliderEventKind> {
        events.iter().map(|e| e.kind).collect()
    }

    #[test]
    fn single_span_slider_emits_head_ticks_tail() {
        // span duration 1000, velocity 0.02 -> min distance from end 0.2,
        // length 100, tick distance 30 -> ticks at 30, 60, 90
        let events = generate_slider_events(0.0, 1000.0, 0.02, 30.0, 100.0, 1).unwrap();
        assert_eq!(
            kinds(&events),
            vec![
                SliderEventKind::Head,
                SliderEventKind::Tick,
                SliderEventKind::Tick,
                SliderEventKind::Tick,
                SliderEventKind::Tail,
            ]
        );
        assert_eq!(events[0].time, 0.0);
        assert_eq!(events[1].time, 300.0);
        assert_eq!(events[1].path_progress, 0.3);
        assert_eq!(events[3].time, 900.0);
        assert_eq!(events[4].time, 1000.0);
        assert_eq!(events[4].path_progress, 1.0); // span_count % 2
        assert_eq!(events[4].span_index, 0);
    }

    #[test]
    fn min_distance_from_end_culls_the_final_tick() {
        // velocity 5 -> min distance from end 50; length 100, tick distance 30:
        // the tick at 60 survives (60 < 100 - 50 is false -> break), so only
        // the tick at 30 remains (slidereventgenerator.cs:145)
        let events = generate_slider_events(0.0, 20.0, 5.0, 30.0, 100.0, 1).unwrap();
        let ticks: Vec<_> = events.iter().filter(|e| e.kind == SliderEventKind::Tick).collect();
        assert_eq!(ticks.len(), 1);
        assert_eq!(ticks[0].path_progress, 0.3);
    }

    #[test]
    fn repeat_spans_reverse_tick_times_but_not_path_progress() {
        // two spans: span 1 is reversed, so its ticks run from high path
        // progress to low in TIME but are re-reversed into ascending time order
        // (slidereventgenerator.cs:58-62); path progress is always measured
        // from the path start (line 148-149)
        let events = generate_slider_events(0.0, 1000.0, 0.02, 50.0, 100.0, 2).unwrap();
        assert_eq!(
            kinds(&events),
            vec![
                SliderEventKind::Head,
                SliderEventKind::Tick,
                SliderEventKind::Repeat,
                SliderEventKind::Tick,
                SliderEventKind::Tail,
            ]
        );
        // span 0 tick: progress 0.5 at t 500
        assert_eq!(events[1].time, 500.0);
        assert_eq!(events[1].path_progress, 0.5);
        // repeat at span boundary, progress (0+1) % 2 = 1
        assert_eq!(events[2].time, 1000.0);
        assert_eq!(events[2].path_progress, 1.0);
        assert_eq!(events[2].span_index, 0);
        // span 1 tick: progress 0.5, time-reversed -> t = 1000 + (1-0.5)*1000
        assert_eq!(events[3].time, 1500.0);
        assert_eq!(events[3].path_progress, 0.5);
        assert_eq!(events[3].span_index, 1);
        // tail: progress span_count % 2 = 0
        assert_eq!(events[4].time, 2000.0);
        assert_eq!(events[4].path_progress, 0.0);
    }

    #[test]
    fn infinite_tick_distance_yields_no_ticks() {
        // generate_ticks=false paths arrive here as +infinity; the clamp to
        // (0, length) turns it into length and the culling break fires first
        let events = generate_slider_events(0.0, 1000.0, 0.1, f64::INFINITY, 100.0, 1).unwrap();
        assert_eq!(kinds(&events), vec![SliderEventKind::Head, SliderEventKind::Tail]);
    }

    #[test]
    fn zero_tick_distance_yields_no_ticks() {
        // slidereventgenerator.cs:54 guards the tick loop on tickDistance != 0
        let events = generate_slider_events(0.0, 1000.0, 0.1, 0.0, 100.0, 1).unwrap();
        assert_eq!(kinds(&events), vec![SliderEventKind::Head, SliderEventKind::Tail]);
    }

    #[test]
    fn length_is_capped_at_the_lazer_max() {
        // slidereventgenerator.cs:31-33 -- ticks generate over at most 100000
        // distance units even for longer paths
        let events = generate_slider_events(0.0, 1000.0, 0.02, 60_000.0, 150_000.0, 1).unwrap();
        let ticks: Vec<_> = events.iter().filter(|e| e.kind == SliderEventKind::Tick).collect();
        assert_eq!(ticks.len(), 1);
        assert_eq!(ticks[0].path_progress, 0.6); // 60000 / 100000
    }

    #[test]
    fn nested_object_cap_boundary() {
        // tick distance 0.1 over length 100000 declares ~1M ticks; the cap is
        // a policy ceiling (lazer has none) so a crafted file cannot make
        // event generation unbounded. head + ticks at the limit pass, one
        // more tick trips ResourceLimit
        let at_limit_ticks = limits::MAX_SLIDER_NESTED_OBJECTS - 2; // head + tail
        let tick_distance = 100.0 / (at_limit_ticks as f64 + 1.0);
        let events = generate_slider_events(0.0, 1_000_000.0, 1e-9, tick_distance, 100.0, 1).unwrap();
        assert_eq!(events.len(), limits::MAX_SLIDER_NESTED_OBJECTS);

        let tick_distance = 100.0 / (at_limit_ticks as f64 + 2.0);
        match generate_slider_events(0.0, 1_000_000.0, 1e-9, tick_distance, 100.0, 1) {
            Err(EngineError::ResourceLimit { cap: "MAX_SLIDER_NESTED_OBJECTS", .. }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn huge_span_counts_hit_the_cap_instead_of_spinning() {
        // spans each emit a repeat, so a crafted i32::MAX slide count is
        // bounded by the same cap rather than iterating for minutes
        match generate_slider_events(0.0, 1.0, 0.1, 0.0, 100.0, i32::MAX) {
            Err(EngineError::ResourceLimit { cap: "MAX_SLIDER_NESTED_OBJECTS", .. }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn negative_total_distance_rejects() {
        match generate_slider_events(0.0, 1000.0, 0.1, 30.0, -50.0, 1) {
            Err(EngineError::InvalidArgument(msg)) => assert!(msg.contains("non-negative")),
            other => panic!("expected InvalidArgument, got {other:?}"),
        }
    }

    #[test]
    fn zero_span_count_rejects() {
        match generate_slider_events(0.0, 1000.0, 0.1, 30.0, 100.0, 0) {
            Err(EngineError::InvalidArgument(msg)) => assert!(msg.contains("at least 1")),
            other => panic!("expected InvalidArgument, got {other:?}"),
        }
    }

    #[test]
    fn min_span_count_rejects() {
        // i32::MIN would cause overflow on span_count - 1 in debug; the upfront
        // guard prevents this
        match generate_slider_events(0.0, 1000.0, 0.1, 30.0, 100.0, i32::MIN) {
            Err(EngineError::InvalidArgument(msg)) => assert!(msg.contains("at least 1")),
            other => panic!("expected InvalidArgument, got {other:?}"),
        }
    }
}
