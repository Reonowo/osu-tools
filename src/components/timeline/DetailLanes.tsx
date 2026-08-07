// the timeline dock's middle tier: a zoomable span centred on the playhead
// (task 14's overview strip always maps the whole replay; this tier zooms).
// like the overview strip, this is a continuous consumer (decision 6) -- one
// rAF loop reads playbackClock and writes straight to dom refs, never
// through react state. the twist here is that even the *set of marks to
// draw* is continuous (judgements and key/mouse holds scroll past as the
// window slides), and re-rendering react for every one of them would be as
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

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { PHYSICAL_BUTTONS } from "@/engine/buttons";
import { holdSpansFlat, sliceSpansFlat } from "@/engine/interpolation";
import type { VelocitySample } from "@/lib/analysis";
import { formatTime } from "@/lib/format";
import type { FrameDto, Grade, LoadedScene } from "@/lib/scene-types";
import { audioExtendedBounds, type TimeBounds } from "@/lib/timeline";
import {
	clampSpan,
	detailSpanForWheel,
	rulerTicks,
	snapDevicePixels,
	timeToPixels,
	windowAround,
	windowFraction,
	type TimeWindow
} from "@/lib/timeline-view";
import { playbackClock } from "@/playback/instance";
import { useViewerStore } from "@/state/store";
import { Playhead, playheadTransform } from "./Playhead";
import { useTrackMetrics } from "./use-track-metrics";

// the pre-rendered neighbourhood is 3x the visible span (1.5x each side) --
// generous enough that ordinary playback and zooming can move the window a
// good while before a re-slice is needed
const NEIGHBOURHOOD_FACTOR = 3;

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
	for (const button of PHYSICAL_BUTTONS) result[button.edgesKey] = holdSpansFlat(frames, button.is);
	return result;
}

// x = the sample's time position across the pre-rendered neighbourhood (unlike
// AnalysisPanel's whole-replay chart, which places samples by index share --
// this lane must track the playhead, not the replay as a whole). y = the
// sample's share of the replay's peak velocity, so the trace reads at a
// consistent scale as the window slides rather than auto-scaling to look
// maxed-out during slow segments
function velocityPoints(samples: readonly VelocitySample[], peak: number, view: TimeWindow): string | null {
	if (peak <= 0) return null;
	const inView = samples.filter((s) => s.time >= view.start && s.time <= view.end);
	if (inView.length === 0) return null;
	return inView
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
			// a zero viewSpan is only reachable at float magnitudes where the span
			// sits below one ulp of the window's start (rulerTicks guards the same
			// case), and it would divide the layer's width to Infinity
			const layer = laneLayerRef.current;
			if (layer !== null && viewSpan > 0) {
				const layerPx = ((neighbourhood.end - neighbourhood.start) / viewSpan) * trackPx;
				const viewStartInLayer = snapDevicePixels(timeToPixels(neighbourhood, view.start, layerPx), dpr);
				layer.style.width = `${layerPx}px`;
				layer.style.transform = `translate3d(${-viewStartInLayer}px, 0, 0)`;
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

	// neighbourhood-relative, so every one of these is written once per slice
	// and never touched again -- the layer's transform is what moves them
	const percentOf = (t: number) => `${windowFraction(neighbourhood, t) * 100}%`;

	return (
		<div
			data-native-wheel=""
			onWheel={(e) => {
				const next = detailSpanForWheel(detailSpanMs, e);
				if (next !== null) setDetailSpan(next);
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

			{/* overflow-hidden belongs here rather than on each lane: the layer
			below is NEIGHBOURHOOD_FACTOR windows wide and hangs out of the track on
			both sides, and this is the box that clips it back to the visible span */}
			<div ref={track.attach} className="relative min-w-0 flex-1 overflow-hidden pb-1">
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

					<div className="relative h-[17px] border-b border-[#101013]">
						{slicedMarks.map((mark, i) => (
							<div
								key={i}
								className={JUDGE_MARK_CLASS[mark.grade]}
								style={{ left: percentOf(mark.time) }}
							/>
						))}
					</div>

					{/* all four rows share one mark style (bg-[#99ddff]) per the brief --
					only the gutter labels distinguish k1/k2 from m1/m2 by colour */}
					{HOLD_ORDER.map((bit) => (
						<div key={bit} className="relative h-[13px] border-b border-[#101013]">
							{slicedHolds[bit].map((span, i) => {
								// both edges read off the same fraction map and neither is
								// rounded on its own -- the layer's transform is the only
								// snapped quantity in the group, which is what stops a span's
								// two edges stepping in opposite directions on a sub-pixel move
								const left = windowFraction(neighbourhood, span.start);
								const right = windowFraction(neighbourhood, span.end);
								return (
									<div
										key={i}
										className="absolute inset-y-[3px] rounded-[2px] bg-[#99ddff]"
										style={{ left: `${left * 100}%`, width: `${(right - left) * 100}%` }}
									/>
								);
							})}
						</div>
					))}

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
				</div>

				<Playhead ref={playheadRef} />
			</div>
		</div>
	);
}
