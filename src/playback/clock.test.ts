import { describe, expect, test } from "bun:test";
import { PlaybackClock, type ClockAudio } from "./clock";

/** scripted monotonic clock the tests advance by hand */
function fakeNow() {
	let t = 1000;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		}
	};
}

/** audio whose currentTime only refreshes in coarse steps, like chromium */
function fakeAudio(durationMs = 10_000, sampleInterval = 250) {
	let position = 0;
	let playing = false;
	let rate = 1;
	// elapsed time is only accumulated while actually playing (a real
	// HTMLAudioElement's currentTime doesn't move while paused/before
	// play() is called), and the sampling baseline resets on every seek so
	// a coarse resample never folds in idle time from before playback or
	// position from before the seek
	let playElapsed = 0;
	let lastSampleAt = 0;
	const audio: ClockAudio & {
		advance(ms: number): void;
		readonly playingNow: boolean;
		readonly seeks: number[];
		readonly rates: number[];
		readonly volumes: number[];
		pauseCalls: number;
	} = {
		get currentTimeMs() {
			return Math.min(position, durationMs);
		},
		durationMs,
		setRate: (r) => {
			rate = r;
			audio.rates.push(r);
		},
		setVolume: (v) => {
			audio.volumes.push(v);
		},
		play: () => {
			playing = true;
		},
		pause: () => {
			playing = false;
			audio.pauseCalls++;
		},
		seekMs: (ms) => {
			position = ms;
			audio.seeks.push(ms);
			playElapsed = 0;
			lastSampleAt = 0;
		},
		advance(ms: number) {
			if (!playing) return;
			playElapsed += ms;
			// raw position only visibly updates every sampleInterval
			if (playElapsed - lastSampleAt >= sampleInterval) {
				position = Math.min(position + (playElapsed - lastSampleAt) * rate, durationMs);
				lastSampleAt = playElapsed;
			}
		},
		playingNow: false as boolean,
		seeks: [] as number[],
		rates: [] as number[],
		volumes: [] as number[],
		pauseCalls: 0
	};
	Object.defineProperty(audio, "playingNow", { get: () => playing });
	return audio;
}

/** audio whose raw position is set directly by the test, for scripting drift */
function manualAudio(durationMs: number | null = 10_000) {
	let position = 0;
	let playing = false;
	const audio: ClockAudio & {
		setPosition(ms: number): void;
		readonly playingNow: boolean;
		readonly seeks: number[];
	} = {
		get currentTimeMs() {
			return position;
		},
		durationMs,
		setRate: () => {},
		setVolume: () => {},
		play: () => {
			playing = true;
		},
		pause: () => {
			playing = false;
		},
		seekMs: (ms) => {
			position = ms;
			audio.seeks.push(ms);
		},
		setPosition(ms: number) {
			position = ms;
		},
		playingNow: false as boolean,
		seeks: [] as number[]
	};
	Object.defineProperty(audio, "playingNow", { get: () => playing });
	return audio;
}

describe("internal mode", () => {
	test("advances by wall time x rate and auto-pauses at maxTime", () => {
		const c = fakeNow();
		const clock = new PlaybackClock(c.now);
		clock.setBounds(-500, 1000);
		clock.seekTo(-500);
		clock.setRate(2);
		clock.play();
		c.advance(100);
		expect(clock.tick()).toBeCloseTo(-300, 6);
		c.advance(10_000);
		expect(clock.tick()).toBe(1000);
		expect(clock.playing).toBe(false);
	});

	test("seek is exact while paused", () => {
		const clock = new PlaybackClock(fakeNow().now);
		clock.setBounds(-2000, 5000);
		clock.seekTo(-1234);
		expect(clock.currentTime()).toBe(-1234);
		clock.seekTo(-99999);
		expect(clock.currentTime()).toBe(-2000);
	});
});

