// the timeline dock's bottom tier: restart/play-pause/frame-step, the time
// and frame readouts, and the rate/volume groups. this is Controls.tsx
// (deleted in task 13, whose HudReadout half moved into the watch hud)
// restyled into the docked shell -- its play/pause/restart/rate/volume
// wiring and the rAF-driven time readout carry over verbatim, just re-themed
// to the row's own geometry. the time and frame readouts are continuous
// consumers (decision 6): one rAF loop reads playbackClock, reads the frame
// index off the shared frameCursor (the same one ToolPalette's
// CoordinateReadout and FramesPanel's row selection read/write), and writes
// straight to dom refs, never through react state. play/pause/rate/volume stay discrete
// toggles through the store; restart and frame-stepping seek playbackClock
// directly, exactly as Controls.tsx did. keyboard shortcuts and wheel
// frame-stepping live in AppShell's single usePlaybackShortcuts() call --
// this file never adds a second one

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
	ChevronLeft,
	ChevronRight,
	Pause,
	Play,
	SkipBack,
	SlidersHorizontal,
	StepBack,
	StepForward,
	Volume1,
	Volume2,
	VolumeX
} from "lucide-react";
import type { SettingsCategory } from "@/components/settings/categories";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatTime } from "@/lib/format";
import { NO_SEVERITY_TARGETS, SEVERITY_GRADES, type SeverityGrade } from "@/lib/judgement-nav";
import { simulationReasonText } from "@/lib/simulation";
import { cn } from "@/lib/utils";
import { speakerState, type VolumeLevels } from "@/playback/audio-levels";
import { frameCursor } from "@/playback/frame-cursor";
import { playbackClock } from "@/playback/instance";
import { keybindSuffix, SEVERITY_JUMP_KEYBINDS, type EffectiveKeybind } from "@/playback/keybinds";
import { severityJumpNow, severitySeek, stepFrame } from "@/playback/use-playback-shortcuts";
import { useViewerStore } from "@/state/store";

// restart and the two frame-step buttons share one flanking style; only
// play/pause gets the primary treatment
const FLANKING_BUTTON_CLASS = "size-[30px] rounded-lg";

// osu!'s own rate choices; every label carries the U+00D7 multiplication
// sign uniformly, matching Controls.tsx's own "{r}x" suffix on all six --
// this redesign spells it with the real glyph rather than the ascii letter,
// the same reason the analysis panel uses a real minus (U+2212) instead of a
// hyphen
const RATES: { value: number; label: string }[] = [
	{ value: 0.25, label: "0.25×" },
	{ value: 0.5, label: "0.5×" },
	{ value: 0.75, label: "0.75×" },
	{ value: 1, label: "1×" },
	{ value: 1.5, label: "1.5×" },
	{ value: 2, label: "2×" }
];

// ---------------------------------------------------------------------------
// severity jump
// ---------------------------------------------------------------------------

/** the three chips, left to right, in the overview strip's own severity
 * colours (OverviewStrip's TICK_CLASS) so the control and the readout it
 * navigates read as one system. text labels rather than glyphs: a lucide `X`
 * for miss reads as "close" everywhere else in this app, and three tiny
 * coloured icons would need a legend this row has no space for.
 *
 * `100` and `50` are what the app calls the grades the wire spells `ok` and
 * `meh` -- one pair of names for one thing (CONTEXT.md) */
const SEVERITY_CHIP_STYLES: Record<SeverityGrade, { label: string; plural: string; className: string }> = {
	ok: { label: "100", plural: "100s", className: "border-[#88b300]/40 bg-[#88b300]/10 text-[#88b300]" },
	meh: { label: "50", plural: "50s", className: "border-[#ffcc22]/40 bg-[#ffcc22]/10 text-[#ffcc22]" },
	miss: { label: "miss", plural: "misses", className: "border-[#ed1121]/45 bg-[#ed1121]/12 text-[#ed1121]" }
};

/** keyed by grade and rendered in the module's own order, the way the tool
 * palette's tiles are: a fourth navigable grade cannot reach the number keys
 * while this row silently grows no chip for it -- the record stops compiling */
const SEVERITY_CHIPS = SEVERITY_GRADES.map((grade) => ({ grade, ...SEVERITY_CHIP_STYLES[grade] }));

