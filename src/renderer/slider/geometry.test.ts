import { describe, expect, test } from "bun:test";
import { buildPathQuads, pathBounds } from "./geometry";

function quadAt(q: ReturnType<typeof buildPathQuads>, index: number) {
	const positions = q.positions.slice(index * 8, index * 8 + 8);
	const start = q.segStarts.slice(index * 8, index * 8 + 2);
	const end = q.segEnds.slice(index * 8, index * 8 + 2);
	return { positions, start, end };
}

describe("path bounds (path.cs:175-202)", () => {
	test("origin-seeded and inflated by the radius", () => {
		const b = pathBounds([50, 50, 150, 50], 10);
		// min seeds at 0 even though the path starts at (50, 50)
		expect(b.minX).toBe(0);
		expect(b.minY).toBe(0);
		expect(b.width).toBe(160);
		expect(b.height).toBe(60);
	});

	test("an empty vertex list collapses to the zero rectangle (path.cs:200)", () => {
		expect(pathBounds([], 10)).toEqual({ minX: 0, minY: 0, width: 0, height: 0 });
	});

	test("a single vertex still inflates on every side and stays origin-seeded", () => {
		const b = pathBounds([5, -5], 10);
		// minX = min(0, 5-10) = -5; minY = min(0, -5-10) = -15
		// maxX = max(0, 5+10) = 15; maxY = max(0, -5+10) = 5
		expect(b.minX).toBe(-5);
		expect(b.minY).toBe(-15);
		expect(b.width).toBe(20);
		expect(b.height).toBe(20);
	});
});

