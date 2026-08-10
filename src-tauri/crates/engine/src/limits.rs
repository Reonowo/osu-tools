//! hard caps applied at format boundaries. every breach surfaces as
//! `EngineError::ResourceLimit` carrying the constant's name. values are set
//! generously above anything observed in real maps, aspire-tier included;
//! each constant lands alongside the module that enforces it and gets a
//! boundary test (accept at the limit, error just past it).
//!
//! | constant | value | what it guards | boundary test(s) |
//! |---|---|---|---|
//! | [`MAX_OSU_FILE_BYTES`] | 32 MiB | raw `.osu` file byte length, checked in `formats::beatmap::decode_beatmap_bytes` before rosu-map parses anything, and independently in `formats::beatmap::decode_beatmap_path` against the file's declared length *before* the file is read, so the path entry point cannot allocate an oversized buffer on the way to the byte-length check | `formats::beatmap::tests::osu_byte_size_cap_boundary` and `...::osu_byte_size_cap_boundary_through_the_path_entry_point` |
//! | [`MAX_HIT_OBJECTS`] | 500,000 | parsed hit object count, checked in `formats::beatmap::convert` after rosu-map has parsed the file | `formats::beatmap::tests::hit_object_count_cap_boundary` |
//! | [`MAX_SLIDER_CONTROL_POINTS`] | 100,000 | the ceiling for a slider whose every segment is *provably linear*, enforced two different ways at two different times: `formats::beatmap::reject_oversized_slider_paths` is a cheap pre-parse scan over the raw file that counts every declared coordinate token and rejects before rosu-map's curve computation ever runs; `formats::beatmap::convert` then re-checks this cap against rosu-map's actual, deduped control point list, which is the authoritative check for the count as such. the pre-parse scan is deliberately the stricter of the two -- it is a declared-count policy, not an attempt to predict rosu-map's duplicate-point collapsing, so a slider built from many small dedup-friendly segments can be rejected by the pre-parse scan even though its final parsed size would fit comfortably under the cap | `formats::beatmap::tests::slider_control_point_count_cap_boundary` covers the accept-at-limit case, which is the one that actually reaches `convert`; its past-limit case is intercepted by the pre-parse scan first, since `decode_beatmap_bytes` runs that scan before rosu-map. in fact the post-parse *rejection* is unreachable through `decode_beatmap_bytes` at all: rosu-map can only keep or drop declared points, never invent them, so the parsed count is always `<=` the declared count the pre-scan already bounded. it stands as defence in depth for a direct `convert` call. the `precheck_*` tests in the same module exercise the stricter pre-parse policy, including its declared-vs-dedup divergence |
//! | [`MAX_NONLINEAR_SLIDER_CONTROL_POINTS`] | 10,000 | the same pre-parse declared-count policy, but for every slider not proven linear. what it guards differs by family: bezier and b-spline paths (and any perfect curve that is not exactly three points, which `curve.rs:408-414` degrades to `approximate_bezier`) subdivide quadratically in point count, which is the measured hazard; catmull is linear in knots but emits `CATMULL_DETAIL * 2 = 100` vertices per knot (`curve.rs:473`), so at the 100,000 ceiling it would still materialise ~10 million vertices; a well-formed three-point perfect curve is bounded by construction and cannot reach either cap. the 100,000 ceiling above is therefore safe only for the genuinely O(n) linear case. `formats::beatmap::declares_only_linear_segments` decides which applies, mirroring rosu-map's own segment model exactly (first token always types the first segment; later segments start at ascii-alphabetic tokens; a segment is linear iff its leading token's first character is `L`) and failing safe toward this stricter cap | `formats::beatmap::tests::nonlinear_slider_cap_boundary` (accept at the limit, reject past it), `...::a_curved_slider_at_the_linear_cap_is_rejected_before_the_quadratic_parse` (the hazard itself, with a wall-clock assertion), `...::a_coordinate_shaped_first_token_does_not_buy_the_linear_budget` and `...::linear_classification_matches_rosu_maps_first_character_rule` (the classifier), plus the `precheck_*` tests that assert this cap on `B` sliders |
//! | [`MAX_SLIDER_NESTED_OBJECTS`] | 1,000,000 | bounds the slider events (head + ticks + repeats + tail) `beatmap::slider_events` may generate for a single slider. lazer imposes no such cap: tick count is `length / tick_distance` per span and span count is read straight from the file, so a crafted `.osu` can declare a slider whose event generation alone is unbounded (e.g. i32::MAX slides, or a tick distance of 1e-9 -- rosu-map's clamps bound tick distance only through beat length and multiplier, and the 100000 length ceiling still admits ~1e14 ticks at the extreme). real maps, aspire included, sit in the low tens of thousands. this is a policy ceiling, not a parity limit; checked as events are pushed so rejection is O(cap) not O(declared) | `beatmap::slider_events::tests::nested_object_cap_boundary` and `beatmap::slider_events::tests::huge_span_counts_hit_the_cap_instead_of_spinning` |
//! | [`MAX_TOTAL_SLIDER_NESTED_OBJECTS`] | 2,000,000 | the map-wide sum of slider nested objects retained by `beatmap::processing::process_beatmap`. [`MAX_SLIDER_NESTED_OBJECTS`] bounds one slider's events, but every built slider's objects stay resident while the next builds, and a 32 MiB file has room for hundreds of thousands of slider lines whose declared repeat counts each sit just under that per-slider cap -- fresh per-slider budgets alone would let total retention reach tens of GiB and die on allocation instead of returning `ResourceLimit`. charged cumulatively after each slider builds, so the transient overshoot is at most one per-slider cap | `beatmap::processing::tests::total_nested_object_cap_boundary` |
//! | [`MAX_TOTAL_SLIDER_PATH_VERTICES`] | 4,000,000 | the map-wide sum of flattened path vertices retained by `beatmap::processing::process_beatmap`, closing the same aggregate gap for [`MAX_SLIDER_PATH_VERTICES`]: each processed slider retains its full piecewise-linear path (plus a cumulative-length entry per vertex), and many per-slider-cap paths from one file would otherwise accumulate unbounded. charged cumulatively after each slider builds, same overshoot bound as the nested-object cap | `beatmap::processing::tests::total_path_vertex_cap_boundary` |
//! | [`MAX_OSR_FILE_BYTES`] | 32 MiB | raw `.osr` file byte length, checked in `formats::osr::decode_osr` before any framing is parsed | `formats::osr::tests::osr_file_size_cap_boundary` |
//! | [`MAX_LZMA_DECOMPRESSED_BYTES`] | 128 MiB | the lzma-alone replay frame payload's decompressed size, enforced three ways in `formats::osr::decompress_lzma_capped`: a header precheck against the stream's declared uncompressed size, a `CappedWriter` bound on bytes actually produced, and lzma-rs's own `memlimit` guarding its internal dictionary buffer | `formats::osr::tests::lzma_bomb_declared_size_hits_cap` (declared-size precheck), `...::lzma_decompressed_size_cap_boundary` (accept-at-cap via the real decode path, which is also `CappedWriter`'s accept branch), `...::lzma_capped_writer_is_the_sole_guard_for_small_dict_sentinel_streams` (`CappedWriter`'s reject branch, on the one stream shape where neither of the other two layers can fire), `...::lzma_inflated_dict_size_hits_internal_memlimit` (lzma-rs's own memlimit) |
//! | [`MAX_REPLAY_FRAMES`] | 4,000,000 | parsed replay frame count, checked in `formats::osr::parse_actions` | `formats::osr::tests::frame_count_cap_boundary` |
//! | [`MAX_EDIT_BATCH_MEMBERS`] | 4,000,000 (= [`MAX_REPLAY_FRAMES`]) | member count of one `replay::document::ReplayDocument::apply_edit_batch` call, so a legitimate whole-stream edit is never amplification-capped | `replay::document::tests::batch_member_cap_boundary` |
//! | [`MAX_UNDO_DEPTH`] | 1,000 | undo history entries retained per `replay::document::ReplayDocument`; the oldest entry evicts at the cap, and an eviction sets a sticky per-kind dirty flag so a diverged document can never read back as pristine | `replay::document::tests::undo_depth_cap_evicts_the_oldest_and_dirtiness_sticks` |
//! | [`MAX_UNDO_RETAINED_MEMBERS`] | 8,000,000 (= 2 × [`MAX_REPLAY_FRAMES`]) | the member total retained across the undo history's entries, bounding memory where [`MAX_UNDO_DEPTH`] alone cannot: a whole-stream batch or a restore snapshot weighs up to [`MAX_REPLAY_FRAMES`] members on its own, so counting entries admits gigabytes; oldest entries evict past the budget with the same sticky-flag latch, and the entry just pushed never evicts so one over-budget step still lands | `replay::document::tests::undo_history_evicts_by_retained_members_too` and `...::the_newest_entry_survives_a_budget_it_alone_exceeds` |
//! | [`MAX_SIMULATION_SWEEP_STEPS`] | 1,000,000,000 | the total inner-loop steps one `simulation::simulate` run may spend across its per-instant walks: press receptor + note-lock walks, the slider tracking sweep, the drain's per-slider scan, and the spinner rotation sweep. per-instant cost is proportional to the born, unresolved span, which lazer pays too -- but lazer's update count is human-bounded while this one is file-bounded ([`MAX_REPLAY_FRAMES`] admits millions of crafted instants over [`MAX_HIT_OBJECTS`] simultaneous objects, products in the trillions). `simulate` passes the constant into the budget-parameterized runner and the walks charge a shared counter, checked after each frame entry and deadline group so the overshoot is bounded by one instant's walks; like [`MAX_SLIDER_PATH_VERTICES`], tests supply a tighter budget through the parameterized entry point | `simulation::tests::sweep_step_budget_boundary` |
//! | [`MAX_OSR_SERIALIZED_PAYLOAD_BYTES`] | 128 MiB | uncompressed frame text `formats::osr::serialize_actions` produces when `encode_osr` is asked to reserialize (as opposed to passing through the original verbatim compressed payload), checked incrementally as that text is written and before compression is attempted, so an oversized crafted file fails fast without first materialising the whole string or paying for a wasted lzma pass | `formats::osr::tests::reserialized_payload_size_cap_boundary` |
//! | [`MAX_SLIDER_PATH_VERTICES`] | 2,000,000 | the piecewise-linear vertex count of a slider's path, enforced at two layers: per-segment inside `path::approximator` (every approximator function takes it as an explicit `max_vertices` parameter rather than reading the constant directly, so a segment alone can never exceed it) and cross-segment inside `path::slider_path::SliderPath`'s path calculation, which accumulates vertices across all of a slider's segments even when every individual segment stayed under budget on its own | `path::approximator::tests::slider_path_vertex_count_cap_boundary` exercises the per-segment layer; `tests/slider_path_fixtures.rs`'s `vertex_budget_surfaces_as_resource_limit` and `cross_segment_vertex_budget_boundary` exercise the cross-segment accumulation layer specifically (the latter proves the cap by a segment combination no single segment could trip on its own) |
//! | [`MAX_BEZIER_SUBDIVISION_DEPTH`] | 256 | how deep `path::approximator`'s bezier/b-spline subdivision may recurse before a curve is declared non-convergent. this is the only work loop in the crate whose termination is not implied by an output-size cap: a curve that never flattens produces no vertices at all, so `MAX_SLIDER_PATH_VERTICES` never fires and the working stack, not the output, is what grows | `path::approximator::tests::bezier_subdivision_depth_cap_boundary` (exact accept-at-limit/reject-past-limit on a curve with an analytically known depth) and `...::bezier_tolerates_nan_and_infinite_coordinates_without_panicking` (the non-convergent curve family the cap exists for) |
//! | [`MAX_BSPLINE_KNOT_INSERTION_OPS`] | 50,000,000 | the work `path::approximator`'s b-spline path spends converting a spline to bezier segments (Boehm's algorithm) *before* it produces any vertex, which is therefore upstream of [`MAX_SLIDER_PATH_VERTICES`] and driven by the degree rather than the point count. the same site also charges the intermediate points it is about to allocate against the caller's vertex budget, so time and memory are bounded separately | `path::approximator::tests::knot_insertion_op_cap_boundary` (exact accept-at-limit/reject-past-limit through the capped entry point), `...::a_high_degree_spline_is_caught_by_the_op_cap_not_the_point_charge` (the few-segments/huge-degree shape only this cap catches), `...::a_mid_range_explicit_degree_cannot_run_unbounded_knot_insertion` (the complementary shape, caught by the point charge), `...::ordinary_low_degree_b_splines_are_unaffected_by_the_knot_insertion_cap` and `...::max_bspline_knot_insertion_ops_constant_matches_limits_module` |

