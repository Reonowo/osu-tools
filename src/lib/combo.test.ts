import { describe, expect, test } from "bun:test";
import { outQuint } from "@/engine/easing";
import { BREAK_DURATION_MS, comboChanges, comboPopAt, POP_DURATION_MS, type ComboChange } from "./combo";
import type { JudgementEventDto, JudgementKindDto } from "./scene-types";

function event(time: number, comboAfter: number, kind: JudgementKindDto): JudgementEventDto {
	return { time, objectIndex: 0, kind, comboAfter, accuracyAfter: 1 };
}

const great: JudgementKindDto = { type: "circle", grade: "great" };
const miss: JudgementKindDto = { type: "circle", grade: "miss" };

describe("comboChanges", () => {
	test("the play's first hit is an increment from nothing", () => {
		expect(comboChanges([event(1000, 1, great)])).toEqual([{ time: 1000, combo: 1, previous: 0 }]);
	});

	test("a run of hits is one change each, carrying what it rose from", () => {
		const changes = comboChanges([event(1000, 1, great), event(1100, 2, great), event(1200, 3, great)]);
		expect(changes).toEqual([
			{ time: 1000, combo: 1, previous: 0 },
			{ time: 1100, combo: 2, previous: 1 },
			{ time: 1200, combo: 3, previous: 2 }
		]);
	});

	test("holds leave no change: a dropped tail and a non-miss aggregate keep the combo", () => {
		// the engine's own combo semantics: a tail that misses does not reset,
		// and an ok/meh aggregate neither increments nor resets. reading
		// comboAfter rather than the kind is what gets this right with no table
		const changes = comboChanges([
			event(1000, 5, { type: "sliderHead", hit: true }),
			event(1100, 5, { type: "sliderTail", hit: false }),
			event(1150, 5, { type: "sliderAggregate", grade: "ok" })
		]);
		expect(changes).toEqual([{ time: 1000, combo: 5, previous: 0 }]);
	});

	test("spinner spin and bonus events leave no change either", () => {
		const changes = comboChanges([
			event(1000, 3, great),
			event(1100, 3, { type: "spinnerSpin" }),
			event(1200, 3, { type: "spinnerBonus" }),
			event(1300, 4, { type: "spinnerFinal", grade: "great" })
		]);
		expect(changes.map((c) => c.time)).toEqual([1000, 1300]);
	});

	test("a break is one change down to zero, carrying the run it cost", () => {
		const changes = comboChanges([event(1000, 1, great), event(1100, 2, great), event(1200, 0, miss)]);
		expect(changes[2]).toEqual({ time: 1200, combo: 0, previous: 2 });
	});

	test("an empty timeline has no changes", () => {
		expect(comboChanges([])).toEqual([]);
	});
});

describe("comboPopAt", () => {
	const increments: ComboChange[] = [
		{ time: 1000, combo: 1, previous: 0 },
		{ time: 2000, combo: 2, previous: 1 }
	];
	const broke: ComboChange[] = [{ time: 1000, combo: 0, previous: 40 }];

	test("rests before the first change and on an empty list", () => {
		expect(comboPopAt(increments, 0)).toEqual({ scale: 1, flash: 0 });
		expect(comboPopAt([], 5000)).toEqual({ scale: 1, flash: 0 });
	});

	test("an increment is fully popped at phase 0 and eased back by its duration", () => {
		expect(comboPopAt(increments, 1000)).toEqual({ scale: 1.1, flash: 0 });
		const half = comboPopAt(increments, 1000 + POP_DURATION_MS / 2);
		expect(half.scale).toBeCloseTo(1 + 0.1 * (1 - outQuint(0.5)), 12);
		expect(half.scale).toBeGreaterThan(1);
		expect(half.scale).toBeLessThan(1.1);
		expect(half.flash).toBe(0);
	});

	test("an increment is at rest once its duration has passed, and stays there", () => {
		expect(comboPopAt(increments, 1000 + POP_DURATION_MS)).toEqual({ scale: 1, flash: 0 });
		// the second change has not landed yet, so the counter sits at rest
		// between the two rather than holding the first pop
		expect(comboPopAt(increments, 1900)).toEqual({ scale: 1, flash: 0 });
	});

	test("a break shrinks and flashes at phase 0, easing back over its own longer duration", () => {
		expect(comboPopAt(broke, 1000)).toEqual({ scale: 0.8, flash: 1 });
		const half = comboPopAt(broke, 1000 + BREAK_DURATION_MS / 2);
		const tail = 1 - outQuint(0.5);
		expect(half.scale).toBeCloseTo(1 - 0.2 * tail, 12);
		expect(half.flash).toBeCloseTo(tail, 12);
		expect(comboPopAt(broke, 1000 + BREAK_DURATION_MS)).toEqual({ scale: 1, flash: 0 });
	});

	test("a break outlasts an increment, which is the point of the two durations", () => {
		expect(BREAK_DURATION_MS).toBeGreaterThan(POP_DURATION_MS);
		// at 600ms an increment is long done and a break is still going
		expect(comboPopAt(increments, 1600)).toEqual({ scale: 1, flash: 0 });
		expect(comboPopAt(broke, 1600).flash).toBeGreaterThan(0);
	});

	test("a 1 -> 0 drop is not a break: it never flashes", () => {
		const lost: ComboChange[] = [{ time: 1000, combo: 0, previous: 1 }];
		expect(comboPopAt(lost, 1000)).toEqual({ scale: 1, flash: 0 });
		expect(comboPopAt(lost, 1200)).toEqual({ scale: 1, flash: 0 });
	});

	test("a stream of increments 75ms apart never scales past 1.1x", () => {
		const stream: ComboChange[] = Array.from({ length: 40 }, (_, i) => ({
			time: 1000 + i * 75,
			combo: i + 1,
			previous: i
		}));
		for (let t = 900; t < 1000 + 40 * 75 + 600; t += 5) {
			const { scale } = comboPopAt(stream, t);
			expect(scale).toBeLessThanOrEqual(1.1);
			expect(scale).toBeGreaterThanOrEqual(1);
		}
	});

	test("the same millisecond gives the same frame whatever order it is asked in", () => {
		// the whole point of ADR 0009: no per-frame state, so playing into a
		// moment and seeking straight to it cannot differ
		const forward = [1000, 1100, 1200, 1300].map((t) => comboPopAt(broke, t));
		const backward = [1300, 1200, 1100, 1000].map((t) => comboPopAt(broke, t)).reverse();
		expect(backward).toEqual(forward);
		// and a seek far past, then back
		comboPopAt(broke, 99_999);
		expect(comboPopAt(broke, 1000)).toEqual(forward[0]);
	});

	test("two changes sharing a millisecond read as the later one", () => {
		const shared: ComboChange[] = [
			{ time: 1000, combo: 3, previous: 2 },
			{ time: 1000, combo: 0, previous: 3 }
		];
		expect(comboPopAt(shared, 1000)).toEqual({ scale: 0.8, flash: 1 });
	});

	test("NaN reads as before the first change rather than indexing wildly", () => {
		expect(comboPopAt(increments, Number.NaN)).toEqual({ scale: 1, flash: 0 });
	});
});
