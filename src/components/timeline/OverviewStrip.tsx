// the timeline dock's top tier: always maps the whole replay, lead-in to the
// last frame (or the audio's tail, if that runs longer). this is Timeline.tsx
// restyled into a strip rather than a seek bar -- its pointer handling and
// audio-extended bounds carry over verbatim. the played tint, the progress
// fill, the zoom bracket, and the playhead are continuous consumers (decision
// 6): one rAF loop reads playbackClock and writes straight to dom refs, never
// through react state, so scrubbing at 60fps never triggers a react
// re-render. only the discrete pieces (bounds, severity ticks, the bracket's
// edit-mode gate) come from the store via useViewerStore

import { useEffect, useMemo, useRef, type PointerEvent } from "react";
import { audioExtendedBounds, fractionFor, timeFor } from "@/lib/timeline";
import { bracketPixels } from "@/lib/timeline-view";
import { playbackClock } from "@/playback/instance";
import { useViewerStore } from "@/state/store";
import { Playhead, playheadTransform } from "./Playhead";
import { useTrackMetrics } from "./use-track-metrics";

// tick height means severity, not grade: at whole-replay zoom this strip is a
// navigation surface for rough patches, so a miss towers, a meh reads at
// half-height, and an ok stays a stub -- density and height together answer
// "how bad is this section" at a glance. greats are excluded upstream
// (derive.ts's severityTicks), so the marks being looked for are never buried
// in a solid bar
const TICK_CLASS: Record<"ok" | "meh" | "miss", string> = {
	miss: "absolute bottom-0 w-0.5 top-0 bg-[#ed1121]",
	meh: "absolute bottom-0 w-[1.5px] top-[45%] bg-[#ffcc22]",
	ok: "absolute bottom-0 w-[1.5px] top-[65%] bg-[#88b300]"
};

