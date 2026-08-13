// the timeline dock's middle tier: a zoomable span centred on the playhead
// (task 14's overview strip always maps the whole replay; this tier zooms).
// like the overview strip, this is a continuous consumer (decision 6) -- one
// rAF loop reads playbackClock and writes straight to dom refs, never
// through react state. the twist here is that even the *set of marks to
// draw* is continuous (objects, tethers and key/mouse holds scroll past as
// the window slides), and re-rendering react for every one of them would be as
// bad as re-rendering on every clock tick. the neighbourhood scheme below is
// what keeps both under control: see the comment above the rAF effect
//
// the neighbourhood doubles as the lanes' coordinate system. every mark,
// span, ruler tick and the velocity trace is placed once, at slice time, in
// neighbourhood-relative percentages, and the loop moves the whole lot with
// one transform on their shared layer. they used to be positioned one by one
// in window-relative percent on every tick, so each rounded to device pixels
// on its own -- at the default 20s span one replay frame is about 1px, which
// is where a span's two edges start stepping in opposite directions and the
// lanes look like they stall and then jump backwards

import {
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent
} from "react";
import { frameEditGate } from "@/editor/gate";
import { CLICK_SLOP_SCREEN_PX } from "@/editor/gesture-controller";
import { pressRunCommit } from "@/editor/press-commits";
import { pressDrag, type PressDragEffects, type PressDragPreview } from "@/editor/press-drag";
import { expandRetimePress, type PressEdit } from "@/editor/press-ops";
import { pressRunAt, pressRunFromIndex } from "@/editor/press-runs";
import { pressLabel } from "@/editor/tool-commits";
import { physicalButton, PHYSICAL_BUTTONS, type PhysicalKey } from "@/engine/buttons";
import { holdSpansFlat, sliceSpansFlat } from "@/engine/interpolation";
import { velocityTraceWindow, type VelocitySample } from "@/lib/analysis";
import type { ObjectLaneEntry } from "@/lib/derive";
import { formatTime } from "@/lib/format";
import type { FrameDto, RenderObject } from "@/lib/scene-types";
import { audioExtendedBounds, type TimeBounds } from "@/lib/timeline";
import {
	clampSpan,
	laneTimeAtPixel,
	laneTransform,
	rulerTicks,
	timeToPixels,
	windowAround,
	windowFraction,
	type TimeWindow
} from "@/lib/timeline-view";
import { frameCursor } from "@/playback/frame-cursor";
import { playbackClock } from "@/playback/instance";
import { useViewerStore, viewerStore } from "@/state/store";
import { objectLaneClick } from "./object-lane-click";
import { ObjectLane } from "./ObjectLane";
import { Playhead, playheadTransform } from "./Playhead";
import { useTrackMetrics } from "./use-track-metrics";

// the pre-rendered neighbourhood is 3x the visible span (1.5x each side) --
// generous enough that ordinary playback and zooming can move the window a
// good while before a re-slice is needed
const NEIGHBOURHOOD_FACTOR = 3;

// the velocity row's per-slice resolution: one bucket per svg viewBox unit
// across the neighbourhood (the row's polyline viewBox is 600 units wide),
// so the trace resolves with the zoom instead of inheriting the analysis
// panel's whole-replay sample spacing
const VELOCITY_LANE_BUCKETS = 600;

// the *window's* tick target. rulerTicks(view, n) picks the smallest "nice"
// interval >= span/n, so scaling this by the neighbourhood's width in windows
// lands on the interval the window alone would have chosen -- the ruler reads
// at one density however the slice happens to sit
const RULER_TICK_TARGET = 5;

// a hard cap on mounted tick nodes, not merely a pool size: rulerTicks falls
// back to its coarsest step once the ideal interval outgrows its table, so an
// hours-long span would otherwise mount thousands of ticks. the window's own
// count is bounded at 6 (span/interval <= 5, plus the closing tick) and 8 left
// headroom over that; the neighbourhood is NEIGHBOURHOOD_FACTOR windows wide,
// so the same headroom scales with it
const RULER_TICK_POOL = 8 * NEIGHBOURHOOD_FACTOR;

type BitKey = "k1" | "k2" | "m1" | "m2";
// physical keys, not raw bits -- a keyboard tap must light the K1 lane
// alone, never K1 and M1 together (buttons.ts's PHYSICAL_BUTTONS)
const HOLD_ORDER: readonly BitKey[] = PHYSICAL_BUTTONS.map((button) => button.edgesKey);

/** px around a span edge where a pointer-down grabs that edge alone */
const EDGE_ZONE_PX = 5;

