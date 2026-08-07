import { describe, expect, test } from "bun:test";
import { Container, Matrix, updateRenderGroupTransforms } from "pixi.js";
import { DENSITY_BUCKETS } from "../playfield";
import { COMPOSITE_FRAGMENT, distanceTextureOptions } from "./body";

// body.ts's SliderBodyRenderer can't be constructed headlessly (Shader.from
// touches GlProgram, which probes a real <canvas> for max fragment
// precision -- confirmed by running it here: it throws "document is not
// defined" under bun test). What IS headlessly testable is the pixi
// mechanism the prepass's max-blend depends on: `mesh.blendMode = "max"`
// only reaches the gpu if `mesh.groupBlendMode` ends up "max" after pixi's
// own transform/blend propagation pass (meshpipe.mjs:80 reads
// `mesh.groupBlendMode`, never `mesh.blendMode`/`localBlendMode` directly).
// that propagation is defined entirely on `Container` (updateRenderGroupTransforms.mjs's
// `updateColorBlendVisibility`), and `Mesh extends ViewContainer extends
// Container` inherits it unchanged, so a plain `Container` standing in for
// "the prepass mesh" exercises the identical code path a real `Mesh` would.

describe("prepass blend-mode propagation (the mesh.groupBlendMode pixi actually reads)", () => {
	test("a container rendered directly AS the render root never gets its own blendMode into groupBlendMode", () => {
		// this is the bug: renderer.render({ container: prepassMesh, ... })
		// calls prepassMesh.enableRenderGroup() (abstractrenderer.mjs), and
		// enableRenderGroup() hard-sets groupTransform/groupBlendMode semantics
		// for render-group ROOTS specifically -- Container.mjs's constructor
		// default (groupBlendMode = "normal") is never revisited for a root,
		// only for its children (updateColorBlendVisibility runs per-child)
		const root = new Container();
		root.blendMode = "max";
		root.enableRenderGroup();
		updateRenderGroupTransforms(root.renderGroup, true);

		expect(root.localBlendMode).toBe("max"); // the setter worked...
		expect(root.groupBlendMode).toBe("normal"); // ...but pixi never reads this
	});

	test("a container rendered as a CHILD of an (unscaled) render-group root does get its blendMode propagated", () => {
		// the fix: wrap the mesh in a plain root Container and render that
		// instead, so the mesh is a render-group child, which does go through
		// updateColorBlendVisibility
		const root = new Container();
		root.enableRenderGroup();
		const prepassStandIn = new Container();
		prepassStandIn.blendMode = "max";
		root.addChild(prepassStandIn);
		updateRenderGroupTransforms(root.renderGroup, true);

		expect(prepassStandIn.groupBlendMode).toBe("max");
	});

	test("the wrapping root being unscaled does not change the child's rendered transform", () => {
		// meshpipe.mjs feeds `mesh.groupTransform` to uTransformMatrix, and
		// abstractrenderer.mjs feeds the render root's own (updated)
		// localTransform to uWorldTransformMatrix. verifies the two setups
		// produce the same combined uWorldTransformMatrix * uTransformMatrix
		// product, just redistributed across the two uniforms, so wrapping in
		// an identity root (as body.ts's prepassRoot is) is transform-neutral
		// mirrors abstractrenderer.mjs:93-96's exact sequence for whatever
		// container is passed as `options.container` (the render root)
		function renderRootWorldTransform(root: Container): Matrix {
			root.updateLocalTransform();
			return root.localTransform.clone();
		}
		// pixi's own combine order, from Matrix.append's doc: "this = this * matrix"
		function netTransform(world: Matrix, local: Matrix): Matrix {
			return world.clone().append(local);
		}

		// fixed pattern: identity root -> transformed child
		const fixedRoot = new Container();
		const child = new Container();
		child.scale.set(2, 3);
		child.position.set(5, 7);
		fixedRoot.addChild(child);
		const fixedWorldTransform = renderRootWorldTransform(fixedRoot); // uWorldTransformMatrix
		fixedRoot.enableRenderGroup();
		updateRenderGroupTransforms(fixedRoot.renderGroup, true);
		const fixedLocalTransform = child.groupTransform; // uTransformMatrix

		// buggy pattern: the transformed node itself is the render root
		const buggyRoot = new Container();
		buggyRoot.scale.set(2, 3);
		buggyRoot.position.set(5, 7);
		const buggyWorldTransform = renderRootWorldTransform(buggyRoot); // uWorldTransformMatrix
		buggyRoot.enableRenderGroup();
		updateRenderGroupTransforms(buggyRoot.renderGroup, true);
		const buggyLocalTransform = buggyRoot.groupTransform; // uTransformMatrix

		const fixedNet = netTransform(fixedWorldTransform, fixedLocalTransform);
		const buggyNet = netTransform(buggyWorldTransform, buggyLocalTransform);

		expect(fixedNet).toEqual(buggyNet);
		expect(fixedNet).toEqual(new Matrix(2, 0, 0, 3, 5, 7));
	});
});