/** the six buttons in one fixed order: the ref array's, and the order the rAF
 * loop walks. one ordering for both, so the loop cannot write one button's
 * answer onto another's */
const SEVERITY_SLOTS: { grade: SeverityGrade; direction: 1 | -1 }[] = SEVERITY_CHIPS.flatMap(({ grade }) => [
	{ grade, direction: -1 as const },
	{ grade, direction: 1 as const }
]);

const slotIndex = (grade: SeverityGrade, direction: 1 | -1) =>
	SEVERITY_SLOTS.findIndex((slot) => slot.grade === grade && slot.direction === direction);

const JUMP_BUTTON_CLASS =
	"flex size-[22px] items-center justify-center rounded-md text-[#71717a] transition-colors " +
	"hover:bg-muted hover:text-[#e4e4e7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 " +
	"disabled:pointer-events-none disabled:opacity-35";

/** what the tooltip says: what the button does, the key it currently answers
 * to, and -- when it is inert -- which of the three independent reasons it is.
 * the count is the part only a human ever reads, which is why it is passed in
 * from the tooltip's own open rather than computed every frame */
function jumpTooltip(
	named: string,
	direction: 1 | -1,
	chip: (typeof SEVERITY_CHIPS)[number],
	reason: string | null,
	total: number,
	remaining: number
): string {
	// the whole cluster's reason, in the status bar's own words for the same
	// fact -- the two surfaces read the same helper so they cannot drift
	if (reason !== null) return `${named} — ${reason}`;
	if (total === 0) return `${named} — this replay has no ${chip.plural}`;
	const where = direction === 1 ? "ahead" : "behind";
	if (remaining === 0) return `${named} — no more ${chip.plural} ${where}`;
	// "1 more 50" rather than "1 50": two numbers in a row read as one
	return `${named} — ${remaining} more ${remaining === 1 ? chip.label : chip.plural} ${where}`;
}

/** one chevron. it clicks straight through to what its key does -- the same
 * shared answer, never a second copy of the landing-time formula, the ordering
 * or the never-wrap rule */
function SeverityJumpButton({
	chip,
	direction,
	keybinds,
	reason,
	total,
	buttons
}: {
	chip: (typeof SEVERITY_CHIPS)[number];
	direction: 1 | -1;
	keybinds: readonly EffectiveKeybind[];
	reason: string | null;
	total: number;
	buttons: RefObject<(HTMLButtonElement | null)[]>;
}) {
	const [remaining, setRemaining] = useState(0);
	const entry = SEVERITY_JUMP_KEYBINDS[chip.grade][direction === 1 ? "next" : "previous"];
	// the entry's own label is already the sentence this control needs ("jump
	// to the next 100"), and the key comes off the effective table, so a rebind
	// reaches this tooltip without the button knowing anything about it
	const named = `${entry.label}${keybindSuffix(keybinds, entry.action)}`;
	const index = slotIndex(chip.grade, direction);
	const readRemaining = () => setRemaining(severityJumpNow(chip.grade, direction).remaining);
	return (
		<Tooltip
			// a tooltip that is not showing must cost nothing, and only a human
			// ever reads the number: the count is taken when it opens, and again
			// on the one thing that changes it while it is open -- a click on the
			// button it is describing. never per frame
			onOpenChange={(open) => {
				if (open) readRemaining();
			}}
		>
			{/* a natively-disabled button fires no hover events, so the trigger is
			the wrapping span -- the same reason the tool palette's tiles wrap
			theirs, and what keeps a disabled control explained rather than mute */}
			<TooltipTrigger render={<span />}>
				<button
					type="button"
					// no `disabled` PROP, and that absence is load-bearing: react
					// refuses to dispatch onClick on an interactive element whose
					// props say disabled, whatever the dom property says
					// (shouldPreventMouseEvent, react-dom). rendering it disabled and
					// clearing the property from the loop therefore produced a button
					// that looked live, styled live, took the click natively -- and
					// never reached this handler. the dom property is the whole state
					// instead: written here on mount so the control paints its real
					// answer on the frame it appears, and by the rAF loop after. react
					// never writes a prop it was not given, so the two cannot fight,
					// and :disabled styling and the browser's own click suppression
					// both follow the property this owns
					ref={(element) => {
						buttons.current[index] = element;
						if (element !== null) {
							element.disabled = severityJumpNow(chip.grade, direction).target === null;
						}
					}}
					aria-label={entry.label}
					onClick={() => {
						severitySeek(chip.grade, direction);
						// the pointer is still on the button, so the tooltip is still
						// open and now describes a count its own click just spent
						readRemaining();
					}}
					className={JUMP_BUTTON_CLASS}
				>
					{direction === 1 ? (
						<ChevronRight aria-hidden className="size-3.5" />
					) : (
						<ChevronLeft aria-hidden className="size-3.5" />
					)}
				</button>
			</TooltipTrigger>
			<TooltipContent>{jumpTooltip(named, direction, chip, reason, total, remaining)}</TooltipContent>
		</Tooltip>
	);
}