// the lane rows' pixel stack, top of the layer down: ruler, object lane,
// K1/K2/M1/M2, velocity. the extended tether draws across rows and needs
// these offsets; keep them in lockstep with the row classNames below
const RULER_ROW_PX = 17;
const OBJECT_ROW_PX = 17;
const HOLD_ROW_PX = 13;
/** the at-rest tether hairline's y within the layer: 2px up from the object
 * row's bottom edge */
const TETHER_REST_Y_PX = RULER_ROW_PX + OBJECT_ROW_PX - 3;

function holdRowCentreY(bit: BitKey): number {
	const rowTop = RULER_ROW_PX + OBJECT_ROW_PX + HOLD_ORDER.indexOf(bit) * HOLD_ROW_PX;
	return rowTop + Math.floor(HOLD_ROW_PX / 2);
}

// spans are retained per scene in holdSpansFlat's pair-packed form so a
// capped multi-million-frame replay pins one Float64Array per bit instead of
// millions of span objects; only the slice around the neighbourhood below
// materializes objects, and that is at most a handful of screens' worth
function holdsForScene(frames: readonly FrameDto[]): Record<BitKey, Float64Array> {
	const result = {} as Record<BitKey, Float64Array>;
	for (const button of PHYSICAL_BUTTONS) result[button.edgesKey] = holdSpansFlat(frames, button.is);
	return result;
}

// x = the sample's time position across the pre-rendered neighbourhood (unlike
// AnalysisPanel's whole-replay chart, which places samples by index share --
// this lane must track the playhead, not the replay as a whole). y = the
// sample's share of the replay's peak velocity, so the trace reads at a
// consistent scale as the window slides rather than auto-scaling to look
// maxed-out during slow segments. samples arrive already resampled to this
// slice (velocityTraceWindow), straddling each edge by one pair, so the end
// points may map slightly outside the 0..600 viewBox -- the svg clips them
function velocityPoints(samples: readonly VelocitySample[], peak: number, view: TimeWindow): string | null {
	if (peak <= 0 || samples.length === 0) return null;
	return samples
		.map((s) => {
			const x = windowFraction(view, s.time) * 600;
			const y = 34 - Math.min(1, Math.max(0, s.velocity / peak)) * 34;
			return `${x.toFixed(2)},${y.toFixed(2)}`;
		})
		.join(" ");
}

