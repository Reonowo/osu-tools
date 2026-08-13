// the cursor trail as a pure function of the replay's frame stream and the
// current time. citations: cursortrail.cs:179-226 (parts spaced a fixed
// distance apart along the path the cursor took), cursortrail.cs:129 and
// argoncursortrail.cs:16,26 (the fade). cursortrail.cs's actual
// vertex/fragment shader (sh_CursorTrail.vs/.fs) lives in an osu-framework
// nupkg, not the pinned source checkout -- the fade formula below is inlined
// from the task brief, cross-checked against cursortrail.cs's C#-side
// FadeClock/FadeExponent wiring
//
// this replaces an incremental tracker that accumulated parts across
// update() calls. that state belonged to the drawable, so a rebuilt drawable
// -- which is what a density rebake does to every scene-lifetime one --
// started from an empty trail and, paused, never refilled it. deriving the
// parts from the frames instead makes a rebuild unobservable: there is no
// accumulated state left to lose. it also retires the seek reset the tracker
// needed, since a part can now only ever sit somewhere the cursor genuinely
// was, and a seek simply reads the destination's own trail rather than
// streaking a line across the screen from wherever playback left off

import { partitionPoint } from "../../engine/interpolation";
import type { FrameDto } from "../../lib/scene-types";

/** osuconfigmanager.cs:115,117 -- GameplayCursorSize defaults to 1.0 and
 * AutoCursorSize defaults to false, so OsuCursor.CalculateCursorScale() is
 * always 1 for an unmodded replay viewer */
const CURSOR_SCALE = 1;
/** cursortrail.cs:201 -- interval = Texture.DisplayWidth * CursorScale.X / 2.5 * IntervalMultiplier;
 * argoncursortrail.cs:14 -- IntervalMultiplier override is 0.4 (base is 1.0) */
const TRAIL_INTERVAL = ((64 * CURSOR_SCALE) / 2.5) * 0.4;
/** cursortrail.cs:129 -- FadeDuration */
const TRAIL_FADE_DURATION = 300;
/** argoncursortrail.cs:16 -- FadeExponent override (base CursorTrail is 1.7) */
const TRAIL_FADE_EXPONENT = 4;
/** argoncursortrail.cs:26 -- Alpha */
const TRAIL_BASE_ALPHA = 0.8;
/** ample for a ~300ms fade window at ~10.24 osu!px spacing -- only a cursor
 * teleporting frame after frame (a doctored replay, not a played one) can
 * reach it. the cap is on the parts nearest the cursor because those are the
 * ones still bright enough to see */
const TRAIL_MAX_PARTS = 256;

export interface TrailShape {
	/** osu!px along the path between consecutive parts */
	interval: number;
	/** ms a part takes to fade from the base alpha to nothing */
	fadeDuration: number;
	/** the most parts drawn at once; past this the oldest are dropped */
	maxParts: number;
}

/** the trail the argon skin draws */
export const ARGON_TRAIL: TrailShape = {
	interval: TRAIL_INTERVAL,
	fadeDuration: TRAIL_FADE_DURATION,
	maxParts: TRAIL_MAX_PARTS
};

export interface TrailPart {
	x: number;
	y: number;
	/** when the cursor was at (x, y) -- what the fade ages against */
	bornAt: number;
	/** already faded for the time the part was asked for */
	alpha: number;
}

/** the frame polyline with the distance travelled along it, computed once per
 * frame stream (the precomputed-track pattern the per-object drawables use):
 * everything below is a lookup into it */
export interface TrailPath {
	readonly frames: readonly FrameDto[];
	/** osu!px travelled from the first frame to frame i; non-decreasing */
	readonly arc: Float64Array;
}

export function buildTrailPath(frames: readonly FrameDto[]): TrailPath {
	const arc = new Float64Array(frames.length);
	for (let i = 1; i < frames.length; i += 1) {
		arc[i] = arc[i - 1] + Math.hypot(frames[i].x - frames[i - 1].x, frames[i].y - frames[i - 1].y);
	}
	return { frames, arc };
}

/** the trail shader's pow(clamp(m_Time - g_FadeClock, 0, 1), g_FadeExponent)
 * times the base alpha (argoncursortrail.cs:26); `age` is already
 * normalized to fade duration, i.e. (t - bornAt) / fadeDuration */
export function trailAlpha(age: number): number {
	return TRAIL_BASE_ALPHA * Math.max(0, Math.min(1, 1 - age)) ** TRAIL_FADE_EXPONENT;
}

/** how far along the path the cursor has travelled at `time`. the frame
 * selection mirrors interpolation.ts's cursorStateAt exactly, so the head of
 * the trail always meets the cursor the renderer actually draws: the first
 * frame's position holds before the replay starts, the last one's after it
 * ends, and a duplicate-time run settles on the last frame of the run */
function arcAt(path: TrailPath, time: number): number {
	const { frames, arc } = path;
	const idx = partitionPoint(frames, time);
	if (idx === 0) return 0;
	if (idx >= frames.length) return arc[frames.length - 1];
	const span = frames[idx].time - frames[idx - 1].time;
	if (span <= 0) return arc[idx - 1];
	return arc[idx - 1] + (arc[idx] - arc[idx - 1]) * ((time - frames[idx - 1].time) / span);
}

/** the greatest index whose arc length is still at or below `distance`,
 * searched from `lo` upward -- the caller walks distances in ascending order,
 * so each search picks up where the last one stopped */
function segmentAt(arc: Float64Array, distance: number, lo: number): number {
	let hi = arc.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (arc[mid] <= distance) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** the parts to draw at `t`: the cursor's path over the last `fadeDuration`,
 * sampled every `interval` osu!px, each one aged by how long ago the cursor
 * passed it.
 *
 * the sample lattice is anchored at the first frame rather than at the fade
 * window, which is what keeps a part still while the window slides over it --
 * measuring from a moving origin would shift every part by up to an interval
 * each time the window's trailing edge crossed a frame. the open interval
 * matches cursortrail.cs's own `for (d = interval; d < distance; d +=
 * interval)`: nothing spawns on top of the cursor, and a part that has aged
 * out exactly is already invisible */
export function trailPartsAt(path: TrailPath, t: number, shape: TrailShape): TrailPart[] {
	const { frames, arc } = path;
	if (frames.length < 2 || !(shape.interval > 0)) return [];

	const head = arcAt(path, t);
	const tail = arcAt(path, t - shape.fadeDuration);
	const last = Math.ceil(head / shape.interval) - 1;
	let first = Math.floor(tail / shape.interval) + 1;
	if (last < first) return [];
	if (last - first + 1 > shape.maxParts) first = last - shape.maxParts + 1;

	const parts: TrailPart[] = [];
	let segment = 0;
	for (let k = first; k <= last; k += 1) {
		const distance = k * shape.interval;
		segment = segmentAt(arc, distance, segment);
		const next = Math.min(segment + 1, frames.length - 1);
		const span = arc[next] - arc[segment];
		const progress = span > 0 ? (distance - arc[segment]) / span : 0;
		const bornAt = frames[segment].time + (frames[next].time - frames[segment].time) * progress;
		parts.push({
			x: frames[segment].x + (frames[next].x - frames[segment].x) * progress,
			y: frames[segment].y + (frames[next].y - frames[segment].y) * progress,
			bornAt,
			alpha: trailAlpha((t - bornAt) / shape.fadeDuration)
		});
	}
	return parts;
}
