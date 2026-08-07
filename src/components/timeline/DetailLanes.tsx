// the timeline dock's middle tier: a zoomable span centred on the playhead
// (task 14's overview strip always maps the whole replay; this tier zooms).
// like the overview strip, this is a continuous consumer (decision 6) -- one
// rAF loop reads playbackClock and writes straight to dom refs, never
// through react state. the twist here is that even the *set of marks to
// draw* is continuous (judgements and key/mouse holds scroll past as the
// window slides), and re-rendering react for every one of them would be as
// bad as re-rendering on every clock tick. the neighbourhood scheme below is
// what keeps both under control: see the comment above the rAF effect

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { K1, K2, M1, M2 } from "@/engine/buttons";
import { holdSpansFlat, sliceSpansFlat } from "@/engine/interpolation";
import type { VelocitySample } from "@/lib/analysis";
import { formatTime } from "@/lib/format";
import type { FrameDto, Grade, LoadedScene } from "@/lib/scene-types";
import { audioExtendedBounds, type TimeBounds } from "@/lib/timeline";
import { rulerTicks, windowAround, type TimeWindow } from "@/lib/timeline-view";
import { playbackClock } from "@/playback/instance";
import { useViewerStore } from "@/state/store";

// the pre-rendered neighbourhood is 3x the visible span (1.5x each side) --
// generous enough that ordinary playback and zooming can move the window a
// good while before a re-slice is needed
const NEIGHBOURHOOD_FACTOR = 3;

// rulerTicks(window, 5) picks the smallest "nice" interval >= span/5, which
// bounds the major count at 6 (span/interval <= 5, plus the closing tick);
// minors sit one-fewer, between each pair of majors. 8 leaves headroom
// without allocating a pool sized for a case that can't occur
const RULER_TICK_POOL = 8;

type BitKey = "k1" | "k2" | "m1" | "m2";
const HOLD_BITS: Record<BitKey, number> = { k1: K1, k2: K2, m1: M1, m2: M2 };
const HOLD_ORDER: readonly BitKey[] = ["k1", "k2", "m1", "m2"];

interface JudgeMark {
	time: number;
	grade: Grade;
}

const JUDGE_MARK_CLASS: Record<Grade, string> = {
	great: "absolute w-0.5 inset-y-[3px] bg-[#66ccff]",
	ok: "absolute w-[2.5px] inset-y-px bg-[#88b300]",
	meh: "absolute w-[2.5px] inset-y-px bg-[#ffcc22]",
	miss: "absolute w-[3px] inset-y-0 bg-[#ed1121]"
};

// only these three judgement kinds carry a grade the judge lane can draw;
// ticks/repeats/tails/spinner-spin events are proximity- or spin-driven and
// have nothing gradeable to show here (mirrors analysis.ts's judgedTime)
function judgeMarksFor(scene: LoadedScene | null): JudgeMark[] {
	if (scene === null || scene.simulation.status !== "authoritative") return [];
	const marks: JudgeMark[] = [];
	for (const event of scene.simulation.events) {
		const kind = event.kind;
		if (kind.type === "circle" || kind.type === "sliderAggregate" || kind.type === "spinnerFinal") {
			marks.push({ time: event.time, grade: kind.grade });
		}
	}
	return marks;
}

// spans are retained per scene in holdSpansFlat's pair-packed form so a
// capped multi-million-frame replay pins one Float64Array per bit instead of
// millions of span objects; only the slice around the neighbourhood below
// materializes objects, and that is at most a handful of screens' worth
function holdsForScene(frames: readonly FrameDto[]): Record<BitKey, Float64Array> {
	const result = {} as Record<BitKey, Float64Array>;
	for (const bit of HOLD_ORDER) result[bit] = holdSpansFlat(frames, HOLD_BITS[bit]);
	return result;
}

