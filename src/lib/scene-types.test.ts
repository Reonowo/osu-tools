import { describe, expect, test } from "bun:test";
import type { IpcError, JudgementKindDto, LoadedSceneWarning, RenderKind, SimulationDto } from "./scene-types";
import { isIpcError } from "./ipc";

describe("scene contract mirror", () => {
	test("judgement kinds accept the rust-serialized literals", () => {
		// literals copied from scene.rs's judgement_kinds_serialize_type_tagged
		const kinds: JudgementKindDto[] = [
			{ type: "circle", grade: "great" },
			{ type: "sliderHead", hit: false },
			{ type: "sliderAggregate", grade: "ok" },
			{ type: "spinnerBonus" },
			{ type: "sliderTick", hit: true },
			{ type: "sliderRepeat", hit: true },
			{ type: "sliderTail", hit: true },
			{ type: "spinnerSpin" },
			{ type: "spinnerFinal", grade: "miss" }
		];
		expect(kinds).toHaveLength(9);
	});

	test("the simulation union narrows on status", () => {
		const sims: SimulationDto[] = [
			{
				status: "authoritative",
				events: [
					{
						time: 1030,
						objectIndex: 0,
						kind: { type: "circle", grade: "meh" },
						comboAfter: 1,
						accuracyAfter: 50 / 300
					}
				],
				totals: { count300: 0, count100: 0, count50: 1, countMiss: 0, maxCombo: 1 }
			},
			{ status: "notSimulated", reason: "unsupportedMods" },
			{ status: "notSimulated", reason: "beatmapMismatch" }
		];
		for (const sim of sims) {
			if (sim.status === "authoritative") expect(sim.events.length).toBeGreaterThan(0);
			else expect(["unsupportedMods", "beatmapMismatch"]).toContain(sim.reason);
		}
	});

	test("render kinds narrow on type", () => {
		// literals matching render_plan.rs's serialized_shape test
		const kinds: RenderKind[] = [
			{ type: "circle" },
			{
				type: "slider",
				vertices: [0, 0, 100, 0],
				cumulativeLengths: [0, 100],
				distance: 100,
				segmentEnds: [1],
				repeatCount: 0,
				spanCount: 1,
				spanDuration: 500,
				duration: 500,
				endPosition: [200, 100],
				snakeInDuration: 200,
				nested: [
					{
						kind: "head",
						spanIndex: 0,
						time: 2000,
						position: [100, 100],
						pathProgress: 0,
						preempt: 600,
						fadeIn: 400
					}
				]
			},
			{ type: "spinner", duration: 2000, spinsRequired: 5, maxBonusSpins: 5 }
		];
		expect(kinds[1].type).toBe("slider");
	});

	test("isIpcError recognises kind-tagged rejections and nothing else", () => {
		const errors: IpcError[] = [
			{ kind: "replayParse", message: "bad" },
			{ kind: "beatmapParse", message: "bad" },
			{ kind: "beatmapNotFound", md5: "abc" },
			{ kind: "beatmapMismatch", expectedMd5: "a", actualMd5: "b" },
			{ kind: "osuDbNotFound", searched: ["C:\\osu!"] },
			{ kind: "unsupportedMode", mode: "Taiko" },
			{ kind: "resourceLimit", cap: "MAX_OSZ_ENTRIES", limit: 1, actual: 2 },
			{ kind: "io", message: "denied" },
			{ kind: "internal", message: "x" }
		];
		for (const e of errors) expect(isIpcError(e)).toBe(true);
		expect(isIpcError(new Error("nope"))).toBe(false);
		expect(isIpcError({ message: "no kind" })).toBe(false);
		expect(isIpcError(null)).toBe(false);
	});

	test("warnings carry their payload fields", () => {
		const warnings: LoadedSceneWarning[] = [
			{ kind: "audioMissing" },
			{ kind: "modsNotSimulated", mods: 8 },
			{ kind: "beatmapMismatch", expectedMd5: "a", actualMd5: "b" }
		];
		expect(warnings).toHaveLength(3);
	});
});
