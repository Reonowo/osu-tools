// the timeline dock's top tier: always maps the whole replay, lead-in to the
// last frame (or the audio's tail, if that runs longer). this is Timeline.tsx
// restyled into a strip rather than a seek bar -- its pointer handling and
// audio-extended bounds carry over verbatim. the played tint, the progress
// fill, the zoom bracket, and the playhead are continuous consumers (decision
// 6): one rAF loop reads playbackClock and writes straight to dom refs, never
// through react state, so scrubbing at 60fps never triggers a react
// re-render. only the discrete pieces (bounds, markers, the bracket's
// edit-mode gate) come from the store via useViewerStore

import { useEffect, useMemo, useRef, type PointerEvent } from "react";
import { audioExtendedBounds, fractionFor, timeFor } from "@/lib/timeline";
import { windowAround } from "@/lib/timeline-view";
import { playbackClock } from "@/playback/instance";
import { useViewerStore } from "@/state/store";
import { Playhead, playheadTransform } from "./Playhead";
import { useTrackMetrics } from "./use-track-metrics";

const TICK_CLASS: Record<"ok" | "meh" | "miss", string> = {
	miss: "absolute bottom-0 w-0.5 top-0 bg-[#ed1121]",
	meh: "absolute bottom-0 w-[1.5px] top-[30%] bg-[#ffcc22]",
	ok: "absolute bottom-0 w-[1.5px] top-[40%] bg-[#88b300]"
};

export function OverviewStrip() {
	const derived = useViewerStore((s) => s.derived);
	const audioDurationMs = useViewerStore((s) => s.audioDurationMs);
	const mode = useViewerStore((s) => s.mode);
	const detailSpanMs = useViewerStore((s) => s.detailSpanMs);

	const track = useTrackMetrics();
	const playedRef = useRef<HTMLDivElement>(null);
	const fillRef = useRef<HTMLDivElement>(null);
	const bracketRef = useRef<HTMLDivElement>(null);
	const playheadRef = useRef<HTMLDivElement>(null);

	// when the audio outlives the last object, PlayerView extends the clock's
	// maxTime on loadedmetadata; the strip must map every layer -- the tint,
	// the ticks, seeks, the zoom bracket -- against those same effective
	// bounds, or the trailing audio is pegged at 100% and unseekable once the
	// replay's own frames have run out
	const baseBounds = derived?.bounds ?? { minTime: 0, maxTime: 1 };
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
			// the windowAround call than to compute a position nothing reads
			if (bracketRef.current !== null) {
				const detailWindow = windowAround(bounds, t, detailSpanMs);
				const left = fractionFor(bounds, detailWindow.start) * 100;
				const right = fractionFor(bounds, detailWindow.end) * 100;
				bracketRef.current.style.left = `${left}%`;
				bracketRef.current.style.width = `${right - left}%`;
			}
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [bounds.minTime, bounds.maxTime, detailSpanMs]);

	const markers = useMemo(
		() =>
			(derived?.timelineMarkers ?? []).map((m) => ({ left: fractionFor(bounds, m.time) * 100, grade: m.grade })),
		[derived, bounds.minTime, bounds.maxTime]
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
				e.currentTarget.setPointerCapture(e.pointerId);
				playheadRef.current?.setAttribute("data-scrubbing", "");
				seekFromPointer(e);
			}}
			onPointerMove={(e) => {
				if (e.currentTarget.hasPointerCapture(e.pointerId)) seekFromPointer(e);
			}}
			onLostPointerCapture={() => playheadRef.current?.removeAttribute("data-scrubbing")}
		>
			{/* 1: lead-in hatch, static per scene */}
			<div
				className="absolute inset-y-0 left-0 bg-[repeating-linear-gradient(45deg,rgba(255,255,255,.035)_0_3px,transparent_3px_6px)]"
				style={{ width: `${leadInWidth}%` }}
			/>
			{/* 2: played tint, rAF-driven */}
			<div ref={playedRef} className="absolute inset-y-0 left-0 bg-primary/5" />
			{/* 3: judgement ticks, static per scene */}
			{markers.map((m, i) => (
				<div key={i} className={TICK_CLASS[m.grade]} style={{ left: `${m.left}%` }} />
			))}
			{/* 4: progress rail, fill is rAF-driven */}
			<div className="absolute inset-x-0 bottom-0 h-0.5 bg-border">
				<div ref={fillRef} className="absolute inset-y-0 left-0 bg-primary" />
			</div>
			{/* 5: zoom bracket, edit-mode only, rAF-driven */}
			{showBracket && (
				<div
					ref={bracketRef}
					className="pointer-events-none absolute inset-y-0 border-x border-primary/60 bg-primary/[.07]"
				/>
			)}
			{/* 6: playhead, rAF-driven */}
			<Playhead ref={playheadRef} />
		</div>
	);
}
