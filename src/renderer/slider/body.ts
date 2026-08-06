// the argon slider body: prepass quads -> max-blend distance texture ->
// lut composite (decision 1; ports path.drawnode.cs + sh_pathprepass.fs +
// sh_path.fs + smoothpath.cs against the pinned framework)

import { Container, Geometry, Mesh, RenderTexture, Shader, Sprite, Texture, type Renderer } from "pixi.js";
import { SLIDER_BODY_ALPHA, SLIDER_PATH_RADIUS } from "../../engine/argon";
import { withAlpha, type Rgba } from "../../engine/color";
import { bakeSliderLut } from "../../engine/slider-lut";
import { pathToProgress } from "../../engine/slider-path";
import type { RenderSlider } from "../../lib/scene-types";
import { buildPathQuads, pathBounds } from "./geometry";

/** osu!px -> distance-texture texels; capped so marathon bodies stay < 2048 */
const SUPERSAMPLE = 2;
const MAX_TEXTURE_DIM = 2048;

// pixi shaders skip `#version 300 es`, which puts them on pixi's own
// portable-source path (glprogram.mjs): `in`/`out` get macro-translated to
// attribute/varying and `finalColor`/`texture` to gl_fragcolor/texture2d
// under webgl1, so this is the same convention pixi's own bundled shaders
// use (eg. filters/defaults/noise/noise.frag) rather than raw gl_FragColor

const PREPASS_VERTEX = `
  in vec2 aPosition;
  in vec2 aStart;
  in vec2 aEnd;
  out vec2 vPos;
  out vec2 vStart;
  out vec2 vEnd;
  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;
  void main() {
    vPos = aPosition;
    vStart = aStart;
    vEnd = aEnd;
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  }
`;

// sh_pathprepass.fs + sh_circularprogressutils.h's dsttoline, verbatim
const PREPASS_FRAGMENT = `
  precision highp float;
  in vec2 vPos;
  in vec2 vStart;
  in vec2 vEnd;
  out vec4 finalColor;
  uniform float uRadius;

  float dstToLine(vec2 start, vec2 end, vec2 pixelPos) {
    vec2 dir = end - start;
    float lineLengthSquared = dir.x * dir.x + dir.y * dir.y;
    if (lineLengthSquared < 0.000001)
      return distance(pixelPos, start);
    vec2 dir2 = pixelPos - start;
    float t = clamp(dot(dir2, dir), 0.0, lineLengthSquared) / lineLengthSquared;
    return distance(pixelPos, start + dir * t);
  }

  void main() {
    float value = clamp(1.0 - dstToLine(vStart, vEnd, vPos) / uRadius, 0.0, 1.0);
    finalColor = vec4(value, 0.0, 0.0, 1.0);
  }
`;

const COMPOSITE_VERTEX = `
  in vec2 aPosition;
  in vec2 aUV;
  out vec2 vUV;
  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;
  void main() {
    vUV = aUV;
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  }
`;

// sh_path.fs: distance value -> lut u; u == 0 is outside the ribbon.
// output premultiplied for pixi's normal blending
//
// uColor is not one of this shader's own `resources` -- it is supplied by
// pixi itself. GlMeshAdaptor.execute() unconditionally binds
// meshPipe.localUniformsBindGroup (uTransformMatrix, uColor, uRound) to this
// mesh's shader regardless of whether the shader is pixi's default or (as
// here) a fully custom one; the vertex shader below already relies on this
// for uTransformMatrix. uColor is mesh.groupColorAlpha (the Container-tree
// tint*alpha, composited by updateRenderGroupTransforms.mjs's
// updateColorBlendVisibility -- the same propagation the prepass's MAX
// blend mode rides) packed premultiplied: `.rgb` is tintRGB*groupAlpha,
// `.a` is groupAlpha (scene/graphics/gpu/colorToUniform.js's
// color32BitToUniform). without reading it here, `view.alpha`/`view.tint`
// (set every frame by the owner) had no effect on the rasterised body at
// all -- the shader multiplies the two premultiplied colours componentwise,
// which is exactly the correct combination for two premultiplied RGBA
// values under a tint+alpha modulation (see task-15's fix report for the
// derivation)
// exported so body.test.ts can pin, by static inspection, that the uColor
// fix (see the comment above) isn't silently reverted -- there is no
// headless way to actually execute this glsl (Shader.from needs a real
// <canvas>) so a source-text regression check is the best available guard
export const COMPOSITE_FRAGMENT = `
  precision highp float;
  in vec2 vUV;
  out vec4 finalColor;
  uniform sampler2D uDistance;
  uniform sampler2D uLut;
  uniform vec4 uColor;
  void main() {
    float dstFromEdge = texture(uDistance, vUV).r;
    vec4 pathCol = texture(uLut, vec2(dstFromEdge, 0.5));
    float alpha = pathCol.a * (dstFromEdge > 0.0 ? 1.0 : 0.0);
    finalColor = vec4(pathCol.rgb * alpha, alpha) * uColor;
  }
`;