/** the speaker glyph tracks the level, exactly as Controls.tsx did, and clicking
 * it mutes -- the convention every media player trains, which is why it stays
 * the mute and never the way into the audio modal (the sliders button beside
 * the readout is that affordance instead).
 *
 * the glyph's state is not just the master's: audio-levels.ts folds all three
 * channels, so a master at 70 with music and hitsounds both silent reads muted
 * rather than 70%. the CLICK is the master's alone, because the master is the
 * slider sitting next to it -- which means the one case where the two disagree
 * (a fold that reads muted because both children are zero) mutes the master on
 * the first click rather than restoring anything. that is the honest reading:
 * the glyph is never made to lie, and the two clicks still get you back */
function VolumeButton({ levels, onToggle }: { levels: VolumeLevels; onToggle: () => void }) {
	const state = speakerState(levels);
	const Icon = state === "muted" ? VolumeX : state === "low" ? Volume1 : Volume2;
	const muted = levels.master <= 0;
	return (
		<IconAction
			label={muted ? "unmute" : "mute"}
			tooltip={muted ? "restore the volume this muted" : "mute"}
			className="size-[26px] rounded-lg"
			onClick={onToggle}
		>
			<Icon />
		</IconAction>
	);
}

/** an icon-only ghost button and its tooltip. the aria-label names the
 * control for screen readers; the tooltip says what it does, which for the
 * frame steppers is the part a glyph cannot carry */
function IconAction({
	label,
	tooltip,
	className,
	onClick,
	children
}: {
	label: string;
	tooltip: string;
	className: string;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button size="icon" variant="ghost" aria-label={label} className={className} onClick={onClick}>
						{children}
					</Button>
				}
			/>
			<TooltipContent>{tooltip}</TooltipContent>
		</Tooltip>
	);
}

