import { describe, expect, test } from "bun:test";
import { testScene } from "../test/scene";
import { hasTimeline, profileText, simulated, simulationReasonText } from "./simulation";

// the strings themselves are the contract: the status bar and the transport's
// severity-jump cluster both print them, and the whole reason this lives in
// one module is that the two must never drift apart. pinned as literals for
// the same reason warningText's are
describe("simulationReasonText", () => {
	test("each reason gets the inline noun phrase both surfaces print", () => {
		expect(simulationReasonText({ kind: "unsupportedMods", acronyms: ["HD", "ZZ"] })).toBe(
			"mods not simulated (HD ZZ)"
		);
		expect(simulationReasonText({ kind: "beatmapMismatch" })).toBe("beatmap mismatch");
		expect(simulationReasonText({ kind: "unreadableScoreInfo", reason: "not lzma" })).toBe(
			"score-info block unreadable"
		);
		expect(profileText("stable")).toBe("stable profile");
		expect(profileText("native")).toBe("native profile");
	});
});

describe("hasTimeline", () => {
	test("authoritative and approximate carry a timeline; a refusal does not", () => {
		const authoritative = testScene().simulation;
		expect(hasTimeline(authoritative)).toBe(true);
		if (authoritative.status !== "authoritative") throw new Error("the shared fixture simulates");
		const approximate = { ...authoritative, status: "approximate" as const, profile: "stable" as const };
		expect(hasTimeline(approximate)).toBe(true);
		expect(simulated(approximate)?.events).toBe(authoritative.events);
		const refused = { status: "notSimulated" as const, reason: { kind: "beatmapMismatch" as const } };
		expect(hasTimeline(refused)).toBe(false);
		expect(simulated(refused)).toBeNull();
	});
});
