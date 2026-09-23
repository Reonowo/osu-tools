// pins index.css's chrome vocabulary to lib/chrome-tokens.ts and to
// engine/osu-colours.ts, then bans raw design literals in src/ (docs/adr/0011).
// modelled on lib/easing-css.test.ts: the stylesheet is the rendered source of
// truth, the manifest is the cited list, and a hand-tweaked hex that claims to
// be a grade colour cannot slip through.
//
// the raw-literal ban is phase-gated: ALLOW lists paths still to convert and
// burns to [] once the sweep is done. it never WIDENS -- a straggler is either
// converted or written down in TODO.md as exempt.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { OSU_COLOUR } from "@/engine/osu-colours";
import { CHROME_TOKENS, DESIGN_TOKEN_PREFIXES, OSU_COLOUR_PINS } from "./chrome-tokens";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const STYLESHEET = readFileSync(join(SRC, "index.css"), "utf8");

/** whitespace-collapsed, because the formatter breaks long declarations over
 * lines (same rule as easing-css.test.ts's linear() handling) */
function collapse(value: string): string {
	return value.replace(/\s+/g, " ").trim().replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
}

/** every `--token: value` declaration in the stylesheet, including the
 * companions (`--text-caption--line-height`). keyframes' custom properties are
 * ordinary declarations and are included on purpose */
function stylesheetTokens(): Map<string, string> {
	const found = new Map<string, string>();
	const pattern = /(--[a-z0-9-]+(?:--[a-z0-9-]+)*)\s*:\s*([^;]+);/g;
	let match = pattern.exec(STYLESHEET);
	while (match !== null) {
		found.set(match[1], collapse(match[2]));
		match = pattern.exec(STYLESHEET);
	}
	return found;
}

function isDesignToken(name: string): boolean {
	return DESIGN_TOKEN_PREFIXES.some((prefix) => name === prefix || name.startsWith(prefix));
}

/** every ts/tsx under src/ the ban reaches. excluded: the engine/skin/renderer
 * ports (lazer and Pixi values live in TS with their own citations), assets,
 * tests, and the manifest itself -- chrome-tokens.ts is the value list, the one
 * place outside index.css where a hex is written down on purpose */
function banTargets(): string[] {
	const skipDirs = new Set(["engine", "skin", "renderer", "assets", "node_modules"]);
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			const st = statSync(full);
			if (st.isDirectory()) {
				if (!skipDirs.has(entry)) walk(full);
				continue;
			}
			if (!/\.(ts|tsx)$/.test(entry)) continue;
			if (/\.test\.(ts|tsx)$/.test(entry)) continue;
			if (entry === "chrome-tokens.ts") continue;
			out.push(full);
		}
	};
	walk(SRC);
	return out.sort();
}

