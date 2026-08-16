// pixi's webgl batch fragment shader picks a sprite's texture through an if
// chain on an interpolated varying and samples with implicit derivatives
// inside that non-uniform control flow (the whole gl high-shader pipeline
// compiles as glsl es 1.00, where texture() is #defined to texture2D). the
// derivatives are undefined there (glsl es spec, texture lookup functions),
// and on angle/d3d11 -- the webview2 this app always renders in -- the lod
// goes wrong exactly where a 2x2 derivative quad straddles the diagonal
// shared by a sprite quad's two triangles, so every mipmapped sprite shows a
// hairline seam along that diagonal (textures.ts bakes with mipmaps, and the
// density buckets leave most sprites slightly minified, so the seam sharpens
// as the viewer zooms in). pixi's webgpu path already has the cure: it hoists
// the derivatives out of the switch and samples with textureSampleGrad
// (generateTextureBatchBit's wgsl half). this module rebuilds the gl program
// the same way -- as glsl es 3.00, which GlProgram supports whenever the
// source carries "#version 300 es", with the gradients computed once in
// uniform control flow and every branch sampling through textureGrad -- and
// installs it on the shared default batch shader before the first frame
// compiles it

import {
	colorBitGl,
	compileHighShaderGl,
	DefaultBatcher,
	fragmentGlTemplate,
	generateTextureBatchBitGl,
	GlProgram,
	globalUniformsBitGl,
	roundPixelsBitGl,
	vertexGlTemplate,
	WebGLRenderer,
	type HighShaderBit,
	type Renderer
} from "pixi.js";

/** pixi's texture-batch bit with every sample rewritten to explicit
 * gradients. null when the bit no longer carries the source text this
 * rewrite targets (a pixi upgrade), which is the caller's cue to leave the
 * stock shader alone -- the seam comes back, the app keeps working, and
 * batch-shader.test.ts fails loudly */
export function gradSafeTextureBatchBitGl(maxTextures: number): HighShaderBit | null {
	const bit = generateTextureBatchBitGl(maxTextures);
	const main = bit.fragment?.main;
	if (main === undefined || !main.includes("texture(uTextures[")) return null;
	const sampled = main
		.replaceAll("texture(uTextures[", "textureGrad(uTextures[")
		.replaceAll("], vUV)", "], vUV, uvDx, uvDy)");
	// a fresh object rather than an edit of pixi's: generateTextureBatchBitGl
	// hands out a module-cached bit that pixi's own DefaultShader still
	// compiles from, and the high-shader compile cache keys on bit identity
	return {
		name: bit.name,
		vertex: bit.vertex,
		fragment: {
			header: bit.fragment!.header,
			main: `vec2 uvDx = dFdx(vUV);\nvec2 uvDy = dFdy(vUV);\n${sampled}`
		}
	};
}

/** the corrected batch program's glsl, assembled from the same template and
 * bits DefaultShader uses but pinned to es 3.00 (textureGrad and dFdx do not
 * exist in the es 1.00 the stock pipeline compiles as). null when the bit
 * rewrite did not apply */
export function gradSafeBatchProgramSources(maxTextures: number): { vertex: string; fragment: string } | null {
	const bit = gradSafeTextureBatchBitGl(maxTextures);
	if (bit === null) return null;
	const source = compileHighShaderGl({
		template: { vertex: vertexGlTemplate, fragment: fragmentGlTemplate },
		bits: [globalUniformsBitGl, colorBitGl, bit, roundPixelsBitGl]
	});
	// the version marker is what flips GlProgram's preprocessors into their
	// es 3.00 mode (it is stripped and re-inserted at the very top); without
	// it they bolt on the webgl1 compatibility defines and the shader breaks
	return {
		vertex: `#version 300 es\n${source.vertex}`,
		fragment: `#version 300 es\n${source.fragment}`
	};
}

/** swaps the gradient-safe program into the shared shader every default
 * batcher uses. must run after renderer init and before the first frame,
 * while the stock program is still unbound. a no-op off webgl2 (es 3.00
 * needs a webgl2 context) and when the rewrite did not apply; returns
 * whether the patched program is in place */
export function installGradSafeBatchShader(renderer: Renderer): boolean {
	if (!(renderer instanceof WebGLRenderer) || renderer.context.webGLVersion !== 2) return false;
	const maxTextures = renderer.limits.maxBatchableTextures;
	// constructing a DefaultBatcher is the one public route to the module-level
	// shader singleton; destroy() releases the probe's own buffers and leaves
	// the shared shader alone
	const probe = new DefaultBatcher({ maxTextures });
	try {
		// a second renderer mount finds the singleton already patched; swapping
		// again would compile one more identical program per mount
		if (probe.shader.glProgram.fragment?.includes("textureGrad")) return true;
		const sources = gradSafeBatchProgramSources(maxTextures);
		if (sources === null) return false;
		probe.shader.glProgram = new GlProgram({ name: "batch", ...sources });
		return true;
	} finally {
		probe.destroy();
	}
}
