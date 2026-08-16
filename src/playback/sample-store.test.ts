import { describe, expect, test } from "bun:test";
import { decodedBytes, MAX_SAMPLE_BYTES, SampleStore, type SampleStoreDeps } from "./sample-store";

/** an AudioBuffer's two fields the store reads. bun has no AudioBuffer, and
 * the store deliberately depends on nothing else about one */
function buffer(length: number, numberOfChannels = 2): AudioBuffer {
	return { length, numberOfChannels } as AudioBuffer;
}

function deps(over: Partial<SampleStoreDeps> = {}) {
	const fetches: string[] = [];
	const decodes: number[] = [];
	const base: SampleStoreDeps = {
		fetchBytes: async (url) => {
			fetches.push(url);
			return new ArrayBuffer(8);
		},
		decode: async () => {
			decodes.push(1);
			return buffer(1000);
		}
	};
	return { deps: { ...base, ...over }, fetches, decodes };
}

describe("decodedBytes", () => {
	test("is float32 per sample per channel", () => {
		expect(decodedBytes(buffer(1000, 2))).toBe(8000);
		expect(decodedBytes(buffer(1000, 1))).toBe(4000);
	});
});

describe("SampleStore", () => {
	test("decodes a url once however many times it is asked for", () => {
		// the case this exists for: several lookups legitimately resolve to one
		// file -- every bank falls back to the same shared sample when a tier
		// is missing one -- and each object asks again
		const { deps: d, fetches, decodes } = deps();
		const store = new SampleStore(d);
		return Promise.all([store.load("a.wav"), store.load("a.wav"), store.load("a.wav")]).then(async () => {
			await store.load("a.wav");
			expect(fetches).toEqual(["a.wav"]);
			expect(decodes).toHaveLength(1);
			expect(store.get("a.wav")).not.toBeNull();
		});
	});

	test("a failure is remembered, not retried", () => {
		// a missing sample is a silence, never a load failure -- and asking for
		// it once per object it appears on would spend a fetch every time to
		// reach the same answer
		let attempts = 0;
		const { deps: d } = deps({
			fetchBytes: async () => {
				attempts += 1;
				throw new Error("404");
			}
		});
		const store = new SampleStore(d);
		return store
			.load("missing.wav")
			.then(() => store.load("missing.wav"))
			.then(() => {
				expect(attempts).toBe(1);
				expect(store.get("missing.wav")).toBeNull();
				expect(store.has("missing.wav")).toBe(true);
			});
	});

	test("load never rejects, whatever the deps do", async () => {
		const { deps: d } = deps({ decode: async () => Promise.reject(new Error("undecodable")) });
		const store = new SampleStore(d);
		await expect(store.load("bad.wav")).resolves.toBeUndefined();
	});

	test("charges decoded bytes against the budget and refuses past it", async () => {
		// engine::limits::MAX_SAMPLE_BYTES on the decode side. the refusal is
		// remembered like a failure, for the same reason
		const { deps: d } = deps({ decode: async () => buffer(1000) }); // 8000 bytes
		const store = new SampleStore(d, 20_000);
		await store.loadAll(["a.wav", "b.wav", "c.wav"]);
		expect(store.residentBytes).toBe(16_000);
		// the third did not fit and is remembered as refused rather than retried
		expect(store.get("c.wav")).toBeNull();
		expect(store.has("c.wav")).toBe(true);
	});

	test("the real budget is the engine's, mirrored", () => {
		expect(MAX_SAMPLE_BYTES).toBe(256 * 1024 * 1024);
	});

	test("clearing a scene drops its samples and keeps the bundled ones", async () => {
		// the bundled default set is the same files for every scene and is
		// decoded once at startup; a beatmap's own files belong to their scene
		const { deps: d } = deps({ decode: async () => buffer(1000) });
		const store = new SampleStore(d);
		await store.loadAll(["/samples/Gameplay/ArgonPro/normal-hitnormal.wav", "map/custom.wav"]);
		expect(store.residentBytes).toBe(16_000);

		store.clear(new Set(["/samples/Gameplay/ArgonPro/normal-hitnormal.wav"]));
		expect(store.get("map/custom.wav")).toBeNull();
		expect(store.has("map/custom.wav")).toBe(false);
		expect(store.get("/samples/Gameplay/ArgonPro/normal-hitnormal.wav")).not.toBeNull();
		// the budget is released with the buffers, or a long session of scene
		// swaps would exhaust it without ever holding that much at once
		expect(store.residentBytes).toBe(8000);
	});

	test("A DECODE THAT LANDS AFTER ITS SCENE IS GONE DOES NOT RE-ENTER THE CACHE", async () => {
		// the warm-up is fire and forget, so a swap routinely happens with the
		// previous map's decodes still in the air. if one commits behind
		// `clear`, its bytes are charged to a scene that never asked for them
		// and nothing drops them until the swap AFTER next -- which is how the
		// budget runs out and the CURRENT scene's samples go silent
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { deps: d } = deps({
			decode: async () => {
				await gate;
				return buffer(1000);
			}
		});
		const store = new SampleStore(d);
		const pending = store.load("old-scene/custom.wav");

		store.clear(new Set());
		release();
		await pending;

		expect(store.has("old-scene/custom.wav")).toBe(false);
		expect(store.residentBytes).toBe(0);
	});

	test("a cancelled load leaves no verdict, so the next scene can still ask for it", async () => {
		// remembering a cancelled load as a failure would be worse than the race
		// it fixed: the url would be denied for the rest of the session
		let attempts = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { deps: d } = deps({
			decode: async () => {
				attempts += 1;
				if (attempts === 1) await gate;
				return buffer(1000);
			}
		});
		const store = new SampleStore(d);
		const pending = store.load("shared.wav");
		store.clear(new Set());
		release();
		await pending;

		await store.load("shared.wav");
		expect(attempts).toBe(2);
		expect(store.get("shared.wav")).not.toBeNull();
		expect(store.residentBytes).toBe(8000);
	});

	test("clearing does not cancel a bundled load still warming up", async () => {
		// the bundled set warms once at startup; a scene load arriving mid
		// warm-up must not turn it into permanent silence, since nothing warms
		// it a second time
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { deps: d } = deps({
			decode: async () => {
				await gate;
				return buffer(1000);
			}
		});
		const store = new SampleStore(d);
		const bundled = "/samples/Gameplay/Argon/combobreak.wav";
		const pending = store.load(bundled);

		store.clear(new Set([bundled]));
		release();
		await pending;

		expect(store.get(bundled)).not.toBeNull();
		expect(store.residentBytes).toBe(8000);
	});
});