describe("audio handoff", () => {
	test("crossing zero starts the audio exactly once, continuously", () => {
		const c = fakeNow();
		const audio = fakeAudio();
		const clock = new PlaybackClock(c.now);
		clock.attachAudio(audio);
		clock.setBounds(-200, 12_000);
		clock.seekTo(-200);
		clock.play();

		let prev = clock.currentTime();
		for (let i = 0; i < 30; i++) {
			c.advance(16);
			audio.advance(16);
			const t = clock.tick();
			expect(t - prev).toBeLessThanOrEqual(16 * 1.5 + 1e-6); // no jumps
			expect(t).toBeGreaterThanOrEqual(prev); // monotonic
			prev = t;
		}
		expect(audio.playingNow).toBe(true);
		expect(audio.seeks.length).toBe(1);
		expect(prev).toBeGreaterThan(0);
	});

	test("audio-master time interpolates between coarse samples, monotonically", () => {
		const c = fakeNow();
		const audio = fakeAudio();
		const clock = new PlaybackClock(c.now);
		clock.attachAudio(audio);
		clock.setBounds(0, 12_000);
		clock.seekTo(0);
		clock.play();

		let prev = -1;
		for (let i = 0; i < 100; i++) {
			c.advance(16);
			audio.advance(16);
			const t = clock.tick();
			expect(t).toBeGreaterThanOrEqual(prev);
			prev = t;
		}
		// ~1.6s elapsed; interpolated time stays near wall time despite 250ms samples
		expect(prev).toBeGreaterThan(1300);
		expect(prev).toBeLessThan(1700);
	});

	test("seeking backwards below zero leaves audio paused and runs internal", () => {
		const c = fakeNow();
		const audio = fakeAudio();
		const clock = new PlaybackClock(c.now);
		clock.attachAudio(audio);
		clock.setBounds(-1000, 12_000);
		clock.seekTo(500);
		clock.play();
		c.advance(16);
		audio.advance(16);
		clock.tick();
		clock.seekTo(-800);
		expect(audio.playingNow).toBe(false);
		expect(clock.currentTime()).toBe(-800);
		c.advance(100);
		audio.advance(100);
		expect(clock.tick()).toBeCloseTo(-700, 6);
	});

	test("audio end reverts to internal and runs out to maxTime", () => {
		const c = fakeNow();
		const audio = fakeAudio(1000);
		const clock = new PlaybackClock(c.now);
		clock.attachAudio(audio);
		clock.setBounds(0, 3000);
		clock.seekTo(900);
		clock.play();
		for (let i = 0; i < 300; i++) {
			c.advance(16);
			audio.advance(16);
			clock.tick();
		}
		expect(clock.currentTime()).toBe(3000);
		expect(clock.playing).toBe(false);
	});

	test("rate changes forward to the audio element", () => {
		const audio = fakeAudio();
		const clock = new PlaybackClock(fakeNow().now);
		clock.attachAudio(audio);
		clock.setRate(1.5);
		expect(clock.rate).toBe(1.5);
		// strengthened: the brief's original body stopped at the clock-internal
		// assertion above, which passes even if setRate never reaches the
		// adapter (it's just the property getter). attachAudio also calls
		// audio.setRate once with the default rate, so the *last* recorded
		// call is the one that matters here.
		expect(audio.rates.at(-1)).toBe(1.5);
	});
});

