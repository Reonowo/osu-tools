import { describe, expect, test } from "bun:test";
import { FrameCursor, type FrameCursorClock } from "./frame-cursor";

// a fake clock: currentTime()/seekTo() drive the cursor exactly as
// PlaybackClock does, plus a `playing` flag the cursor never touches --
// standing in for the real clock's play state to prove row activation and
// stepping leave it alone
class FakeClock implements FrameCursorClock {
	private time = 0;
	private seeks = 0;
	playing = false;

	get seekVersion(): number {
		return this.seeks;
	}

	currentTime(): number {
		return this.time;
	}

	seekTo(ms: number): void {
		this.seeks++;
		this.time = ms;
	}

	/** playback advancing the clock: time moves with no seek behind it */
	advanceTo(ms: number): void {
		this.time = ms;
	}
}

describe("FrameCursor", () => {
	// three duplicate-time frames (indices 1-3) bracketed by two unique ones --
	// the shape adjacentFrameTime used to collapse in a single step
	const dupeTimes = [10, 20, 20, 20, 30];

	test("stepping forward visits every duplicate-time frame in order", () => {
		const clock = new FakeClock();
		const cursor = new FrameCursor(clock);
		cursor.setFrames(dupeTimes);
		cursor.select(0);

		for (const [expectedIndex, expectedTime] of [
			[1, 20],
			[2, 20],
			[3, 20],
			[4, 30]
		] as const) {
			cursor.step(1);
			expect(cursor.currentIndex()).toBe(expectedIndex);
			expect(clock.currentTime()).toBe(expectedTime);
		}

		// past the last frame: clamps in place rather than running off the end
		cursor.step(1);
		expect(cursor.currentIndex()).toBe(4);
	});

	test("stepping backward visits every duplicate-time frame in order", () => {
		const clock = new FakeClock();
		const cursor = new FrameCursor(clock);
		cursor.setFrames(dupeTimes);
		cursor.select(4);

		for (const [expectedIndex, expectedTime] of [
			[3, 20],
			[2, 20],
			[1, 20],
			[0, 10]
		] as const) {
			cursor.step(-1);
			expect(cursor.currentIndex()).toBe(expectedIndex);
			expect(clock.currentTime()).toBe(expectedTime);
		}

		// past the first frame: clamps in place rather than going negative
		cursor.step(-1);
		expect(cursor.currentIndex()).toBe(0);
	});

	test("an ordinary time seek drops the selection and returns the derived last-of-run index", () => {
		const clock = new FakeClock();
		const cursor = new FrameCursor(clock);
		cursor.setFrames(dupeTimes);

		// select the first, unique-time frame
		cursor.select(0);
		expect(cursor.currentIndex()).toBe(0);

		// a seek that bypasses the cursor entirely (a scrub, an arrow-key seek,
		// or playback landing on this instant) -- the cursor has no hook into
		// this, which is the point. it lands mid-run, at a time different from
		// the selected frame's, so the stored atTime no longer matches
		clock.seekTo(20);

		// falls back to the derived index: the *last* frame at-or-before 20,
		// matching lazer's forward-direction-prioritized tie-break, not the
		// frame that used to be selected
		expect(cursor.currentIndex()).toBe(3);
	});

	test("row activation seeks that row's live index and leaves play/pause untouched", () => {
		const clock = new FakeClock();
		clock.playing = true;
		const cursor = new FrameCursor(clock);
		cursor.setFrames(dupeTimes);

		// FramesPanel's click handler calls select() with the row's own
		// (possibly duplicate-time) frame index -- unlike step(), it jumps
		// straight there regardless of where the cursor currently sits
		cursor.select(2);

		expect(cursor.currentIndex()).toBe(2);
		expect(clock.currentTime()).toBe(20);
		// select()/step() only ever call currentTime()/seekTo() on the clock --
		// play state isn't part of FrameCursorClock at all, so there is no way
		// for row activation to reach it
		expect(clock.playing).toBe(true);
	});

	// every scene opens here: PlayerView seeks to derived.bounds.minTime, which
	// folds in the audio lead-in and the first object's preempt and so sits
	// before frame 0. the fake clock starting at 0 against a first frame at 10
	// is that state exactly
	test("stepping forward from before the first frame lands on frame 0 rather than over it", () => {
		const clock = new FakeClock();
		const cursor = new FrameCursor(clock);
		cursor.setFrames(dupeTimes);

		cursor.step(1);

		expect(cursor.currentIndex()).toBe(0);
		expect(clock.currentTime()).toBe(10);
	});

	test("stepping backward from before the first frame stays put rather than seeking forward", () => {
		const clock = new FakeClock();
		const cursor = new FrameCursor(clock);
		cursor.setFrames(dupeTimes);

		cursor.step(-1);

		// there is no frame behind the first one; clamping into range would seek
		// to frame 0, which is *forwards* from where the clock sits
		expect(clock.currentTime()).toBe(0);
	});

	test("a seek away drops the selection, so returning to its timestamp derives the last of the run", () => {
		const clock = new FakeClock();
		const cursor = new FrameCursor(clock);
		cursor.setFrames(dupeTimes);

		// the middle of the tied run -- reachable only by an exact selection
		cursor.select(2);
		expect(cursor.currentIndex()).toBe(2);

		// a seek elsewhere, observed as the readouts observe it every frame
		clock.seekTo(30);
		expect(cursor.currentIndex()).toBe(4);

		// back onto the very same timestamp: the old middle index is gone rather
		// than resurrected, so this derives the last of the run like any other
		// plain time seek would
		clock.seekTo(20);
		expect(cursor.currentIndex()).toBe(3);
	});

	test("stepping back from between two frames lands on the nearer one", () => {
		const clock = new FakeClock();
		const cursor = new FrameCursor(clock);
		cursor.setFrames(dupeTimes);

		// a scrub or a one-second seek leaves the clock between frames, where
		// the frame behind it is the last of the tied run at 20, not the one
		// before that
		clock.seekTo(25);
		cursor.step(-1);
		expect(clock.currentTime()).toBe(20);
		expect(cursor.currentIndex()).toBe(3);

		// forward from the same spot is the plain next frame
		clock.seekTo(25);
		cursor.step(1);
		expect(clock.currentTime()).toBe(30);
	});

	test("stepping past either end of the frame stream does not move the clock", () => {
		const clock = new FakeClock();
		const cursor = new FrameCursor(clock);
		cursor.setFrames(dupeTimes);

		// past the last frame -- the audio can outlive the replay, so the clock
		// reaches here on its own. forward has nothing to reach, and clamping
		// would rewind onto the last frame
		clock.seekTo(40);
		cursor.step(1);
		expect(clock.currentTime()).toBe(40);

		// backward from there lands on the last frame rather than skipping it
		cursor.step(-1);
		expect(clock.currentTime()).toBe(30);
	});

	test("a scrub away and back invalidates even with nobody reading in between", () => {
		const clock = new FakeClock();
		const cursor = new FrameCursor(clock);
		cursor.setFrames(dupeTimes);
		cursor.select(2);

		// no currentIndex()/selectedIndex() call while the clock is away: with
		// nothing but the timestamp to go on this pair of seeks is invisible, so
		// the seek count is what has to notice it
		clock.seekTo(30);
		clock.seekTo(20);

		expect(cursor.selectedIndex()).toBeNull();
		expect(cursor.currentIndex()).toBe(3);
	});

	test("playback advancing the clock invalidates without any seek", () => {
		const clock = new FakeClock();
		const cursor = new FrameCursor(clock);
		cursor.setFrames(dupeTimes);
		cursor.select(1);

		// the seek count is unchanged here -- only the time moved, which is what
		// the atTime half of the check is for
		clock.advanceTo(30);

		expect(cursor.selectedIndex()).toBeNull();
		expect(cursor.currentIndex()).toBe(4);
	});

	test("selectedIndex reports a frame only while the exact selection is live", () => {
		const clock = new FakeClock();
		const cursor = new FrameCursor(clock);
		cursor.setFrames(dupeTimes);

		// a plain time seek disambiguates nothing, however it lands
		clock.seekTo(20);
		expect(cursor.selectedIndex()).toBeNull();
		expect(cursor.currentIndex()).toBe(3);

		cursor.select(1);
		expect(cursor.selectedIndex()).toBe(1);

		clock.seekTo(30);
		expect(cursor.selectedIndex()).toBeNull();
	});

	test("setFrames drops a prior selection so a new scene cannot inherit a stale index", () => {
		const clock = new FakeClock();
		const cursor = new FrameCursor(clock);
		cursor.setFrames(dupeTimes);
		cursor.select(2);
		expect(cursor.currentIndex()).toBe(2);

		cursor.setFrames([5, 15]);
		// the old selection is gone; this derives fresh from the new times --
		// the clock is still sitting at 20 from the earlier select(2), which is
		// at-or-after both new frame times, so it derives the last one (index 1)
		expect(cursor.currentIndex()).toBe(1);
	});
});
