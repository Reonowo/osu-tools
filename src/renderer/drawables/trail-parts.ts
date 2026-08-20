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

import { cursorStateAt, partitionPoint } from "../../engine/interpolation";
import {
	CONNECTED_TRAIL_FADE_DURATION,
	DISJOINT_TRAIL_FADE_DURATION,
	DISJOINT_TRAIL_TIME_SEPARATION,
	LEGACY_TRAIL_FADE_EXPONENT
} from "@/skin/legacy/constants";
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

/**
 * how a trail spawns its parts.
 *
 * two shapes, and the difference is lazer's own: a connected trail
 * (cursortrail.cs:183-215) interpolates along the path the cursor took and
 * drops a part every `interval` osu!px, while a DISJOINT one
 * (legacycursortrail.cs:81-85) drops one wherever the cursor is every
 * `separation` ms and interpolates nothing. which of the two a legacy skin gets
 * is decided by whether its cursor provider ships a `cursormiddle`
 */
export type TrailSpawn =
	/** cursortrail.cs:201 -- interval = Texture.DisplayWidth * CursorScale.X / 2.5 * IntervalMultiplier */
	| { by: "distance"; interval: number }
	/** legacycursortrail.cs:19,81-85 -- one part per 60fps frame */
	| { by: "time"; separation: number };

export interface TrailShape {
	spawn: TrailSpawn;
	/** ms a part takes to fade from the base alpha to nothing */
	fadeDuration: number;
	/** cursortrail.cs:35 -- the shader's `pow(..., FadeExponent)` */
	fadeExponent: number;
	/** the trail drawable's own Alpha, which every part is multiplied by */
	baseAlpha: number;
	/** the most parts drawn at once; past this the oldest are dropped */
	maxParts: number;
}

/** the trail the argon skin draws */
export const ARGON_TRAIL: TrailShape = {
	spawn: { by: "distance", interval: TRAIL_INTERVAL },
	fadeDuration: TRAIL_FADE_DURATION,
	fadeExponent: TRAIL_FADE_EXPONENT,
	baseAlpha: TRAIL_BASE_ALPHA,
	maxParts: TRAIL_MAX_PARTS
};

/**
 * the trail a legacy skin draws.
 *
 * `displayWidth` is the trail texture's own osu!px width and cannot be a
 * constant: the interval is derived from it (cursortrail.cs:201), so a skin
 * with a wider trail sprite spaces its parts further apart. `IntervalMultiplier`
 * is 1/max(cursorSize,1) (legacycursortrail.cs:71) and the cursor size is fixed
 * at 1 for an unmodded replay, so it folds away
 */
export function legacyTrailShape(displayWidth: number, disjoint: boolean): TrailShape {
	return {
		spawn: disjoint
			? { by: "time", separation: DISJOINT_TRAIL_TIME_SEPARATION }
			: { by: "distance", interval: (displayWidth * CURSOR_SCALE) / 2.5 },
		// legacycursortrail.cs:66
		fadeDuration: disjoint ? DISJOINT_TRAIL_FADE_DURATION : CONNECTED_TRAIL_FADE_DURATION,
		// legacycursortrail.cs:67
		fadeExponent: LEGACY_TRAIL_FADE_EXPONENT,
		// LegacyCursorTrail sets no Alpha of its own, so every part draws at full
		baseAlpha: 1,
		maxParts: TRAIL_MAX_PARTS
	};
}

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
 * times the trail's own alpha; `age` is already normalized to fade duration,
 * i.e. (t - bornAt) / fadeDuration.
 *
 * the exponent and the base are the SHAPE's rather than constants, because the
 * two eras disagree on both: argon fades at the fourth power from 0.8
 * (argoncursortrail.cs:16,26), a legacy trail linearly from full
 * (legacycursortrail.cs:67) */
export function trailAlpha(age: number, shape: Pick<TrailShape, "fadeExponent" | "baseAlpha">): number {
	return shape.baseAlpha * Math.max(0, Math.min(1, 1 - age)) ** shape.fadeExponent;
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

/** the parts to draw at `t`.
 *
 * a DISTANCE trail is the cursor's path over the last `fadeDuration`, sampled
 * every `interval` osu!px, each part aged by how long ago the cursor passed it.
 * a TIME trail is the cursor's position at each of the last `separation`-ms
 * ticks, which is a different set entirely: a still cursor keeps stacking parts
 * on one spot rather than drawing none.
 *
 * both lattices are anchored absolutely -- at the first frame's arc length, and
 * at time zero -- rather than at the sliding fade window, which is what keeps a
 * part still while the window slides over it. measuring from a moving origin
 * would shift every part by up to one step each time the window's trailing edge
 * crossed a frame.
 *
 * the open interval matches cursortrail.cs's own `for (d = interval; d <
 * distance; d += interval)`: nothing spawns on top of the cursor, and a part
 * that has aged out exactly is already invisible
 */
export function trailPartsAt(path: TrailPath, t: number, shape: TrailShape): TrailPart[] {
	return shape.spawn.by === "time"
		? timedPartsAt(path, t, shape, shape.spawn.separation)
		: distancedPartsAt(path, t, shape, shape.spawn.interval);
}

/** legacycursortrail.cs:81-85 -- one part wherever the cursor was at each tick,
 * with no interpolation between frames (`InterpolateMovements` is false for a
 * disjoint trail, so a part sits exactly where a frame put it) */
function timedPartsAt(path: TrailPath, t: number, shape: TrailShape, separation: number): TrailPart[] {
	const { frames } = path;
	if (frames.length === 0 || !(separation > 0)) return [];
	const last = Math.ceil(t / separation) - 1;
	let first = Math.floor((t - shape.fadeDuration) / separation) + 1;
	if (last < first) return [];
	if (last - first + 1 > shape.maxParts) first = last - shape.maxParts + 1;

	const parts: TrailPart[] = [];
	for (let k = first; k <= last; k += 1) {
		const bornAt = k * separation;
		const state = cursorStateAt(frames, bornAt);
		if (state === null) continue;
		parts.push({
			x: state.x,
			y: state.y,
			bornAt,
			alpha: trailAlpha((t - bornAt) / shape.fadeDuration, shape)
		});
	}
	return parts;
}

function distancedPartsAt(path: TrailPath, t: number, shape: TrailShape, interval: number): TrailPart[] {
	const { frames, arc } = path;
	if (frames.length < 2 || !(interval > 0)) return [];

	const head = arcAt(path, t);
	const tail = arcAt(path, t - shape.fadeDuration);
	const last = Math.ceil(head / interval) - 1;
	let first = Math.floor(tail / interval) + 1;
	if (last < first) return [];
	if (last - first + 1 > shape.maxParts) first = last - shape.maxParts + 1;

	const parts: TrailPart[] = [];
	let segment = 0;
	for (let k = first; k <= last; k += 1) {
		const distance = k * interval;
		segment = segmentAt(arc, distance, segment);
		const next = Math.min(segment + 1, frames.length - 1);
		const span = arc[next] - arc[segment];
		const progress = span > 0 ? (distance - arc[segment]) / span : 0;
		const bornAt = frames[segment].time + (frames[next].time - frames[segment].time) * progress;
		parts.push({
			x: frames[segment].x + (frames[next].x - frames[segment].x) * progress,
			y: frames[segment].y + (frames[next].y - frames[segment].y) * progress,
			bornAt,
			alpha: trailAlpha((t - bornAt) / shape.fadeDuration, shape)
		});
	}
	return parts;
}
