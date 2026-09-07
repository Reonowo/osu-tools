// two halves. the first pins the module itself -- the generator round-trips
// through its own parser, and the bezier evaluator lands on the points a
// cubic bezier's shape guarantees. the second is the one that matters
// (docs/adr/0010, decision 7): it reads index.css, finds every --ease-* token
// in it, and asserts each against engine/easing.ts, so a hand-tweaked curve
// in the stylesheet cannot claim to be a lazer easing it is not

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EASINGS, outQuint, type EasingFn } from "@/engine/easing";
import {
	cubicBezierAt,
	LINEAR_SEGMENTS,
	linearEasing,
	maxDeviation,
	parseCubicBezier,
	parseLinearEasing,
	sampleLinear
} from "./easing-css";

/** how far a stylesheet easing may sit from the curve it names, at its worst
 * point. a hundredth of the animated range is below what any of these sites
 * moves in a frame, and it is loose enough that a bezier which genuinely IS
 * the curve passes while one picked by eye does not */
const TOLERANCE = 0.01;

/** where the deviation is measured. dense enough that a curve which is only
 * wrong in a narrow band -- which the elastic overshoot is -- cannot slip
 * between the samples */
const GRID_POINTS = 500;

const STYLESHEET = readFileSync(new URL("../index.css", import.meta.url), "utf8");

/** the engine easing a token name claims: `--ease-out-elastic-half` names
 * `OutElasticHalf`. the mapping is the naming convention, so a token can only
 * be added under a name the port actually has */
function portName(token: string): string {
	return token
		.replace(/^--ease-/, "")
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

/** every `--ease-*` declaration in the stylesheet, read out of the file
 * rather than restated here: a token added without a port entry fails the
 * assertions below instead of going unnoticed.
 *
 * the value is whitespace-collapsed, because a long `linear()` is exactly
 * what the formatter breaks over many lines: how the declaration is LAID OUT
 * is oxfmt's business, and what is pinned here is the curve */
function stylesheetEasings(): { token: string; value: string }[] {
	const found: { token: string; value: string }[] = [];
	const pattern = /^\s*(--ease-[a-z0-9-]+)\s*:\s*([^;]+);/gm;
	let match = pattern.exec(STYLESHEET);
	while (match !== null) {
		const collapsed = match[2].replace(/\s+/g, " ").trim();
		found.push({ token: match[1], value: collapsed.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")") });
		match = pattern.exec(STYLESHEET);
	}
	return found;
}

describe("the linear() generator", () => {
	test("round trips through the module's own parser", () => {
		const generated = linearEasing(outQuint);
		const stops = parseLinearEasing(generated);
		expect(stops).not.toBeNull();
		expect(stops).toHaveLength(LINEAR_SEGMENTS + 1);
		// the stops ARE the curve at even inputs, which is the whole claim the
		// pin test below rests on
		expect(stops![0]).toBe(0);
		expect(stops![LINEAR_SEGMENTS]).toBe(1);
		for (let i = 0; i <= LINEAR_SEGMENTS; i++) {
			expect(stops![i]).toBeCloseTo(outQuint(i / LINEAR_SEGMENTS), 4);
		}
	});

	test("a regenerated string is byte-identical, so the pin test can compare strings", () => {
		expect(linearEasing(outQuint)).toBe(linearEasing(outQuint));
	});

	test("the parser declines anything that is not a linear()", () => {
		expect(parseLinearEasing("cubic-bezier(0, 0, 1, 1)")).toBeNull();
		expect(parseLinearEasing("ease-out")).toBeNull();
		// one stop is a constant, not a curve
		expect(parseLinearEasing("linear(0.5)")).toBeNull();
	});

	test("a stop that is not a number fails the parse rather than shortening the curve", () => {
		// the failure this guards is silent: dropping the bad stop would leave a
		// readable two-stop easing that the pin test below would happily accept
		expect(parseLinearEasing("linear(0, oops, 1)")).toBeNull();
		expect(parseLinearEasing("linear(0, , 1)")).toBeNull();
	});

	test("a parsed linear() evaluates by the same even spacing it was written with", () => {
		const stops = [0, 0.5, 1];
		expect(sampleLinear(stops, 0)).toBeCloseTo(0, 6);
		expect(sampleLinear(stops, 0.25)).toBeCloseTo(0.25, 6);
		expect(sampleLinear(stops, 0.5)).toBeCloseTo(0.5, 6);
		expect(sampleLinear(stops, 1)).toBeCloseTo(1, 6);
	});
});

describe("the cubic-bezier evaluator", () => {
	test("is pinned at both endpoints whatever the control points", () => {
		expect(cubicBezierAt([0.23, 1, 0.32, 1], 0)).toBe(0);
		expect(cubicBezierAt([0.23, 1, 0.32, 1], 1)).toBe(1);
	});

	test("linear control points are the identity", () => {
		const identity = [0, 0, 1, 1] as const;
		for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
			expect(cubicBezierAt(identity, t)).toBeCloseTo(t, 6);
		}
	});

	test("a symmetric ease-in-out is at a half at its midpoint", () => {
		// the standard css `ease-in-out`, whose symmetry fixes the one interior
		// point a bezier's shape guarantees without solving anything
		expect(cubicBezierAt([0.42, 0, 0.58, 1], 0.5)).toBeCloseTo(0.5, 6);
	});

	test("the parser declines anything that is not a cubic-bezier()", () => {
		expect(parseCubicBezier("linear(0, 1)")).toBeNull();
		expect(parseCubicBezier("cubic-bezier(0, 0, 1)")).toBeNull();
		expect(parseCubicBezier("cubic-bezier(0.42, 0, 0.58, 1)")).toEqual([0.42, 0, 0.58, 1]);
	});
});

describe("the stylesheet's easing tokens", () => {
	const tokens = stylesheetEasings();

	test("the stylesheet declares easings at all, so a silent regex miss cannot pass this file", () => {
		expect(tokens.length).toBeGreaterThan(0);
	});

	test("every token names an easing the engine's port has", () => {
		const unknown = tokens.map(({ token }) => portName(token)).filter((name) => EASINGS[name] === undefined);
		// on the list rather than on a count: the failure names the token
		expect(unknown).toEqual([]);
	});

	test("no token is declared twice", () => {
		const names = tokens.map(({ token }) => token);
		expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
	});

	for (const { token, value } of tokens) {
		const fn: EasingFn | undefined = EASINGS[portName(token)];

		test(`${token} is the curve it claims to be`, () => {
			expect(fn).toBeDefined();
			const stops = parseLinearEasing(value);
			if (stops !== null) {
				// a linear() is a SAMPLING of the port, so it is pinned exactly:
				// regenerating it from the port must reproduce the token verbatim,
				// which is stricter than a tolerance and is what stops a stop being
				// nudged by hand
				expect(value).toBe(linearEasing(fn!));
				// and the sample count itself has to earn the tolerance -- this is
				// what LINEAR_SEGMENTS is chosen against
				expect(maxDeviation(fn!, (t) => sampleLinear(stops, t), GRID_POINTS)).toBeLessThan(TOLERANCE);
				return;
			}
			const control = parseCubicBezier(value);
			// anything that is neither shape is a token the test cannot check,
			// which is the case decision 7 rules out
			expect(control).not.toBeNull();
			expect(maxDeviation(fn!, (t) => cubicBezierAt(control!, t), GRID_POINTS)).toBeLessThan(TOLERANCE);
		});
	}
});
