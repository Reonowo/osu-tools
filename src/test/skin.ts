// a skin manifest built for a test, and the file map to go with it.
//
// this lives beside `scene.ts` for the same reason that does: the shape is the
// wire's, so a change to `SkinManifest` should break one builder rather than
// every suite that names a skin. the defaults are the "declared nothing" skin
// -- every config field null -- so a test that cares about one key sets that
// key and nothing else

import type { Texture } from "pixi.js";
import type { SkinConfigDto, SkinManifest } from "@/lib/scene-types";
import { ALL_PIECES_ENABLED, resolvePieces, type PiecePreferences, type SkinPieces } from "@/skin/pieces";
import { BUNDLED_SKIN, type TextureSource } from "@/skin/texture-sources";

/** every field null: what a skin.ini that declared nothing decodes to */
export const NO_SKIN_CONFIG: SkinConfigDto = {
	version: 2.7,
	isLatestVersion: true,
	comboColours: [],
	sliderBorder: null,
	sliderTrackOverride: null,
	sliderBall: null,
	spinnerBackground: null,
	animationFramerate: null,
	layeredHitSounds: null,
	allowSliderBallTint: null,
	comboPrefix: null,
	comboOverlap: null,
	hitCirclePrefix: null,
	hitCircleOverlap: null,
	cursorCentre: null,
	cursorExpand: null,
	cursorRotate: null,
	cursorTrailRotate: null,
	hitCircleOverlayAboveNumber: null,
	spinnerFrequencyModulate: null,
	spinnerNoBlink: null,
	settings: {}
};

export function testSkin(files: Record<string, string> = {}, options: Partial<SkinManifest> = {}): SkinManifest {
	return {
		locator: { kind: "folder", path: "C:\\skin" },
		name: "Test Skin",
		author: "nobody",
		source: "folder",
		era: "legacy",
		files,
		blank: [],
		...options,
		config: { ...NO_SKIN_CONFIG, ...options.config },
		fellBack: options.fellBack ?? null
	};
}

/** a file map whose values are the absolute paths a real manifest carries */
export function skinFiles(...names: string[]): Record<string, string> {
	return Object.fromEntries(names.map((name) => [name, `C:\\skin\\${name}`]));
}

export const testToUrl = (path: string): string => `asset://${path}`;

/** the three skin fields a `RenderContext` carries, for a drawable test that
 * is not about the skin at all. defaults to the bundled default -- argon, all
 * procedural, nothing loaded -- which is what every drawable test drew against
 * before a skin could be selected */
export function testSkinContext(
	skin: SkinManifest = BUNDLED_SKIN,
	sources: readonly TextureSource[] = [],
	prefs: PiecePreferences = ALL_PIECES_ENABLED
): { skin: SkinManifest; pieces: SkinPieces; skinTexture: (url: string) => Texture | null } {
	return {
		skin,
		pieces: resolvePieces({ skin, sources, prefs }),
		// a drawable test has no gpu, so a textured spec draws nothing rather
		// than throwing -- exactly what a file that failed to load does
		skinTexture: () => null
	};
}
