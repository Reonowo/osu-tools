//! beatmap processing: cs/ar/od derivations, control point timing, slider
//! event generation, combo indexing, stacking. sources cited per module

pub mod difficulty;
pub mod processing;
pub mod slider_events;
pub mod stacking;
pub mod timing;

pub use processing::{
    process_beatmap, NestedKind, NestedObject, ProcessedBeatmap, ProcessedKind, ProcessedObject,
    ProcessedSlider, ProcessedSpinner,
};
