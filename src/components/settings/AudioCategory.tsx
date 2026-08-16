// audio: everything that makes a sound -- the volume channels, the hit samples
// and the offset that syncs them to the music.
//
// this deliberately does NOT mirror lazer's global settings split, which files
// the positional level and the combo-break flag under
// Sections/Gameplay/AudioSettings and beatmap hitsounds under
// Sections/Gameplay/BeatmapSettings, leaving Sections/Audio holding only the
// output device, the volumes and the offset. that split is "output plumbing vs
// how a play behaves", and it does not carry: this app has no gameplay to
// configure, so its gameplay category is background dim and render effects --
// entirely visual -- and a hit-samples section there was the one audible row
// in a tab about what gets drawn.
//
// lazer's own replay-side surface agrees. PlayerSettings/AudioSettings.cs, the
// group ReplayPlayer shows during playback, is titled "Audio" and holds
// beatmap hitsounds plus the offset control. a replay viewer is that surface,
// not the game's options screen.
//
// the master is mirrored here and on the transport on purpose -- lazer does
// the same (VolumeSettings.cs), because one of them is the drag you reach for
// mid-replay and the other is the one you set beside the channels it
// multiplies

import { SectionLabel } from "@/components/panels/SectionLabel";
import { InertNotice } from "@/components/panels/InertNotice";
import { ToggleRow } from "@/components/settings/ToggleRow";
import { NumberField } from "@/components/ui/number-field";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AUDIO_OFFSET_MAX, AUDIO_OFFSET_MIN, VOLUME_MAX, VOLUME_MIN } from "@/state/defaults";
import { useViewerStore, type AudioSettings, type GameplaySettings } from "@/state/store";

/** the audio group's own toggles, as data -- categories.test.ts reads this
 * to assert every persisted audio pref reaches a control */
export const AUDIO_TOGGLES: { key: keyof AudioSettings; label: string; description: string }[] = [
	{
		key: "ignoreBeatmapHitsounds",
		label: "ignore beatmap hitsounds",
		description:
			"drops the map's own sample FILES and plays the default set instead. the map's hitsound DESIGN -- which bank each object draws from, which additions fire, how loud each one is -- is object data and keeps applying either way"
	}
];

/**
 * the hit-sample toggles this category renders out of the GAMEPLAY prefs
 * group, named for the group they store under rather than the tab they appear
 * in -- every other descriptor array in the dialog is named that way too, and
 * here the mismatch is the point.
 *
 * these persist under `gameplay` (settings.rs GameplayPrefs) because that is
 * where they have always persisted; the keys were left alone when the controls
 * moved so no existing settings file needs migrating. which tab a control
 * renders in and which group it serialises under are separate questions, and
 * categories.ts is what keeps the answer to the first one honest
 */
export const GAMEPLAY_TOGGLES: { key: keyof GameplaySettings; label: string; description: string }[] = [
	{
		key: "alwaysPlayFirstComboBreak",
		label: "always play the first combo break",
		description:
			"the combo-break sound normally needs a combo above 20 to fire. with this on, the play's FIRST break always sounds however small the combo was -- matching osu!'s own default"
	}
];

/** the two channels under the master, as data -- categories.test.ts reads
 * this to assert every persisted audio pref reaches a control */
export const AUDIO_CHANNELS: { key: keyof AudioSettings; label: string; description: string }[] = [
	{
		key: "musicVolume",
		label: "music",
		description: "the beatmap's own audio track. the master multiplies it, so this at 0 leaves hitsounds audible"
	},
	{
		key: "hitsoundVolume",
		label: "hitsounds",
		description:
			"the samples objects make as they are judged. the master multiplies it, so this at 0 leaves the music playing"
	}
];

function VolumeRow({
	label,
	description,
	value,
	disabled,
	onChange
}: {
	label: string;
	description: string;
	value: number;
	disabled?: boolean;
	onChange: (value: number) => void;
}) {
	return (
		<label
			className="flex items-center justify-between gap-4 text-sm data-disabled:opacity-50"
			data-disabled={disabled || undefined}
		>
			{label}
			<span className="flex items-center gap-2">
				<Tooltip>
					<TooltipTrigger render={<span />}>
						<Slider
							// shrink-0 keeps the track from collapsing to its thumb
							// inside the flex row (Transport.tsx carries the same note)
							className="w-[110px] shrink-0"
							aria-label={label}
							min={VOLUME_MIN}
							max={VOLUME_MAX}
							step={1}
							disabled={disabled}
							value={[value]}
							onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
						/>
					</TooltipTrigger>
					<TooltipContent side="left">{description}</TooltipContent>
				</Tooltip>
				<span className="w-[30px] text-right font-mono text-[10.5px] text-[#71717a] tabular-nums">
					{value}%
				</span>
			</span>
		</label>
	);
}

