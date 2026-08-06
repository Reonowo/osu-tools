// the raw-bits keypress overlay (decision 12): rows are the viewer's own
// K1/K2/M1/M2 convention over the .osr bitfield, not lazer's action
// counters. reads playbackClock directly inside its own rAF loop (decision
// 6 -- the clock owns continuous time, so this never pushes a per-frame
// value into react state) and writes dom text/dataset imperatively instead

import { useEffect, useRef } from "react";
import { countAtOrBefore } from "@/renderer/overlays/analysis";
import { cursorStateAt } from "@/engine/interpolation";
import { K1, K2, M1, M2 } from "@/engine/buttons";
import { playbackClock } from "@/playback/instance";
import { useViewerStore } from "@/state/store";

const KEYS = [
	{ label: "K1", bit: K1, edges: "k1" as const },
	{ label: "K2", bit: K2, edges: "k2" as const },
	{ label: "M1", bit: M1, edges: "m1" as const },
	{ label: "M2", bit: M2, edges: "m2" as const }
];

/** argonkeycounter.cs:88-90 -- 52.5x45 tiles (30/35 base * 1.5 scale_factor);
 * :49-51,32 -- 4.5px indicator bar (line_height 3 * scale_factor) that drops
 * indicator_press_offset (4px) while held; :71,133 -- name colour
 * osucolour.cs:421 Blue0 #99ddff -> white on press, bold counts */
export function KeypressOverlay() {
	const scene = useViewerStore((s) => s.scene);
	const derived = useViewerStore((s) => s.derived);
	const visible = useViewerStore((s) => s.overlays.keyOverlay);
	const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

	useEffect(() => {
		if (!visible || scene === null || derived === null) return;
		let raf = 0;
		const loop = () => {
			const t = playbackClock.currentTime();
			const state = cursorStateAt(scene.frames, t);
			KEYS.forEach((key, i) => {
				const row = rowRefs.current[i];
				if (row === null) return;
				const held = state !== null && (state.buttons & key.bit) !== 0;
				row.dataset.held = String(held);
				const count = countAtOrBefore(derived.edges[key.edges], t);
				const countEl = row.querySelector("[data-count]")!;
				if (countEl.textContent !== String(count)) countEl.textContent = String(count);
			});
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [visible, scene, derived]);

	if (!visible || scene === null) return null;
	return (
		<div className="pointer-events-none absolute right-3 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-0.5">
			{KEYS.map((key, i) => (
				<div
					key={key.label}
					ref={(el) => {
						rowRefs.current[i] = el;
					}}
					data-held="false"
					className="group w-[52px] rounded-sm bg-zinc-900/70 p-1 backdrop-blur"
				>
					<div className="h-[4px] rounded-full bg-white opacity-50 transition-all duration-100 group-data-[held=true]:translate-y-[2px] group-data-[held=true]:opacity-100" />
					<div className="mt-1.5 text-[13px] font-bold leading-none text-[#99ddff] group-data-[held=true]:text-white">
						{key.label}
					</div>
					<div data-count className="text-[17px] font-bold leading-tight tabular-nums text-zinc-100">
						0
					</div>
				</div>
			))}
		</div>
	);
}
