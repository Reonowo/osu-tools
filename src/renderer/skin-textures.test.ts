import { describe, expect, test } from "bun:test";
import type { Texture } from "pixi.js";
import { createSkinTextureStore, evictOtherSkins, skinCacheKey } from "./skin-textures";

/** a stand-in for a pixi texture: the store only ever holds one and hands it
 * back, and everything it does to release one goes through the injected
 * unloader, so nothing about the object itself is observed */
function fakeTexture(url: string): Texture {
	return { url } as unknown as Texture;
}

describe("the cache key names the skin, not just its path", () => {
	test("a folder skin and a stable skin under one path are two keys", () => {
		expect(skinCacheKey({ kind: "folder", path: "C:\\skins\\mine" })).not.toBe(
			skinCacheKey({ kind: "stable", path: "C:\\skins\\mine" })
		);
	});

	test("the path is compared case-insensitively, as every other path here is", () => {
		expect(skinCacheKey({ kind: "folder", path: "C:\\Skins\\Mine" })).toBe(
			skinCacheKey({ kind: "folder", path: "c:\\skins\\mine" })
		);
	});

	test("the bundled default has one key and no path", () => {
		expect(skinCacheKey({ kind: "bundled" })).toBe("bundled");
	});
});

describe("eviction is per skin, never per density bucket", () => {
	test("everything but the kept skin goes", () => {
		const entries = new Map([
			["a", 1],
			["b", 2],
			["c", 3]
		]);
		evictOtherSkins(entries, "b");
		expect([...entries.keys()]).toEqual(["b"]);
	});

	test("keeping a skin that is not there empties the map rather than throwing", () => {
		const entries = new Map([["a", 1]]);
		evictOtherSkins(entries, "z");
		expect(entries.size).toBe(0);
	});
});

