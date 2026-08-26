import { describe, expect, test } from "bun:test";
import { DANSER_BACKGROUND_DIM, DANSER_SETTINGS_SUBTREE, DANSER_TOGGLES } from "./danser-section";
import { EDITED_MARKER } from "./export-flow";
import type { LoadedScene, RendererOptionsMap } from "./scene-types";
import {
	blobBool,
	blobNumber,
	blobString,
	blobValue,
	defaultVideoFileName,
	defaultVideoSavePath,
	directoryOfPath,
	exportMenuEntries,
	formatDownloadSize,
	renderProgressLine,
	sanitizeFileName,
	stageLabel,
	videoExportGate,
	videoSkinStatement,
	withBlobValue
} from "./video-export-flow";

function sceneWith(overrides: { simulation?: LoadedScene["simulation"]; playerName?: string | null }): LoadedScene {
	return {
		beatmap: { artist: "Camellia", title: "GHOST", version: "Collab Nightmare" },
		replay: { playerName: overrides.playerName === undefined ? "mrekk" : overrides.playerName },
		simulation: overrides.simulation ?? { status: "authoritative", events: [], totals: {} }
	} as unknown as LoadedScene;
}

describe("videoExportGate", () => {
	test("every ordinary scene is offered, unsimulated-mods scenes included", () => {
		expect(videoExportGate(sceneWith({})).available).toBe(true);
		// modded plays render (the renderer applies mods itself)
		expect(
			videoExportGate(sceneWith({ simulation: { status: "notSimulated", reason: "unsupportedMods" } })).available
		).toBe(true);
	});

	test("a consented mismatch is refused with the stated reason", () => {
		const gate = videoExportGate(sceneWith({ simulation: { status: "notSimulated", reason: "beatmapMismatch" } }));
		expect(gate).toEqual({ available: false, reason: "video export needs a matching beatmap" });
	});

	test("the menu carries the gate's refusal on the video entry only", () => {
		const entries = exportMenuEntries(
			sceneWith({ simulation: { status: "notSimulated", reason: "beatmapMismatch" } })
		);
		expect(entries.map((e) => e.id)).toEqual(["replay", "video"]);
		expect(entries[0].disabledReason).toBeNull();
		expect(entries[1].disabledReason).toBe("video export needs a matching beatmap");

		const open = exportMenuEntries(sceneWith({}));
		expect(open.every((e) => e.disabledReason === null)).toBe(true);
	});
});

