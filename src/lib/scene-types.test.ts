import { describe, expect, test } from "bun:test";
import {
	DEFAULT_AUDIO,
	DEFAULT_EDITING,
	DEFAULT_EFFECTS,
	DEFAULT_GAMEPLAY,
	DEFAULT_OVERLAYS,
	DEFAULT_SKIN,
	DEFAULT_TIMELINE
} from "../state/defaults";
import type {
	EffectSettings,
	IpcError,
	JudgementKindDto,
	LoadedSceneWarning,
	OverlaySettings,
	RenderKind,
	Settings,
	SimulationDto
} from "./scene-types";
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
			{ type: "sliderRepeat", hit: true, repeatIndex: 2 },
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
						fadeIn: 400,
						samples: []
					}
				]
			},
			{ type: "spinner", duration: 2000, spinsRequired: 5, maxBonusSpins: 5, bonusSamples: [] }
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
			{ kind: "internal", message: "x" },
			{ kind: "fileExists", path: "C:\\out.osr" },
			{ kind: "exportOverflow", field: "maxCombo" }
		];
		for (const e of errors) expect(isIpcError(e)).toBe(true);
		expect(isIpcError(new Error("nope"))).toBe(false);
		expect(isIpcError({ message: "no kind" })).toBe(false);
		expect(isIpcError(null)).toBe(false);
	});

	test("the overlay prefs accept the rust-serialized shape, grid spacing included", () => {
		// keys copied from settings.rs's settings_serialize_with_camel_case_keys.
		// the spacing is a plain number rather than a literal union, since json
		// can keep no such promise -- sanitize() and clampPlayfieldGridSpacing
		// are the validation instead
		const overlays: OverlaySettings = {
			cursorPath: true,
			clickMarkers: true,
			frameMarkers: false,
			tintIdleMarkers: true,
			hideCursor: true,
			keyOverlay: false,
			displayLength: 1200,
			playfieldGrid: 16
		};
		expect(overlays.playfieldGrid).toBe(16);
	});

	test("the effect prefs accept the rust-serialized shape, dim included", () => {
		// keys copied from settings.rs's settings_serialize_with_camel_case_keys;
		// the background dim is a plain number rather than a literal union,
		// since json can keep no such promise -- sanitize() and
		// clampBackgroundDim are the validation instead
		const effects: EffectSettings = {
			enabled: true,
			hitAnimations: false,
			hitEffects: true,
			cursorGlow: false,
			cursorTrail: true,
			followPoints: false,
			backgroundDim: 35
		};
		expect(effects.backgroundDim).toBe(35);
	});

	test("the settings contract carries the keybind overrides, sparsely", () => {
		// keys copied from settings.rs's settings_serialize_with_camel_case_keys.
		// the map is opaque on the rust side, so this is the only declaration of
		// what an action or a binding is -- and the three states it can be in:
		// absent (follow the default), present (these keys), present-and-empty
		// (deliberately unbound)
		const settings: Settings = {
			osuStablePath: null,
			volume: 100,
			audio: DEFAULT_AUDIO,
			gameplay: DEFAULT_GAMEPLAY,
			overlays: DEFAULT_OVERLAYS,
			recents: [],
			editing: DEFAULT_EDITING,
			effects: DEFAULT_EFFECTS,
			timeline: DEFAULT_TIMELINE,
			keybinds: { selectTool: [{ hotkey: "К", codes: ["KeyV"] }], eraseTool: [] },
			skin: DEFAULT_SKIN
		};
		expect(settings.keybinds.selectTool?.[0].codes).toEqual(["KeyV"]);
		expect(settings.keybinds.eraseTool).toEqual([]);
		expect(settings.keybinds.moveTool).toBeUndefined();
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
