// the skin's own texture cache, and the deliberate reason it is not the one in
// `textures.ts`.
//
// that module bakes PROCEDURAL art at a quantised density bucket and rebakes it
// when the zoom moves, keying and evicting by bucket. a legacy skin's asset is a
// fixed-resolution file: rebaking is meaningless, and running one through the
// bucket would evict and re-decode real files on every zoom step -- a user
// inspecting a moment closely would watch their own skin get slower and no
// sharper. so skin textures get their own cache, keyed on the SKIN and the
// file, and evicted when the skin changes rather than when the zoom does.
//
// `@2x` is not handled here at all: the lookup already carried a resolution
// factor out (`ResolvedTexture.resolutionFactors`), exactly as the procedural
// textures carry one, and the draw site divides by it. a texture is stored at
// whatever size its file is

import { Assets, Texture } from "pixi.js";
import type { SkinLocator } from "@/lib/scene-types";

/**
 * which skin a cached texture belongs to.
 *
 * the kind is part of the key, not just the path: a folder skin and a stable
 * one under the same directory are two selections, and a re-import replaces a
 * skin's files in place under an unchanged path. keying on the path alone would
 * hand back the old files after a re-import, which is exactly the case a user
 * re-picks a skin to fix
 */
export function skinCacheKey(locator: SkinLocator): string {
	return locator.kind === "bundled" ? "bundled" : `${locator.kind}:${locator.path.toLowerCase()}`;
}

/**
 * drops every skin but `keep`.
 *
 * pure over the map it is given, which is what makes the eviction policy
 * testable without a gpu -- the same split `evictStaleBuckets` already makes.
 * eviction is per SKIN and never per bucket: a zoom must not cost a re-decode
 */
export function evictOtherSkins<T>(entries: Map<string, T>, keep: string): void {
	for (const key of entries.keys()) {
		if (key !== keep) entries.delete(key);
	}
}

/** what a drawable needs from the store: one already-loaded texture, or null
 * when the url was never loaded. injected into the render context rather than
 * imported, so a drawable test can answer without pixi */
export type SkinTextureLookup = (url: string) => Texture | null;

export interface SkinTextureStore {
	/**
	 * loads every url, in parallel, and returns once they are ALL resident.
	 *
	 * this is what makes the atomic swap possible: skin textures load
	 * asynchronously, unlike anything else in the renderer's rebuild path, so
	 * the caller awaits the whole set and publishes once. a per-texture
	 * progressive swap is rejected -- it momentarily produces exactly the mixed
	 * look the classic floor exists to prevent.
	 *
	 * what a re-install of the SAME skin cannot do yet is pick up files edited
	 * in place: the cache (this one and pixi's, both url-keyed) hands the old
	 * decode back, and dropping it before the reload would destroy textures the
	 * published drawables still render. see TODO.md's skin re-select entry
	 */
	install(skin: string, urls: Iterable<string>): Promise<void>;
	/** the lookup handed to the drawables */
	lookup: SkinTextureLookup;
	/** frees every texture of every skin. only the renderer's own teardown */
	destroy(): void;
}

/** a url that failed to load. cached as a MISS rather than retried, so a
 * corrupt file in a skin costs one failed fetch instead of one per rebuild */
const FAILED = Symbol("failed");

/**
 * the store, over an injected loader and unloader.
 *
 * both are parameters for the same reason the clock takes `now()`: the policy
 * above is worth covering headlessly and pixi's asset pipeline needs a gpu.
 *
 * the UNLOADER is why releasing is not simply `texture.destroy()`. pixi's
 * `Assets` keeps its own cache keyed on the url, so a texture destroyed behind
 * its back leaves a destroyed object in that cache -- and re-selecting the skin
 * later would be handed it straight back. `Assets.unload` destroys the texture
 * AND drops the cache entry, which is the only pairing that survives a user
 * switching away from a skin and back
 */
