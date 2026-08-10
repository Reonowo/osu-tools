import { describe, expect, test } from "bun:test";
import { testScene } from "../test/scene";
import { FIRST_LAZER_VERSION, frameEditGate } from "./gate";

describe("frameEditGate", () => {
	test("authoritative pre-lazer scenes are editable", () => {
		expect(frameEditGate(testScene())).toEqual({ editable: true });
	});

	test("not-simulated scenes lock with the reason", () => {
		const gate = frameEditGate(testScene({ simulation: { status: "notSimulated", reason: "unsupportedMods" } }));
		expect(gate.editable).toBe(false);
		if (!gate.editable) expect(gate.reason).toContain("not simulated");
	});

	test("lazer-native replays lock with the rules-profile reason", () => {
		const scene = testScene();
		const gate = frameEditGate({
			...scene,
			replay: { ...scene.replay, version: FIRST_LAZER_VERSION }
		});
		expect(gate.editable).toBe(false);
		if (!gate.editable) expect(gate.reason).toContain("lazer");
	});
});
