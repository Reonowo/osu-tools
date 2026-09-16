import { describe, expect, test } from "bun:test";
import { approximateNativeTestScene, nativeTestScene, testScene } from "../test/scene";
import {
	nativeStatistics,
	recordedInFile,
	replayHeaderTrailing,
	resultLabel,
	simulatedStatsLabel
} from "./replay-panel";

describe("replayHeaderTrailing", () => {
	test("names the version and the profile it selects, for both profiles", () => {
		expect(replayHeaderTrailing(testScene())).toBe("v20240101 · stable profile");
		expect(replayHeaderTrailing(nativeTestScene())).toBe("v30000016 · native profile");
	});
});

describe("simulatedStatsLabel", () => {
	test("an authoritative scene carries no label; an approximate one names the profile it ran under", () => {
		expect(simulatedStatsLabel(testScene())).toBeNull();
		expect(simulatedStatsLabel(nativeTestScene())).toBeNull();
		expect(simulatedStatsLabel(approximateNativeTestScene())).toBe("approximate · stable profile");
		expect(
			simulatedStatsLabel(
				testScene({ simulation: { status: "notSimulated", reason: { kind: "beatmapMismatch" } } })
			)
		).toBeNull();
	});
});

describe("recordedInFile", () => {
	test("a present block renders its own fields, statistics in the block's order", () => {
		const scene = nativeTestScene();
		const card = recordedInFile(scene.replay.scoreInfo, "native");
		if (card.kind !== "present") throw new Error("the native fixture carries a block");
		expect(card.rows).toEqual([
			{ label: "rank", value: "SS" },
			{ label: "total (no mods)", value: (1000000).toLocaleString() },
			{ label: "client", value: "2026.401.0-lazer" },
			{ label: "online id", value: "none" },
			{ label: "pauses", value: "0" }
		]);
		expect(card.statistics.map((s) => s.result)).toEqual(["great", "slider_tail_hit"]);
		expect(card.maximumStatistics).toEqual([{ result: "great", count: 1 }]);
	});

	test("a rank-f block prints its F and a real online id prints as itself", () => {
		const card = recordedInFile(
			{
				status: "present",
				statistics: [],
				maximumStatistics: [],
				// an empty maximum map weighs nothing, so the block states no
				// accuracy rather than a perfect one
				accuracy: null,
				rank: "f",
				totalScoreWithoutMods: null,
				clientVersion: "",
				onlineId: "4242",
				userId: 1,
				pauseCount: 3
			},
			"native"
		);
		if (card.kind !== "present") throw new Error("present");
		expect(card.rows.map((r) => r.value)).toEqual(["F", "none", "unknown", "4242", "3"]);
	});

	test("the three block-less states say there is no block, each in its own words", () => {
		const opaque = recordedInFile({ status: "opaque" }, "stable");
		const absent = recordedInFile({ status: "absent" }, "native");
		const empty = recordedInFile({ status: "empty" }, "native");
		for (const card of [opaque, absent, empty]) {
			expect(card.kind).toBe("none");
			if (card.kind === "none") expect(card.note).toContain("no score-info block");
		}
		if (empty.kind === "none") expect(empty.note).toContain("legacy bitfield");
		if (absent.kind === "none") expect(absent.note).toContain("first replay version");
	});

	test("a malformed block says unreadable with the reader's reason", () => {
		const card = recordedInFile({ status: "malformed", reason: "score-info block is not lzma" }, "native");
		expect(card.kind).toBe("unreadable");
		if (card.kind === "unreadable") expect(card.note).toContain("not lzma");
	});

	test("result names print with their underscores as spaces", () => {
		expect(resultLabel("large_tick_hit")).toBe("large tick hit");
		expect(resultLabel("great")).toBe("great");
	});
});

describe("nativeStatistics", () => {
	test("a stable scene has no row; a native scene lists the totals' map with the block's count as the reference", () => {
		expect(nativeStatistics(testScene())).toBeNull();
		const scene = nativeTestScene();
		expect(nativeStatistics(scene)).toEqual([{ result: "ok", count: 1, recorded: null }]);
		if (scene.simulation.status !== "authoritative") throw new Error("the native fixture simulates");
		const edited = nativeTestScene({
			simulation: {
				...scene.simulation,
				totals: {
					...scene.simulation.totals,
					statistics: [
						{ result: "great", count: 2 },
						{ result: "slider_tail_hit", count: 1 },
						{ result: "ignore_hit", count: 1 }
					]
				}
			}
		});
		expect(nativeStatistics(edited)).toEqual([
			{ result: "great", count: 2, recorded: 1 },
			{ result: "slider_tail_hit", count: 1, recorded: 0 },
			{ result: "ignore_hit", count: 1, recorded: null }
		]);
	});
});