pub const MAX_OSU_FILE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_HIT_OBJECTS: usize = 500_000;

/// bounds a slider two different ways, at two different times. `formats::beatmap`'s pre-parse
/// scan counts every token in a slider's curve field whose first two `:`-separated parts are both
/// numbers (plus the head) and rejects a slider that *declares* more than this many points, before
/// rosu-map ever parses or dedups anything. the post-parse check in the same module then re-checks this cap against
/// rosu-map's actual, deduped control point list -- that second check is the authoritative one.
/// the pre-parse scan is deliberately the stricter of the two: it is a declared-count policy, not
/// an attempt to predict rosu-map's duplicate-point collapsing, so a slider built from many small
/// dedup-friendly segments can be rejected by the pre-parse scan even though its final parsed size
/// would fit comfortably under this same cap.
pub const MAX_SLIDER_CONTROL_POINTS: usize = 100_000;

/// the same declared-point policy as [`MAX_SLIDER_CONTROL_POINTS`], but for any slider that is
/// not *provably* linear. rosu-map computes each slider's curve eagerly while parsing, and what
/// that costs depends on the family:
///
/// - bezier and b-spline subdivide quadratically in point count. so does a perfect curve that
///   is not exactly three points, since `curve.rs:408-414` degrades it to `approximate_bezier`
/// - catmull is linear in knots, but emits `CATMULL_DETAIL * 2 = 100` vertices per knot
///   (`curve.rs:473`) -- at 100,000 points that is ~10 million vertices, which is worth
///   refusing on its own even though it is not quadratic
/// - a well-formed three-point perfect curve takes the circular-arc path and is bounded by
///   construction; it cannot approach either cap
///
/// so [`MAX_SLIDER_CONTROL_POINTS`] is a safe ceiling only for the genuinely O(n) linear case.
///
/// measured on this machine against rosu-map 0.2.1, distinct (non-dedupable) control points,
/// timing `decode_beatmap_bytes` on a single `B` slider:
///
/// | points | release | debug |
/// |---|---|---|
/// | 4,000 | 2.8 ms | 81 ms |
/// | 8,000 | 10 ms | 346 ms |
/// | 16,000 | 36 ms | 1.16 s |
/// | 32,000 | 141 ms | 4.59 s |
/// | 99,999 | 1.31 s | ~45 s (extrapolated) |
///
/// clean quadratic: each doubling of the point count quadruples the time. at the 100,000 cap a
/// *single* such slider costs over a second in release, and a 32 MiB file (see
/// [`MAX_OSU_FILE_BYTES`]) has room for roughly 45 of them -- about a minute of parsing in
/// release and well over half an hour in debug, from a file the caps otherwise accept. the
/// existing boundary test at `formats::beatmap::tests::slider_control_point_count_cap_boundary`
/// documents this hazard in passing: it deliberately builds its at-cap slider as `L`, noting
/// that a `B` of the same size would hang the test.
///
/// 10,000 sits roughly 30x above the largest control-point counts real beatmaps contain,
/// aspire-tier included, while cutting the worst-case aggregate parse cost by an order of
/// magnitude (worst-case total work is proportional to file bytes times this cap, so lowering
/// it lowers the ceiling proportionally). the guard fails safe: the strict cap applies unless
/// every path-type letter in the curve field is `L`, so an unrecognized, absent, or compound
/// path type gets the strict cap rather than the generous one.
///
/// this is a policy ceiling, not a parity limit -- lazer itself imposes none. a generated map
/// with a >10,000-point curved slider decodes in lazer and is refused here; raise this constant
/// if such a file ever needs to open
pub const MAX_NONLINEAR_SLIDER_CONTROL_POINTS: usize = 10_000;