export function AudioCategory({
	draftOffset,
	onDraftOffsetChange,
	onCommitOffset
}: {
	/** the offset field's uncommitted draft, owned by SettingsDialog so a
	 * half-typed value survives a category switch */
	draftOffset: number | null;
	onDraftOffsetChange: (value: number | null) => void;
	onCommitOffset: (value: number | null) => void;
}) {
	const volume = useViewerStore((s) => s.volume);
	const setVolume = useViewerStore((s) => s.setVolume);
	const audio = useViewerStore((s) => s.audio);
	const setAudio = useViewerStore((s) => s.setAudio);
	const gameplay = useViewerStore((s) => s.gameplay);
	const setGameplay = useViewerStore((s) => s.setGameplay);
	// what governs nothing right now, and why. with NO scene every control
	// stays live: these are ordinary preferences, and the start screen opens
	// settings for exactly that
	const scene = useViewerStore((s) => s.scene);
	const noAudioFile = scene !== null && scene.audioPath === null;
	const notSimulated = scene !== null && scene.simulation.status !== "authoritative";

	return (
		<div className="grid gap-4">
			<section className="space-y-2">
				<SectionLabel>volume</SectionLabel>
				<VolumeRow
					label="master"
					description="multiplies both channels below; the transport's slider is this same setting"
					value={volume}
					onChange={setVolume}
				/>
				{AUDIO_CHANNELS.map(({ key, label, description }) => (
					<VolumeRow
						key={key}
						label={label}
						description={description}
						value={audio[key] as number}
						disabled={key === "musicVolume" ? noAudioFile : notSimulated}
						onChange={(value) => setAudio(key, value)}
					/>
				))}
			</section>

			{/* one section for all three rather than a lone "beatmap" toggle beside
			    a pair: which files play, how they are panned, and whether a break
			    sounds are the same question asked three ways. the two groups are
			    rendered separately only because they persist under different
			    prefs and therefore take different setters */}
			<section className="space-y-2">
				<SectionLabel>hit samples</SectionLabel>
				<label className="flex items-center justify-between gap-4 text-sm">
					positional hitsounds
					<span className="flex items-center gap-2">
						<Tooltip>
							<TooltipTrigger render={<span />}>
								<Slider
									// shrink-0 for the reason VolumeRow above carries
									className="w-[110px] shrink-0"
									aria-label="positional hitsounds"
									min={0}
									max={100}
									step={1}
									value={[Math.round(gameplay.positionalHitsoundLevel * 100)]}
									onValueChange={(v) =>
										setGameplay("positionalHitsoundLevel", (Array.isArray(v) ? v[0] : v) / 100)
									}
								/>
							</TooltipTrigger>
							<TooltipContent side="left">
								how far a hit sample is panned toward its object's side of the playfield. 0 centres
								everything; osu!'s own default is 20%
							</TooltipContent>
						</Tooltip>
						<span className="w-[30px] text-right font-mono text-[10.5px] text-[#71717a] tabular-nums">
							{Math.round(gameplay.positionalHitsoundLevel * 100)}%
						</span>
					</span>
				</label>
				{AUDIO_TOGGLES.map(({ key, label, description }) => (
					<ToggleRow
						key={key}
						label={label}
						description={description}
						checked={audio[key] as boolean}
						onCheckedChange={(v) => setAudio(key, v as AudioSettings[typeof key])}
					/>
				))}
				{GAMEPLAY_TOGGLES.map(({ key, label, description }) => (
					<ToggleRow
						key={key}
						label={label}
						description={description}
						checked={gameplay[key] as boolean}
						onCheckedChange={(v) => setGameplay(key, v as GameplaySettings[typeof key])}
					/>
				))}
			</section>

			<section className="space-y-2">
				<SectionLabel>sync</SectionLabel>
				<label className="flex items-center justify-between gap-4 text-sm">
					audio offset
					<span className="flex items-center gap-2">
						<Tooltip>
							<TooltipTrigger render={<span />}>
								<NumberField
									min={AUDIO_OFFSET_MIN}
									max={AUDIO_OFFSET_MAX}
									step={1}
									largeStep={10}
									value={draftOffset}
									onValueChange={onDraftOffsetChange}
									onValueCommitted={onCommitOffset}
								/>
							</TooltipTrigger>
							<TooltipContent side="left">
								positive moves the playfield, the judgements and the hit samples ahead of the music --
								equivalently, delays the music against everything else. hit samples ride the same offset
								as the playfield, so this never desyncs a sound from the circle it belongs to
							</TooltipContent>
						</Tooltip>
						<span className="text-zinc-400">ms</span>
					</span>
				</label>
			</section>

			{/* the reason a control is inert is stated rather than hiding it: a
			    missing slider reads as a bug, a disabled one with a reason reads
			    as an answer (InertNotice's own rationale) */}
			{noAudioFile && (
				<InertNotice>
					this replay's beatmap has no audio file, so the music channel governs nothing. it still saves, and
					applies to the next replay that has one
				</InertNotice>
			)}
			{notSimulated && (
				<InertNotice>
					this replay was not simulated, so no judgements exist for hit samples to fire off and the hitsound
					channel governs nothing. it still saves, and applies to the next replay that is simulated
				</InertNotice>
			)}
		</div>
	);
}