// unlike lib/timeline's fractionFor, this must not clamp into [0,1]: a mark
// that starts or ends outside the visible window is clipped by its lane's
// overflow-hidden box, not stuck against the 0/1 edge -- clamping here would
// hide the fact that a hold started before the window and make it look like
// it began exactly at the left edge every time
function windowFraction(window: TimeWindow, t: number): number {
	const span = window.end - window.start;
	return span <= 0 ? 0 : (t - window.start) / span;
}

// x = the sample's time position across the *current* window (unlike
// AnalysisPanel's whole-replay chart, which places samples by index share --
// this lane must track the playhead, not the replay as a whole). y = the
// sample's share of the replay's peak velocity, so the trace reads at a
// consistent scale as the window slides rather than auto-scaling to look
// maxed-out during slow segments
function velocityPoints(samples: readonly VelocitySample[], peak: number, window: TimeWindow): string | null {
	if (peak <= 0) return null;
	const inWindow = samples.filter((s) => s.time >= window.start && s.time <= window.end);
	if (inWindow.length === 0) return null;
	return inWindow
		.map((s) => {
			const x = windowFraction(window, s.time) * 600;
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
	const setDetailSpan = useViewerStore((s) => s.setDetailSpan);

	// AppShell (and so TimelineDock) only mounts once App.tsx has a loaded
	// scene, and mode only reaches "edit" with one loaded -- these fallbacks
	// just keep the hooks below well-typed against the store's nullable
	// fields, matching TopBar's own convention, not a real null-scene path
	const bounds: TimeBounds = audioExtendedBounds(derived?.bounds ?? { minTime: 0, maxTime: 1 }, audioDurationMs);
	const velocitySamples = derived?.analysis.velocity ?? [];
	const peakVelocity = derived?.analysis.peakVelocity ?? 0;

	// per-scene source lists: independent of the zoom window, recomputed only
	// when a new scene installs (scene's reference changes 1:1 with sceneId,
	// since store.install() sets both together)
	const judgeMarks = useMemo(() => judgeMarksFor(scene), [scene]);
	const holds = useMemo(() => holdsForScene(scene?.frames ?? []), [scene]);

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
	const neighbourhoodRef = useRef<TimeWindow>(neighbourhood);
	useLayoutEffect(() => {
		neighbourhoodRef.current = neighbourhood;
	}, [neighbourhood]);

	const slicedMarks = useMemo(
		() => judgeMarks.filter((m) => m.time >= neighbourhood.start && m.time <= neighbourhood.end),
		[judgeMarks, neighbourhood]
	);
	const slicedHolds = useMemo(() => {
		// one lane pixel of the neighbourhood, the merge quantum sliceSpansFlat
		// coalesces below -- sub-pixel gaps cannot render distinctly, and the
		// quantum is what bounds a duplicate-time span flood to a drawable count
		const mergeGap = (neighbourhood.end - neighbourhood.start) / 4096;
		const slice = (flat: Float64Array) => sliceSpansFlat(flat, neighbourhood.start, neighbourhood.end, mergeGap);
		return { k1: slice(holds.k1), k2: slice(holds.k2), m1: slice(holds.m1), m2: slice(holds.m2) };
	}, [holds, neighbourhood]);

	const playheadRef = useRef<HTMLDivElement>(null);
	const markRefs = useRef<(HTMLDivElement | null)[]>([]);
	const holdRefs = useRef<Record<BitKey, (HTMLDivElement | null)[]>>({ k1: [], k2: [], m1: [], m2: [] });
	const majorTickRefs = useRef<(HTMLDivElement | null)[]>([]);
	const minorTickRefs = useRef<(HTMLDivElement | null)[]>([]);
	const polylineRef = useRef<SVGPolylineElement>(null);
	const polygonRef = useRef<SVGPolygonElement>(null);

	// the single rAF loop for the whole lane group. it restarts (cheap: a few
	// times a minute at most) whenever the pre-rendered marks change under it
	// -- slicedMarks/slicedHolds are new arrays, backing new dom nodes with
	// fresh refs, exactly when a re-slice lands -- so the closure below is
	// never stale by more than the one frame it takes react to commit that
	// re-render
	useEffect(() => {
		let raf = 0;
		const loop = () => {
			const t = playbackClock.currentTime();
			const window = windowAround(bounds, t, detailSpanMs);

			if (playheadRef.current !== null) {
				playheadRef.current.style.left = `${windowFraction(window, t) * 100}%`;
			}

			// ruler: majors from rulerTicks(window, 5), each a pooled wrapper whose
			// line+label children travel together under one style.left write;
			// minors sit halfway between each pair of majors
			const majors = rulerTicks(window, 5);
			for (let i = 0; i < RULER_TICK_POOL; i++) {
				const el = majorTickRefs.current[i];
				if (el === null) continue;
				const tickTime = majors[i];
				if (tickTime === undefined) {
					el.style.display = "none";
					continue;
				}
				el.style.display = "";
				el.style.left = `${windowFraction(window, tickTime) * 100}%`;
				// fixed child order (line, then label) -- indexed rather than
				// re-queried every frame, same convention as FramesPanel's rows
				(el.children[1] as HTMLElement).textContent = formatTime(tickTime);
			}
			for (let i = 0; i < RULER_TICK_POOL; i++) {
				const el = minorTickRefs.current[i];
				if (el === null) continue;
				const a = majors[i];
				const b = majors[i + 1];
				if (a === undefined || b === undefined) {
					el.style.display = "none";
					continue;
				}
				el.style.display = "";
				el.style.left = `${windowFraction(window, (a + b) / 2) * 100}%`;
			}

			// judge lane: point marks, position only -- each grade's width is
			// fixed by its className
			for (let i = 0; i < slicedMarks.length; i++) {
				const el = markRefs.current[i];
				if (el === null) continue;
				const frac = windowFraction(window, slicedMarks[i].time);
				if (frac < 0 || frac > 1) {
					el.style.display = "none";
					continue;
				}
				el.style.display = "";
				el.style.left = `${frac * 100}%`;
			}

			// K1/K2/M1/M2 lanes: span marks, left + width from start/end. one
			// shared loop over the four bits rather than four copies
			for (const bit of HOLD_ORDER) {
				const list = slicedHolds[bit];
				const refs = holdRefs.current[bit];
				for (let i = 0; i < list.length; i++) {
					const el = refs[i];
					if (el === null) continue;
					const startFrac = windowFraction(window, list[i].start);
					const endFrac = windowFraction(window, list[i].end);
					if (endFrac < 0 || startFrac > 1) {
						el.style.display = "none";
						continue;
					}
					el.style.display = "";
					el.style.left = `${startFrac * 100}%`;
					el.style.width = `${Math.max(0, endFrac - startFrac) * 100}%`;
				}
			}

			// velocity: rebuilt every tick straight from the (small, fixed-size)
			// full-replay trace -- cheap enough that it needs neither pre-rendered
			// marks nor the neighbourhood scheme above
			if (polylineRef.current !== null && polygonRef.current !== null) {
				const points = velocityPoints(velocitySamples, peakVelocity, window);
				polylineRef.current.setAttribute("points", points ?? "");
				polygonRef.current.setAttribute("points", points !== null ? `0,34 ${points} 600,34` : "");
			}

			// re-slice when the visible window is about to outgrow the
			// pre-rendered neighbourhood. the neighbourhood is 1.5x the span
			// wider on each side than the window, so this can only fire after the
			// playhead has moved roughly a full span away from the last slice's
			// centre -- not on every frame near some boundary. neighbourhoodRef
			// is updated synchronously right here, before this function returns,
			// so even a straggling tick from a loop instance that's about to be
			// replaced (its cancelAnimationFrame cleanup lands on react's next
			// commit, not necessarily before this callback's next invocation)
			// reads the already-fresh boundary and cannot re-trigger
			const nb = neighbourhoodRef.current;
			if (window.start < nb.start || window.end > nb.end) {
				neighbourhoodRef.current = windowAround(bounds, t, detailSpanMs * NEIGHBOURHOOD_FACTOR);
				sliceEpochRef.current += 1;
				setSliceEpoch(sliceEpochRef.current);
			}

			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [bounds.minTime, bounds.maxTime, detailSpanMs, slicedMarks, slicedHolds, velocitySamples, peakVelocity]);

	return (
		<div
			data-native-wheel=""
			onWheel={(e) => {
				// a horizontal-only trackpad swipe arrives with deltaY 0 and must
				// not fall into the zoom-in branch
				if (e.deltaY === 0) return;
				setDetailSpan(detailSpanMs * (e.deltaY > 0 ? 1.25 : 0.8));
			}}
			className="relative flex border-b border-[#17171b] bg-surface-rail"
		>
			<div className="w-[74px] shrink-0 border-r border-[#17171b] pr-2 pb-1 text-right font-mono text-[10.5px]">
				<div className="h-[17px]" />
				<div className="flex h-[17px] items-center justify-end text-[#71717a]">judge</div>
				<div className="flex h-[13px] items-center justify-end text-[#99ddff]">K1</div>
				<div className="flex h-[13px] items-center justify-end text-[#99ddff]">K2</div>
				<div className="flex h-[13px] items-center justify-end text-[#8a8a93]">M1</div>
				<div className="flex h-[13px] items-center justify-end text-[#8a8a93]">M2</div>
				<div className="flex h-[34px] items-center justify-end text-[#eb4791]">vel</div>
			</div>

			<div className="relative min-w-0 flex-1 pb-1">
				<div className="relative h-[17px] border-b border-[#17171b] font-mono text-[10.5px] text-[#8a8a93]">
					{Array.from({ length: RULER_TICK_POOL }, (_, i) => (
						<div
							key={i}
							ref={(el) => {
								majorTickRefs.current[i] = el;
							}}
							className="absolute inset-y-0"
						>
							<div className="absolute top-[9px] bottom-0 left-0 w-px bg-border" />
							<span className="absolute top-[3px] left-0 whitespace-nowrap" />
						</div>
					))}
					{Array.from({ length: RULER_TICK_POOL }, (_, i) => (
						<div
							key={i}
							ref={(el) => {
								minorTickRefs.current[i] = el;
							}}
							className="absolute top-3 bottom-0 w-px bg-[#17171b]"
						/>
					))}
				</div>

				<div className="relative h-[17px] overflow-hidden border-b border-[#101013]">
					{slicedMarks.map((mark, i) => (
						<div
							key={i}
							ref={(el) => {
								markRefs.current[i] = el;
							}}
							className={JUDGE_MARK_CLASS[mark.grade]}
						/>
					))}
				</div>

				{/* all four rows share one mark style (bg-[#99ddff]) per the brief --
				only the gutter labels distinguish k1/k2 from m1/m2 by colour */}
				{HOLD_ORDER.map((bit) => (
					<div key={bit} className="relative h-[13px] overflow-hidden border-b border-[#101013]">
						{slicedHolds[bit].map((_, i) => (
							<div
								key={i}
								ref={(el) => {
									holdRefs.current[bit][i] = el;
								}}
								className="absolute inset-y-[3px] rounded-[2px] bg-[#99ddff]"
							/>
						))}
					</div>
				))}

				<div className="h-[34px] overflow-hidden">
					<svg viewBox="0 0 600 34" preserveAspectRatio="none" className="block h-full w-full">
						<polygon ref={polygonRef} fill="#eb4791" fillOpacity={0.16} />
						<polyline ref={polylineRef} fill="none" stroke="#eb4791" strokeWidth={1.4} />
					</svg>
				</div>

				<div
					ref={playheadRef}
					className="pointer-events-none absolute inset-y-0 w-[1.5px] -translate-x-1/2 bg-primary"
				>
					<div className="absolute top-0 left-1/2 h-[9px] w-2 -translate-x-1/2 rounded-b-[2px] bg-primary" />
				</div>
			</div>
		</div>
	);
}