// fix-report finding 1: the composite fragment never sampled uColor, so
// `view.alpha`/`view.tint` (set every frame by slider.ts) never reached the
// rasterised body -- it popped in fully opaque, never dimmed, and never
// faded out. same headless limitation as above (Shader.from needs a real
// <canvas>), so this pins the same two things the fix depends on: (1) the
// mechanism that feeds uColor -- mesh.groupColorAlpha, composited by the
// identical updateColorBlendVisibility pass the blend-mode tests above
// already exercise (MeshPipe.js:87-91's color32BitToUniform reads exactly
// this field) -- and (2) that the shipped shader source still declares and
// consumes uColor, since nothing else here can catch a silent revert
describe("body tint/alpha propagation (uColor's source, updateRenderGroupTransforms.mjs's updateColorBlendVisibility)", () => {
	test("a parent Sprite-stand-in's tint and alpha propagate into a mesh-stand-in child's groupColorAlpha", () => {
		// updateColorBlendVisibility: container.groupColorAlpha =
		// container.groupColor + ((groupAlpha * 255 | 0) << 24), where
		// groupColor = multiplyColors(localColor, parent.groupColor) -- a
		// pure-black tint (0x000000) forces every colour channel to 0
		// regardless of pixi's internal bgr byte packing, so this test never
		// needs to know that packing order to be unambiguous
		const root = new Container();
		root.enableRenderGroup();
		const parent = new Container(); // stands in for body.ts's `view` (a Sprite)
		parent.tint = 0x000000;
		parent.alpha = 0.5;
		const meshStandIn = new Container(); // stands in for compositeMesh, itself never touched
		parent.addChild(meshStandIn);
		root.addChild(parent);
		updateRenderGroupTransforms(root.renderGroup, true);

		const packed = meshStandIn.groupColorAlpha;
		expect(packed & 0xffffff).toBe(0); // the black tint propagated (any byte order)
		expect((packed >>> 24) & 0xff).toBe(127); // 0.5 alpha propagated: (255 * 0.5) | 0
	});

	test("an untouched parent leaves the child fully opaque and white", () => {
		const root = new Container();
		root.enableRenderGroup();
		const parent = new Container();
		const meshStandIn = new Container();
		parent.addChild(meshStandIn);
		root.addChild(parent);
		updateRenderGroupTransforms(root.renderGroup, true);

		expect(meshStandIn.groupColorAlpha >>> 0).toBe(0xffffffff);
	});
});

describe("distance texture options", () => {
	const smallBody = { width: 200, height: 120 };

	test("osu!px -> texels follows the density bucket, so a body is as sharp as the circles on it", () => {
		expect(distanceTextureOptions(2, smallBody)).toMatchObject({ width: 400, height: 240 });
		expect(distanceTextureOptions(4, smallBody)).toMatchObject({ width: 800, height: 480 });
		expect(distanceTextureOptions(8, smallBody)).toMatchObject({ width: 1600, height: 960 });
	});

	test("the dimension cap holds whatever the bucket asks for", () => {
		// a body spanning most of the playfield at the top bucket would be 4k+
		const marathon = { width: 500, height: 380 };
		for (const bucket of DENSITY_BUCKETS) {
			const { width, height } = distanceTextureOptions(bucket, marathon);
			expect(Math.max(width, height)).toBeLessThanOrEqual(2048);
		}
		// the cap scales both axes by the same factor, preserving the aspect the
		// composite quad samples over
		const capped = distanceTextureOptions(8, marathon);
		expect(capped.width).toBe(2048);
		expect(capped.height / capped.width).toBeCloseTo(380 / 500, 2);
	});

	test("a degenerate body still asks for a texture the gpu will accept", () => {
		expect(distanceTextureOptions(4, { width: 0, height: 0 })).toMatchObject({ width: 1, height: 1 });
	});

	test("linear sampling and antialias on, mipmaps off", () => {
		const options = distanceTextureOptions(4, smallBody);
		// linear is load-bearing: the target holds a distance field, and nearest
		// would replicate the lut's aa ramp into blocky steps on diagonals
		expect(options.scaleMode).toBe("linear");
		expect(options.antialias).toBe(true);
		// setRange() re-rasterises this target every time the snake range moves,
		// so a mip chain would be regenerated per frame for no benefit
		expect(options.autoGenerateMipmaps).toBe(false);
	});
});

describe("composite fragment shader consumes uColor (fix-report finding 1 regression pin)", () => {
	test("declares uColor and multiplies it into the final premultiplied output", () => {
		expect(COMPOSITE_FRAGMENT).toMatch(/uniform\s+vec4\s+uColor\s*;/);
		expect(COMPOSITE_FRAGMENT).toMatch(/finalColor\s*=.*\*\s*uColor\s*;/);
	});
});

describe("premultiplied-alpha composite math (the correctness of `* uColor`)", () => {
	test("componentwise-multiplying two premultiplied RGBA values matches modulating in straight-alpha space first", () => {
		const pathRGB = [0.8, 0.4, 0.2];
		const pathAlpha = 0.6;
		const tintRGB = [0.5, 1, 0.25];
		const groupAlpha = 0.5;

		// the "obviously correct" reference: modulate colour and alpha in
		// straight-alpha space, then premultiply the result
		const expectedRGB = pathRGB.map((c, i) => c * tintRGB[i] * pathAlpha * groupAlpha);
		const expectedAlpha = pathAlpha * groupAlpha;

		// the shader's actual approach: premultiply pathRGB by its own alpha
		// first (unchanged from before the fix), then componentwise-multiply by
		// uColor = (tintRGB * groupAlpha, groupAlpha) -- exactly
		// `vec4(pathCol.rgb * alpha, alpha) * uColor`
		const uColor = { rgb: tintRGB.map((c) => c * groupAlpha), a: groupAlpha };
		const shaderRGB = pathRGB.map((c, i) => c * pathAlpha * uColor.rgb[i]);
		const shaderAlpha = pathAlpha * uColor.a;

		for (let i = 0; i < 3; i++) expect(shaderRGB[i]).toBeCloseTo(expectedRGB[i], 12);
		expect(shaderAlpha).toBeCloseTo(expectedAlpha, 12);
	});
});
