// the seek bar. progress and the playhead are continuous consumers (decision
// 6): they read playbackClock inside their own rAF loop and write straight to
// dom refs, never through react state, so scrubbing at 60fps never triggers a
// react re-render. only the discrete pieces (bounds, markers) come from the
// store via useViewerStore

import { useEffect, useMemo, useRef, type PointerEvent } from "react";
import { toCss } from "@/engine/color";
import { fractionFor, timeFor } from "@/lib/timeline";
import { playbackClock } from "@/playback/instance";
import { GRADE_COLOURS } from "@/renderer/drawables/judgement-tracks";
import { useViewerStore } from "@/state/store";

export function Timeline() {
	const derived = useViewerStore((s) => s.derived);
	const audioDurationMs = useViewerStore((s) => s.audioDurationMs);
	const trackRef = useRef<HTMLDivElement>(null);
	const fillRef = useRef<HTMLDivElement>(null);
	const playheadRef = useRef<HTMLDivElement>(null);
	// when the audio outlives the last object, PlayerView extends the clock's
	// maxTime on loadedmetadata; the bar must map fill, markers, and seeks
	// against those same effective bounds or the trailing audio is pegged at
	// 100% and unseekable
	const baseBounds = derived?.bounds ?? { minTime: 0, maxTime: 1 };
	const bounds = {
		minTime: baseBounds.minTime,
		maxTime: audioDurationMs === null ? baseBounds.maxTime : Math.max(baseBounds.maxTime, audioDurationMs)
	};

	// continuous progress outside react
	useEffect(() => {
		let raf = 0;
		const loop = () => {
			const fraction = fractionFor(bounds, playbackClock.currentTime());
			if (fillRef.current !== null) fillRef.current.style.width = `${fraction * 100}%`;
			if (playheadRef.current !== null) playheadRef.current.style.left = `${fraction * 100}%`;
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [bounds.minTime, bounds.maxTime]);

	const markers = useMemo(
		() =>
			(derived?.timelineMarkers ?? []).map((m) => ({
				left: fractionFor(bounds, m.time) * 100,
				colour: toCss(GRADE_COLOURS[m.grade])
			})),
		[derived, bounds.minTime, bounds.maxTime]
	);
	const leadInWidth = fractionFor(bounds, 0) * 100;

	function seekFromPointer(e: PointerEvent<HTMLDivElement>) {
		const rect = trackRef.current!.getBoundingClientRect();
		playbackClock.seekTo(timeFor(bounds, (e.clientX - rect.left) / rect.width));
	}

	if (derived === null) return null;
	return (
		<div
			ref={trackRef}
			className="group relative h-5 w-full cursor-pointer touch-none"
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
			<div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-zinc-800">
				<div
					className="absolute left-0 top-0 h-full rounded-l-full bg-zinc-700/60"
					style={{ width: `${leadInWidth}%` }}
				/>
				<div ref={fillRef} className="absolute left-0 top-0 h-full rounded-full bg-[#ff66ab]" />
			</div>
			{markers.map((m, i) => (
				<div
					key={i}
					className="absolute top-0 h-5 w-0.5"
					style={{ left: `${m.left}%`, backgroundColor: m.colour }}
				/>
			))}
			{/* grab handle at the current time, not a hover preview at the cursor */}
			<div
				ref={playheadRef}
				className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/40 bg-[#ff66ab] opacity-0 transition-opacity group-hover:opacity-100 data-scrubbing:opacity-100"
			/>
		</div>
	);
}