export function Transport({ onOpenSettings }: { onOpenSettings: (category?: SettingsCategory) => void }) {
	const scene = useViewerStore((s) => s.scene);
	const playing = useViewerStore((s) => s.playing);
	const rate = useViewerStore((s) => s.rate);
	const volume = useViewerStore((s) => s.volume);
	const audio = useViewerStore((s) => s.audio);
	const setPlaying = useViewerStore((s) => s.setPlaying);
	const setRate = useViewerStore((s) => s.setRate);
	const setVolume = useViewerStore((s) => s.setVolume);
	const toggleMute = useViewerStore((s) => s.toggleMute);
	// every button here names a key, and every one of those keys is rebindable:
	// read the effective table so a hint cannot go on advertising one the user
	// has moved or taken away
	const keybinds = useViewerStore((s) => s.effectiveKeybinds);
	// per-scene and discrete, so it comes through react rather than the loop
	// below: how many of each grade the whole replay holds, which is what tells
	// a permanently-dead button apart from one that has simply run out. the
	// module constant keeps this selector referentially stable with no scene
	const severityTargets = useViewerStore((s) => s.derived?.severityTargets ?? NO_SEVERITY_TARGETS);

	const currentTimeRef = useRef<HTMLSpanElement>(null);
	const totalTimeRef = useRef<HTMLSpanElement>(null);
	const frameIndexRef = useRef<HTMLSpanElement>(null);
	const jumpButtonsRef = useRef<(HTMLButtonElement | null)[]>([]);

	// the transport's only continuous consumers -- current time, total time,
	// and the frame index -- all read the same clock tick, so one loop drives
	// every dom write instead of one loop per readout
	useEffect(() => {
		if (scene === null) return;
		let raf = 0;
		const loop = () => {
			const t = playbackClock.currentTime();
			if (currentTimeRef.current !== null) currentTimeRef.current.textContent = formatTime(t);
			// re-read maxTime every tick rather than a captured bound: the clock's
			// max extends once the audio's metadata loads (see OverviewStrip), and
			// this readout must pick that up exactly as Controls.tsx did
			if (totalTimeRef.current !== null) totalTimeRef.current.textContent = formatTime(playbackClock.maxTime);
			// 0-indexed, matching ToolPalette's coordinate readout and the
			// frames/keys panels -- frameCursor resolves any exact row selection,
			// falling back to the last frame at-or-before t
			if (frameIndexRef.current !== null) frameIndexRef.current.textContent = String(frameCursor.currentIndex());
			// "nothing lies ahead of the playhead" is continuous -- it changes as
			// the replay plays -- so the six enabled flags join this loop rather
			// than getting one of their own. each answer is a binary search over a
			// list of at most a few hundred entries, and the dom write only happens
			// when an answer actually changes.
			//
			// a scene with no authoritative simulation needs no branch here: it has
			// no severity ticks at all, so every list is empty and all six come out
			// disabled by this same test. that reason changes only what the
			// tooltips say
			for (const [index, slot] of SEVERITY_SLOTS.entries()) {
				const button = jumpButtonsRef.current[index] ?? null;
				if (button === null) continue;
				const disabled = severityJumpNow(slot.grade, slot.direction).target === null;
				if (button.disabled !== disabled) button.disabled = disabled;
			}
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [scene]);

	if (scene === null) return null;
	// the one reason that disables the whole cluster at once, and the only one
	// that changes the tooltips' voice. the cluster stays mounted on such a
	// scene: hiding it would make the feature look absent rather than
	// inapplicable
	const notSimulatedReason =
		scene.simulation.status === "notSimulated" ? simulationReasonText(scene.simulation.reason) : null;
	return (
		<div className="flex items-center gap-[7px] px-2.5 py-1.5">
			<IconAction
				label="restart"
				tooltip={`jump back to the start of the replay${keybindSuffix(keybinds, "restart")}`}
				className={FLANKING_BUTTON_CLASS}
				onClick={() => playbackClock.seekTo(playbackClock.minTime)}
			>
				<SkipBack />
			</IconAction>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							size="icon"
							aria-label={playing ? "pause" : "play"}
							className="size-8 rounded-[9px] bg-primary text-primary-foreground hover:bg-[#ff87bc] hover:-translate-y-px"
							onClick={() => setPlaying(!playing)}
						>
							{playing ? <Pause /> : <Play />}
						</Button>
					}
				/>
				<TooltipContent>
					{playing ? "pause" : "play"}
					{keybindSuffix(keybinds, "playPause")}
				</TooltipContent>
			</Tooltip>
			<IconAction
				label="previous frame"
				tooltip={`step back exactly one replay frame, not a fixed interval${keybindSuffix(keybinds, "frameStepBack")}`}
				className={FLANKING_BUTTON_CLASS}
				onClick={() => stepFrame(-1)}
			>
				<StepBack />
			</IconAction>
			<IconAction
				label="next frame"
				tooltip={`step forward exactly one replay frame, not a fixed interval${keybindSuffix(keybinds, "frameStepForward")}`}
				className={FLANKING_BUTTON_CLASS}
				onClick={() => stepFrame(1)}
			>
				<StepForward />
			</IconAction>

			<Separator orientation="vertical" className="h-5" />

			{/* severity jump: the only way to the judgements the overview strip
			marks. six plain buttons rather than a grade filter plus one pair --
			five controls instead of six, but a navigation control that silently
			changes what it will do next is the failure this feature exists to
			avoid, and stateless means the button under the cursor is the whole
			promise.

			no component test, deliberately: this repo renders components to
			static markup through react-dom/server with no dom, no rAF and no
			interaction, so a test here could assert only that six buttons exist
			and nothing about the state that makes them correct. every decision
			they carry is tested at lib/judgement-nav.test.ts, and what is left --
			the rAF-driven disabled state and the seek under a running clock --
			is the human pass with a real replay (AGENTS.md) */}
			<div className="flex items-center gap-1">
				{SEVERITY_CHIPS.map((chip) => (
					<div key={chip.grade} className="flex items-center">
						<SeverityJumpButton
							chip={chip}
							direction={-1}
							keybinds={keybinds}
							reason={notSimulatedReason}
							total={severityTargets[chip.grade].length}
							buttons={jumpButtonsRef}
						/>
						{/* the chip dims with its own pair, at the same strength the
						disabled chevrons take: a grade the replay never produced, and a
						cluster with no simulation behind it at all, are both wholly
						inert, and a lit label over two dead arrows would read as half
						available. it dims on the two per-scene reasons only -- running
						out in one direction leaves the other live, so the label stays
						lit and the chevrons carry that answer alone */}
						<span
							aria-hidden
							className={cn(
								"rounded-[5px] border px-1 py-px font-mono text-[10px] leading-[14px] font-semibold tabular-nums",
								chip.className,
								(notSimulatedReason !== null || severityTargets[chip.grade].length === 0) &&
									"opacity-35"
							)}
						>
							{chip.label}
						</span>
						<SeverityJumpButton
							chip={chip}
							direction={1}
							keybinds={keybinds}
							reason={notSimulatedReason}
							total={severityTargets[chip.grade].length}
							buttons={jumpButtonsRef}
						/>
					</div>
				))}
			</div>

			<Separator orientation="vertical" className="h-5" />

			<div className="flex items-baseline gap-0.5 font-mono">
				<span ref={currentTimeRef} className="text-[13px] text-[#f4f4f5] tabular-nums" />
				<span className="text-[#3f3f46]">/</span>
				<span ref={totalTimeRef} className="text-[11px] text-[#71717a] tabular-nums" />
			</div>

			<Separator orientation="vertical" className="h-5" />

			<span className="font-mono text-[10.5px] text-[#71717a] tabular-nums">
				{/* denominator is the last frame index, matching the readout above's
				0-indexing -- guarded so an empty (never-happens-post-null-check, but
				cheap to guard) frame list can't render frame 0 / -1 */}
				frame <span ref={frameIndexRef}>0</span> / {Math.max(0, scene.frames.length - 1)}
			</span>

			<div className="ml-auto flex items-center gap-2">
				<ToggleGroup
					value={[String(rate)]}
					onValueChange={(next) => {
						// base-ui's toggle group value is array-valued even in
						// single-select mode, and clicking the already-active item
						// empties it -- the group stays controlled by `rate`, so an
						// empty result is ignored rather than clearing it to undefined
						const chosen = next[0];
						if (chosen !== undefined) setRate(Number(chosen));
					}}
					className="h-[26px] rounded-[7px] border border-border bg-[#131316] p-0.5"
				>
					{RATES.map(({ value, label }) => (
						<ToggleGroupItem
							key={value}
							value={String(value)}
							className="h-full rounded-[5px] px-2 text-[10.5px] text-[#71717a] aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:font-bold"
						>
							{label}
						</ToggleGroupItem>
					))}
				</ToggleGroup>

				<div className="flex items-center gap-2">
					<VolumeButton
						levels={{ master: volume, music: audio.musicVolume, hitsound: audio.hitsoundVolume }}
						onToggle={toggleMute}
					/>
					<Slider
						// shrink-0 or the ml-auto group squeezes the track away entirely,
						// same trap Controls.tsx's own comment called out: the thumb is
						// the only non-shrinkable part, so a bare width alone collapses
						// to it
						className="w-[86px] shrink-0"
						aria-label="master volume"
						min={0}
						max={100}
						step={1}
						value={[volume]}
						onValueChange={(v) => setVolume(Array.isArray(v) ? v[0] : v)}
					/>
					<span className="w-[30px] text-right font-mono text-[10.5px] text-[#71717a] tabular-nums">
						{volume}%
					</span>
					{/* after the readout rather than replacing the speaker: the
					    speaker stays passive (see VolumeIcon), and the master slider
					    stays the thing you reach for mid-replay while everything
					    else is one click further */}
					<IconAction
						label="audio settings"
						tooltip="music and hitsound levels, and the rest of the audio settings"
						className="size-[26px] rounded-lg"
						onClick={() => onOpenSettings("audio")}
					>
						<SlidersHorizontal />
					</IconAction>
				</div>
			</div>
		</div>
	);
}
