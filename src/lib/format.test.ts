import { describe, expect, test } from "bun:test";
import { formatAccuracy, formatMods, formatTime } from "./format";

describe("format helpers", () => {
	test("time formats signed m:ss.SSS", () => {
		expect(formatTime(0)).toBe("0:00.000");
		expect(formatTime(61_500)).toBe("1:01.500");
		expect(formatTime(-1500)).toBe("-0:01.500");
		expect(formatTime(600_042)).toBe("10:00.042");
	});

	test("mods decode the legacy bitfield", () => {
		expect(formatMods(0)).toBe("none");
		expect(formatMods(8)).toBe("HD");
		expect(formatMods(8 | 64)).toBe("HD DT");
		expect(formatMods(1 | 2 | 16 | 1024)).toBe("NF EZ HR FL");
	});

	test("a nonzero mask never displays as none", () => {
		expect(formatMods(536_870_912)).toBe("SV2");
		// bits outside the table (here mania's fadein, 1<<20) surface as hex
		expect(formatMods(1 << 20)).toBe("0x100000");
		expect(formatMods(8 | (1 << 20))).toBe("HD 0x100000");
		// bit 31 must not turn the residue negative
		expect(formatMods((1 << 31) >>> 0)).toBe("0x80000000");
	});

	test("accuracy renders two decimals", () => {
		expect(formatAccuracy(1)).toBe("100.00%");
		expect(formatAccuracy(0.98731)).toBe("98.73%");
	});
});