/// bounds the slider events (head + ticks + repeats + tail) `beatmap::slider_events`
/// may generate for a single slider. lazer imposes no such cap: tick count is
/// `length / tick_distance` per span and span count is read straight from the
/// file, so a crafted `.osu` can declare a slider whose event generation alone
/// is unbounded (e.g. i32::MAX slides, or a tick distance of 1e-9 -- rosu-map's
/// clamps bound tick distance only through beat length and multiplier, and the
/// 100000 length ceiling still admits ~1e14 ticks at the extreme). real maps,
/// aspire included, sit in the low tens of thousands. this is a policy
/// ceiling, not a parity limit; checked as events are pushed so rejection is
/// O(cap) not O(declared)
pub const MAX_SLIDER_NESTED_OBJECTS: usize = 1_000_000;

/// the map-wide companion to [`MAX_SLIDER_NESTED_OBJECTS`]: that cap bounds
/// one slider's event generation, but `beatmap::processing::process_beatmap`
/// retains every built slider's nested objects while the next one builds, and
/// a repeat count is a handful of file bytes -- a 32 MiB file can declare
/// hundreds of thousands of sliders each sitting just under the per-slider
/// cap, so fresh per-slider budgets alone admit tens of GiB of retention and
/// an allocation abort instead of a `ResourceLimit`. charged cumulatively as
/// sliders build (the per-slider cap bounds the transient overshoot to one
/// slider's worth). 2x the per-slider ceiling keeps every real map, aspire
/// included (low tens of thousands of nested objects map-wide), two orders of
/// magnitude clear, while bounding worst-case retention near 100 MiB
pub const MAX_TOTAL_SLIDER_NESTED_OBJECTS: usize = 2_000_000;

