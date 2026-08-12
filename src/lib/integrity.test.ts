import { describe, expect, test } from "bun:test";
import {
	crossCheckConsistent,
	describeCrossCheck,
	integrityRowLabel,
	integrityRowValue,
	lifeBarNote
} from "./integrity";
import type { IntegrityReport } from "./scene-types";

const report: IntegrityReport = {
	rows: [
		{ field: "count300", header: 100, simulated: 100, match: true },
		{ field: "countGeki", header: 103, simulated: 99, match: false },
		{ field: "perfect", header: 1, simulated: 0, match: false }
	],
	crossCheck: { sections: 105, gekiKatsu: 103, sectionsWithMiss: 2, countMiss: 2 },
	lifeBarPresent: false
};

describe("integrity rows", () => {
	test("every wire field has a prose label, katu spelled the prose way", () => {
		expect(integrityRowLabel("countGeki")).toBe("geki");
		expect(integrityRowLabel("countKatsu")).toBe("katu");
		expect(integrityRowLabel("maxCombo")).toBe("max combo");
		expect(integrityRowLabel("totalScore")).toBe("total score");
		// an unknown field falls back to itself rather than hiding
		expect(integrityRowLabel("mystery")).toBe("mystery");
	});

	test("perfect formats as yes/no, counts as locale numbers", () => {
		expect(integrityRowValue("perfect", 1)).toBe("yes");
		expect(integrityRowValue("perfect", 0)).toBe("no");
		expect(integrityRowValue("totalScore", 1234567)).toBe((1234567).toLocaleString());
	});
});

describe("cross-check", () => {
	test("the sentence states the identity with the header misses beside it", () => {
		expect(describeCrossCheck(report.crossCheck)).toBe(
			"105 sections − 103 geki+katu = 2 with a miss · header misses 2"
		);
	});

	test("consistency holds when miss-sections fit inside the miss count", () => {
		expect(crossCheckConsistent({ sections: 105, gekiKatsu: 103, sectionsWithMiss: 2, countMiss: 2 })).toBe(true);
		// two misses can share one section
		expect(crossCheckConsistent({ sections: 105, gekiKatsu: 104, sectionsWithMiss: 1, countMiss: 2 })).toBe(true);
		// more miss-sections than misses is impossible for an honest header
		expect(crossCheckConsistent({ sections: 105, gekiKatsu: 100, sectionsWithMiss: 5, countMiss: 2 })).toBe(false);
		// negative implied count means geki+katu exceeds the section count
		expect(crossCheckConsistent({ sections: 100, gekiKatsu: 103, sectionsWithMiss: -3, countMiss: 0 })).toBe(false);
	});
});

describe("life bar note", () => {
	test("absence is information, not silence", () => {
		expect(lifeBarNote(true)).toBe("life bar present");
		expect(lifeBarNote(false)).toContain("absent");
	});
});
