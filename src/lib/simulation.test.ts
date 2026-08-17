import { describe, expect, test } from "bun:test";
import { simulationReasonText } from "./simulation";

// the strings themselves are the contract: the status bar and the transport's
// severity-jump cluster both print them, and the whole reason this lives in
// one module is that the two must never drift apart. pinned as literals for
// the same reason warningText's are
describe("simulationReasonText", () => {
	test("each reason gets the inline noun phrase both surfaces print", () => {
		expect(simulationReasonText("unsupportedMods")).toBe("mods not simulated");
		expect(simulationReasonText("beatmapMismatch")).toBe("beatmap mismatch");
	});
});
