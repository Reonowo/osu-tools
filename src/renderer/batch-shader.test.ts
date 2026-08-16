import { describe, expect, test } from "bun:test";
import { generateTextureBatchBitGl } from "pixi.js";
import { gradSafeBatchProgramSources, gradSafeTextureBatchBitGl } from "./batch-shader";

// installGradSafeBatchShader needs a live webgl2 context, which bun test has
// not -- what is testable here is the whole string surface it installs: that
// the rewrite still lands on pixi's generated source (a pixi upgrade that
// changes the batch shader text must fail here, not silently bring the
// diagonal seam back), and that the assembled program is the es 3.00 shape
// GlProgram keys its preprocessing off

describe("gradSafeTextureBatchBitGl", () => {
	test("rewrites every sample to explicit gradients", () => {
		const bit = gradSafeTextureBatchBitGl(16);
		expect(bit).not.toBeNull();
		const main = bit!.fragment!.main!;
		expect(main.startsWith("vec2 uvDx = dFdx(vUV);\nvec2 uvDy = dFdy(vUV);")).toBe(true);
		expect(main.match(/textureGrad\(uTextures\[\d+\], vUV, uvDx, uvDy\)/g)).toHaveLength(16);
		// no implicit-derivative sample may survive inside the if chain
		expect(main).not.toContain("texture(uTextures[");
	});

	test("scales with the texture count the renderer reports", () => {
		expect(gradSafeTextureBatchBitGl(4)!.fragment!.main!.match(/textureGrad/g)).toHaveLength(4);
	});

	test("leaves pixi's own module-cached bit untouched", () => {
		gradSafeTextureBatchBitGl(8);
		const original = generateTextureBatchBitGl(8);
		expect(original.fragment!.main).toContain("texture(uTextures[");
		expect(original.fragment!.main).not.toContain("textureGrad");
	});

	test("shares the vertex half with pixi's bit, by reference", () => {
		// the fragment is the only thing rewritten; a diverging vertex would
		// desync vTextureId's declaration from what the fragment consumes
		expect(gradSafeTextureBatchBitGl(4)!.vertex).toBe(generateTextureBatchBitGl(4).vertex);
	});
});

describe("gradSafeBatchProgramSources", () => {
	test("both halves open with the es 3.00 version marker", () => {
		const sources = gradSafeBatchProgramSources(16);
		expect(sources).not.toBeNull();
		// GlProgram detects es 3.00 by this exact string; without it the
		// preprocessors bolt on webgl1 defines and the fragment fails to compile
		expect(sources!.vertex.startsWith("#version 300 es\n")).toBe(true);
		expect(sources!.fragment.startsWith("#version 300 es\n")).toBe(true);
	});

	test("the fragment carries the gradient samples and the sampler array", () => {
		const fragment = gradSafeBatchProgramSources(16)!.fragment;
		expect(fragment).toContain("uniform sampler2D uTextures[16];");
		expect(fragment.match(/textureGrad\(/g)).toHaveLength(16);
		expect(fragment).toContain("in float vTextureId;");
	});
});
