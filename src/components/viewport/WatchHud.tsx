// the watch hud: merges today's HudReadout (combo + accuracy) and
// KeypressOverlay (key counter) verbatim in behaviour, restyled. both stay
// continuous consumers (decision 6) -- each rAF loop reads playbackClock
// directly and writes dom text/dataset, never react state. play/pause and
// mode itself are the only discrete inputs, read once per effect re-run.
//
// the mode gate is PER ELEMENT, not on the component: combo and accuracy
// mount in edit mode too, because they are the numbers an edit is made to
// change (CONTEXT.md's watch HUD), and their corners -- bottom-left and
// top-right -- are the two the edit-mode viewport leaves free. the HP bar
// stays watch-only because the tool palette holds its corner, and the key
// tiles because the timeline's hold lanes are already in view while editing.
// during a pending gesture these show the last LANDED simulation, which is
// what the store's authoritative simulation already is

import { useEffect, useRef } from "react";
import { PHYSICAL_BUTTONS } from "@/engine/buttons";
import { cursorStateAt } from "@/engine/interpolation";
import { comboPopAt, COMBO_AT_REST } from "@/lib/combo";
import { formatAccuracy } from "@/lib/format";
import { smoothedHpAt } from "@/lib/hp";
import { selectMotion } from "@/lib/motion";
import { scoreAt } from "@/lib/score";
import { countAtOrBefore, statsAt } from "@/lib/timeline";
import { useShellPresence } from "@/lib/use-presence";
import { cn } from "@/lib/utils";
import { playbackClock } from "@/playback/instance";
import { useViewerStore } from "@/state/store";

// physical keys, not raw bits -- a keyboard tap must light K1 alone, never
// K1 and M1 together (buttons.ts's PHYSICAL_BUTTONS)
const KEYS = PHYSICAL_BUTTONS;

// the severity ticks' own miss red, as channels because the combo counter
// mixes toward it rather than swapping to it. ONE declaration for both
// readouts that use it -- the HP bar's danger fill and the combo break --
// so "this is bad" cannot start reading two different reds
const MISS_RED_RGB = [237, 17, 33];
const REST_WHITE_RGB = [255, 255, 255];

// the HP bar's danger threshold and the two colours either side of it
const HP_LOW_FRACTION = 0.2;
const HP_FILL = "rgba(255,255,255,.92)";
const HP_FILL_LOW = `rgb(${MISS_RED_RGB.join(",")})`;

/** the digits' colour at a flash strength; the empty string at rest, which
 * hands the span back to the class its parent sets */