/// the same aggregate concern for [`MAX_SLIDER_PATH_VERTICES`]: each
/// processed slider retains its flattened path (vertices plus a
/// cumulative-length f64 per vertex), and a curved slider needs only
/// [`MAX_NONLINEAR_SLIDER_CONTROL_POINTS`] declared points -- well under 100
/// KiB of file -- to reach the per-slider vertex cap, so one file can retain
/// many such paths at once. charged cumulatively alongside the nested-object
/// budget, same transient overshoot bound. real maps keep total path
/// vertices in the tens of thousands; 2x the per-slider ceiling bounds
/// worst-case retention near 64 MiB while staying far above anything real
pub const MAX_TOTAL_SLIDER_PATH_VERTICES: usize = 4_000_000;

pub const MAX_OSR_FILE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_LZMA_DECOMPRESSED_BYTES: u64 = 128 * 1024 * 1024;
pub const MAX_REPLAY_FRAMES: usize = 4_000_000;

/// most members one edit batch may carry. a legitimate whole-stream snap or
/// smooth touches every frame, so the cap prevents amplification, not scale;
/// enforced by `replay::document::ReplayDocument::apply_edit_batch`
pub const MAX_EDIT_BATCH_MEMBERS: usize = MAX_REPLAY_FRAMES;