describe("sign transitions via explicit seeks", () => {
	test("seeking across zero upward while playing hands off to audio mid-flight", () => {
		const c = fakeNow();
		const audio = fakeAudio();
		const clock = new PlaybackClock(c.now);
		clock.attachAudio(audio);
		clock.setBounds(-500, 5000);
		clock.seekTo(-100);
		clock.play();
		expect(audio.playingNow).toBe(false);

		clock.seekTo(50);
		expect(clock.currentTime()).toBe(50);
		expect(audio.playingNow).toBe(true);
		expect(audio.seeks).toEqual([50]);
	});

	test("seeking across zero downward while playing hands audio off back to internal", () => {
		const c = fakeNow();
		const audio = fakeAudio();
		const clock = new PlaybackClock(c.now);
		clock.attachAudio(audio);
		clock.setBounds(-500, 5000);
		clock.seekTo(200);
		clock.play();
		expect(audio.playingNow).toBe(true);

		clock.seekTo(-50);
		expect(clock.currentTime()).toBe(-50);
		expect(audio.playingNow).toBe(false);
	});

	test("seeking while paused pre-syncs audio position without starting playback", () => {
		const audio = fakeAudio();
		const clock = new PlaybackClock(fakeNow().now);
		clock.attachAudio(audio);
		clock.setBounds(-500, 5000);

		clock.seekTo(500);
		expect(clock.currentTime()).toBe(500);
		expect(audio.seeks).toEqual([500]);
		expect(audio.playingNow).toBe(false);

		// seeking further while still paused must not attempt to seek audio
		// negative, since a negative beatmap time has no audio position
		clock.seekTo(-300);
		expect(clock.currentTime()).toBe(-300);
		expect(audio.seeks).toEqual([500]);
		expect(audio.playingNow).toBe(false);
	});
});

describe("bounds", () => {
	test("seeking beyond maxTime clamps exactly to maxTime", () => {
		const clock = new PlaybackClock(fakeNow().now);
		clock.setBounds(0, 5000);
		clock.seekTo(999_999);
		expect(clock.currentTime()).toBe(5000);
	});

	test("seeking to exactly minTime or maxTime lands precisely on the boundary", () => {
		const clock = new PlaybackClock(fakeNow().now);
		clock.setBounds(-2000, 5000);
		clock.seekTo(-2000);
		expect(clock.currentTime()).toBe(-2000);
		clock.seekTo(5000);
		expect(clock.currentTime()).toBe(5000);
	});

	test("play() at maxTime restarts from minTime", () => {
		const c = fakeNow();
		const clock = new PlaybackClock(c.now);
		clock.setBounds(-100, 1000);
		clock.seekTo(1000);
		clock.play();
		expect(clock.currentTime()).toBe(-100);
		expect(clock.playing).toBe(true);
	});

	test("a seek to maxTime while playing pauses on the following tick", () => {
		const c = fakeNow();
		const clock = new PlaybackClock(c.now);
		clock.setBounds(0, 1000);
		clock.seekTo(0);
		clock.play();
		clock.seekTo(1000);
		expect(clock.currentTime()).toBe(1000);
		c.advance(16);
		expect(clock.tick()).toBe(1000);
		expect(clock.playing).toBe(false);
	});
});

describe("rate changes while playing", () => {
	test("changing rate mid-flight in internal mode forwards to audio and rescales subsequent ticks", () => {
		const c = fakeNow();
		const audio = fakeAudio();
		const clock = new PlaybackClock(c.now);
		clock.attachAudio(audio);
		clock.setBounds(-1000, 5000);
		clock.seekTo(-1000);
		clock.play();
		c.advance(100);
		expect(clock.tick()).toBeCloseTo(-900, 6);

		clock.setRate(4);
		expect(audio.rates.at(-1)).toBe(4);
		c.advance(50);
		expect(clock.tick()).toBeCloseTo(-700, 6);
	});

	test("changing rate mid-flight in audio-master mode forwards to audio without jumping time", () => {
		const c = fakeNow();
		const audio = fakeAudio();
		const clock = new PlaybackClock(c.now);
		clock.attachAudio(audio);
		clock.setBounds(0, 12_000);
		clock.seekTo(0);
		clock.play();
		c.advance(16);
		audio.advance(16);
		clock.tick();
		c.advance(16);
		audio.advance(16);
		const before = clock.tick();

		clock.setRate(2);
		expect(audio.rates.at(-1)).toBe(2);
		// rebasing on a rate change must not move the visible clock by itself
		expect(clock.tick()).toBeCloseTo(before, 6);
	});
});