export class SliderBodyRenderer {
	readonly view: Sprite;
	private readonly renderer: Renderer;
	private readonly slider: RenderSlider;
	private readonly radius: number;
	private readonly bounds: { minX: number; minY: number; width: number; height: number };
	private readonly target: RenderTexture;
	private readonly lut: Texture;
	private readonly compositeGeometry: Geometry;
	private readonly compositeShader: Shader;
	private readonly compositeMesh: Mesh<Geometry, Shader>;
	private readonly prepassShader: Shader;
	// the prepass mesh is rendered as a child of this root, never as the
	// render root itself -- see setRange() for why
	private readonly prepassRoot = new Container();
	private prepassMesh: Mesh<Geometry, Shader> | null = null;
	private currentRange: [number, number] | null = null;
	/** the un-offset snaked vertex list, exposed for the repeat arrows to aim along */
	private snaked: number[] | null = null;

	/** slider.cs-relative snaked polyline (head-relative, unshifted by bounds) */
	get currentCurve(): number[] | null {
		return this.snaked;
	}

	constructor(renderer: Renderer, slider: RenderSlider, accent: Rgba, csScale: number) {
		this.renderer = renderer;
		this.slider = slider;
		this.radius = SLIDER_PATH_RADIUS * csScale;
		// pinned to the full path once, so the texture never resizes while
		// snaking (snakingsliderbody.cs:150-155)
		this.bounds = pathBounds(slider.vertices, this.radius);

		const scale = Math.min(SUPERSAMPLE, MAX_TEXTURE_DIM / Math.max(this.bounds.width, this.bounds.height, 1));
		// linear, not nearest: the playfield transform + devicePixelRatio almost
		// never lands texels 1:1 on device pixels (eg. 2.25 device px/osu!px at
		// 1920x1080 dpr 1), so nearest replicates the lut's ~2.2-texel aa ramp
		// into blocky 2-5px steps on diagonals. a distance field interpolates
		// exactly, which is the whole point of storing distance instead of colour
		//
		// format left at the default (~8-bit rgba), not path.cs:318's r32float:
		// pixi requests ext_color_buffer_float but never ext_float_blend, and
		// webgl2 makes any blended draw into a 32-bit-float attachment
		// invalid_operation without it -- and the prepass blends. 8-bit distance
		// quantisation (~0.2 osu!px steps) is finer than the lut's own 110-texel
		// resolution, so it's lossless where it matters
		this.target = RenderTexture.create({
			width: Math.max(1, Math.ceil(this.bounds.width * scale)),
			height: Math.max(1, Math.ceil(this.bounds.height * scale)),
			scaleMode: "linear"
		});

		const { width, rgba } = bakeSliderLut(withAlpha(accent, SLIDER_BODY_ALPHA), accent, this.radius);
		// explicit format: bufferimagesource.mjs defaults a raw Uint8Array to
		// bgra8unorm (harmless under webgl, where bgra8unorm and rgba8unorm both
		// map to gl.RGBA with no byte swizzle -- but wgpu does distinguish them,
		// so pin the format bakesliderlut actually writes)
		this.lut = Texture.from({ resource: rgba, width, height: 1, scaleMode: "linear", format: "rgba8unorm" });

		this.prepassShader = Shader.from({
			gl: { vertex: PREPASS_VERTEX, fragment: PREPASS_FRAGMENT },
			resources: { prepassUniforms: { uRadius: { value: this.radius, type: "f32" } } }
		});

		this.compositeGeometry = new Geometry({
			attributes: {
				aPosition: new Float32Array([
					0,
					0,
					this.bounds.width,
					0,
					this.bounds.width,
					this.bounds.height,
					0,
					this.bounds.height
				]),
				aUV: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
			},
			indexBuffer: new Uint32Array([0, 1, 2, 0, 2, 3])
		});
		this.compositeShader = Shader.from({
			gl: { vertex: COMPOSITE_VERTEX, fragment: COMPOSITE_FRAGMENT },
			resources: { uDistance: this.target.source, uLut: this.lut.source }
		});
		this.compositeMesh = new Mesh({ geometry: this.compositeGeometry, shader: this.compositeShader });

		// wrap the mesh in a sprite-like container positioned at the bounds
		// origin; the owner translates/fades/tints this view
		this.view = new Sprite(Texture.EMPTY);
		this.view.addChild(this.compositeMesh);
		this.view.position.set(this.bounds.minX, this.bounds.minY);
	}

