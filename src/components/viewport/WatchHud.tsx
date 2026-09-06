// watch-mode hud: merges today's HudReadout (combo + accuracy) and
// KeypressOverlay (key counter) verbatim in behaviour, restyled. both stay
// continuous consumers (decision 6) -- each rAF loop reads playbackClock
// directly and writes dom text/dataset, never react state. play/pause and
// mode itself are the only discrete inputs, read once per effect re-run

import { useEffect, useRef } from "react";
import { PHYSICAL_BUTTONS } from "@/engine/buttons";
import { cursorStateAt } from "@/engine/interpolation";
import { formatAccuracy } from "@/lib/format";
import { smoothedHpAt } from "@/lib/hp";
import { countAtOrBefore, statsAt } from "@/lib/timeline";
import { playbackClock } from "@/playback/instance";
import { useViewerStore } from "@/state/store";

// physical keys, not raw bits -- a keyboard tap must light K1 alone, never
// K1 and M1 together (buttons.ts's PHYSICAL_BUTTONS)
const KEYS = PHYSICAL_BUTTONS;

// the HP bar's danger threshold and the two colours either side of it. the
// low colour is the severity ticks' own miss red, so "this is bad" reads the
// same on the playfield as it does on the overview strip
const HP_LOW_FRACTION = 0.2;
const HP_FILL = "rgba(255,255,255,.92)";
const HP_FILL_LOW = "#ed1121";

// a fixed tile, rendered once; the rAF loop below only ever rewrites its
// dataset state (held/zero) and the count text, never creates or destroys a
// tile -- matches the fixed-row pattern FramesPanel/KeypressPanel use
function KeyTile({ label, setRef }: { label: string; setRef: (el: HTMLDivElement | null) => void }) {
	return (
		<div
			ref={setRef}
			data-state=""
			className="group w-[50px] rounded-[5px] border border-white/5 bg-[#0c0c0f]/[.72] px-[5px] pt-[5px] pb-1 backdrop-blur-[6px]"
		>
			{/* fixed child order -- the loop below indexes into el.children rather
			than re-querying by attribute every frame */}
			<div className="h-[3px] rounded-full bg-white opacity-50 transition-all duration-100 group-data-[state=held]:translate-y-px group-data-[state=held]:opacity-100" />
			<div className="mt-1.5 text-[13px] leading-none font-bold text-[#99ddff] group-data-[state=held]:text-white group-data-[state=zero]:text-[#8a8a93]">
				{label}
			</div>
			<div className="text-[17px] leading-tight font-bold tabular-nums text-zinc-100 group-data-[state=zero]:text-[#8a8a93]">
				0
			</div>
		</div>
	);
}