export function OverviewStrip() {
	const derived = useViewerStore((s) => s.derived);
	const timelineBounds = useViewerStore((s) => s.timelineBounds);
	const audioDurationMs = useViewerStore((s) => s.audioDurationMs);
	const mode = useViewerStore((s) => s.mode);
	const detailSpanMs = useViewerStore((s) => s.detailSpanMs);
	const showSeverityTicks = useViewerStore((s) => s.timeline.severityTicks);

	const track = useTrackMetrics();
	const playedRef = useRef<HTMLDivElement>(null);
	const fillRef = useRef<HTMLDivElement>(null);
	const bracketRef = useRef<HTMLDivElement>(null);
	const playheadRef = useRef<HTMLDivElement>(null);

	// when the audio outlives the last object, PlayerView extends the clock's
	// maxTime on loadedmetadata; the strip must map every layer -- the tint,
	// the ticks, seeks, the zoom bracket -- against those same effective
	// bounds, or the trailing audio is pegged at 100% and unseekable once the
	// replay's own frames have run out. the timeline bounds, not
	// derived.bounds: the strip's frame of reference must hold still while
	// edits re-judge the replay (store.ts)
	const baseBounds = timelineBounds ?? { minTime: 0, maxTime: 1 };
	const bounds = audioExtendedBounds(baseBounds, audioDurationMs);

	// the four continuous layers (played tint, progress fill, zoom bracket,
	// playhead) share a single rAF loop rather than one each -- they all read
	// the same clock tick, so splitting them would be wasteful and could let
	// them drift out of sync with one another
	useEffect(() => {
		let raf = 0;
		const loop = () => {
			const t = playbackClock.currentTime();
			const fraction = fractionFor(bounds, t);
			if (playedRef.current !== null) playedRef.current.style.width = `${fraction * 100}%`;
			if (fillRef.current !== null) fillRef.current.style.width = `${fraction * 100}%`;
			// the playhead moves in snapped pixels, not percent: its head and stem
			// have to land on the same device-pixel phase as each other every frame
			if (playheadRef.current !== null) {
				const offset = fraction * track.widthPx.current;
				playheadRef.current.style.transform = playheadTransform(offset, window.devicePixelRatio);
			}
			// null when the bracket isn't mounted (watch mode) -- cheaper to skip
			// the bracketPixels call than to compute a position nothing reads.
			// same t as the playhead's write above, snapped onto the same grid,
			// moved by transform: the bracket slides with the playhead as one
			// rigid piece instead of its edges rounding percent for themselves.
			// the width is written every tick even though only a zoom changes
			// it: the div remounts on a watch->edit toggle without this effect
			// restarting, so any skip-if-unchanged cache here would leave the
			// fresh div at width auto until the next zoom
			if (bracketRef.current !== null) {
				const bracket = bracketPixels(bounds, t, detailSpanMs, track.widthPx.current, window.devicePixelRatio);
				bracketRef.current.style.transform = `translate3d(${bracket.left}px, 0, 0)`;
				bracketRef.current.style.width = `${bracket.width}px`;
			}
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [bounds.minTime, bounds.maxTime, detailSpanMs]);

	const severityTicks = useMemo(
		() =>
			showSeverityTicks
				? (derived?.severityTicks ?? []).map((m) => ({
						left: fractionFor(bounds, m.time) * 100,
						grade: m.grade
					}))
				: [],
		[derived, bounds.minTime, bounds.maxTime, showSeverityTicks]
	);
	const leadInWidth = fractionFor(bounds, 0) * 100;
	// task 15's detail lanes render on mode === "edit"; the bracket must never
	// advertise a zoom window over lanes that aren't on screen, so it shares
	// that same gate rather than a condition of its own
	const showBracket = mode === "edit";

	function seekFromPointer(e: PointerEvent<HTMLDivElement>) {
		const rect = track.element.current!.getBoundingClientRect();
		playbackClock.seekTo(timeFor(bounds, (e.clientX - rect.left) / rect.width));
	}

	if (derived === null) return null;
	return (
		<div
			ref={track.attach}
			// touch-none carries over from Timeline.tsx: without it, a touch drag
			// fights the browser's own scroll/gesture handling instead of staying
			// a clean pointer-capture seek
			className="relative h-[26px] touch-none cursor-pointer overflow-hidden border-b border-[#17171b] bg-surface-strip"
			onPointerDown={(e) => {
				// the default action here is arming a native drag: with a text
				// selection anywhere on the page, a press that lands on it starts
				// a browser drag mid-scrub ("no drop" cursor) and the scrub dies.
				// preventing it keeps the gesture a scrub unconditionally
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				seekFromPointer(e);
			}}
			// the capture test is the whole gesture state, which is also what
			// makes interruption safe: a pointercancel (or any capture loss)
			// releases the capture, so the next move seeks nothing and the next
			// pointer-down starts a fresh scrub
			onPointerMove={(e) => {
				if (e.currentTarget.hasPointerCapture(e.pointerId)) seekFromPointer(e);
			}}
		>
			{/* 1: lead-in hatch, static per scene */}
			<div
				className="absolute inset-y-0 left-0 bg-[repeating-linear-gradient(45deg,rgba(255,255,255,.035)_0_3px,transparent_3px_6px)]"
				style={{ width: `${leadInWidth}%` }}
			/>
			{/* 2: played tint, rAF-driven */}
			<div ref={playedRef} className="absolute inset-y-0 left-0 bg-primary/5" />
			{/* 3: severity ticks, static per scene */}
			{severityTicks.map((tick, i) => (
				<div key={i} className={TICK_CLASS[tick.grade]} style={{ left: `${tick.left}%` }} />
			))}
			{/* 4: progress rail, fill is rAF-driven */}
			<div className="absolute inset-x-0 bottom-0 h-0.5 bg-border">
				<div ref={fillRef} className="absolute inset-y-0 left-0 bg-primary" />
			</div>
			{/* 5: zoom bracket, edit-mode only, rAF-driven (translated from the
			track's left edge; the loop writes transform + a width that only
			changes with the zoom) */}
			{showBracket && (
				<div
					ref={bracketRef}
					className="pointer-events-none absolute inset-y-0 left-0 border-x border-primary/60 bg-primary/[.07]"
				/>
			)}
			{/* 6: playhead, rAF-driven */}
			<Playhead ref={playheadRef} />
		</div>
	);
}
