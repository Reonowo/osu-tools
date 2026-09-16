import { describe, expect, test } from "bun:test";
import { nativeTestScene, testScene } from "../test/scene";
import { effectiveModRows, modChipLabels, modProvenanceNote } from "./metadata-panel";

describe("modChipLabels", () => {
	test("NM for a play with genuinely no mods, the acronyms otherwise", () => {
		expect(modChipLabels(testScene())).toEqual(["NM"]);
		expect(modChipLabels(nativeTestScene())).toEqual(["NM"]);
		const scene = nativeTestScene();
		const modded = nativeTestScene({
			configuration: { ...scene.configuration, mods: [{ acronym: "CL", settings: {} }] }
		});
		expect(modChipLabels(modded)).toEqual(["CL"]);
	});

	test("an unreadable block chips `?`, never `NM` -- an empty list is not no mods", () => {
		// a malformed block resolves to an EMPTY mod list with unresolvable
		// provenance, so emptiness alone cannot tell "no mods" from "unknown";
		// the chrome must not assert the first for the second
		const scene = nativeTestScene();
		const unreadable = nativeTestScene({
			configuration: { ...scene.configuration, mods: [], provenance: "unresolvable" }
		});
		expect(modChipLabels(unreadable)).toEqual(["?"]);
		expect(modProvenanceNote(unreadable)).toContain("unknown");
	});
});

describe("effectiveModRows", () => {
	test("a stable file keeps its legacy chips, one per bit and none for nomod", () => {
		expect(effectiveModRows(testScene())).toEqual([]);
		const scene = testScene();
		expect(effectiveModRows(testScene({ replay: { ...scene.replay, mods: 8 | 64 } }))).toEqual([
			{ acronym: "HD", settings: [] },
			{ acronym: "DT", settings: [] }
		]);
	});

	test("a lazer file lists the block's entries, a changed setting distinguishing a mod from a default one", () => {
		const scene = nativeTestScene();
		expect(effectiveModRows(scene)).toEqual([]);
		const modded = nativeTestScene({
			configuration: {
				...scene.configuration,
				mods: [
					{ acronym: "HD", settings: {} },
					{ acronym: "DA", settings: { circle_size: 7.5, approach_rate: 10 } },
					{ acronym: "DT", settings: { speed_change: 1.3, adjust_pitch: true } }
				]
			}
		});
		expect(effectiveModRows(modded)).toEqual([
			{ acronym: "HD", settings: [] },
			{ acronym: "DA", settings: ["circle_size: 7.5", "approach_rate: 10"] },
			{ acronym: "DT", settings: ["speed_change: 1.3", "adjust_pitch: true"] }
		]);
	});
});

describe("modProvenanceNote", () => {
	test("the block and the bitfield need no note; an inferred or unresolvable list gets one", () => {
		expect(modProvenanceNote(testScene())).toBeNull();
		expect(modProvenanceNote(nativeTestScene())).toBeNull();
		const scene = nativeTestScene();
		const inferred = nativeTestScene({
			configuration: { ...scene.configuration, provenance: "inferredFromBitfield" }
		});
		expect(modProvenanceNote(inferred)).toContain("inferred from the legacy mod bitfield");
		const unresolvable = nativeTestScene({
			configuration: { ...scene.configuration, provenance: "unresolvable" }
		});
		expect(modProvenanceNote(unresolvable)).toContain("could not be read");
	});
});