	/** re-rasterises the distance field when the snaked range changes */
	setRange(p0: number, p1: number): void {
		if (p0 > p1) [p0, p1] = [p1, p0];
		if (this.currentRange !== null && this.currentRange[0] === p0 && this.currentRange[1] === p1) return;
		this.currentRange = [p0, p1];

		const flat = pathToProgress(this.slider, p0, p1);
		this.snaked = [...flat];
		// shift into texture space (bounds origin at 0,0)
		for (let i = 0; i < flat.length; i += 2) {
			flat[i] -= this.bounds.minX;
			flat[i + 1] -= this.bounds.minY;
		}
		const quads = buildPathQuads(flat, this.radius);

		// detach the stale mesh (if any) before building the new one, so the
		// two are never both children of prepassRoot at once -- otherwise the
		// render() call below would rasterise both into the target
		const staleMesh = this.prepassMesh;
		if (staleMesh !== null) this.prepassRoot.removeChild(staleMesh);

		this.prepassMesh = new Mesh({
			geometry: new Geometry({
				attributes: {
					aPosition: quads.positions,
					aStart: quads.segStarts,
					aEnd: quads.segEnds
				},
				indexBuffer: quads.indices
			}),
			shader: this.prepassShader
		});
		// max-combine keeps the spine-closest fragment: the depth-free
		// anti-double-blend (path.drawnode.cs:63-71)
		this.prepassMesh.blendMode = "max";
		// scale path px -> texture px
		this.prepassMesh.scale.set(this.target.width / this.bounds.width, this.target.height / this.bounds.height);

		// rendered as a child of prepassRoot, never as the render root itself:
		// renderer.render({container}) calls container.enableRenderGroup() on
		// whatever it's given (abstractrenderer.mjs), and meshpipe.mjs reads
		// mesh.groupBlendMode -- which updateRenderGroupTransforms only ever
		// assigns to a render group's children, never to the render group root
		// itself (a root's groupBlendMode is hard-set to "normal" by
		// enableRenderGroup and never revisited). rendering the mesh directly as
		// root left it blended with pixi's default "normal" equation, so
		// max-combine silently never reached the gpu; wrapping it one level
		// deeper is what actually gets blendMode="max" propagated to
		// groupBlendMode. prepassRoot has no scale/position of its own
		// (identity), so this does not change the mesh's rendered transform --
		// verified against pixi's actual transform-propagation code: the same
		// combined uWorldTransformMatrix*uTransformMatrix product results either
		// way, just redistributed between the two uniforms
		this.prepassRoot.addChild(this.prepassMesh);
		this.renderer.render({ container: this.prepassRoot, target: this.target, clear: true });

		// mesh.destroy() never cascades to its geometry (geometry/shader can be
		// shared between meshes in pixi) -- a fresh geometry is built every call
		// above, so its buffers must be freed explicitly or this leaks GPU
		// vertex buffers on every single range update, not just once per slider
		if (staleMesh !== null) {
			staleMesh.geometry.destroy(true);
			staleMesh.destroy();
		}
	}

	destroy(): void {
		// view.destroy({children:true}) recurses into compositeMesh, but (per
		// mesh.destroy()'s own contract) that never frees compositeMesh's
		// geometry or shader -- both are this instance's alone, so they are
		// destroyed explicitly below
		this.view.destroy({ children: true });
		this.compositeGeometry.destroy(true);
		this.compositeShader.destroy();

		if (this.prepassMesh !== null) {
			this.prepassMesh.geometry.destroy(true);
			this.prepassMesh.destroy(); // also detaches it from prepassRoot
		}
		this.prepassRoot.destroy();
		// prepassShader's glProgram is deduplicated by glprogram.from's
		// module-level source-string cache and shared by every slider body on
		// the map -- destroy(true) here would tear down that shared compiled
		// program out from under sliders still alive, so only the per-instance
		// shader wrapper (bind groups) is released
		this.prepassShader.destroy();

		this.target.destroy(true);
		this.lut.destroy(true);
	}
}
