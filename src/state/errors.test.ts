import { describe, expect, test } from "bun:test";
import { describeIpcError } from "./errors";
import { isIpcError } from "../lib/ipc";

describe("ipc error mapping", () => {
	test("recoveries", () => {
		expect(describeIpcError({ kind: "beatmapNotFound", md5: "abc" }).recovery).toBe("pickBeatmap");
		expect(describeIpcError({ kind: "osuDbNotFound", searched: [] }).recovery).toBe("pickBeatmap");
		expect(describeIpcError({ kind: "osuDbUnreadable", path: "C:\\a", reason: "why" }).recovery).toBe(
			"pickBeatmap"
		);
		expect(describeIpcError({ kind: "beatmapMismatch", expectedMd5: "a", actualMd5: "b" }).recovery).toBe(
			"offerMismatch"
		);
		expect(describeIpcError({ kind: "replayParse", message: "x" }).recovery).toBeNull();
	});

	test("details carry the payload", () => {
		const d = describeIpcError({ kind: "resourceLimit", cap: "MAX_OSZ_ENTRIES", limit: 1, actual: 2 });
		expect(d.detail).toContain("MAX_OSZ_ENTRIES");
		const db = describeIpcError({ kind: "osuDbNotFound", searched: ["C:\\a", "C:\\b"] });
		expect(db.detail).toContain("C:\\a");
	});

	test("an unreadable osu!.db names the file, the reason, and the way out", () => {
		// the install exists; the listing does not read. the toast must be
		// about the file rather than about the app, and must say the beatmap
		// can still be picked by hand
		const d = describeIpcError({
			kind: "osuDbUnreadable",
			path: "E:\\osu!\\osu!.db",
			reason: "osu!.db version 20260711 (walk stopped at byte 1353): boom"
		});
		expect(d.title).toBe("couldn't read osu!.db");
		expect(d.detail).toContain("E:\\osu!\\osu!.db");
		expect(d.detail).toContain("20260711");
		expect(d.detail).toContain("pick the beatmap manually");
		expect(d.recovery).toBe("pickBeatmap");
	});

	test("editor error kinds map to copy", () => {
		expect(describeIpcError({ kind: "invalidEdit", message: "why" })).toEqual({
			title: "couldn't apply the edit",
			detail: "why",
			recovery: null
		});
		expect(describeIpcError({ kind: "staleSession" }).title).toBe("the edit hit a replaced session");
		expect(describeIpcError({ kind: "notEditable", reason: "because" })).toEqual({
			title: "this replay can't be frame-edited",
			detail: "because",
			recovery: null
		});
	});

	test("isIpcError recognizes the editor kinds", () => {
		expect(isIpcError({ kind: "staleSession" })).toBe(true);
		expect(isIpcError({ kind: "invalidEdit", message: "m" })).toBe(true);
		expect(isIpcError({ kind: "notEditable", reason: "r" })).toBe(true);
	});
});