/// undo history entries retained per document. the oldest entry evicts at
/// the cap, which strands nothing: `revert_all` restores the retained
/// pristine baseline directly rather than walking the stack
pub const MAX_UNDO_DEPTH: usize = 1_000;

/// the member total retained across the undo history's entries, bounding
/// memory where the entry-count cap cannot: a whole-stream batch or a
/// restore snapshot weighs up to [`MAX_REPLAY_FRAMES`] members by itself, so
/// [`MAX_UNDO_DEPTH`] entries could otherwise retain gigabytes. twice the
/// frame cap keeps at least one worst-case step plus headroom (the entry
/// just pushed never evicts, so an over-budget step still lands); the redo
/// stack holds at most what the undo history previously retained, so the
/// combined retention bound is twice this again
pub const MAX_UNDO_RETAINED_MEMBERS: usize = 2 * MAX_REPLAY_FRAMES;

/// bounds the total inner-loop steps one `simulation::simulate` run may
/// spend across its per-instant walks: the press receptor and note-lock
/// walks, the slider tracking sweep, the nested-object drain's per-slider
/// scan, and the spinner rotation sweep. each walk's per-instant cost is
/// proportional to the born, unresolved object span -- the same shape as
/// lazer's own per-update work over its alive drawables -- but lazer's
/// update count is bounded by a human playing in real time, while this
/// one is bounded only by the file: [`MAX_REPLAY_FRAMES`] admits millions
/// of crafted frame instants (and press edges) and [`MAX_HIT_OBJECTS`]
/// admits hundreds of thousands of simultaneously-live objects, products
/// in the trillions from cap-compliant input. the walks charge a shared
/// counter and `simulate`'s instant loop checks it after each frame entry
/// and each deadline group, so the overshoot past the budget is bounded by
/// one instant's walks over one object span. real replays sit orders of
/// magnitude below: instants in the hundreds of thousands times live spans
/// in the tens, with even 2b-style simultaneous-object maps reaching only
/// the hundreds of millions. like [`MAX_SLIDER_PATH_VERTICES`], the budget
/// is a parameter of the internal runner so tests can supply a tighter
/// one; the public `simulate` passes this constant
pub const MAX_SIMULATION_SWEEP_STEPS: u64 = 1_000_000_000;

