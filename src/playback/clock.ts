// the signed beatmap-time clock (spec, frontend clock): rAF-driven internal
// time below zero and without audio, drift-corrected audio master otherwise.
// pure logic over an injected now() so bun tests can script it

export interface ClockAudio {
	readonly currentTimeMs: number;
	readonly durationMs: number | null;
	setRate(rate: number): void;
	/** linear amplitude, 0-1 */
	setVolume(volume: number): void;
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
		// HTMLMediaElement.volume throws on anything outside 0-1, so clamp at the
		// boundary rather than trusting every caller
		setVolume: (volume) => {
			el.volume = Math.min(Math.max(volume, 0), 1);
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
	private isPlaying = false;
	private currentRate = 1;
	/** linear amplitude 0-1, held here so it survives audio swaps */
	private currentVolume = 1;

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
	get volume() {
		return this.currentVolume;
	}

	attachAudio(audio: ClockAudio | null): void {
		this.audio?.pause();
		this.audio = audio;
		// re-apply both persistent settings: loading a second replay swaps in a
		// fresh element that starts at full volume and 1x
		audio?.setRate(this.currentRate);
		audio?.setVolume(this.currentVolume);
		this.mode = "internal";
	}

	setBounds(minMs: number, maxMs: number): void {
		this.boundsMin = minMs;
		this.boundsMax = maxMs;
		this.time = Math.min(Math.max(this.time, minMs), maxMs);
	}

	currentTime(): number {
		return this.time;
	}

	setRate(rate: number): void {
		// rebase the audio interpolation so the rate change applies from now
		this.rebaseFromRaw();
		this.currentRate = rate;
		this.audio?.setRate(rate);
	}

	/** linear amplitude 0-1. osu-framework applies its aggregate volume
	 * straight to the bass channel volume (TrackBass.cs:371), so linear is the
	 * osu!-matching curve. remembered across attachAudio */
	setVolume(volume: number): void {
		this.currentVolume = Math.min(Math.max(volume, 0), 1);
		this.audio?.setVolume(this.currentVolume);
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
		this.time = Math.min(Math.max(ms, this.boundsMin), this.boundsMax);
		this.lastNow = this.now();
		if (this.isPlaying) this.enterModeFor(this.time);
		else {
			// keep a paused audio element in sync so a later play resumes there
			if (this.audioCovers(this.time)) this.audio!.seekMs(this.time);
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
				this.audio!.seekMs(next);
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
			const raw = this.audio!.currentTimeMs;
			const duration = this.audio!.durationMs;
			if (duration !== null && raw >= duration) {
				// audio ran out; keep going internally from where the audio stopped
				this.mode = "internal";
				this.time = Math.max(this.time, duration);
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

	private audioCovers(t: number): boolean {
		if (this.audio === null || t < 0) return false;
		const duration = this.audio.durationMs;
		return duration === null || t < duration;
	}

	private enterModeFor(t: number): void {
		if (this.audioCovers(t)) {
			this.audio!.seekMs(t);
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
