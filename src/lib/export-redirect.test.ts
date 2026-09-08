// the export prefill's redirect rule, kept in its own file beside
// export-flow's other cases: it is the one path decision that reads
// something outside the source path -- the resolved install root -- and it
// is what stops an edited replay landing in stable's private Data/r folder

import { describe, expect, test } from "bun:test";
import { redirectedExportPath, type ExportNaming } from "./export-flow";

const ROOT = "E:\\osu!";

// the committed scores.db slice's own play, so the date below is a value
// checked against a real client rather than invented
const PLAY: ExportNaming = {
	playerName: "Reonowo",
	artist: "Aqours",
	title: "Miracle Wave",
	version: "Insane",
	timestampTicks: "636895947445841476"
};

describe("redirectedExportPath", () => {
	test("a Data/r source is prefilled into Replays under stable's own name", () => {
		expect(redirectedExportPath(`${ROOT}\\Data\\r\\abc-1234.osr`, ROOT, PLAY)).toBe(
			`${ROOT}\\Replays\\Reonowo - Aqours - Miracle Wave [Insane] (2019-03-31) Osu (edited).osr`
		);
	});

	test("a source already in Replays keeps today's rule", () => {
		// the redirect exists to move a file OUT of the client's private
		// folder; firing here would move one the user deliberately placed
		const inReplays = `${ROOT}\\Replays\\downloaded.osr`;
		expect(redirectedExportPath(inReplays, ROOT, PLAY)).toBe(`${ROOT}\\Replays\\downloaded (edited).osr`);
		// and a subfolder of it counts as inside
		const nested = `${ROOT}\\Replays\\archive\\old.osr`;
		expect(redirectedExportPath(nested, ROOT, PLAY)).toBe(`${ROOT}\\Replays\\archive\\old (edited).osr`);
	});

	test("a source outside the install keeps today's rule", () => {
		expect(redirectedExportPath("D:\\downloads\\play.osr", ROOT, PLAY)).toBe("D:\\downloads\\play (edited).osr");
		// a directory whose name merely starts with the root's is outside it
		expect(redirectedExportPath("E:\\osu!2\\Data\\r\\a.osr", ROOT, PLAY)).toBe(
			"E:\\osu!2\\Data\\r\\a (edited).osr"
		);
	});

	test("with no resolved install nothing is redirected", () => {
		expect(redirectedExportPath(`${ROOT}\\Data\\r\\abc-1234.osr`, null, PLAY)).toBe(
			`${ROOT}\\Data\\r\\abc-1234 (edited).osr`
		);
	});

	test("path comparison is case-insensitive and separator-agnostic, as windows is", () => {
		expect(redirectedExportPath(`e:\\OSU!\\data\\R\\abc.osr`, ROOT, PLAY)).toContain("\\Replays\\");
		expect(redirectedExportPath(`${ROOT}/Data/r/abc.osr`, ROOT, PLAY)).toContain("\\Replays\\");
		// a trailing separator on the root must not produce a doubled one
		expect(redirectedExportPath(`${ROOT}\\Data\\r\\abc.osr`, `${ROOT}\\`, PLAY)).toBe(
			`${ROOT}\\Replays\\Reonowo - Aqours - Miracle Wave [Insane] (2019-03-31) Osu (edited).osr`
		);
	});

	test("a forward-slash root builds a forward-slash prefill", () => {
		expect(redirectedExportPath("/home/x/osu!/Data/r/a.osr", "/home/x/osu!", PLAY)).toBe(
			"/home/x/osu!/Replays/Reonowo - Aqours - Miracle Wave [Insane] (2019-03-31) Osu (edited).osr"
		);
	});

	test("characters the OS forbids in a file name become spaces", () => {
		const awkward: ExportNaming = {
			...PLAY,
			artist: "A/B",
			title: 'a "quoted" <thing>',
			version: "1:2*3?"
		};
		const path = redirectedExportPath(`${ROOT}\\Data\\r\\a.osr`, ROOT, awkward);
		const name = path.slice(path.lastIndexOf("\\") + 1);
		expect(name).toBe("Reonowo - A B - a  quoted   thing  [1 2 3 ] (2019-03-31) Osu (edited).osr");
		// the directory half keeps its own separators, obviously
		expect(path.startsWith(`${ROOT}\\Replays\\`)).toBe(true);
	});

	test("an absent player name leaves the leading separator stable itself writes", () => {
		const guest = redirectedExportPath(`${ROOT}\\Data\\r\\a.osr`, ROOT, { ...PLAY, playerName: null });
		expect(guest).toBe(`${ROOT}\\Replays\\ - Aqours - Miracle Wave [Insane] (2019-03-31) Osu (edited).osr`);
	});

	test("an unreadable timestamp drops the date rather than the whole name", () => {
		const undated = redirectedExportPath(`${ROOT}\\Data\\r\\a.osr`, ROOT, {
			...PLAY,
			timestampTicks: "0"
		});
		expect(undated).toBe(`${ROOT}\\Replays\\Reonowo - Aqours - Miracle Wave [Insane] Osu (edited).osr`);
	});
});
