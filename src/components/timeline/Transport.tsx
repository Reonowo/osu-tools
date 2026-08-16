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

import { useEffect, useRef, type ReactNode } from "react";
import {
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
import { speakerState, type VolumeLevels } from "@/playback/audio-levels";
import { frameCursor } from "@/playback/frame-cursor";
import { playbackClock } from "@/playback/instance";
import { keybindSuffix } from "@/playback/keybinds";
import { stepFrame } from "@/playback/use-playback-shortcuts";
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
	// all four of these buttons name a key, and all four keys are rebindable
	// now: read the effective table so a hint cannot go on advertising one the
	// user has moved or taken away
	const keybinds = useViewerStore((s) => s.effectiveKeybinds);

	const currentTimeRef = useRef<HTMLSpanElement>(null);
	const totalTimeRef = useRef<HTMLSpanElement>(null);
	const frameIndexRef = useRef<HTMLSpanElement>(null);

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
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [scene]);

	if (scene === null) return null;
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
