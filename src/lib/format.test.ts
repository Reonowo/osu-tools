import { describe, expect, test } from "bun:test";
import { formatAccuracy, formatButtons, formatMods, formatRelativeTime, formatTime, ticksToUnixMs } from "./format";

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

	test("buttons decode to physical keys, not raw bits", () => {
		expect(formatButtons(0)).toBe("");
		expect(formatButtons(5)).toBe("K1"); // k1|m1 keyboard tap -- never both
		expect(formatButtons(10)).toBe("K2"); // k2|m2 keyboard tap -- never both
		expect(formatButtons(1)).toBe("M1");
		expect(formatButtons(4)).toBe("K1"); // bare k1, no paired m1
		expect(formatButtons(4 | 8)).toBe("K1 K2");
	});
});

describe("formatRelativeTime", () => {
	const now = 1_770_000_000_000;
	test("under a minute reads as just now", () => {
		expect(formatRelativeTime(now - 30_000, now)).toBe("just now");
	});
	test("minutes and hours are compact", () => {
		expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
		expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe("2h ago");
	});
	test("a day is yesterday, more are counted", () => {
		expect(formatRelativeTime(now - 26 * 3_600_000, now)).toBe("yesterday");
		expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe("3 days ago");
	});
	test("beyond a week falls back to weeks", () => {
		expect(formatRelativeTime(now - 9 * 86_400_000, now)).toBe("last week");
		expect(formatRelativeTime(now - 30 * 86_400_000, now)).toBe("4 weeks ago");
	});
	test("a future timestamp is clamped to just now", () => {
		expect(formatRelativeTime(now + 60_000, now)).toBe("just now");
	});
});

describe("ticksToUnixMs", () => {
	test("converts the .net epoch offset", () => {
		// 1970-01-01T00:00:00Z is 621355968000000000 ticks
		expect(ticksToUnixMs("621355968000000000")).toBe(0);
	});

	test("converts a real replay timestamp", () => {
		// 638000000000000000 / 10_000 - 62_135_596_800_000 = 1_664_403_200_000;
		// the brief this test was transcribed from stated 1_664_064_000_000,
		// which does not match the formula it also specifies -- corrected here
		expect(ticksToUnixMs("638000000000000000")).toBe(1_664_403_200_000);
	});

	test("rejects zero, negatives, and non-numeric input", () => {
		expect(ticksToUnixMs("0")).toBeNull();
		expect(ticksToUnixMs("-1")).toBeNull();
		expect(ticksToUnixMs("not a number")).toBeNull();
	});
});
