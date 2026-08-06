import { describe, expect, test } from "bun:test";
import { loadFixture } from "../test/fixtures";
import { EASINGS } from "./easing";

interface EasingFixture {
	samples: number[];
	cases: { name: string; values: number[] }[];
}

describe("easing parity", () => {
	test("every fixture case has a port and reproduces lazer's values", async () => {
		const fixture = await loadFixture<EasingFixture>("easing.json");
		expect(fixture.cases.length).toBe(36);
		for (const c of fixture.cases) {
			const fn = EASINGS[c.name];
			expect(fn, `missing easing port: ${c.name}`).toBeDefined();
			c.values.forEach((expected, i) => {
				const actual = fn(fixture.samples[i]);
				expect(Math.abs(actual - expected), `${c.name} at t=${fixture.samples[i]}`).toBeLessThanOrEqual(1e-9);
			});
		}
	});

	test("no port exists without a fixture case", async () => {
		const fixture = await loadFixture<EasingFixture>("easing.json");
		const names = new Set(fixture.cases.map((c) => c.name));
		for (const key of Object.keys(EASINGS)) expect(names.has(key)).toBe(true);
	});
});