describe("drift correction", () => {
	test("a small drift behind the interpolated estimate is absorbed without stepping backward", () => {
		const c = fakeNow();
		const audio = manualAudio();
		const clock = new PlaybackClock(c.now);
		clock.attachAudio(audio);
		clock.setBounds(0, 12_000);
		clock.seekTo(0);
		audio.setPosition(0);
		clock.play();

		audio.setPosition(16);
		c.advance(16);
		expect(clock.tick()).toBe(16); // in sync, rebased to the fresh raw sample

		// wall clock races ahead of the next raw sample by 100ms with no new
		// sample yet, so the clock keeps interpolating forward
		c.advance(100);
		expect(clock.tick()).toBe(116);

		// a fresh raw sample now lands 16ms behind the interpolated estimate
		// (a plausible small drift, well under the snap threshold) - it must
		// not step the visible clock backwards
		audio.setPosition(100);
		const held = clock.tick();
		expect(held).toBe(116);

		// as wall time keeps advancing from the new (lower) raw base, the
		// clock should catch back up to real wall time rather than getting
		// stuck or oscillating
		c.advance(20);
		const recovered = clock.tick();
		expect(recovered).toBeGreaterThanOrEqual(held);
		expect(recovered).toBe(120);
	});

	test("a large drift at or beyond the snap threshold corrects instead of freezing the clock", () => {
		const c = fakeNow();
		const audio = manualAudio();
		const clock = new PlaybackClock(c.now);
		clock.attachAudio(audio);
		clock.setBounds(0, 12_000);
		clock.seekTo(0);
		audio.setPosition(0);
		clock.play();

		audio.setPosition(16);
		c.advance(16);
		expect(clock.tick()).toBe(16);

		// wall clock runs far ahead with no fresh sample (e.g. a stall)
		c.advance(500);
		expect(clock.tick()).toBe(516);

		// the real audio position turns out to be far behind the interpolated
		// estimate (516) - the gap is beyond SNAP_THRESHOLD_MS, so this reads as
		// a genuine stall/seek rather than sampling noise, and the clock must
		// snap to it instead of holding the stale, now-wrong estimate forever
		audio.setPosition(300);
		expect(clock.tick()).toBe(300);
	});
});

describe("tick edge cases", () => {
	test("tick with zero elapsed wall time is a no-op in internal mode", () => {
		const c = fakeNow();
		const clock = new PlaybackClock(c.now);
		clock.setBounds(-500, 5000);
		clock.seekTo(-100);
		clock.play();
		c.advance(16);
		const t1 = clock.tick();
		const t2 = clock.tick();
		expect(t2).toBe(t1);
	});

	test("tick with zero elapsed wall time is a no-op in audio-master mode", () => {
		const c = fakeNow();
		const audio = fakeAudio();
		const clock = new PlaybackClock(c.now);
		clock.attachAudio(audio);
		clock.setBounds(0, 12_000);
		clock.seekTo(0);
		clock.play();
		c.advance(16);
		audio.advance(16);
		const t1 = clock.tick();
		const t2 = clock.tick();
		expect(t2).toBe(t1);
	});

	test("a large wall-clock jump in audio mode (e.g. a backgrounded tab) catches up in one tick without extra seeks", () => {
		const c = fakeNow();
		const audio = fakeAudio(60_000);
		const clock = new PlaybackClock(c.now);
		clock.attachAudio(audio);
		clock.setBounds(0, 60_000);
		clock.seekTo(0); // paused pre-sync seeks the audio once
		clock.play(); // entering audio mode seeks it again to the same spot
		c.advance(16);
		audio.advance(16);
		clock.tick();
		expect(audio.seeks.length).toBe(2);

		// the tab is backgrounded; both wall clock and the (still-playing) real
		// audio element advance a long way before the next tick is observed
		c.advance(30_000);
		audio.advance(30_000);
		const t = clock.tick();

		expect(t).toBeGreaterThan(25_000);
		expect(t).toBeLessThanOrEqual(30_100);
		expect(audio.seeks.length).toBe(2); // caught up by resampling, not by reseeking
		expect(clock.playing).toBe(true);
	});
});