export function createSkinTextureStore(
	// resolution pinned to 1: pixi parses `@2x` out of a url on its own, and the
	// floor's `/skins/legacy/*@2x.png` urls would otherwise arrive pre-halved --
	// while the tauri asset urls (whose `@` is percent-encoded) would not,
	// splitting one skin's sizing by which tier answered. the lookup already
	// carries the factor out (`ResolvedTexture.resolutionFactors`) and the draw
	// site divides exactly once
	load: (url: string) => Promise<Texture> = (url) => Assets.load<Texture>({ src: url, data: { resolution: 1 } }),
	unload: (url: string) => void = (url) => void Assets.unload(url)
): SkinTextureStore {
	/** skin key -> url -> texture (or the failure marker) */
	const bySkin = new Map<string, Map<string, Texture | typeof FAILED>>();
	let current = "";
	/** bumped by every install (and by destroy), so an install that has awaited
	 * its loads can tell whether it is still the newest request. a superseded
	 * install must not commit: its eviction would run AFTER the winner's and
	 * unload the very textures the winner just published */
	let generation = 0;
	/** the newest install's full url set. an abandoning install leaves these
	 * alone even when nothing committed holds them yet: pixi's loader dedupes
	 * by url, so the winner may be awaiting the very same texture object */
	let latestRequested = new Set<string>();

	const release = (skin: string): void => {
		for (const [url, entry] of bySkin.get(skin) ?? []) {
			// released outright, unlike the procedural cache's eviction: nothing
			// else holds a skin texture, and a skin change has already rebuilt
			// every drawable that could have been drawing one. the procedural cache
			// cannot do this because a drawable baked two buckets ago may still be
			// on screen
			if (entry !== FAILED) unload(url);
		}
	};

	const resident = (url: string): boolean => {
		for (const textures of bySkin.values()) {
			const entry = textures.get(url);
			if (entry !== undefined && entry !== FAILED) return true;
		}
		return false;
	};

	return {
		async install(skin, urls) {
			const thisGeneration = ++generation;
			const requested = new Set(urls);
			latestRequested = requested;
			const held = bySkin.get(skin);
			const wanted = [...requested].filter((url) => !(held?.has(url) ?? false));
			const loaded = new Map<string, Texture | typeof FAILED>();
			await Promise.all(
				wanted.map(async (url) => {
					try {
						loaded.set(url, await load(url));
					} catch {
						// a missing or corrupt file is an ordinary lookup miss, not a
						// failure of the skin: the element simply draws nothing, the
						// same posture a stale locator gets
						loaded.set(url, FAILED);
					}
				})
			);
			if (thisGeneration !== generation) {
				// a newer install (or destroy) landed while these files loaded.
				// committing now would evict what it published, so this one
				// abandons instead: whatever it decoded is released, except urls
				// the surviving maps or the newest request still claim
				for (const [url, entry] of loaded) {
					if (entry !== FAILED && !latestRequested.has(url) && !resident(url)) unload(url);
				}
				return;
			}
			const textures = held ?? new Map<string, Texture | typeof FAILED>();
			for (const [url, entry] of loaded) textures.set(url, entry);
			// urls the new resolution no longer names are released too: the
			// beatmap's own art rides the active skin's key, so browsing replays
			// without a skin change would otherwise grow this map by every
			// map's decoded files
			for (const [url, entry] of textures) {
				if (requested.has(url)) continue;
				if (entry !== FAILED) unload(url);
				textures.delete(url);
			}
			bySkin.set(skin, textures);
			current = skin;
			// evicted only once the new skin is fully resident, so the previous
			// skin is still drawable for every frame between the request and the
			// swap. urls the winner also holds are skipped: the beatmap's art and
			// the classic floor ride EVERY skin's request set, and pixi hands the
			// same url back as the same texture object -- unloading it here would
			// leave the new bundle rendering a destroyed texture
			for (const [key, entries] of bySkin) {
				if (key === skin) continue;
				for (const [url, entry] of entries) {
					const kept = textures.get(url);
					if (entry !== FAILED && (kept === undefined || kept === FAILED)) unload(url);
				}
			}
			evictOtherSkins(bySkin, skin);
		},
		lookup(url) {
			const entry = bySkin.get(current)?.get(url);
			return entry === undefined || entry === FAILED ? null : entry;
		},
		destroy() {
			// the bump makes any in-flight install abandon rather than repopulate
			// a store whose renderer is gone
			generation += 1;
			latestRequested = new Set();
			for (const key of bySkin.keys()) release(key);
			bySkin.clear();
			current = "";
		}
	};
}