export function DetailLanes() {
	const scene = useViewerStore((s) => s.scene);
	const derived = useViewerStore((s) => s.derived);
	const audioDurationMs = useViewerStore((s) => s.audioDurationMs);
	const detailSpanMs = useViewerStore((s) => s.detailSpanMs);
	const mode = useViewerStore((s) => s.mode);
	const pressSelection = useViewerStore((s) => s.editor?.pressSelection ?? null);
	const panelOpen = useViewerStore((s) => s.panelOpen);
	const panelTab = useViewerStore((s) => s.panelTab);
	/** the persisted per-layer visibility (settings.rs TimelinePrefs). the
	 * extended tether is selection chrome and deliberately not gated by it */
	const timeline = useViewerStore((s) => s.timeline);
	/** the live drag's frame-snapped outcome, drawn in place of the spans it
	 * replaces -- local dom state, never the store or the pixi chrome */
	const [dragPreview, setDragPreview] = useState<PressDragPreview | null>(null);
	/** the lane gesture's frozen inversion: view, transform, and box are
	 * captured at pointer-down so a mid-drag re-slice cannot re-aim it */
	const laneGestureRef = useRef<{ pointerId: number; toTime: (e: { clientX: number }) => number } | null>(null);

	// AppShell (and so TimelineDock) only mounts once App.tsx has a loaded
	// scene, and mode only reaches "edit" with one loaded -- these fallbacks
	// just keep the hooks below well-typed against the store's nullable
	// fields, matching TopBar's own convention, not a real null-scene path
	const bounds: TimeBounds = audioExtendedBounds(derived?.bounds ?? { minTime: 0, maxTime: 1 }, audioDurationMs);
	const peakVelocity = derived?.analysis.peakVelocity ?? 0;

	// per-scene source lists: independent of the zoom window, recomputed only
	// when a new scene installs (scene's reference changes 1:1 with sceneId,
	// since store.install() sets both together)
	const holds = useMemo(() => holdsForScene(scene?.frames ?? []), [scene]);

	// the hit-window band background, one per-scene gradient shared by every
	// aimable object: three nested bands (meh, ok, great) centred where the
	// press should land, in the same hit colours the grades use. the widths
	// are per-scene constants off the render plan, so the stop positions are
	// computed once; the bands draw always and are allowed to be sub-pixel at
	// coarse zoom -- resolving with zoom is the intended behaviour, and no
	// bands draw on a NotSimulated scene
	const hitWindowBand = useMemo(() => {
		if (scene === null || scene.simulation.status !== "authoritative") return null;
		const windows = scene.renderPlan.hitWindows;
		if (!(windows.meh > 0)) return null;
		const stop = (ms: number) => `${((ms / (2 * windows.meh)) * 100).toFixed(3)}%`;
		const meh = "#ffcc2226";
		const ok = "#88b30038";
		const great = "#66ccff52";
		// the gradient spans ±meh; each stop is where one band hands over to
		// the next, early (left) side then late (right) side
		const earlyOkStop = stop(windows.meh - windows.ok);
		const earlyGreatStop = stop(windows.meh - windows.great);
		const lateGreatStop = stop(windows.meh + windows.great);
		const lateOkStop = stop(windows.meh + windows.ok);
		return {
			mehMs: windows.meh,
			background: `linear-gradient(to right, ${meh} 0 ${earlyOkStop}, ${ok} ${earlyOkStop} ${earlyGreatStop}, ${great} ${earlyGreatStop} ${lateGreatStop}, ${ok} ${lateGreatStop} ${lateOkStop}, ${meh} ${lateOkStop} 100%)`
		};
	}, [scene]);

	// the selected press, resolved to its run for the lane highlight and the
	// tether's extended state. edit mode only -- watch mode's lanes keep
	// their observational look -- and only while the sidebar is open on the
	// keypress tab: the highlight is that panel's presence on the timeline,
	// and a brightened span with no visible owner reads as a glitch. hide,
	// not clear -- the selection itself stays in the store, so reopening the
	// panel restores it exactly. (the drag preview below is gesture state and
	// never gates on the panel, and the viewport's frame-selection chrome is
	// tool-owned elsewhere)
	const selectedHighlight = useMemo(() => {
		if (mode !== "edit" || !panelOpen || panelTab !== "keys") return null;
		if (scene === null || pressSelection === null) return null;
		const run = pressRunFromIndex(scene.frames, pressSelection.key, pressSelection.startIndex);
		if (run === null) return null;
		return {
			bit: physicalButton(pressSelection.key).edgesKey,
			key: pressSelection.key,
			startIndex: run.startIndex,
			fallIndex: run.fallIndex,
			startTime: run.startTime,
			endTime: run.endTime
		};
	}, [mode, panelOpen, panelTab, scene, pressSelection]);

	// sliceEpochRef is the counter of record, bumped synchronously by the rAF
	// loop the instant the playhead threatens to outgrow the pre-rendered
	// neighbourhood; sliceEpoch (state) exists only so that bump can ask react
	// for a render -- the loop itself never waits on it (see the rAF effect)
	const sliceEpochRef = useRef(0);
	const [sliceEpoch, setSliceEpoch] = useState(0);

	// the pre-rendered neighbourhood: ±1.5x the visible span around the
	// playhead. reads the clock directly rather than any store state -- this
	// is exactly the "continuous time" snapshot the clock exists to serve,
	// same as the steady-state per-frame reads in the rAF loop below
	const neighbourhood = useMemo(
		() => windowAround(bounds, playbackClock.currentTime(), detailSpanMs * NEIGHBOURHOOD_FACTOR),
		// sliceEpoch is a synthetic dependency: bumping it is how the rAF loop
		// asks for a fresh slice without going through react state for the
		// window itself
		[scene, bounds.minTime, bounds.maxTime, detailSpanMs, sliceEpoch]
	);

	// the *requested* neighbourhood, which is not the same thing as the one on
	// screen: the loop sets this the instant it asks for a re-slice, one or
	// more frames before react commits the marks for it. only the re-slice
	// guard reads it -- drawing uses the committed `neighbourhood`, or the
	// layer would move to the new slice's offset while the old slice's marks
	// were still mounted, which is the jump this tier is supposed to have lost
	const requestedNeighbourhoodRef = useRef<TimeWindow>(neighbourhood);
	useLayoutEffect(() => {
		requestedNeighbourhoodRef.current = neighbourhood;
	}, [neighbourhood]);

	// the object lane's slice: render objects with their derived entries,
	// index-aligned by construction (derive.ts). padded by the miss window so
	// a hit-window band or tether poking into the neighbourhood from a
	// just-outside object still draws at extreme zoom
	const slicedObjects = useMemo(() => {
		if (scene === null || derived === null) return [];
		const objects = scene.renderPlan.objects;
		const pad = scene.renderPlan.hitWindows.miss;
		const sliced: { index: number; object: RenderObject; entry: ObjectLaneEntry }[] = [];
		for (let index = 0; index < objects.length; index++) {
			const object = objects[index];
			if (object.endTime < neighbourhood.start - pad || object.startTime > neighbourhood.end + pad) continue;
			sliced.push({ index, object, entry: derived.objectLane[index] });
		}
		return sliced;
	}, [scene, derived, neighbourhood]);

	// the tether whose extended state is showing: the visible object judged
	// by the selected press. shares selectedHighlight's keys-tab gate exactly
	// -- the extension is selection chrome, hidden (not cleared) with the
	// panel. containment over frame indices rather than times: duplicate-time
	// frames can pack a release and re-press into one millisecond, where two
	// distinct runs share the tether's toTime and only the rise frame's index
	// says which run the judging press belongs to
	const tetherExtension = useMemo(() => {
		if (selectedHighlight === null) return null;
		for (const { entry } of slicedObjects) {
			const tether = entry.tether;
			if (tether === null || tether.key !== selectedHighlight.key) continue;
			if (
				tether.pressFrameIndex >= selectedHighlight.startIndex &&
				tether.pressFrameIndex < selectedHighlight.fallIndex
			) {
				return tether;
			}
		}
		return null;
	}, [slicedObjects, selectedHighlight]);
	const slicedHolds = useMemo(() => {
		// one lane pixel of the neighbourhood, the merge quantum sliceSpansFlat
		// coalesces below -- sub-pixel gaps cannot render distinctly, and the
		// quantum is what bounds a duplicate-time span flood to a drawable count
		const mergeGap = (neighbourhood.end - neighbourhood.start) / 4096;
		const slice = (flat: Float64Array) => sliceSpansFlat(flat, neighbourhood.start, neighbourhood.end, mergeGap);
		return { k1: slice(holds.k1), k2: slice(holds.k2), m1: slice(holds.m1), m2: slice(holds.m2) };
	}, [holds, neighbourhood]);

	const rulerMajors = useMemo(() => {
		// the target scales by how many windows wide the neighbourhood *actually*
		// is rather than by NEIGHBOURHOOD_FACTOR flat: near the ends of a short
		// replay the neighbourhood is clamped and the two are almost the same
		// window, where a flat 3x would triple the ruler's density
		const windowsWide = (neighbourhood.end - neighbourhood.start) / clampSpan(bounds, detailSpanMs);
		return rulerTicks(neighbourhood, RULER_TICK_TARGET * windowsWide).slice(0, RULER_TICK_POOL);
	}, [neighbourhood, bounds.minTime, bounds.maxTime, detailSpanMs]);
	// minors sit halfway between each pair of majors
	const rulerMinors = useMemo(
		() => rulerMajors.slice(0, -1).map((tick, i) => (tick + rulerMajors[i + 1]) / 2),
		[rulerMajors]
	);
	// the lane's own per-slice resample of the frame stream. the analysis
	// panel's whole-replay trace is far too coarse here: a long replay left a
	// slice only a handful of its VELOCITY_SAMPLES points and none near the
	// slice's leading edge, so the line visibly cut off ahead of the playhead
	// until the next re-slice. the peak stays the whole-replay figure so the
	// scale does not breathe between slices
	const velocitySamples = useMemo(
		() =>
			scene === null
				? []
				: velocityTraceWindow(scene.frames, neighbourhood.start, neighbourhood.end, VELOCITY_LANE_BUCKETS),
		[scene, neighbourhood]
	);
	const velocityTrace = useMemo(
		() => velocityPoints(velocitySamples, peakVelocity, neighbourhood),
		[velocitySamples, peakVelocity, neighbourhood]
	);

	const track = useTrackMetrics();
	const laneLayerRef = useRef<HTMLDivElement>(null);
	const playheadRef = useRef<HTMLDivElement>(null);

	// the single rAF loop for the whole lane group. it restarts (cheap: a few
	// times a minute at most) whenever a re-slice lands, so its closure is
	// never stale by more than the one frame it takes react to commit that
	// re-render
	useLayoutEffect(() => {
		let raf = 0;
		const draw = () => {
			const t = playbackClock.currentTime();
			const dpr = window.devicePixelRatio;
			const trackPx = track.widthPx.current;
			const view = windowAround(bounds, t, detailSpanMs);
			const viewSpan = view.end - view.start;

			if (playheadRef.current !== null) {
				playheadRef.current.style.transform = playheadTransform(timeToPixels(view, t, trackPx), dpr);
			}

			// the lane group's only two per-frame writes. the width is recomputed
			// rather than held constant so a detail-tier zoom is picked up on the
			// tick it happens, ahead of the re-slice below; the transform slides
			// the neighbourhood under the window in one snapped step, which is what
			// makes every lane move together instead of each rounding for itself.
			// laneTransform is shared with the pointer handlers' click-to-time
			// inversion, so a hit computes through exactly the drawn geometry.
			// a zero viewSpan is only reachable at float magnitudes where the span
			// sits below one ulp of the window's start (rulerTicks guards the same
			// case), and it would divide the layer's width to Infinity
			const layer = laneLayerRef.current;
			const transform = viewSpan > 0 ? laneTransform(neighbourhood, view, trackPx, dpr) : null;
			if (layer !== null && transform !== null) {
				layer.style.width = `${transform.layerPx}px`;
				layer.style.transform = `translate3d(${-transform.viewStartInLayer}px, 0, 0)`;
			}

			// re-slice when the visible window is about to outgrow the
			// pre-rendered neighbourhood. the neighbourhood is 1.5x the span
			// wider on each side than the window, so this can only fire after the
			// playhead has moved roughly a full span away from the last slice's
			// centre -- not on every frame near some boundary. the request is
			// recorded synchronously right here, before this function returns, so
			// even a straggling tick from a loop instance that's about to be
			// replaced (its cancelAnimationFrame cleanup lands on react's next
			// commit, not necessarily before this callback's next invocation)
			// reads the already-fresh boundary and cannot re-trigger
			const requested = requestedNeighbourhoodRef.current;
			if (view.start < requested.start || view.end > requested.end) {
				requestedNeighbourhoodRef.current = windowAround(bounds, t, detailSpanMs * NEIGHBOURHOOD_FACTOR);
				sliceEpochRef.current += 1;
				setSliceEpoch(sliceEpochRef.current);
			}

			raf = requestAnimationFrame(draw);
		};
		// drawn once synchronously rather than only scheduled: react has just
		// committed this neighbourhood's marks while the layer under them still
		// carries the previous slice's offset, and waiting for the next rAF would
		// paint one frame of lanes a whole window out of place
		draw();
		return () => cancelAnimationFrame(raf);
	}, [bounds.minTime, bounds.maxTime, detailSpanMs, neighbourhood]);

	const cancelLiveDrag = () => {
		if (!pressDrag.live) return;
		laneGestureRef.current = null;
		detachEscape();
		const fx = pressDrag.cancel();
		if (fx.preview !== undefined) setDragPreview(fx.preview);
	};

	// the drag's escape listener registers at pointer-down and detaches with
	// the gesture, so it always registers after use-edit-tools' mount-time
	// listener and therefore runs after it -- the viewport's handler sees
	// pressDrag.live and yields its clear-selections stage, then this one
	// cancels. the ordering holds by registration time, not by mount order
	const escapeListenerRef = useRef<((e: KeyboardEvent) => void) | null>(null);
	const attachEscape = () => {
		if (escapeListenerRef.current !== null) return;
		const listener = (e: KeyboardEvent) => {
			if (e.key === "Escape") cancelLiveDrag();
		};
		escapeListenerRef.current = listener;
		window.addEventListener("keydown", listener);
	};
	function detachEscape() {
		if (escapeListenerRef.current !== null) {
			window.removeEventListener("keydown", escapeListenerRef.current);
			escapeListenerRef.current = null;
		}
	}

	// any landing delta -- structural or a buttons-only rewrite from a queued
	// commit or an undo -- invalidates the frozen frames the live drag
	// computes against, and preview-equals-commit only holds over unchanged
	// frames: cancel rather than commit against a stream the preview never saw
	const editRevision = useViewerStore((s) => s.editRevision);
	useEffect(() => {
		cancelLiveDrag();
		// the listener must not outlive the component either
		return detachEscape;
	}, [editRevision]);

	/** the intent the released drag commits (press-commits.ts): re-expanded
	 * at dispatch against the then-current frames from the drag's final edit
	 * -- identical inputs, so the previewed expansion is the committed
	 * expansion. bound to the dragged run's time-space identity rather than
	 * the selection: a commit queued behind an in-flight edit must not
	 * follow a selection the user moved after release */
	const commitDrag = (commit: { key: PhysicalKey; runStartTime: number; edit: PressEdit }) => {
		void viewerStore.getState().commitEdit({
			...pressRunCommit(pressLabel("drag", commit.key), commit.key, commit.runStartTime, (frames, run, ed) =>
				expandRetimePress(frames, run, commit.edit, ed.lattice, "this drag")
			),
			// the preview stands in until the delta's own spans replace it (or
			// the commit dies) -- no frame shows neither
			onSettled: () => setDragPreview(null)
		});
	};

	const applyDragFx = (fx: PressDragEffects) => {
		const state = viewerStore.getState();
		if (fx.pause) state.setPlaying(false);
		if (fx.select !== undefined) state.setPressSelection(fx.select);
		if (fx.clearSelection) state.setPressSelection(null);
		if (fx.preview !== undefined) setDragPreview(fx.preview);
		if (fx.commit !== undefined) commitDrag(fx.commit);
	};

	/** the frozen pixel-to-time inversion for one gesture: the same
	 * laneTransform the draw loop just painted with */
	const laneInversion = (): ((e: { clientX: number }) => number) | null => {
		const trackEl = track.element.current;
		const trackPx = track.widthPx.current;
		if (trackEl === null || trackPx <= 0) return null;
		const view = windowAround(bounds, playbackClock.currentTime(), detailSpanMs);
		const transform = laneTransform(neighbourhood, view, trackPx, window.devicePixelRatio);
		if (transform === null) return null;
		const rect = trackEl.getBoundingClientRect();
		return (e) => laneTimeAtPixel(neighbourhood, transform, e.clientX - rect.left);
	};

	const laneKeyForEvent = (target: EventTarget | null): PhysicalKey | null => {
		const laneEl = target instanceof Element ? target.closest("[data-hold-lane]") : null;
		if (laneEl === null) return null;
		const bit = (laneEl as HTMLElement).dataset.holdLane;
		return PHYSICAL_BUTTONS.find((button) => button.edgesKey === bit)?.label ?? null;
	};

	const objectIndexForEvent = (target: EventTarget | null): number | null => {
		const objectEl = target instanceof Element ? target.closest("[data-object-index]") : null;
		if (objectEl === null) return null;
		const index = Number((objectEl as HTMLElement).dataset.objectIndex);
		return Number.isInteger(index) ? index : null;
	};

	/** the same ancestor walk the two markers above get, scoping the click
	 * handler's clear to the object lane's own row */
	const withinObjectLane = (target: EventTarget | null): boolean =>
		target instanceof Element && target.closest("[data-object-lane]") !== null;

	// "fix this note": a single click on a tethered object selects its
	// judging press and raises the keypress tab (opening the panel if it is
	// closed, so the click never lands invisibly). the tether's stored rise
	// frame index resolves the click through the existing press-run lookup --
	// nothing is re-derived, and the index (not a time search) is what keeps
	// duplicate-time streams honest: a release and re-press at one
	// millisecond are two runs, and only the index names the judging one.
	// a click on a genuine gap in the lane lets the press selection go, the
	// same rule as the hold lane directly below it; the branches themselves
	// are object-lane-click.ts's. single clicks never seek, the detail tier's
	// one rule. deliberately not behind the frame-edit gate: selection is
	// inspection, and on a non-editable-but-simulated scene the keypress
	// panel opens with its controls disabled, which is that panel's own job
	// to say
	const onLaneClick = (e: ReactMouseEvent<HTMLDivElement>) => {
		const state = viewerStore.getState();
		if (state.mode !== "edit" || state.scene === null || state.derived === null) return;
		const objectIndex = objectIndexForEvent(e.target);
		const tether = objectIndex === null ? null : (state.derived.objectLane[objectIndex]?.tether ?? null);
		const run = tether === null ? null : pressRunFromIndex(state.scene.frames, tether.key, tether.pressFrameIndex);
		const decision = objectLaneClick({
			insideObjectLane: withinObjectLane(e.target),
			objectIndex,
			tether,
			pressRunStartIndex: run?.startIndex ?? null
		});
		if (decision.kind === "nothing") return;
		if (decision.kind === "clear") {
			state.setPressSelection(null);
			return;
		}
		state.setPressSelection(decision.selection);
		state.setPanelTab("keys");
	};

	const onLanePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0 || pressDrag.live || laneGestureRef.current !== null) return;
		const state = viewerStore.getState();
		// watch-mode lanes keep their current behaviour: no selection, no drag
		if (state.mode !== "edit" || state.scene === null || state.editor === null) return;
		if (!frameEditGate(state.scene).editable) return;
		const key = laneKeyForEvent(e.target);
		if (key === null) return;
		const toTime = laneInversion();
		if (toTime === null) return;
		const trackPx = track.widthPx.current;
		const view = windowAround(bounds, playbackClock.currentTime(), detailSpanMs);
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		laneGestureRef.current = { pointerId: e.pointerId, toTime };
		attachEscape();
		applyDragFx(
			pressDrag.pointerDown(toTime(e), {
				key,
				frames: state.scene.frames,
				msPerPx: (view.end - view.start) / trackPx,
				slopPx: CLICK_SLOP_SCREEN_PX,
				edgeZonePx: EDGE_ZONE_PX,
				lattice: state.editor.lattice
			})
		);
	};

	const onLanePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const gesture = laneGestureRef.current;
		if (gesture === null || e.pointerId !== gesture.pointerId) return;
		applyDragFx(pressDrag.pointerMove(gesture.toTime(e)));
	};

	const onLanePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
		const gesture = laneGestureRef.current;
		if (gesture === null || e.pointerId !== gesture.pointerId) return;
		laneGestureRef.current = null;
		detachEscape();
		if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
		applyDragFx(pressDrag.pointerUp(gesture.toTime(e)));
	};

	const onLanePointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
		const gesture = laneGestureRef.current;
		if (gesture === null || e.pointerId !== gesture.pointerId) return;
		laneGestureRef.current = null;
		detachEscape();
		applyDragFx(pressDrag.cancel());
	};

	// double-click is the one deliberate seek affordance; single-click never
	// seeks. an object double-click is pure navigation: through the playback
	// clock rather than the frame cursor, and ungated by the frame-edit gate,
	// so it still works on a NotSimulated scene where the hold-lane gestures
	// are disabled. the hold-lane path resolves through the same inversion as
	// the drag hit-testing
	const onLaneDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
		const state = viewerStore.getState();
		if (state.mode !== "edit" || state.scene === null) return;
		const objectIndex = objectIndexForEvent(e.target);
		if (objectIndex !== null) {
			const object = state.scene.renderPlan.objects[objectIndex];
			if (object !== undefined) playbackClock.seekTo(object.startTime);
			return;
		}
		if (!frameEditGate(state.scene).editable) return;
		const key = laneKeyForEvent(e.target);
		if (key === null) return;
		const toTime = laneInversion();
		if (toTime === null) return;
		const run = pressRunAt(state.scene.frames, key, toTime(e));
		if (run !== null) frameCursor.select(run.startIndex);
	};

	// neighbourhood-relative, so every one of these is written once per slice
	// and never touched again -- the layer's transform is what moves them
	const percentOf = (t: number) => `${windowFraction(neighbourhood, t) * 100}%`;

	return (
		// no wheel handling and no native-wheel opt-out here: plain wheel
		// frame-steps over these lanes exactly as it does everywhere else, and
		// the span zoom rides ctrl+wheel on the dock (TimelineDock), one rule
		// for every tier
		<div className="relative flex border-b border-[#17171b] bg-surface-rail">
			{/* the hold-lane labels share one neutral tone: k/m identity comes
			from the label text alone, keeping hue reserved for judgement meaning
			(blue means "great", never "K1") */}
			<div className="w-[74px] shrink-0 border-r border-[#17171b] pr-2 pb-1 text-right font-mono text-[10.5px]">
				<div className="h-[17px]" />
				<div className="flex h-[17px] items-center justify-end text-[#71717a]">obj</div>
				<div className="flex h-[13px] items-center justify-end text-[#8a8a93]">K1</div>
				<div className="flex h-[13px] items-center justify-end text-[#8a8a93]">K2</div>
				<div className="flex h-[13px] items-center justify-end text-[#8a8a93]">M1</div>
				<div className="flex h-[13px] items-center justify-end text-[#8a8a93]">M2</div>
				<div className="flex h-[34px] items-center justify-end text-[#eb4791]">vel</div>
			</div>

			{/* overflow-hidden belongs here rather than on each lane: the layer
			below is NEIGHBOURHOOD_FACTOR windows wide and hangs out of the track on
			both sides, and this is the box that clips it back to the visible span.
			the pointer handlers live here too -- capture retargets a drag's later
			events to this box; presses do something only inside a [data-hold-lane]
			row and clicks only inside a [data-object-index] mark, so the ruler and
			velocity rows stay untouched and the object lane never disturbs press
			dragging */}
			<div
				ref={track.attach}
				onPointerDown={onLanePointerDown}
				onPointerMove={onLanePointerMove}
				onPointerUp={onLanePointerUp}
				onPointerCancel={onLanePointerCancel}
				onClick={onLaneClick}
				onDoubleClick={onLaneDoubleClick}
				className="relative min-w-0 flex-1 overflow-hidden pb-1"
			>
				{/* the lane layer, out of flow so it can be wider than the track --
				the gutter column beside it is what gives this row its height */}
				<div ref={laneLayerRef} className="absolute inset-y-0 left-0">
					<div className="relative h-[17px] border-b border-[#17171b] font-mono text-[10.5px] text-[#8a8a93]">
						{rulerMajors.map((tick) => (
							<div key={tick} className="absolute inset-y-0" style={{ left: percentOf(tick) }}>
								<div className="absolute top-[9px] bottom-0 left-0 w-px bg-border" />
								<span className="absolute top-[3px] left-0 whitespace-nowrap">{formatTime(tick)}</span>
							</div>
						))}
						{rulerMinors.map((tick) => (
							<div
								key={tick}
								className="absolute top-3 bottom-0 w-px bg-[#17171b]"
								style={{ left: percentOf(tick) }}
							/>
						))}
					</div>

					<ObjectLane
						objects={slicedObjects}
						neighbourhood={neighbourhood}
						hitWindowBand={hitWindowBand}
						showHitWindowBands={timeline.hitWindowBands}
						showTethers={timeline.tethers}
						showNestedMarks={timeline.nestedMarks}
					/>

					{/* all four rows share one neutral span tone -- hue stays reserved
					for judgement meaning, and only the gutter labels distinguish the
					keys. the selected press's span brightens, a stronger signal now
					that its neighbours are neutral; a live drag hides the spans its
					expansion replaces and draws the realized outcome in their place */}
					{HOLD_ORDER.map((bit) => {
						const preview =
							dragPreview !== null && physicalButton(dragPreview.key).edgesKey === bit
								? dragPreview
								: null;
						const selectedTime = selectedHighlight?.bit === bit ? selectedHighlight.startTime : null;
						const spans =
							preview === null
								? slicedHolds[bit]
								: slicedHolds[bit].filter((span) =>
										preview.hide.every((range) => span.end < range.from || span.start > range.to)
									);
						const previewFractions =
							preview === null
								? null
								: {
										left: windowFraction(neighbourhood, preview.span.start),
										right: windowFraction(neighbourhood, preview.span.end)
									};
						return (
							<div key={bit} data-hold-lane={bit} className="relative h-[13px] border-b border-[#101013]">
								{spans.map((span, i) => {
									// both edges read off the same fraction map and neither is
									// rounded on its own -- the layer's transform is the only
									// snapped quantity in the group, which is what stops a span's
									// two edges stepping in opposite directions on a sub-pixel move
									const left = windowFraction(neighbourhood, span.start);
									const right = windowFraction(neighbourhood, span.end);
									const selected =
										preview === null &&
										selectedTime !== null &&
										span.start <= selectedTime &&
										selectedTime <= span.end;
									return (
										<div
											key={i}
											data-selected={selected ? "" : undefined}
											className="absolute inset-y-[3px] rounded-[2px] bg-[#a1a1aa] data-[selected]:bg-[#f4f4f5] data-[selected]:shadow-[0_0_0_1px_#ffffff66]"
											style={{ left: `${left * 100}%`, width: `${(right - left) * 100}%` }}
										/>
									);
								})}
								{previewFractions !== null && (
									<div
										className="absolute inset-y-[3px] rounded-[2px] bg-[#f4f4f5] shadow-[0_0_0_1px_#ffffff66]"
										style={{
											left: `${previewFractions.left * 100}%`,
											width: `${(previewFractions.right - previewFractions.left) * 100}%`
										}}
									/>
								)}
							</div>
						);
					})}

					{/* the trace shares the layer rather than sitting outside it: left
					on the track it would re-point itself every frame and drift a
					sub-pixel against the lanes it is meant to line up with. the 600
					viewBox units therefore span the neighbourhood, not the window */}
					<div className="h-[34px]">
						<svg viewBox="0 0 600 34" preserveAspectRatio="none" className="block h-full w-full">
							<polygon
								fill="#eb4791"
								fillOpacity={0.16}
								points={velocityTrace === null ? "" : `0,34 ${velocityTrace} 600,34`}
							/>
							<polyline fill="none" stroke="#eb4791" strokeWidth={1.4} points={velocityTrace ?? ""} />
						</svg>
					</div>

					{/* the tether's extended state: the bond drops out of the object
					lane down to its press exactly while that press is selected (the
					keys-tab gate, via tetherExtension) or mid-drag. during a drag the
					press end follows the frame-snapped preview -- the same render the
					preview span itself rides, so the error visibly shrinks as the
					user aims -- and a cancelled drag retracts with the preview. the
					preview substitutes only for its own run: it lingers until the
					commit settles, and selecting another same-key run in that window
					must show that run's authoritative tether, not the old drag's time */}
					{tetherExtension !== null &&
						(() => {
							const tether = tetherExtension;
							const pressTime =
								dragPreview !== null &&
								dragPreview.key === tether.key &&
								dragPreview.runStartIndex === selectedHighlight?.startIndex
									? dragPreview.span.start
									: tether.toTime;
							const fromTime = tether.fromTime;
							const span = neighbourhood.end - neighbourhood.start;
							const width = (Math.abs(pressTime - fromTime) / span) * 100;
							const dropBottom = holdRowCentreY(physicalButton(tether.key).edgesKey);
							return (
								<div className="pointer-events-none absolute inset-0">
									<div
										className="absolute h-px bg-[#f4f4f5]"
										style={{
											top: `${TETHER_REST_Y_PX}px`,
											left: percentOf(Math.min(fromTime, pressTime)),
											width: `${width}%`
										}}
									/>
									<div
										className="absolute w-px bg-[#f4f4f5]/80"
										style={{
											top: `${TETHER_REST_Y_PX}px`,
											height: `${dropBottom - TETHER_REST_Y_PX}px`,
											left: percentOf(pressTime)
										}}
									/>
								</div>
							);
						})()}
				</div>

				<Playhead ref={playheadRef} />
			</div>
		</div>
	);
}
