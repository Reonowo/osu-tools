import { describe, expect, test } from "bun:test";
import { approximateNativeTestScene, nativeTestScene, testScene } from "../test/scene";
import { frameEditGate } from "./gate";

describe("frameEditGate", () => {
	test("an authoritative stable scene is editable", () => {
		expect(frameEditGate(testScene())).toEqual({ editable: true });
	});

	test("a refused capability locks with the scene's own reason, whatever refused it", () => {
		const scene = testScene();
		const reason = "mods not simulated (HD), so frame edits cannot re-derive the results";
		const gate = frameEditGate({
			...scene,
			configuration: {
				...scene.configuration,
				capabilities: {
					simulate: { status: "refused", reason: { kind: "unsupportedMods", acronyms: ["HD"] } },
					editFrames: { allowed: false, reason },
					regenerateExport: { allowed: false, reason }
				}
			}
		});
		expect(gate).toEqual({ editable: false, reason });
	});

	test("an authoritative lazer-native scene is editable like a stable one", () => {
		expect(frameEditGate(nativeTestScene())).toEqual({ editable: true });
	});

	test("an approximate lazer-native scene locks with the profile reason the engine authored", () => {
		const scene = approximateNativeTestScene();
		const gate = frameEditGate(scene);
		expect(gate.editable).toBe(false);
		if (gate.editable) return;
		expect(gate.reason).toContain("lazer-native");
		const capability = scene.configuration.capabilities.editFrames;
		if (capability.allowed) throw new Error("the native fixture refuses frame edits");
		expect(gate.reason).toBe(capability.reason);
	});
});