describe("the store", () => {
	test("loads every url before it answers any of them", async () => {
		const loaded: string[] = [];
		const store = createSkinTextureStore(async (url) => {
			loaded.push(url);
			return fakeTexture(url);
		});
		const install = store.install("skin-a", ["one.png", "two.png"]);
		// nothing is answerable until the whole set is resident: that is what
		// makes the swap atomic rather than progressive
		expect(store.lookup("one.png")).toBeNull();
		await install;
		expect(loaded.sort()).toEqual(["one.png", "two.png"]);
		expect(store.lookup("one.png")).not.toBeNull();
		expect(store.lookup("two.png")).not.toBeNull();
	});

	test("a second install of the same skin does not re-decode what it already holds", async () => {
		let loads = 0;
		const store = createSkinTextureStore(async (url) => {
			loads += 1;
			return fakeTexture(url);
		});
		await store.install("skin-a", ["one.png"]);
		await store.install("skin-a", ["one.png", "two.png"]);
		expect(loads).toBe(2);
	});

	test("a zoom cannot re-decode anything, because nothing here is keyed on a bucket", async () => {
		let loads = 0;
		const store = createSkinTextureStore(async (url) => {
			loads += 1;
			return fakeTexture(url);
		});
		await store.install("skin-a", ["one.png"]);
		// the renderer re-installs the same skin on every rebuild, which is what
		// a density move triggers. the file must not be fetched again
		await store.install("skin-a", ["one.png"]);
		await store.install("skin-a", ["one.png"]);
		expect(loads).toBe(1);
	});

	test("a skin change frees the previous skin's textures through the unloader", async () => {
		// through the UNLOADER rather than by destroying the texture: pixi's own
		// Assets cache is keyed on the url, and a texture destroyed behind its
		// back would be handed straight back on the next load of the same file
		const unloaded: string[] = [];
		const store = createSkinTextureStore(
			async (url) => fakeTexture(url),
			(url) => unloaded.push(url)
		);
		await store.install("skin-a", ["one.png"]);
		await store.install("skin-b", ["two.png"]);
		expect(unloaded).toEqual(["one.png"]);
		expect(store.lookup("one.png")).toBeNull();
		expect(store.lookup("two.png")).not.toBeNull();
	});

	test("switching away from a skin and back re-loads it rather than reusing a freed texture", async () => {
		const loads: string[] = [];
		const store = createSkinTextureStore(
			async (url) => {
				loads.push(url);
				return fakeTexture(url);
			},
			() => {}
		);
		await store.install("skin-a", ["one.png"]);
		await store.install("skin-b", ["two.png"]);
		await store.install("skin-a", ["one.png"]);
		expect(loads).toEqual(["one.png", "two.png", "one.png"]);
		expect(store.lookup("one.png")).not.toBeNull();
	});

	test("a file that fails to load is a miss, not a thrown install", async () => {
		const store = createSkinTextureStore(
			async (url) => {
				if (url === "broken.png") throw new Error("corrupt");
				return fakeTexture(url);
			},
			() => {}
		);
		await store.install("skin-a", ["broken.png", "fine.png"]);
		expect(store.lookup("broken.png")).toBeNull();
		expect(store.lookup("fine.png")).not.toBeNull();
	});

	test("a failure is remembered rather than retried on every rebuild", async () => {
		let attempts = 0;
		const store = createSkinTextureStore(async () => {
			attempts += 1;
			throw new Error("corrupt");
		});
		await store.install("skin-a", ["broken.png"]);
		await store.install("skin-a", ["broken.png"]);
		expect(attempts).toBe(1);
	});

	test("a url shared with the previous skin survives its eviction", async () => {
		// the beatmap's art and the classic floor ride EVERY skin's request
		// set, and pixi's url-keyed loader hands both skins the same texture
		// object -- evicting the old skin must not destroy what the new one
		// just published
		const unloaded: string[] = [];
		const store = createSkinTextureStore(
			async (url) => fakeTexture(url),
			(url) => unloaded.push(url)
		);
		await store.install("skin-a", ["floor.png", "a.png"]);
		await store.install("skin-b", ["floor.png", "b.png"]);
		expect(unloaded).toEqual(["a.png"]);
		expect(store.lookup("floor.png")).not.toBeNull();
		expect(store.lookup("b.png")).not.toBeNull();
	});

	test("a superseded install never evicts what the newer one published", async () => {
		// skin a's file loads slowly; skin b is requested meanwhile and lands
		// first. a finishing late must abandon rather than commit -- its
		// eviction would run AFTER b's and unload the textures b just published
		const unloaded: string[] = [];
		let releaseA = () => {};
		const store = createSkinTextureStore(
			async (url) => {
				if (url === "a.png") await new Promise<void>((resolve) => (releaseA = resolve));
				return fakeTexture(url);
			},
			(url) => unloaded.push(url)
		);
		const stale = store.install("skin-a", ["a.png"]);
		await store.install("skin-b", ["b.png"]);
		releaseA();
		await stale;
		expect(store.lookup("b.png")).not.toBeNull();
		expect(unloaded).not.toContain("b.png");
		// the loser's own decode is released rather than leaked
		expect(unloaded).toContain("a.png");
	});

	test("urls the new resolution no longer names are released", async () => {
		// the beatmap's own art rides the active skin's key, so without the
		// prune, browsing replays without a skin change would grow the map by
		// every map's decoded files
		const unloaded: string[] = [];
		const store = createSkinTextureStore(
			async (url) => fakeTexture(url),
			(url) => unloaded.push(url)
		);
		await store.install("skin-a", ["map1-hitcircle.png", "cursor.png"]);
		await store.install("skin-a", ["map2-hitcircle.png", "cursor.png"]);
		expect(unloaded).toEqual(["map1-hitcircle.png"]);
		expect(store.lookup("map1-hitcircle.png")).toBeNull();
		expect(store.lookup("cursor.png")).not.toBeNull();
	});

	test("destroy frees everything and answers nothing afterwards", async () => {
		const unloaded: string[] = [];
		const store = createSkinTextureStore(
			async (url) => fakeTexture(url),
			(url) => unloaded.push(url)
		);
		await store.install("skin-a", ["one.png"]);
		store.destroy();
		expect(unloaded).toEqual(["one.png"]);
		expect(store.lookup("one.png")).toBeNull();
	});
});