/// bounds the uncompressed frame text `formats::osr::serialize_actions` produces
/// when `encode_osr` is asked to reserialize (as opposed to passing through the
/// original verbatim compressed payload). the two cursor coordinates are range-checked
/// against lazer's own `Parsing.MAX_COORDINATE_VALUE`, but `delta` and `z` deliberately are
/// not, so a crafted `.osr` can still carry frames whose formatted text is much longer than
/// their compact source tokens.
/// `format_dotnet_f32` matching .net's own fixed/scientific notation switch
/// already keeps that inflation small (a few bytes per field even at extreme
/// magnitudes, instead of dozens of positional digits), but this cap is the
/// hard backstop regardless: it mirrors `MAX_LZMA_DECOMPRESSED_BYTES`, since a
/// legitimate reserialized replay should never need to be materially larger
/// than what a legitimate decode would have produced, and a real replay's
/// serialized text sits nowhere near it (a maximal `MAX_REPLAY_FRAMES` reserialize
/// of ordinary playfield-range coordinates lands in the tens of MiB). the cap is
/// enforced *while* the frame text is written, not after it exists, and before
/// compression is attempted: `MAX_REPLAY_FRAMES` bounds decoding only, so a
/// hand-built `OsrFile` that never went through a decode can carry an unbounded
/// action list, and measuring the finished string would mean allocating all of
/// it (many GiB for a crafted list) purely to reject it
pub const MAX_OSR_SERIALIZED_PAYLOAD_BYTES: u64 = 128 * 1024 * 1024;

/// per-slider budget on the piecewise-linear vertices `path::approximator` produces.
/// every approximator function takes this as an explicit `max_vertices` parameter rather
/// than reading the constant directly, so callers (and tests) can supply a tighter budget;
/// production call sites pass this constant.
pub const MAX_SLIDER_PATH_VERTICES: usize = 2_000_000;