export function WatchHud() {
	const mode = useViewerStore((s) => s.mode);
	const scene = useViewerStore((s) => s.scene);
	const derived = useViewerStore((s) => s.derived);
	const keyVisible = useViewerStore((s) => s.overlays.keyOverlay);
	const hpVisible = useViewerStore((s) => s.overlays.hpBar);
	const comboRef = useRef<HTMLSpanElement>(null);
	const accuracyRef = useRef<HTMLDivElement>(null);
	const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
	const hpFillRef = useRef<HTMLDivElement>(null);
	const hpReadoutRef = useRef<HTMLDivElement>(null);

	// combo/accuracy render only when the simulation is authoritative --
	// unchanged rule, carried over from HudReadout
	const authoritative = scene !== null && scene.simulation.status === "authoritative";

	// combo, accuracy and the HP bar share one loop: they read the same clock
	// tick, and the HP bar's own value comes from the same simulation the
	// other two do. the HP curve is the engine's -- the very fold the .osr
	// header's life bar graph is written from -- so the bar and the header can
	// never describe different plays.
	//
	// the bar is gated exactly as combo and accuracy are, plus its own
	// preference, and the preference is tested INSIDE the loop rather than on
	// the effect: off must mean no HP is evaluated, while combo and accuracy
	// keep running
	useEffect(() => {
		if (mode !== "watch" || !authoritative || scene === null) return;
		const events = scene.simulation.status === "authoritative" ? scene.simulation.events : [];
		const curve = derived?.hp.curve ?? [];
		let raf = 0;
		let lastPercent = -1;
		const loop = () => {
			const now = playbackClock.currentTime();
			const stats = statsAt(events, now);
			if (comboRef.current !== null) comboRef.current.textContent = String(stats?.combo ?? 0);
			if (accuracyRef.current !== null) {
				accuracyRef.current.textContent = stats === null ? "100.00%" : formatAccuracy(stats.accuracy);
			}
			if (hpVisible) {
				// the damped reading, not the raw one: a pure function of time, so
				// seeking to a moment and playing into it fill the bar identically
				const fraction = smoothedHpAt(curve, now);
				if (hpFillRef.current !== null) {
					hpFillRef.current.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
					hpFillRef.current.style.backgroundColor = fraction < HP_LOW_FRACTION ? HP_FILL_LOW : HP_FILL;
				}
				const percent = Math.round(fraction * 100);
				if (percent !== lastPercent && hpReadoutRef.current !== null) {
					hpReadoutRef.current.textContent = `${percent}%`;
					lastPercent = percent;
				}
			}
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [mode, scene, derived, authoritative, hpVisible]);

	useEffect(() => {
		if (mode !== "watch" || !keyVisible || scene === null || derived === null) return;
		const frames = scene.frames;
		const edges = derived.edges;
		let raf = 0;
		const loop = () => {
			const t = playbackClock.currentTime();
			const cursor = cursorStateAt(frames, t);
			KEYS.forEach((key, i) => {
				const row = rowRefs.current[i];
				if (row === null) return;
				const held = cursor !== null && key.is(cursor.buttons);
				const count = countAtOrBefore(edges[key.edgesKey], t);
				row.dataset.state = held ? "held" : count === 0 ? "zero" : "";
				const countEl = row.children[2] as HTMLElement;
				if (countEl.textContent !== String(count)) countEl.textContent = String(count);
			});
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [mode, keyVisible, scene, derived]);

	if (mode !== "watch" || scene === null) return null;

	return (
		<>
			{authoritative && hpVisible && (
				/* top-left with the HUD's own margin. no miss flash (the popup and
				the overview strip already mark misses), no fill-up animation (HP is
				full at time zero, so there is nothing to fill up from) and no
				perfect-play ghost -- that needs a second curve out of the search */
				<div className="pointer-events-none absolute top-3.5 left-4 flex w-[40%] items-center gap-2">
					<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[.12]">
						<div
							ref={hpFillRef}
							className="h-full w-full rounded-full"
							style={{ backgroundColor: HP_FILL }}
						/>
					</div>
					<div
						ref={hpReadoutRef}
						className="text-[10px] font-semibold tracking-[.1em] text-white/40 uppercase tabular-nums"
					>
						100%
					</div>
				</div>
			)}
			{authoritative && (
				<div className="pointer-events-none absolute bottom-4 left-4 text-[34px] font-bold tracking-[-.01em] text-white/[.92] tabular-nums">
					<span ref={comboRef}>0</span>
					<span className="text-[22px] text-white/60">x</span>
				</div>
			)}
			<div className="pointer-events-none absolute top-3.5 right-4 text-right">
				{authoritative && (
					<div ref={accuracyRef} className="text-[22px] font-semibold text-white/90 tabular-nums">
						100.00%
					</div>
				)}
				{/* the header's totalScore, frozen at load -- there is no score
				simulator, so unlike combo/accuracy this never tracks playback.
				always rendered, unlike the accuracy line above: totalScore comes
				straight from the .osr header and is available for every replay,
				while accuracy needs an authoritative simulation, which mods.rs
				being NoMod-only means most replays never get */}
				<div className="text-[10px] font-semibold tracking-[.1em] text-white/40 uppercase">
					{scene.replay.totalScore.toLocaleString()}
				</div>
			</div>
			{keyVisible && (
				<div className="pointer-events-none absolute top-1/2 right-4 flex -translate-y-1/2 flex-col gap-[3px]">
					{KEYS.map((key, i) => (
						<KeyTile
							key={key.label}
							label={key.label}
							setRef={(el) => {
								rowRefs.current[i] = el;
							}}
						/>
					))}
				</div>
			)}
		</>
	);
}
