// the app's three volume channels and the pure folds over them. the WebAudio
// graph that applies these lives in audio-graph.ts, which `bun test` cannot
// construct -- everything decidable without an AudioContext lives here

/** linear amplitude percents, 0-100 */
export interface VolumeLevels {
	master: number;
	music: number;
	hitsound: number;
}

export const VOLUME_CHANNELS = ["master", "music", "hitsound"] as const;
export type VolumeChannel = (typeof VOLUME_CHANNELS)[number];

/** one channel's effective gain, 0-1: master x channel, both linear.
 *
 * linear rather than logarithmic because osu-framework applies its aggregate
 * volume straight to the bass channel volume (TrackBass.cs:371), so a linear
 * slider is the osu!-matching one -- and multiplying two linear channels is
 * what makes zero anywhere the mute, exactly as lazer's nested
 * AudioContainer volumes do */
export function channelGain(master: number, channel: number): number {
	return clampPercent(master) * clampPercent(channel);
}

/** percent -> 0-1, rejecting anything outside the range (a hand-edited
 * settings file can carry 900, and the audio nodes must never see it) */
function clampPercent(percent: number): number {
	if (!Number.isFinite(percent)) return 0;
	return Math.min(Math.max(percent, 0), 100) / 100;
}

/** what the transport's speaker glyph shows.
 *
 * muted when the master is zero OR when both children are, and scaled by the
 * master otherwise. that second clause is the one that earns its keep: a
 * master at 70 with music and hitsounds both at 0 is a 70% slider and total
 * silence, and a glyph reading "70%" there would be lying about the only
 * thing it exists to say */
export function speakerState(levels: VolumeLevels): "muted" | "low" | "high" {
	const master = clampPercent(levels.master);
	if (master === 0) return "muted";
	if (clampPercent(levels.music) === 0 && clampPercent(levels.hitsound) === 0) return "muted";
	return master < 0.5 ? "low" : "high";
}

/** where an unmute lands when there is nothing to restore -- the app was
 * launched already muted, or the slider was dragged to zero and the mute
 * remembers nothing. anything but silence, or the button reads as broken */
export const FALLBACK_UNMUTE_VOLUME = 100;

/**
 * clicking the speaker. the master is what moves, because the master is what
 * the slider beside the speaker controls and what the glyph is mostly reading.
 *
 * an unmute lands back on the level the mute replaced rather than on a
 * default: a media player that unmutes to a different volume than it muted
 * from is one that lost your place, and the level people set mid-replay is a
 * level they chose
 */
export function toggleMute(volume: number, mutedFrom: number | null): { volume: number; mutedFrom: number | null } {
	if (volume > 0) return { volume: 0, mutedFrom: volume };
	// a remembered zero is not a level to come back to; it is the same silence
	const restore = mutedFrom !== null && mutedFrom > 0 ? mutedFrom : FALLBACK_UNMUTE_VOLUME;
	return { volume: restore, mutedFrom: null };
}
