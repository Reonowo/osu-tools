import { describe, expect, test } from "bun:test";
import { finalScore, scoreAt } from "./score";
import type { ScoreCurve } from "./scene-types";

// three judgements and a spinner tick between the last two, which is the
// shape the engine emits: a step per scoring moment, carrying the RUNNING
// total after it
const CURVE: ScoreCurve = [
	[1000, 300],
	[2000, 600],
	[2500, 700],
	[3000, 948]
];

describe("scoreAt", () => {
	test("rests at 0 before the first step", () => {
		expect(scoreAt(CURVE, -5000)).toBe(0);
		expect(scoreAt(CURVE, 999)).toBe(0);
	});

	test("a step's own millisecond reads the total AFTER it", () => {
		expect(scoreAt(CURVE, 1000)).toBe(300);
		expect(scoreAt(CURVE, 2500)).toBe(700);
	});

	test("holds between steps rather than ramping", () => {
		// halfway between 300 and 600 is still 300: the number jumps at a
		// judgement, it does not slide toward the next one
		expect(scoreAt(CURVE, 1500)).toBe(300);
		expect(scoreAt(CURVE, 1999)).toBe(300);
	});

	test("holds the last value past the end", () => {
		expect(scoreAt(CURVE, 3000)).toBe(948);
		expect(scoreAt(CURVE, 999_999)).toBe(948);
	});

	test("an empty curve reads 0 everywhere", () => {
		expect(scoreAt([], -1)).toBe(0);
		expect(scoreAt([], 0)).toBe(0);
		expect(scoreAt([], 10_000)).toBe(0);
	});

	test("two steps sharing a millisecond read as the later one", () => {
		// the engine can emit a spinner's half turn and the judgement that
		// bounded it at the same time; the number on screen is the total after
		// both, never the one in between
		const shared: ScoreCurve = [
			[1000, 100],
			[1000, 400]
		];
		expect(scoreAt(shared, 1000)).toBe(400);
	});

	test("a single-step curve reads on both sides of its step", () => {
		const one: ScoreCurve = [[500, 30]];
		expect(scoreAt(one, 499)).toBe(0);
		expect(scoreAt(one, 500)).toBe(30);
		expect(scoreAt(one, 501)).toBe(30);
	});

	test("NaN reads as before the first step rather than indexing wildly", () => {
		expect(scoreAt(CURVE, Number.NaN)).toBe(0);
	});
});

describe("finalScore", () => {
	test("is the curve's last step", () => {
		expect(finalScore(CURVE)).toBe(948);
	});

	test("a play that scored nothing has no steps and no score", () => {
		expect(finalScore([])).toBe(0);
	});

	test("agrees with reading past the end", () => {
		expect(finalScore(CURVE)).toBe(scoreAt(CURVE, Number.POSITIVE_INFINITY));
	});
});
