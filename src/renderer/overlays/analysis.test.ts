import { describe, expect, test } from "bun:test";
import { cursorStateAt } from "../../engine/interpolation";
import type { FrameDto } from "../../lib/scene-types";
import { aliveWindow, cursorPathPoints } from "./analysis";

describe("aliveWindow (analysisframeentry.cs lifetime [t, t+len))", () => {
	const times = [0, 100, 200, 300, 400];

	test("selects entries with time <= t < time + displayLength", () => {
		expect(aliveWindow(times, 250, 800)).toEqual({ lo: 0, hi: 3 });
		expect(aliveWindow(times, 950, 800)).toEqual({ lo: 2, hi: 5 });
		// exactly at expiry: entry at 0 dies at t=800
		expect(aliveWindow(times, 800, 800)).toEqual({ lo: 1, hi: 5 });
		expect(aliveWindow(times, -1, 800)).toEqual({ lo: 0, hi: 0 });
	});

	test("empty times array is always an empty window", () => {
		expect(aliveWindow([], 500, 800)).toEqual({ lo: 0, hi: 0 });
	});

	// duplicate timestamps are a real replay-frame shape (interpolation.ts:43-46,
	// confirmed against framedreplayinputhandler.cs:141-146); a run of ties must
	// enter and leave the window together, never split by index
	describe("duplicate timestamps", () => {
		const dup = [100, 100, 200, 200, 200, 300];

		test("a run of ties at the trailing edge (time === t) is fully included", () => {
			// window (100, 200]: excludes both 100s, includes all three 200s
			expect(aliveWindow(dup, 200, 100)).toEqual({ lo: 2, hi: 5 });
		});

		test("a run of ties at the leading edge (time === t - displayLength) is fully excluded", () => {
			// window (0, 100]: both 100s satisfy time <= t and t < time + length, so
			// they are alive -- but a *different* tie exactly at t - displayLength
			// itself would be excluded (time <= t - length fails t < time + length)
			expect(aliveWindow(dup, 100, 100)).toEqual({ lo: 0, hi: 2 });
		});

		test("a lone entry past every tie", () => {
			// window (200, 300]: only the trailing 300 qualifies
			expect(aliveWindow(dup, 300, 100)).toEqual({ lo: 5, hi: 6 });
		});
	});
});

describe("cursorPathPoints (the path ends at the drawn cursor, not the newest frame)", () => {
	const frame = (time: number, x: number, y: number): FrameDto => ({ time, x, y, buttons: 0 });
	const frames = [frame(0, 0, 0), frame(100, 100, 0), frame(200, 100, 100), frame(300, 200, 100)];
	const times = frames.map((f) => f.time);

	test("a seek landing between frames appends the interpolated cursor sample", () => {
		// t=250 sits halfway along the 200 -> 300 segment
		const { lo, hi } = aliveWindow(times, 250, 800);
		const points = cursorPathPoints(frames, lo, hi, 250);
		const head = cursorStateAt(frames, 250)!;
		expect(points.length).toBe(hi - lo + 1);
		expect(points[points.length - 1]).toEqual({ x: head.x, y: head.y });
		expect(points[points.length - 1]).toEqual({ x: 150, y: 100 });
		// the window frames themselves are untouched, in order
		expect(points.slice(0, -1)).toEqual(frames.slice(lo, hi).map((f) => ({ x: f.x, y: f.y })));
	});

	test("a frame-exact t appends nothing -- the newest frame already is the cursor", () => {
		const { lo, hi } = aliveWindow(times, 200, 800);
		const points = cursorPathPoints(frames, lo, hi, 200);
		expect(points.length).toBe(hi - lo);
		expect(points[points.length - 1]).toEqual({ x: 100, y: 100 });
	});

	test("a single window frame plus the mid-segment cursor is a drawable two-point path", () => {
		// window (150, 250] holds only the frame at 200; the old frame-only path
		// had nothing to draw here even though the cursor is visibly on the move
		const { lo, hi } = aliveWindow(times, 250, 100);
		expect(hi - lo).toBe(1);
		expect(cursorPathPoints(frames, lo, hi, 250)).toEqual([
			{ x: 100, y: 100 },
			{ x: 150, y: 100 }
		]);
	});

	test("past the last frame the cursor holds and no head is stacked on", () => {
		const { lo, hi } = aliveWindow(times, 350, 800);
		const points = cursorPathPoints(frames, lo, hi, 350);
		expect(points.length).toBe(hi - lo);
		expect(points[points.length - 1]).toEqual({ x: 200, y: 100 });
	});

	test("an empty window yields no path regardless of the cursor", () => {
		expect(cursorPathPoints(frames, 0, 0, -50)).toEqual([]);
	});

	test("t on a duplicate-time run settles on its last frame without a stacked head", () => {
		const dup = [frame(0, 0, 0), frame(100, 50, 0), frame(100, 80, 0), frame(200, 120, 0)];
		const { lo, hi } = aliveWindow(
			dup.map((f) => f.time),
			100,
			800
		);
		const points = cursorPathPoints(dup, lo, hi, 100);
		expect(points.length).toBe(hi - lo);
		expect(points[points.length - 1]).toEqual({ x: 80, y: 0 });
	});
});
