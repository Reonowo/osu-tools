import { describe, expect, test } from "bun:test";
import {
	crossCheckConsistent,
	describeCrossCheck,
	incompletenessNote,
	integrityRowLabel,
	integrityRowValue,
	lifeBarNote,
	rowVerdict
} from "./integrity";
import type { IntegrityReport } from "./scene-types";

const report: IntegrityReport = {
	rows: [
		{ field: "count300", header: 100, simulated: 100, match: true },
		{ field: "countGeki", header: 103, simulated: 99, match: false },
		{ field: "perfect", header: 1, simulated: 0, match: false }
	],
	crossCheck: { sections: 105, gekiKatsu: 103, sectionsWithoutBurst: 2, countMiss: 2, count50: 0 },
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
	test("the sentence states the identity with the header misses and 50s beside it", () => {
		expect(describeCrossCheck(report.crossCheck)).toBe(
			"105 sections − 103 geki+katu = 2 with a miss or 50 · header misses 2 · 50s 0"
		);
	});

	test("consistency holds when burst-free sections fit inside misses plus 50s", () => {
		expect(
			crossCheckConsistent({ sections: 105, gekiKatsu: 103, sectionsWithoutBurst: 2, countMiss: 2, count50: 0 })
		).toBe(true);
		// two misses can share one section
		expect(
			crossCheckConsistent({ sections: 105, gekiKatsu: 104, sectionsWithoutBurst: 1, countMiss: 2, count50: 0 })
		).toBe(true);
		// a 50 forfeits a burst without a miss -- stable's rule, an honest header
		expect(
			crossCheckConsistent({ sections: 105, gekiKatsu: 102, sectionsWithoutBurst: 3, countMiss: 2, count50: 1 })
		).toBe(true);
		// more burst-free sections than misses + 50s is impossible for an honest header
		expect(
			crossCheckConsistent({ sections: 105, gekiKatsu: 100, sectionsWithoutBurst: 5, countMiss: 2, count50: 1 })
		).toBe(false);
		// negative implied count means geki+katu exceeds the section count
		expect(
			crossCheckConsistent({ sections: 100, gekiKatsu: 103, sectionsWithoutBurst: -3, countMiss: 0, count50: 0 })
		).toBe(false);
	});
});

describe("life bar note", () => {
	test("absence is information, not silence", () => {
		expect(lifeBarNote(true)).toBe("life bar present");
		expect(lifeBarNote(false)).toContain("absent");
	});
});

describe("row verdicts", () => {
	const matching = { field: "count300", header: 100, simulated: 100, match: true };
	const differing = { field: "count300", header: 100, simulated: 90, match: false };
	const endedEarly = { judged: 480, total: 1544 };

	test("a difference is a verdict only when the play is complete", () => {
		expect(rowVerdict(matching, null)).toBe("match");
		expect(rowVerdict(differing, null)).toBe("differs");
		expect(rowVerdict(matching, endedEarly)).toBe("match");
		expect(rowVerdict(differing, endedEarly)).toBe("expected");
	});

	test("the cross-check identity carries no verdict on an incomplete play", () => {
		const impossible = { sections: 105, gekiKatsu: 100, sectionsWithoutBurst: 5, countMiss: 2, count50: 1 };
		expect(crossCheckConsistent(impossible)).toBe(false);
		expect(crossCheckConsistent(impossible, endedEarly)).toBe(true);
	});
});

describe("incompleteness note", () => {
	test("states the judged share and reads as context, not accusation", () => {
		const note = incompletenessNote({ judged: 480, total: 1544 });
		expect(note).toContain("play ended early");
		expect(note).toContain(`${(480).toLocaleString()} of ${(1544).toLocaleString()} objects judged`);
		expect(note).toContain("expected, not verdicts");
	});
});