function comboColour(flash: number): string {
	if (flash <= 0) return "";
	const channel = (index: number) =>
		Math.round(REST_WHITE_RGB[index] + (MISS_RED_RGB[index] - REST_WHITE_RGB[index]) * flash);
	return `rgba(${channel(0)},${channel(1)},${channel(2)},.92)`;
}

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
			than re-querying by attribute every frame.

			data-hud-motion: this press transition is the watch HUD's own motion,
			not the chrome's, so the interface-motion master does not zero it
			(docs/adr/0009 draws that boundary; index.css keeps it) */}
			<div
				data-hud-motion
				className="h-[3px] rounded-full bg-white opacity-50 transition-all duration-100 group-data-[state=held]:translate-y-px group-data-[state=held]:opacity-100"
			/>
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
	const comboVisible = useViewerStore((s) => s.overlays.comboCounter);
	const accuracyVisible = useViewerStore((s) => s.overlays.accuracy);
	const scoreVisible = useViewerStore((s) => s.overlays.score);
	const motionEnabled = useViewerStore(selectMotion);
	const comboPopEnabled = useViewerStore((s) => s.interface.comboPop);
	const comboBoxRef = useRef<HTMLDivElement>(null);
	const comboRef = useRef<HTMLSpanElement>(null);
	const accuracyRef = useRef<HTMLDivElement>(null);
	const scoreRef = useRef<HTMLDivElement>(null);
	const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
	const hpFillRef = useRef<HTMLDivElement>(null);
	const hpReadoutRef = useRef<HTMLDivElement>(null);

	// combo/accuracy render only when the simulation is authoritative --
	// unchanged rule, carried over from HudReadout
	const authoritative = scene !== null && scene.simulation.status === "authoritative";

	// the HP bar's own mode gate, folded once here rather than re-read at each
	// of its three sites (the loop's branch, the effect's deps and the jsx)
	const hpActive = mode === "watch" && hpVisible;
	const keyActive = mode === "watch" && keyVisible;

	// the two watch-only mounts fade rather than drop on a mode switch. each
	// wrapper is always in the dom and only its opacity moves; the element
	// inside is presence-gated, and while it leaves the loops above stop
	// writing to it (their own flags are already false), so it fades holding
	// its last reading rather than snapping to a rest value
	const hpMount = useShellPresence(authoritative && hpActive, "opacity");
	const keyMount = useShellPresence(keyActive, "opacity");

	// the score needs a curve to read: null is a fold that never ran, which the
	// panel answers with the header's own total and which the HUD -- having no
	// second number to show -- answers by not drawing the line at all
	const scoreCurve = scene?.simulation.status === "authoritative" ? scene.simulation.scoreCurve : null;
	const scoreActive = scoreVisible && scoreCurve !== null;

	// the pop needs the counter on screen, the master on and its own row on.
	// off means comboPopAt is never called and the loop writes rest values --
	// a preference set to off is not a lookup answered "no", it is a lookup
	// not made
	const popActive = comboVisible && motionEnabled && comboPopEnabled;

	// combo, accuracy, the score and the HP bar share one loop: they read the
	// same clock tick and all four come from the same simulation. both curves
	// are the engine's -- the HP one is the very fold the .osr header's life
	// bar graph is written from, and the score one the fold its total score is
	// written from -- so no readout here can describe a different play from the
	// file's own numbers.
	//
	// the loop runs in BOTH modes, because combo and accuracy do. every
	// readout's own preference is tested INSIDE the loop rather than on the
	// effect: off must mean that element's lookup is not run at all, while its
	// neighbours keep running. the effect itself only stands down when nothing
	// at all is showing, since a rAF loop writing to four unmounted refs is
	// exactly the work these rows exist to avoid
	useEffect(() => {
		if (!authoritative || scene === null) return;
		if (!comboVisible && !accuracyVisible && !scoreActive && !hpActive) return;
		const events = scene.simulation.status === "authoritative" ? scene.simulation.events : [];
		const steps = scoreCurve ?? [];
		const curve = derived?.hp.curve ?? [];
		const changes = derived?.comboChanges ?? [];
		let raf = 0;
		let lastPercent = -1;
		let lastScore = -1;
		// the transform and the colour last written. NOT a "did the value change
		// since the last frame" check on the combo itself -- that is exactly the
		// violation `docs/adr/0009` names. the pop is a function of the clock's
		// time and the change list; these only spare the DOM a write of what it
		// already has.
		//
		// they start at a value no pop produces, so the FIRST frame always
		// writes: switching the pop off mid-animation re-runs this effect, and
		// starting them at rest would leave the stale transform on the counter
		// forever because the rest value it now wants already "matches"
		let lastScale = -1;
		let lastFlash = -1;
		const loop = () => {
			const now = playbackClock.currentTime();
			// combo and accuracy share ONE binary search rather than doing the
			// same one twice -- they read the same judgement event. it runs
			// while either row is on and not at all when both are off; each
			// element's own write stays behind its own row
			if (comboVisible || accuracyVisible) {
				const stats = statsAt(events, now);
				if (comboVisible && comboRef.current !== null) {
					comboRef.current.textContent = String(stats?.combo ?? 0);
				}
				if (accuracyVisible && accuracyRef.current !== null) {
					accuracyRef.current.textContent = stats === null ? "100.00%" : formatAccuracy(stats.accuracy);
				}
			}
			// the pop's phase is TIMELINE time -- the clock's time minus the last
			// combo change -- so a seek lands mid-pop on the frame playback would
			// have shown, a pause holds it there, and a landed edit rebuilds the
			// change list and pops nothing of its own (`docs/adr/0009`). the
			// number itself still comes from statsAt above and snaps
			const { scale, flash } = popActive ? comboPopAt(changes, now) : COMBO_AT_REST;
			if (scale !== lastScale && comboBoxRef.current !== null) {
				// grows from the counter's bottom-left anchor, which is the corner
				// it is positioned by: a pop must not walk the digits off the
				// playfield's edge
				comboBoxRef.current.style.transform = scale === 1 ? "" : `scale(${scale})`;
				lastScale = scale;
			}
			if (flash !== lastFlash && comboRef.current !== null) {
				comboRef.current.style.color = comboColour(flash);
				lastFlash = flash;
			}
			if (scoreActive) {
				// a step function, so the text only ever changes on a step -- the
				// same "write on change" the HP percentage does, and for the same
				// reason: toLocaleString on every frame for a number that moves a
				// few hundred times in a play is work nobody sees
				const score = scoreAt(steps, now);
				if (score !== lastScore && scoreRef.current !== null) {
					scoreRef.current.textContent = score.toLocaleString();
					lastScore = score;
				}
			}
			if (hpActive) {
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
	}, [scene, derived, authoritative, hpActive, comboVisible, accuracyVisible, scoreActive, scoreCurve, popActive]);

	useEffect(() => {
		if (!keyActive || scene === null || derived === null) return;
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
	}, [keyActive, scene, derived]);

	if (scene === null) return null;

	return (
		<>
			{/* top-left with the HUD's own margin. no miss flash (the popup and
			the overview strip already mark misses), no fill-up animation (HP is
			full at time zero, so there is nothing to fill up from) and no
			perfect-play ghost -- that needs a second curve out of the search.
			the wrapper is the mount FADE and is always in the dom, so a scene
			opening in watch mode shows the bar in place; no `inert`, since the
			whole cluster is pointer-events-none and holds nothing focusable */}
			<div
				data-motion-row="shell"
				onTransitionEnd={hpMount.onTransitionEnd}
				className={cn(
					"shell-hud-mount pointer-events-none absolute top-3.5 left-4 flex w-[40%] items-center gap-2",
					authoritative && hpActive ? "opacity-100" : "opacity-0"
				)}
			>
				{hpMount.mounted && (
					<>
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
					</>
				)}
			</div>
			{authoritative && comboVisible && (
				<div
					ref={comboBoxRef}
					style={{ transformOrigin: "bottom left" }}
					className="pointer-events-none absolute bottom-4 left-4 text-[34px] font-bold tracking-[-.01em] text-white/[.92] tabular-nums"
				>
					<span ref={comboRef}>0</span>
					<span className="text-[22px] text-white/60">x</span>
				</div>
			)}
			<div className="pointer-events-none absolute top-3.5 right-4 text-right">
				{authoritative && (
					<>
						{accuracyVisible && (
							<div ref={accuracyRef} className="text-[22px] font-semibold text-white/90 tabular-nums">
								100.00%
							</div>
						)}
						{/* the play's own score at the playhead, off the engine's score curve --
						the same fold an export's header total is written from. inside
						the authoritative guard beside combo and accuracy, because like
						them it is a SIMULATED number: an unsimulated replay hides it
						rather than showing the header's frozen total, which would be
						the one readout up here describing a different thing from the
						others. rests at 0 through the lead-in, as combo does */}
						{scoreActive && (
							<div
								ref={scoreRef}
								className="text-[10px] font-semibold tracking-[.1em] text-white/40 uppercase tabular-nums"
							>
								0
							</div>
						)}
					</>
				)}
			</div>
			{/* the mount fade sits OUTSIDE the indexed subtree on purpose: the
			loop above indexes into each tile's children by position, so a
			wrapper anywhere inside a tile would shift that indexing. no `inert`,
			for the reason the HP cluster has none: pointer-events-none with
			nothing focusable inside it */}
			<div
				data-motion-row="shell"
				onTransitionEnd={keyMount.onTransitionEnd}
				className={cn(
					"shell-hud-mount pointer-events-none absolute top-1/2 right-4 flex -translate-y-1/2 flex-col gap-[3px]",
					keyActive ? "opacity-100" : "opacity-0"
				)}
			>
				{keyMount.mounted &&
					KEYS.map((key, i) => (
						<KeyTile
							key={key.label}
							label={key.label}
							setRef={(el) => {
								rowRefs.current[i] = el;
							}}
						/>
					))}
			</div>
		</>
	);
}
