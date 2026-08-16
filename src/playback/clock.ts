// the signed beatmap-time clock (spec, frontend clock): rAF-driven internal
// time below zero and without audio, drift-corrected audio master otherwise.
// pure logic over an injected now() so bun tests can script it.
//
// the clock owns TIME and nothing else. level belongs to the audio graph
// (playback/audio-graph.ts), where the music element is one input to a gain
// tree the hit samples share -- a clock that also set element volume would be
// the second place deciding it

export interface ClockAudio {
	readonly currentTimeMs: number;
	readonly durationMs: number | null;
	setRate(rate: number): void;
	play(): void;
	pause(): void;
	seekMs(ms: number): void;
}

export function htmlAudioAdapter(el: HTMLAudioElement): ClockAudio {
	el.preservesPitch = true;
	return {
		get currentTimeMs() {
			return el.currentTime * 1000;
		},
		get durationMs() {
			return Number.isFinite(el.duration) ? el.duration * 1000 : null;
		},
		setRate: (rate) => {
			el.playbackRate = rate;
		},
		play: () => {
			void el.play().catch(() => {});
		},
		pause: () => el.pause(),
		seekMs: (ms) => {
			el.currentTime = ms / 1000;
		}
	};
}

/** below this error the interpolated clock is trusted over a fresh raw
 * sample's backward step; above it the clock snaps (a real seek/stall) */
const SNAP_THRESHOLD_MS = 150;

export class PlaybackClock {
	private audio: ClockAudio | null = null;
	private mode: "internal" | "audio" = "internal";
	private time = 0;
	private lastNow: number;
	private rawBase = 0;
	private rawStamp = 0;
	private lastRaw = Number.NaN;

	private boundsMin = 0;
	private boundsMax = 0;
	private seeks = 0;
	private isPlaying = false;
	private currentRate = 1;
	/** the user's global audio offset, ms. see setOffset */
	private offsetMs = 0;

	constructor(private readonly now: () => number = () => performance.now()) {
		this.lastNow = this.now();
	}

	get minTime() {
		return this.boundsMin;
	}
	get maxTime() {
		return this.boundsMax;
	}
	get playing() {
		return this.isPlaying;
	}
	get rate() {
		return this.currentRate;
	}
	get offset() {
		return this.offsetMs;
	}
	/** how many seeks this clock has served. a consumer that time-stamped a
	 * decision can compare times to notice playback drifting underneath it, but
	 * not a seek that left and came back to the very same millisecond -- the two
	 * are indistinguishable by time alone, and only this tells them apart
	 * (playback/frame-cursor.ts is the one that cares) */
	get seekVersion() {
		return this.seeks;
	}

	attachAudio(audio: ClockAudio | null): void {
		this.audio?.pause();
		this.audio = audio;
		// re-apply the persistent setting: loading a second replay swaps in a
		// fresh element that starts at 1x. level is the audio graph's, and its
		// gain nodes outlive every element, so nothing to re-apply there
		audio?.setRate(this.currentRate);
		this.mode = "internal";
	}

	/** deliberately leaves an overrun past maxTime alone: PlayerView re-feeds
	 * the live bounds on every landed edit, and clamping a paused time under a
	 * shrinking maxTime visibly yanked the playhead backwards on release. that
	 * overrun is safe everywhere it can be read -- tick() holds a paused time
	 * and pauses a playing one at the boundary, seekTo clamps, and play() at or
	 * past maxTime restarts from minTime.
	 *
	 * a time below a risen minTime is not: only the frame stream can move that
	 * bound (derive.ts takes it against the beatmap's own edit-invariant
	 * lead-in and first appear), so deleting the earliest frame lifts it past
	 * where the user sits paused, and play() -- which only restarts at the
	 * other end -- would then run forward through pre-roll the edit removed.
	 * clamping up to it is a forward correction, not the backward yank above */
	setBounds(minMs: number, maxMs: number): void {
		this.boundsMin = minMs;
		this.boundsMax = maxMs;
		if (this.time < minMs) {
			this.time = minMs;
			// same rebase seekTo does: moving time out-of-band without this
			// leaves lastNow naming the tick before the correction, and the next
			// tick re-applies that whole interval on top of the new minimum.
			// only internal mode can reach here -- minTime is at most 0
			// (derive.ts mins it against a literal 0), so a time below it is
			// negative, and audioCovers() keeps a negative time off the audio
			this.lastNow = this.now();
		}
	}

	currentTime(): number {
		return this.time;
	}

	/**
	 * the user's global audio offset, in ms. positive moves the playfield, the
	 * judgements and the hit samples AHEAD of the music -- equivalently, delays
	 * the music against everything else.
	 *
	 * ported from lazer's clock stack rather than invented: `FramedBeatmapClock`
	 * wraps the interpolated track in an `OffsetCorrectionClock`, so gameplay
	 * time is the track's time PLUS the offset, and `Seek(position)` puts the
	 * source at `position - TotalAppliedOffset` -- which is why every seek here
	 * is still in raw beatmap time and an offset never leaks into a seek target.
	 *
	 * two of lazer's offsets are deliberately NOT ported: the per-beatmap offset
	 * is a separate setting with its own storage, and the Windows platform
	 * offset (`WINDOWS_BASE_AUDIO_OFFSET`) is a BASS compensation with no
	 * meaning outside BASS
	 */
	setOffset(offsetMs: number): void {
		if (!Number.isFinite(offsetMs) || offsetMs === this.offsetMs) return;
		this.offsetMs = offsetMs;
		// the mapping between beatmap time and track time just moved, so the
		// track has to move under a held beatmap time rather than the beatmap
		// time moving under the user
		this.resyncAudioPosition();
	}