/** paths still carrying raw literals. phase 6 burns this to [] */
const ALLOW: string[] = [];

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const RGB = /\brgba?\([0-9]/;
/** value-arbitrary utilities whose bracket is a pure measurement or colour:
 * `-[9px]`, `-[.14em]`, `-[11.3deg]`, `-[#fff]`, `-[rgba(…)]`, `-[min(…)]`.
 * deliberately NOT `calc(…)` (a derived value, not a design measurement) and
 * NOT `data-[…]` / `aria-[…]` / `has-data-[…]` / `group-data-[…]` /
 * `in-data-[…]` / `not-aria-[…]` / `[*:inherit]` / `[*:var(--…)]` --
 * variant selectors and functional references, not design values */
const VALUE_ARBITRARY =
	/-(?:\[\s*-?\d*\.?\d+(?:px|rem|em|deg)\s*\]|\[#[0-9a-fA-F]{3,8}\]|\[rgba?\([^\]]*\)\]|\[min\([^\]]*\)\])/;
const ALLOWED_ARBITRARY = [
	/\[data-/,
	/\[aria-/,
	/\[has-data-/,
	/\[group-data-/,
	/\[in-data-/,
	/\[not-aria-/,
	/\[data-highlighted/,
	/\[\*:inherit\]/,
	/\[\*:var\(/,
	/\[--spacing\(var\(--gap\)\)\]/
];

/** an arbitrary property (`[height:13px]`) whose value is a design literal */
const ARBITRARY_PROPERTY = /^\[[a-z-]+:[^\]]*(?:\d(?:px|rem|em|deg)|#[0-9a-fA-F]{3,8}|rgba?\(|min\()/;

/** a variant whose bracket is a measurement (`min-[900px]:`, `@[400px]:`,
 * `[@media(min-width:900px)]:`) -- a breakpoint written as a raw pixel */
const ARBITRARY_VARIANT = /\[[^\]]*\d(?:px|rem|em|deg)/;

/** a class split at every `:` outside brackets and parentheses -- the variant
 * chain, then the utility last -- so a bracketed or named-group variant
 * (`data-[size=sm]:`, `group-data-horizontal/tabs:`, `[&>svg]:`) cannot hide
 * the value behind it. a quote inside a variant splits the class and leaves
 * closing brackets unmatched, so depth is clamped at 0 rather than going
 * negative and mistaking a later bracket's own colon for a separator */
function segmentsOf(cls: string): string[] {
	const segments: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < cls.length; i++) {
		const ch = cls[i];
		if (ch === "[" || ch === "(") depth++;
		else if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
		else if (ch === ":" && depth === 0) {
			segments.push(cls.slice(start, i));
			start = i + 1;
		}
	}
	segments.push(cls.slice(start));
	return segments;
}

function violationsIn(source: string, label: string): string[] {
	const hits: string[] = [];
	// comment lines are citations, not sites: osucolour.cs's hexes and a
	// contrast working belong in the prose beside the code (same posture as
	// the engine ports' module maps). a literal in code on the same line is
	// still caught, because only a line whose trimmed form OPENS as a
	// comment is skipped
	const code = source
		.split("\n")
		.filter((line) => {
			const t = line.trim();
			return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#"));
		})
		.join("\n");
	const check = (pattern: RegExp, what: string) => {
		const match = code.match(pattern);
		if (match) hits.push(`${label}: ${what}: ${match[0]}`);
	};
	check(HEX, "raw hex");
	check(RGB, "raw rgb/rgba");
	for (const cls of code.split(/[\s"'`]+/)) {
		if (!cls.includes("[")) continue;
		const segments = segmentsOf(cls);
		const utility = segments[segments.length - 1] ?? "";
		if (segments.slice(0, -1).some((variant) => ARBITRARY_VARIANT.test(variant))) {
			hits.push(`${label}: arbitrary variant: ${cls}`);
		}
		if (ALLOWED_ARBITRARY.some((skip) => skip.test(utility))) continue;
		if (ARBITRARY_PROPERTY.test(utility)) hits.push(`${label}: arbitrary property: ${cls}`);
		if (VALUE_ARBITRARY.test(utility)) hits.push(`${label}: arbitrary value: ${cls}`);
		if (/grid-(?:rows|cols)-\[/.test(utility)) hits.push(`${label}: raw grid template: ${cls}`);
		if (/\[(?:min|max)\(/.test(utility) && !/rounded-control/.test(utility)) {
			hits.push(`${label}: raw min/max cap: ${cls}`);
		}
	}
	return hits;
}

describe("the chrome vocabulary", () => {
	const stylesheet = stylesheetTokens();

	test("the stylesheet declares the vocabulary at all, so a silent regex miss cannot pass this file", () => {
		expect(stylesheet.size).toBeGreaterThan(50);
		expect(Object.keys(CHROME_TOKENS).length).toBeGreaterThan(50);
	});

	test("every manifest token is in the stylesheet with its exact value", () => {
		const missing: string[] = [];
		const wrong: string[] = [];
		for (const [token, entry] of Object.entries(CHROME_TOKENS)) {
			const actual = stylesheet.get(token);
			if (actual === undefined) {
				missing.push(token);
				continue;
			}
			if (actual !== collapse(entry.value)) {
				wrong.push(`${token}: expected ${collapse(entry.value)}, got ${actual}`);
			}
		}
		expect(missing).toEqual([]);
		expect(wrong).toEqual([]);
	});

	test("no design token in the stylesheet is missing from the manifest", () => {
		const unnamed = [...stylesheet.keys()]
			.filter(isDesignToken)
			.filter((name) => !(name in CHROME_TOKENS))
			.filter(
				(name) =>
					![
						"--radius",
						"--radius-sm",
						"--radius-md",
						"--radius-lg",
						"--radius-xl",
						"--radius-2xl",
						"--radius-3xl",
						"--radius-4xl"
					].includes(name)
			);
		expect(unnamed).toEqual([]);
	});

	test("every --color-* bridge to a manifest token points at that token and nothing else", () => {
		const rebound = [...stylesheet.entries()]
			.filter(([name]) => name.startsWith("--color-") && `--${name.slice("--color-".length)}` in CHROME_TOKENS)
			.filter(([name, value]) => value !== `var(--${name.slice("--color-".length)})`)
			.map(([name, value]) => `${name}: ${value}`);
		expect(rebound).toEqual([]);
	});

	test("no manifest entry is orphaned (covered by the presence check, restated for a readable failure)", () => {
		const orphans = Object.keys(CHROME_TOKENS).filter((name) => !stylesheet.has(name));
		expect(orphans).toEqual([]);
	});
});

describe("grade, graph and lattice tokens are the OsuColour port", () => {
	const stylesheet = stylesheetTokens();

	for (const [token, expected] of Object.entries(OSU_COLOUR_PINS)) {
		test(`${token} is the port value`, () => {
			expect(stylesheet.get(token)).toBe(collapse(expected));
			expect(CHROME_TOKENS[token]?.value).toBe(expected);
		});
	}

	test("--grade-miss is osucolour.cs Red and not --destructive", () => {
		expect(stylesheet.get("--grade-miss")).toBe(OSU_COLOUR.red);
		// the two must stay the same red whatever a theme does, but they are two
		// tokens (TODO.md, overview-strip fail mark) -- pin the VALUES to the
		// port and the destructive token to the same hex for now, so a theme
		// that moves one has to move both deliberately
		expect(stylesheet.get("--destructive")).toBe(OSU_COLOUR.red);
	});
});

describe("the raw-literal ban", () => {
	const targets = banTargets();

	test("the ban scans a nonempty target set, so a silent path bug cannot pass this file", () => {
		expect(targets.length).toBeGreaterThan(30);
	});

	test("a value behind any variant shape is caught, and a variant's own bracket is not", () => {
		for (const cls of [
			"md:text-[11px]",
			"data-[size=default]:h-[18.4px]",
			"group-data-horizontal/tabs:after:-bottom-[5px]",
			"[&>svg]:size-[14px]",
			"[&_svg:not([class*='size-'])]:size-[14px]",
			"[&_svg:not([class*='size-'])]:[height:13px]",
			"[height:13px]",
			"min-[900px]:flex",
			"@[400px]:flex",
			"[@media(min-width:900px)]:flex",
			"hover:bg-[#16161a]",
			"w-[min(760px,calc(100vw-4rem))]",
			"grid-rows-[48px_minmax(0,1fr)]"
		]) {
			expect(violationsIn(`<div className="${cls}" />`, "probe")).not.toEqual([]);
		}
		for (const cls of [
			"data-[size=sm]:rounded-control-sm",
			"group-data-[spacing=0]/toggle-group:rounded-none",
			"[&_svg:not([class*='size-'])]:size-3",
			"gap-[--spacing(var(--gap))]",
			"rounded-[inherit]",
			"translate-y-arrow-centre"
		]) {
			expect(violationsIn(`<div className="${cls}" />`, "probe")).toEqual([]);
		}
	});

	test("no raw hex, rgb/rgba or value-arbitrary utility in chrome ts/tsx", () => {
		const all: string[] = [];
		for (const file of targets) {
			const rel = relative(SRC, file);
			if (ALLOW.some((allowed) => rel === allowed || rel.startsWith(allowed + "/"))) continue;
			all.push(...violationsIn(readFileSync(file, "utf8"), rel));
		}
		expect(all).toEqual([]);
	});
});
