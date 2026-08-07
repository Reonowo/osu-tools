import { describe, expect, test } from "bun:test";
import { isK1, isK2, isLeft, isM1, isM2, isRight, K1, K2, M1, M2, PHYSICAL_BUTTONS } from "./buttons";

describe("physical predicates (osuReplayEditor API.cs:249)", () => {
	test("raw 5 (k1|m1, a keyboard tap) yields K1 only", () => {
		expect(isK1(5)).toBe(true);
		expect(isM1(5)).toBe(false);
	});

	test("raw 10 (k2|m2, a keyboard tap) yields K2 only", () => {
		expect(isK2(10)).toBe(true);
		expect(isM2(10)).toBe(false);
	});

	test("raw 1 (m1 alone) yields M1", () => {
		expect(isM1(1)).toBe(true);
		expect(isK1(1)).toBe(false);
	});

	test("bare 4 (k1 without m1) still yields K1", () => {
		expect(isK1(4)).toBe(true);
		expect(isM1(4)).toBe(false);
	});

	test("bare 8 (k2 without m2) still yields K2", () => {
		expect(isK2(8)).toBe(true);
		expect(isM2(8)).toBe(false);
	});

	test("raw 2 (m2 alone) yields M2", () => {
		expect(isM2(2)).toBe(true);
		expect(isK2(2)).toBe(false);
	});

	test("isK1/isM1 partition isLeft, and isK2/isM2 partition isRight, over every raw value", () => {
		// the 5-bit raw bitfield (m1|m2|k1|k2|smoke) has 32 combinations; the
		// physical predicates must never agree on both keys of a side, and must
		// agree with the logical predicate on whether that side is held at all
		for (let raw = 0; raw < 32; raw++) {
			expect(isK1(raw) && isM1(raw), `raw=${raw}`).toBe(false);
			expect(isK1(raw) || isM1(raw), `raw=${raw}`).toBe(isLeft(raw));
			expect(isK2(raw) && isM2(raw), `raw=${raw}`).toBe(false);
			expect(isK2(raw) || isM2(raw), `raw=${raw}`).toBe(isRight(raw));
		}
	});
});

describe("isLeft/isRight are unchanged by the physical predicates (gameplay/simulation invariance)", () => {
	test("every raw bitfield value 0-31 matches the M1|K1 / M2|K2 formula", () => {
		for (let raw = 0; raw < 32; raw++) {
			expect(isLeft(raw), `raw=${raw}`).toBe((raw & (M1 | K1)) !== 0);
			expect(isRight(raw), `raw=${raw}`).toBe((raw & (M2 | K2)) !== 0);
		}
	});
});

describe("PHYSICAL_BUTTONS", () => {
	test("lists all four physical keys, K1 K2 M1 M2, with matching predicates", () => {
		expect(PHYSICAL_BUTTONS.map((b) => b.label)).toEqual(["K1", "K2", "M1", "M2"]);
		expect(PHYSICAL_BUTTONS.map((b) => b.edgesKey)).toEqual(["k1", "k2", "m1", "m2"]);
		expect(PHYSICAL_BUTTONS.map((b) => b.is)).toEqual([isK1, isK2, isM1, isM2]);
	});
});