describe("path quads (path.drawnode.cs)", () => {
	test("a single segment is one quad with both caps extended", () => {
		const q = buildPathQuads([0, 0, 100, 0], 10);
		expect(q.quadCount).toBe(1);
		const { positions, start, end } = quadAt(q, 0);
		// tl, tr, br, bl; ortho of (1,0) is (0,1); caps extend by radius
		expect(positions).toEqual([-10, 10, 110, 10, 110, -10, -10, -10]);
		expect(start).toEqual([0, 0]);
		expect(end).toEqual([100, 0]);
		expect([...q.indices]).toEqual([0, 1, 2, 0, 2, 3]);
	});

	test("collinear vertices merge into one segment spanning the full run", () => {
		const q = buildPathQuads([0, 0, 50, 0, 100, 0], 10);
		expect(q.quadCount).toBe(1);
		const { start, end } = quadAt(q, 0);
		expect(start).toEqual([0, 0]);
		expect(end).toEqual([100, 0]);
	});

	test("sub-precision segments are absorbed into the running segment", () => {
		// second segment has length 0.05 (lengthSquared 0.0025 < 0.01)
		const q = buildPathQuads([0, 0, 100, 0, 100.05, 0, 200, 0.0001], 10);
		expect(q.quadCount).toBe(1);
		const { start, end } = quadAt(q, 0);
		expect(start).toEqual([0, 0]);
		// segEnds is a Float32Array, so the f64 literal rounds to its nearest f32
		expect(end).toEqual([200, Math.fround(0.0001)]);
	});

	test("an exactly zero-length segment is absorbed via the raw length guard", () => {
		// the first raw segment itself has zero length, exercising
		// `lengthSquared < precision` (path.drawnode.cs:187) directly, unlike
		// the sub-precision case above which goes through the pDot-collinearity
		// reduction (path.drawnode.cs:197)
		const q = buildPathQuads([0, 0, 0, 0, 100, 0], 10);
		expect(q.quadCount).toBe(1);
		const { start, end } = quadAt(q, 0);
		expect(start).toEqual([0, 0]);
		expect(end).toEqual([100, 0]);
	});

	test("a right-angle joint start-caps the next segment instead of filling", () => {
		// dot(dir, -dir2) == 0 -> the >= 0 branch: no joint quad
		const q = buildPathQuads([0, 0, 100, 0, 100, 100], 10);
		expect(q.quadCount).toBe(2);
		// seg1 (100,0)->(100,100) must actually receive the start cap: pulled
		// back by offset = dir*radius = (0,10), not merely left unmodified
		const seg1 = quadAt(q, 1);
		expect(seg1.positions[0]).toBeCloseTo(90, 5); // tlx
		expect(seg1.positions[1]).toBeCloseTo(-10, 5); // tly
		expect(seg1.positions[6]).toBeCloseTo(110, 5); // blx
		expect(seg1.positions[7]).toBeCloseTo(-10, 5); // bly
	});

	test("an obtuse joint above the merge angle gets a degenerate-segment fill quad", () => {
		// turn of ~11.3deg > pi/24; joint quad's segment collapses to the origin
		const q = buildPathQuads([0, 0, 100, 0, 200, 20], 10);
		expect(q.quadCount).toBe(3);
		const joint = quadAt(q, 1);
		expect(joint.start).toEqual([100, 0]);
		expect(joint.end).toEqual([100, 0]);
	});

	test("the joint fill quad's corners follow drawQuad's actual push order (path.drawnode.cs:134-165)", () => {
		// path.drawnode.cs:137 calls drawQuad(toConnect.StartPoint, outerVertex,
		// innerVertex, toConnect.EndPoint, origin, origin). drawQuad's own
		// parameter list is (topLeft, topRight, bottomLeft, bottomRight, ...)
		// but it pushes topLeft, topRight, bottomRight, bottomLeft
		// (path.drawnode.cs:161-164) -- so the four vertices actually emitted
		// are [start, outer, end, inner], not [start, outer, inner, end].
		// this test recomputes the four corners independently from the pinned
		// formulas (not by calling into geometry.ts's own helpers) so it fails
		// if the emitted order regresses to the naive reading of the call site.
		const radius = 10;
		const q = buildPathQuads([0, 0, 100, 0, 200, 20], radius);
		const { positions } = quadAt(q, 1);

		const dir1 = [1, 0]; // seg0's normalized direction
		const seg1Len = Math.hypot(100, 20);
		const dir2 = [100 / seg1Len, 20 / seg1Len]; // seg1's normalized direction
		const negDir1 = [-dir1[0], -dir1[1]];
		const dot = dir2[0] * negDir1[0] + dir2[1] * negDir1[1];
		const pDot = dir2[0] * negDir1[1] - dir2[1] * negDir1[0];
		const thetaDiff = Math.abs(Math.atan(pDot / dot));

		const ortho1 = [-dir1[1], dir1[0]];
		const ortho2 = [-dir2[1], dir2[0]];
		// pDot > 0 here -> toConnect = Line(prevSegment.BottomRight, segment.BottomLeft)
		const prevBottomRight = [100 - ortho1[0] * radius, 0 - ortho1[1] * radius];
		const curBottomLeft = [100 - ortho2[0] * radius, 0 - ortho2[1] * radius];
		const offset = [dir2[0] * radius, dir2[1] * radius];
		const tan = Math.tan(thetaDiff * 0.5);
		const outer = [curBottomLeft[0] - offset[0] * tan, curBottomLeft[1] - offset[1] * tan];
		const origin = [100, 0];
		const inner = [outer[0] + (origin[0] - outer[0]) * 1.1, outer[1] + (origin[1] - outer[1]) * 1.1];

		const expected = [
			prevBottomRight[0],
			prevBottomRight[1], // from = toConnect.StartPoint
			outer[0],
			outer[1], // outer
			curBottomLeft[0],
			curBottomLeft[1], // to = toConnect.EndPoint
			inner[0],
			inner[1] // inner
		];
		for (let i = 0; i < 8; i++) expect(positions[i]).toBeCloseTo(expected[i], 5);
	});

	test("indices stay in range and offset by 4 per quad across a multi-quad path", () => {
		const q = buildPathQuads([0, 0, 100, 0, 200, 20], 10);
		expect(q.quadCount).toBe(3);
		expect([...q.indices]).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11]);
	});

	test("a shallow joint below pi/24 shares the previous quad edge (no joint quad)", () => {
		// turn of ~2.9deg < pi/24
		const q = buildPathQuads([0, 0, 100, 0, 200, 5], 10);
		expect(q.quadCount).toBe(2);
		// pDot > 0 here -> seg1's bottomLeft is overwritten with the previous
		// (seg0's) DrawableSegment.BottomRight: (100,0) - (0,10) = (100,-10)
		const seg1 = quadAt(q, 1);
		expect(seg1.positions[6]).toBeCloseTo(100, 5); // blx
		expect(seg1.positions[7]).toBeCloseTo(-10, 5); // bly
	});

	test("degenerate inputs do not throw and produce no geometry", () => {
		expect(buildPathQuads([], 10).quadCount).toBe(0);
		expect(buildPathQuads([50, 50], 10).quadCount).toBe(0);
		// radius 0 draws nothing (path.drawnode.cs:53's `radius == 0f` guard)
		expect(buildPathQuads([0, 0, 100, 0], 0).quadCount).toBe(0);
	});

	test("two identical vertices fall back to the unit-x direction (path.drawnode.cs:294-295)", () => {
		const q = buildPathQuads([50, 50, 50, 50], 10);
		expect(q.quadCount).toBe(1);
		const { positions, start, end } = quadAt(q, 0);
		for (const value of positions) expect(Number.isFinite(value)).toBe(true);
		expect(start).toEqual([50, 50]);
		expect(end).toEqual([50, 50]);
		// fallback dir=(1,0) -> ortho=(0,radius); both caps extend by radius*dir
		expect(positions).toEqual([40, 60, 60, 60, 60, 40, 40, 40]);
	});
});