describe("play/pause idempotency", () => {
	test("play() while already playing does not restart audio or reset the timeline", () => {
		const c = fakeNow();
		const audio = fakeAudio();
		const clock = new PlaybackClock(c.now);
		clock.attachAudio(audio);
		clock.setBounds(0, 12_000);
		clock.seekTo(0); // paused pre-sync seeks the audio once
		clock.play(); // entering audio mode seeks it again to the same spot
		c.advance(16);
		audio.advance(16);
		const before = clock.tick();
		expect(audio.seeks.length).toBe(2);

		clock.play(); // already playing: must not seek or restart audio again
		expect(clock.currentTime()).toBe(before);
		expect(audio.seeks.length).toBe(2);
		expect(clock.playing).toBe(true);
	});

	test("pause() while already paused does nothing", () => {
		const c = fakeNow();
		const audio = fakeAudio();
		const clock = new PlaybackClock(c.now);
		clock.attachAudio(audio);
		clock.setBounds(0, 12_000);
		clock.seekTo(500); // paused pre-sync also pauses the (already-idle) audio once
		clock.play();
		c.advance(16);
		audio.advance(16);
		clock.tick();
		const pauseCallsWhilePlaying = audio.pauseCalls;

		clock.pause();
		expect(clock.playing).toBe(false);
		expect(audio.pauseCalls).toBe(pauseCallsWhilePlaying + 1);
		const pausedAt = clock.currentTime();

		// a second, redundant pause() must not touch the audio adapter again
		// or otherwise change state - only the first transition should
		clock.pause();
		expect(clock.playing).toBe(false);
		expect(audio.pauseCalls).toBe(pauseCallsWhilePlaying + 1);
		expect(clock.currentTime()).toBe(pausedAt);
	});
});

describe("volume", () => {
	test("setVolume forwards to the audio and clamps to 0-1", () => {
		const audio = fakeAudio();
		const clock = new PlaybackClock(fakeNow().now);
		clock.attachAudio(audio);
		const afterAttach = audio.volumes.length;

		clock.setVolume(0.5);
		expect(clock.volume).toBe(0.5);
		expect(audio.volumes[afterAttach]).toBe(0.5);

		clock.setVolume(1.7);
		expect(clock.volume).toBe(1);
		clock.setVolume(-0.2);
		expect(clock.volume).toBe(0);
		expect(audio.volumes.slice(afterAttach)).toEqual([0.5, 1, 0]);
	});

	test("attachAudio re-applies the current volume to the new element", () => {
		// loading a second replay swaps in a fresh <audio>, which starts at full
		// volume; the level the user picked has to follow it across
		const clock = new PlaybackClock(fakeNow().now);
		clock.attachAudio(fakeAudio());
		clock.setVolume(0.25);

		const next = fakeAudio();
		clock.attachAudio(next);
		expect(next.volumes).toEqual([0.25]);
		expect(clock.volume).toBe(0.25);
	});

	test("a volume set with no audio attached applies on the next attach", () => {
		// hydration can finish before PlayerView has mounted an element
		const clock = new PlaybackClock(fakeNow().now);
		clock.setVolume(0.4);
		expect(clock.volume).toBe(0.4);

		const audio = fakeAudio();
		clock.attachAudio(audio);
		expect(audio.volumes).toEqual([0.4]);
	});

	test("volume defaults to full and survives rate changes and seeks", () => {
		const c = fakeNow();
		const audio = fakeAudio();
		const clock = new PlaybackClock(c.now);
		expect(clock.volume).toBe(1);
		clock.attachAudio(audio);
		clock.setBounds(0, 12_000);
		clock.setVolume(0.6);
		clock.setRate(1.5);
		clock.seekTo(3000);
		clock.play();
		c.advance(16);
		audio.advance(16);
		clock.tick();
		expect(clock.volume).toBe(0.6);
	});
});
