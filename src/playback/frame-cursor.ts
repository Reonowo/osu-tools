// the app-wide frame cursor: the single exact current-frame index, surviving
// a duplicate-time run without collapsing it, on top of whatever "current
// frame" the clock's raw time would otherwise derive. distinct from the frame
// selection (the sorted index set the cursor-path tools operate on, which
// lives on the editor slice): selecting never seeks, while the cursor is
// exactly what seeking moves. FramedReplayInputHandler.SetFrameFromTime
// (osu.Game/Replays/Legacy) advances currentFrameIndex by one per call, so
// index-based stepping through a tied run is what lazer itself does; a pure
// time search like countAtOrBefore crosses the whole run in a single step
// and leaves the intermediates unreachable

import { countAtOrBefore } from "../lib/timeline";
import { playbackClock } from "./instance";

/** the slice of PlaybackClock the cursor needs -- kept minimal so tests can
 * drive it with a fake clock instead of a real rAF-driven one */
export interface FrameCursorClock {
	currentTime(): number;
	seekTo(ms: number): void;
	/** monotonic seek counter; see the invalidation rule on exactIndex */
	readonly seekVersion: number;
}

interface Selection {
	index: number;
	atTime: number;
	atSeek: number;
}

export class FrameCursor {
	private times: readonly number[] = [];
	private selected: Selection | null = null;

	constructor(private readonly clock: FrameCursorClock) {}

	/** installs a new scene's frame times; drops any selection from the
	 * previous scene, which would otherwise point at an unrelated frame */
	setFrames(times: readonly number[]): void {
		this.times = times;
		this.selected = null;
	}

	/** clamps to the frame range and seeks the clock there, remembering the
	 * exact index so a following currentIndex() call resolves to it rather
	 * than the derived last-of-run guess */
	select(index: number): void {
		if (this.times.length === 0) return;
		const clamped = Math.min(Math.max(index, 0), this.times.length - 1);
		this.clock.seekTo(this.times[clamped]);
		this.selected = {
			index: clamped,
			atTime: this.clock.currentTime(),
			atSeek: this.clock.seekVersion
		};
	}

	/** the remembered exact selection if nothing has moved the clock since it
	 * was made -- any other seek (a scrub, an arrow-key seek) or playback
	 * advancing invalidates it, with no seek site needing to know the cursor
	 * exists -- else null.
	 *
	 * both halves are load-bearing. the time catches playback, which advances
	 * without seeking; the seek count catches a seek that left and came back to
	 * the very same millisecond, which is invisible to the time alone. counting
	 * rather than polling also means invalidation does not depend on anyone
	 * having *looked* while the clock was elsewhere: a scrub away and back
	 * between two reads still kills the selection.
	 *
	 * a mismatch drops it rather than merely stepping over it -- it is dead
	 * either way, and clearing keeps the state honest for the next reader */
	private exactIndex(t: number): number | null {
		if (this.selected === null) return null;
		if (this.selected.atTime === t && this.selected.atSeek === this.clock.seekVersion) {
			return this.selected.index;
		}
		this.selected = null;
		return null;
	}

	/** the frame the clock's time alone implies: the last one at-or-before it,
	 * which lands on the *last* of a duplicate-time run and so matches lazer's
	 * "forward direction is prioritized" rule for ties -- or -1 when the clock
	 * sits before the first frame at all.
	 *
	 * every scene opens in exactly that state: PlayerView seeks to
	 * derived.bounds.minTime, which folds in the audio lead-in and the first
	 * object's preempt and so generally precedes frame 0. it has to stay
	 * distinguishable from "on frame 0" rather than being flattened into it,
	 * or the first step forward would step straight over frame 0 */
	private derivedIndex(t: number): number {
		return countAtOrBefore(this.times, t) - 1;
	}

	/** the frame to display: the exact selection when one is live, else the
	 * derived one, floored at 0 because the readouts have to name some frame
	 * even while the clock sits in the lead-in before the first */
	currentIndex(): number {
		const t = this.clock.currentTime();
		return this.exactIndex(t) ?? Math.max(0, this.derivedIndex(t));
	}

	/** the disambiguated frame, or null when the clock's time alone decides it.
	 * readouts that show a frame's *own* recorded values -- rather than the
	 * interpolated gameplay state -- need to tell the two apart: sampling a
	 * tied-time run by time always resolves to its last frame, which is not the
	 * frame a step or a row click just selected */
	selectedIndex(): number | null {
		return this.exactIndex(this.clock.currentTime());
	}

	step(direction: 1 | -1): void {
		if (this.times.length === 0) return;
		const t = this.clock.currentTime();
		const exact = this.exactIndex(t);
		const from = exact ?? this.derivedIndex(t);
		// sitting *on* a frame and sitting somewhere after one are different
		// starting points, and only the first can be stepped from symmetrically.
		// after a scrub or a one-second seek the clock lands between frames,
		// where `from` is already behind it: the previous frame is `from`
		// itself, and taking `from - 1` would skip straight over it
		const onFrame = exact !== null || (from >= 0 && this.times[from] === t);
		const target = direction === 1 ? from + 1 : onFrame ? from - 1 : from;
		// nothing in that direction -- before the first frame going back, past
		// the last going forward. clamping into range would step the *other*
		// way, which is worse than not moving at all
		if (target < 0 || target >= this.times.length) return;
		this.select(target);
	}
}

/** app-wide frame cursor, alongside playbackClock (./instance) */
export const frameCursor = new FrameCursor(playbackClock);
