import { describe, expect, test } from "bun:test";
import {
	defaultExportPath,
	expectationCopy,
	exportPathKind,
	initialOverwriteConsent,
	offersOverwriteConfirm,
	outcomeCopy,
	regeneratedSummaryRows
} from "./export-flow";

describe("exportPathKind", () => {
	test("keys off the dirty split exactly", () => {
		expect(exportPathKind(false, false)).toBe("passthrough");
		expect(exportPathKind(false, true)).toBe("carried");
		expect(exportPathKind(true, false)).toBe("regenerating");
		// frames dirty wins the mixed case: the header must be regenerated
		expect(exportPathKind(true, true)).toBe("regenerating");
	});

	test("each path gets distinct expectation copy", () => {
		const copies = new Set(
			(["regenerating", "carried", "passthrough"] as const).map((kind) => expectationCopy(kind))
		);
		expect(copies.size).toBe(3);
		expect(expectationCopy("carried")).toContain("carried byte-for-byte");
		expect(expectationCopy("passthrough")).toContain("byte-identically");
		expect(expectationCopy("regenerating")).toContain("regenerated");
	});
});

describe("defaultExportPath", () => {
	test("inserts the suffix before the extension so the source is never shadowed", () => {
		expect(defaultExportPath("C:\\replays\\cookiezi.osr")).toBe("C:\\replays\\cookiezi (edited).osr");
		expect(defaultExportPath("/home/x/play.osr")).toBe("/home/x/play (edited).osr");
	});

	test("handles dotted directories and extensionless names", () => {
		expect(defaultExportPath("C:\\dir.v2\\replay")).toBe("C:\\dir.v2\\replay (edited)");
		expect(defaultExportPath("replay")).toBe("replay (edited)");
		// a leading dot is a hidden-style name, not an extension
		expect(defaultExportPath("C:\\x\\.osr")).toBe("C:\\x\\.osr (edited)");
	});

	test("keeps multi-dot names intact up to the last extension", () => {
		expect(defaultExportPath("a.b.osr")).toBe("a.b (edited).osr");
	});
});

describe("overwrite flow", () => {
	test("the warning setting decides the up-front consent", () => {
		expect(initialOverwriteConsent(true)).toBe(false);
		expect(initialOverwriteConsent(false)).toBe(true);
	});

	test("only a fileExists failure offers the confirmation", () => {
		expect(offersOverwriteConfirm({ kind: "fileExists", path: "C:\\x.osr" })).toBe(true);
		expect(offersOverwriteConfirm({ kind: "exportOverflow", field: "maxCombo" })).toBe(false);
		expect(offersOverwriteConfirm({ kind: "staleSession" })).toBe(false);
	});
});

describe("post-export summary", () => {
	test("lists every regenerated value plus the two dirty-export constants", () => {
		const rows = regeneratedSummaryRows({
			count300: 1000,
			count100: 12,
			count50: 3,
			countGeki: 150,
			countKatsu: 9,
			countMiss: 2,
			maxCombo: 1204,
			perfect: false,
			totalScore: 31415926
		});
		expect(rows.map((r) => r.label)).toEqual([
			"300s",
			"100s",
			"50s",
			"misses",
			"geki / katu",
			"max combo",
			"perfect",
			"total score",
			"life bar",
			"replay hash"
		]);
		expect(rows.find((r) => r.label === "geki / katu")!.value).toBe(
			`${(150).toLocaleString()} / ${(9).toLocaleString()}`
		);
		expect(rows.find((r) => r.label === "perfect")!.value).toBe("no");
		expect(rows.find((r) => r.label === "total score")!.value).toBe((31415926).toLocaleString());
		expect(rows.find((r) => r.label === "life bar")!.value).toBe("written empty");
	});

	test("passthrough and carried get their own outcome copy", () => {
		expect(outcomeCopy("passthrough", 4096)).toContain("byte-identical");
		expect(outcomeCopy("carried", 4096)).toContain("carried verbatim");
		expect(outcomeCopy("carried", 4096)).toContain((4096).toLocaleString());
	});
});