describe("default video file name", () => {
	test("follows the template and marks only a dirty document", () => {
		const scene = sceneWith({});
		expect(defaultVideoFileName(scene, false)).toBe("mrekk - Camellia - GHOST [Collab Nightmare].mp4");
		expect(defaultVideoFileName(scene, true)).toBe(
			`mrekk - Camellia - GHOST [Collab Nightmare]${EDITED_MARKER}.mp4`
		);
	});

	test("a nameless player and reserved characters stay writable", () => {
		const scene = sceneWith({ playerName: null });
		scene.beatmap.title = 'what: "title"?';
		expect(defaultVideoFileName(scene, false)).toBe("unknown - Camellia - what_ _title__ [Collab Nightmare].mp4");
	});

	test("sanitize replaces every windows-reserved character", () => {
		expect(sanitizeFileName('a\\b/c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
	});
});

describe("save-dialog prefill and the remembered directory", () => {
	test("the last video dir prefixes the name; without one the name stands alone", () => {
		expect(defaultVideoSavePath("out.mp4", "D:\\videos")).toBe("D:\\videos\\out.mp4");
		expect(defaultVideoSavePath("out.mp4", "D:\\videos\\")).toBe("D:\\videos\\out.mp4");
		expect(defaultVideoSavePath("out.mp4", null)).toBe("out.mp4");
		expect(defaultVideoSavePath("out.mp4", "")).toBe("out.mp4");
	});

	test("the directory half of a picked destination", () => {
		expect(directoryOfPath("D:\\videos\\out.mp4")).toBe("D:\\videos");
		expect(directoryOfPath("out.mp4")).toBeNull();
	});
});

describe("videoSkinStatement", () => {
	test("mirrors the backend's mapping: folder skins by name, bundled to the renderer default", () => {
		expect(videoSkinStatement("followApp", { kind: "stable", path: "D:\\osu!\\Skins\\Rafis 2016" }, "danser")).toBe(
			'the video will use the "Rafis 2016" skin'
		);
		expect(videoSkinStatement("followApp", { kind: "bundled" }, "danser")).toContain("danser's default skin");
		expect(videoSkinStatement("rendererDefault", { kind: "stable", path: "D:\\x\\y" }, "danser")).toBe(
			"the video will use danser's default skin"
		);
	});
});

describe("progress display", () => {
	test("every stage has a label", () => {
		for (const stage of ["staging", "rendering", "moving", "installing"] as const) {
			expect(stageLabel(stage).length).toBeGreaterThan(0);
		}
	});

	test("the render line joins only the pieces the event carried", () => {
		expect(renderProgressLine({ jobId: "j", stage: "rendering", percent: 42.4, speed: "15.10x", eta: "2s" })).toBe(
			"42% · 15.10x · ETA 2s"
		);
		expect(renderProgressLine({ jobId: "j", stage: "rendering", percent: 0 })).toBe("0%");
		expect(renderProgressLine({ jobId: "j", stage: "staging" })).toBe("");
	});

	test("the consent size line rounds to megabytes", () => {
		expect(formatDownloadSize(30_942_877)).toBe("~31 MB");
	});
});

describe("blob accessors", () => {
	const options: RendererOptionsMap = {
		danser: {
			probedEncoder: "h264_nvenc",
			settings: { Recording: { MotionBlur: { Enabled: true } } }
		}
	};

	test("reads answer along the path and fall back typed", () => {
		expect(blobValue(options, "danser", ["settings", "Recording", "MotionBlur", "Enabled"])).toBe(true);
		expect(blobBool(options, "danser", ["settings", "Recording", "MotionBlur", "Enabled"], false)).toBe(true);
		expect(blobBool(options, "danser", ["settings", "Nope"], true)).toBe(true);
		expect(blobBool(options, "other", ["settings"], false)).toBe(false);
		expect(blobNumber(options, "danser", ["settings", "Recording"], 7)).toBe(7);
		expect(blobString(options, "danser", ["probedEncoder"], "libx264")).toBe("h264_nvenc");
	});

	test("writes are immutable and preserve unrelated keys at every level", () => {
		const written = withBlobValue(options, "danser", ["settings", "Playfield", "Background", "Dim", "Normal"], 0.8);
		expect(blobNumber(written, "danser", ["settings", "Playfield", "Background", "Dim", "Normal"], 0)).toBe(0.8);
		// the write scrubbed nothing: the probe cache and the sibling subtree
		// survive, which is what lets one control write without knowing the rest
		expect(blobString(written, "danser", ["probedEncoder"], "")).toBe("h264_nvenc");
		expect(blobBool(written, "danser", ["settings", "Recording", "MotionBlur", "Enabled"], false)).toBe(true);
		// and the input map is untouched
		expect(blobValue(options, "danser", ["settings", "Playfield"])).toBeUndefined();
	});

	test("a write into an absent backend creates the blob", () => {
		const written = withBlobValue({}, "danser", ["settings", "Cursor", "CursorRipples"], true);
		expect(blobBool(written, "danser", ["settings", "Cursor", "CursorRipples"], false)).toBe(true);
	});
});

describe("the danser section's control data", () => {
	test("every control writes under the settings subtree with a unique label", () => {
		const labels = new Set<string>();
		for (const control of [...DANSER_TOGGLES, DANSER_BACKGROUND_DIM]) {
			expect(control.path[0]).toBe(DANSER_SETTINGS_SUBTREE);
			expect(control.path.length).toBeGreaterThan(2);
			expect(labels.has(control.label)).toBe(false);
			labels.add(control.label);
		}
	});

	test("the defaults mirror danser 0.11.0's own", () => {
		// captured from the pinned release's generated settings file; an
		// untouched control must change nothing in the patch's effect
		const byLabel = Object.fromEntries(DANSER_TOGGLES.map((t) => [t.label, t.default]));
		expect(byLabel["motion blur"]).toBe(false);
		expect(byLabel["score & accuracy"]).toBe(true);
		expect(byLabel["cursor ripples"]).toBe(false);
		expect(DANSER_BACKGROUND_DIM.default).toBe(0.95);
	});
});