	/** offsetcorrectionclock.cs:42 -- `base.Offset = Offset * Rate`. the same
	 * REAL-WORLD shift has to land at every playback rate, which is the detail a
	 * naive implementation loses at 0.5x */
	private appliedOffset(): number {
		return this.offsetMs * this.currentRate;
	}

	/** beatmap time -> the track position that carries it */
	private sourceTimeFor(beatmapTime: number): number {
		return beatmapTime - this.appliedOffset();
	}

	/** the track's own position, read back as beatmap time */
	private audioTime(): number {
		return this.audio!.currentTimeMs + this.appliedOffset();
	}

	/** put the track back under the current beatmap time. called whenever the
	 * mapping between the two changes (offset, rate) rather than the time */
	private resyncAudioPosition(): void {
		if (this.audio === null) return;
		if (this.isPlaying) this.enterModeFor(this.time);
		else if (this.audioCovers(this.time)) this.audio.seekMs(this.sourceTimeFor(this.time));
	}

	setRate(rate: number): void {
		// rebase the audio interpolation so the rate change applies from now
		this.rebaseFromRaw();
		this.currentRate = rate;
		this.audio?.setRate(rate);
		// the applied offset is rate-scaled, so a rate change moves the
		// beatmap-to-track mapping even though neither time moved
		if (this.offsetMs !== 0) this.resyncAudioPosition();
	}

	play(): void {
		if (this.isPlaying) return;
		if (this.time >= this.boundsMax) this.seekTo(this.boundsMin);
		this.isPlaying = true;
		this.lastNow = this.now();
		this.enterModeFor(this.time);
	}

	pause(): void {
		if (!this.isPlaying) return;
		this.isPlaying = false;
		this.audio?.pause();
		this.mode = "internal";
	}

	seekTo(ms: number): void {
		this.seeks++;
		this.time = Math.min(Math.max(ms, this.boundsMin), this.boundsMax);
		this.lastNow = this.now();
		if (this.isPlaying) this.enterModeFor(this.time);
		else {
			// keep a paused audio element in sync so a later play resumes there
			if (this.audioCovers(this.time)) this.audio!.seekMs(this.sourceTimeFor(this.time));
			this.audio?.pause();
			this.mode = "internal";
		}
	}

	/** advance one frame; call from the rAF loop. returns the current time */
	tick(): number {
		const nowMs = this.now();
		if (!this.isPlaying) {
			this.lastNow = nowMs;
			return this.time;
		}

		if (this.mode === "internal") {
			const next = this.time + (nowMs - this.lastNow) * this.currentRate;
			this.lastNow = nowMs;
			// hand off to audio at the playable boundary
			if (this.audioCovers(next)) {
				this.audio!.seekMs(this.sourceTimeFor(next));
				this.audio!.play();
				this.mode = "audio";
				this.rawBase = next;
				this.rawStamp = nowMs;
				// seed lastRaw with the value we just seeked audio to (not NaN):
				// rawBase/rawStamp are already correct as of this instant, so the
				// very next audio-mode tick must not treat an unchanged raw sample
				// as "fresh" and rebase again, which would silently discard that
				// tick's elapsed time and show up later as a jump once a genuinely
				// new sample lands
				this.lastRaw = next;
				this.time = next;
			} else {
				this.time = next;
			}
		} else {
			const raw = this.audioTime();
			const duration = this.audio!.durationMs;
			// the duration is a TRACK length, so the comparison happens in track
			// time -- the offset shifts which beatmap time the track's end is at
			if (duration !== null && this.sourceTimeFor(raw) >= duration) {
				// audio ran out; keep going internally from where the audio stopped
				this.mode = "internal";
				this.time = Math.max(this.time, duration + this.appliedOffset());
				this.lastNow = nowMs;
			} else {
				if (raw !== this.lastRaw) {
					this.lastRaw = raw;
					this.rawBase = raw;
					this.rawStamp = nowMs;
				}
				const interpolated = this.rawBase + (nowMs - this.rawStamp) * this.currentRate;
				// monotonic while playing: a rebase must not step the visible clock
				// backwards unless the error is a genuine stall/seek
				this.time =
					interpolated < this.time && this.time - interpolated < SNAP_THRESHOLD_MS ? this.time : interpolated;
				this.lastNow = nowMs;
			}
		}

		if (this.time >= this.boundsMax) {
			this.time = this.boundsMax;
			this.pause();
		}
		return this.time;
	}

	/** `t` is a beatmap time; the track's own range is what decides, so the
	 * question is asked in track time */
	private audioCovers(t: number): boolean {
		if (this.audio === null) return false;
		const source = this.sourceTimeFor(t);
		if (source < 0) return false;
		const duration = this.audio.durationMs;
		return duration === null || source < duration;
	}

	private enterModeFor(t: number): void {
		if (this.audioCovers(t)) {
			this.audio!.seekMs(this.sourceTimeFor(t));
			this.audio!.play();
			this.mode = "audio";
			this.rawBase = t;
			this.rawStamp = this.now();
			this.lastRaw = t; // see the tick() handoff for why this isn't NaN
		} else {
			this.audio?.pause();
			this.mode = "internal";
		}
	}

	private rebaseFromRaw(): void {
		if (this.mode !== "audio") return;
		this.rawBase = this.time;
		this.rawStamp = this.now();
	}
}