/// how deep `path::approximator`'s bezier/b-spline subdivision may recurse before the
/// curve is declared non-convergent and rejected. every other loop in the crate is bounded
/// by the size of what it produces; this one is not, because a curve that never satisfies
/// `bezier_is_flat_enough` emits no vertices at all -- [`MAX_SLIDER_PATH_VERTICES`] is
/// checked only where a flattened leaf appends to the output, so a curve with no leaves
/// never reaches it while the working stack grows by one entry per iteration, forever.
/// this is reachable: the flatness test compares f32 second differences, and for extreme
/// control-point magnitudes (roughly `|coord| >= 1e10`, patchily -- it is a float
/// fixed-point condition, not a monotonic threshold) the `(r[j] + r[j+1]) / 2` midpoint
/// recurrence reaches a fixed point at which subdivision stops changing the control
/// polygon, so the second-difference test is permanently false. `.osu` input cannot get
/// there (rosu-map rejects curve coordinates outside +-131,072), but the hand-built
/// `path::SliderPath`/`PathControlPoint` API the crate docs cover explicitly can.
///
/// depth is the right quantity to bound rather than the vertex count or the raw iteration
/// count, because it is the one with a small, provable ceiling for every curve that
/// converges at all: de Casteljau subdivision at t = 0.5 scales a control polygon's second
/// differences by exactly 1/4 per level, so a curve whose largest second difference starts
/// at f32's maximum finite magnitude needs `log4(3.4e38 / 0.5)` ~= 66 levels to reach the
/// `BEZIER_TOLERANCE` threshold, and no f32 curve can need more even in exact arithmetic.
/// convergence is therefore effectively binary -- a couple of dozen levels, or never -- and
/// this cap sits far above the "converges" side while catching the "never" side in a few
/// hundred cheap iterations. measured, not assumed: the entire golden fixture corpus
/// flattens at depth 9, head-relative control-point extremes of +-262,144 (the widest a
/// `.osu` file can express) need 11, and a sweep of quadratic and cubic curves across every
/// power of ten from 1e0 to 1e38 tops out at 14 before the f32 fixed point takes over
/// entirely somewhere between 1e6 and 1e8. that leaves ~28x headroom over the corpus and
/// ~4x over the exact-arithmetic ceiling. bounding depth also keeps the pathological case's
/// peak working set small, since the stack holds one `degree + 1` buffer per level
pub const MAX_BEZIER_SUBDIVISION_DEPTH: usize = 256;

/// bounds the knot-insertion pass `path::approximator`'s b-spline path runs *before* it
/// produces a single vertex. Boehm's algorithm converts a degree-`d` b-spline over `n`
/// control points into `n - d` bezier segments, materialising `(n - d) * (d + 1)` points and
/// performing about `(n - d) * d^2 / 2` operations to do it -- all of it upstream of
/// [`MAX_SLIDER_PATH_VERTICES`], which only ever sees the vertices that come out the far end.
///
/// the gap that leaves is reachable from ordinary input. an explicit degree is spelled
/// directly in a `.osu` curve field (`B5000|...` parses as `PathType::BSpline(5000)`), and a
/// 10,000-point `B5000` slider sits comfortably under
/// [`MAX_NONLINEAR_SLIDER_CONTROL_POINTS`] while materialising ~25 million intermediate
/// points and running 62,475,002,500 inner-loop iterations. neither the file-size cap nor the
/// point caps can see that: the cost is driven by the *degree*, which none of them constrain.
///
/// the two checks in `b_spline_to_bezier_internal` bound the two different resources this
/// spends. materialised points -- `(segments + 1) * (degree + 1)`, the loop's output plus the
/// tail remainder -- are charged against the caller's vertex budget, being the same kind of
/// allocation in the same order of magnitude; the work gets this constant. the counter used
/// against it is the loose `segments * degree^2` rather than the exact
/// `segments * (degree - 1) * degree / 2` the loop performs, so it reads roughly twice the
/// truth (1.25e11 against the 6.25e10 above for that slider) -- over-charging is the safe
/// direction for a guard. 50 million is a small fraction of a second, and real slider degrees
/// are single digits (lazer's editor builds them at degree 4, `SliderPlacementBlueprint.cs:62`),
/// so a legitimate path lands orders of magnitude below: a 10,000-point `B3` slider counts about
/// 90,000
pub const MAX_BSPLINE_KNOT_INSERTION_OPS: u64 = 50_000_000;
