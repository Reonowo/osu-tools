// slider path evaluation over the precomputed polyline + cumulative-length
// lut the render plan carries. frontend twin of engine's
// slider_path.rs / processing.rs ports; both must reproduce the lazer
// fixtures (slider_path.json position_at/path_to_progress, and
// beatmap/*.json ball_samples over render_plan/*.json geometry)

import { f32 } from "./vec";

export interface SliderGeometry {
	/** head-relative flat polyline [x0, y0, x1, y1, ...] */
	vertices: ArrayLike<number>;
	/** f64 arc length at each vertex */
	cumulativeLengths: ArrayLike<number>;
	/** expected-distance-adjusted travel distance */
	distance: number;
}

/** sliderpath.cs:517's almost-equals guard */
const DOUBLE_EPSILON = 1e-7;

/** engine::math::dotnet_double_to_i32_unchecked -- the pre-.net-9 x64
 * unchecked cast: truncate toward zero in range, int.min out of range */
export function dotnetTruncToI32(v: number): number {
	if (Number.isFinite(v) && v >= -2147483648 && v < 2147483648) return Math.trunc(v);
	return -2147483648;
}

/** system.array.binarysearch<double>: a matching index, or the bitwise
 * complement of the insertion point on a miss */
function dotnetBinarySearch(values: ArrayLike<number>, target: number): number {
	let lo = 0;
	let hi = values.length - 1;
	while (lo <= hi) {
		const mid = lo + ((hi - lo) >> 1);
		const v = values[mid];
		if (v === target) return mid;
		if (v < target) lo = mid + 1;
		else hi = mid - 1;
	}
	return ~lo;
}

function indexOfDistance(geo: SliderGeometry, d: number): number {
	const i = dotnetBinarySearch(geo.cumulativeLengths, d);
	return i < 0 ? ~i : i;
}

/** sliderpath.cs:495 */
function progressToDistance(geo: SliderGeometry, progress: number): number {
	return Math.min(Math.max(progress, 0), 1) * geo.distance;
}

/** sliderpath.cs:500 */
function interpolateVertices(geo: SliderGeometry, i: number, d: number): [number, number] {
	const count = geo.vertices.length / 2;
	if (count === 0) return [0, 0];
	if (i <= 0) return [geo.vertices[0], geo.vertices[1]];
	if (i >= count) return [geo.vertices[(count - 1) * 2], geo.vertices[(count - 1) * 2 + 1]];

	// vertices cross ipc/json as f32's own shortest round-trip decimal; a
	// float64 parser recovers a nearby double, not necessarily f64::from(the
	// original f32) bit-for-bit, so fround snaps back to the true f32 value
	// before it enters any float32-consistent arithmetic below
	const x0 = f32(geo.vertices[(i - 1) * 2]);
	const y0 = f32(geo.vertices[(i - 1) * 2 + 1]);
	const x1 = f32(geo.vertices[i * 2]);
	const y1 = f32(geo.vertices[i * 2 + 1]);
	const d0 = geo.cumulativeLengths[i - 1];
	const d1 = geo.cumulativeLengths[i];

	// sliderpath.cs:517 -- avoid dividing by an almost-zero span
	if (Math.abs(d0 - d1) <= DOUBLE_EPSILON) return [x0, y0];
	const w = (d - d0) / (d1 - d0);
	// the lerp weight is cast to f32 before the f32 vector math (slider_path.rs:301-302)
	const w32 = f32(w);
	return [f32(x0 + f32(f32(x1 - x0) * w32)), f32(y0 + f32(f32(y1 - y0) * w32))];
}

/** sliderpath.cs -- single-span position at progress in [0, 1] */
export function positionAt(geo: SliderGeometry, progress: number): [number, number] {
	const d = progressToDistance(geo, progress);
	return interpolateVertices(geo, indexOfDistance(geo, d), d);
}

/** sliderpath.cs:177 -- the vertex range covering [p0, p1], with
 * interpolated endpoints; feeds snaking */
export function pathToProgress(geo: SliderGeometry, p0: number, p1: number): number[] {
	const d0 = progressToDistance(geo, p0);
	const d1 = progressToDistance(geo, p1);
	const count = geo.vertices.length / 2;

	const path: number[] = [];
	let i = 0;
	while (i < count && geo.cumulativeLengths[i] < d0) i++;
	path.push(...interpolateVertices(geo, i, d0));
	while (i < count && geo.cumulativeLengths[i] <= d1) {
		path.push(geo.vertices[i * 2], geo.vertices[i * 2 + 1]);
		i++;
	}
	path.push(...interpolateVertices(geo, i, d1));
	return path;
}

/** ihaspathwithrepeats.cs:46-49 */
export function spanAt(spanCount: number, progress: number): number {
	return dotnetTruncToI32(progress * spanCount);
}

/** ihaspathwithrepeats.cs:33-41 -- fold whole-slider progress into the
 * current span, reversing odd spans */
export function progressAt(spanCount: number, progress: number): number {
	let p = (progress * spanCount) % 1;
	if (spanAt(spanCount, progress) % 2 === 1) p = 1 - p;
	return p;
}

/** ihaspathwithrepeats.cs:24-26 -- head-relative ball position */
export function curvePositionAt(geo: SliderGeometry, spanCount: number, progress: number): [number, number] {
	return positionAt(geo, progressAt(spanCount, progress));
}
