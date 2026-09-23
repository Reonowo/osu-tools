import { describe, expect, test } from "bun:test";
import { MAX_REMUX_BYTES, openMusicSource, type MusicSourceDeps } from "./music-source";

/** 128kbps mpeg-1 layer iii frames at 44.1k, back to back. the default four
 * are enough for the remux */
function mp3(length = 4 * 417): Uint8Array {
	const out = new Uint8Array(length);
	for (let at = 0; at + 4 <= length; at += 417) out.set([0xff, 0xfb, 0x90, 0x40], at);
	return out;
}

function deps(read: () => Promise<Uint8Array | null>) {
	const created: Blob[] = [];
	const revoked: string[] = [];
	const reads: { url: string; maxBytes: number }[] = [];
	const injected: MusicSourceDeps = {
		readBytes: (url, _signal, maxBytes) => {
			reads.push({ url, maxBytes });
			return read();
		},
		createObjectUrl: (blob) => {
			created.push(blob);
			return `blob:music-${created.length}`;
		},
		revokeObjectUrl: (url) => revoked.push(url)
	};
	return { injected, created, revoked, reads };
}

const live = () => new AbortController().signal;

describe("openMusicSource", () => {
	test("an mp3 plays from a repackaged mp4 blob, released on request", async () => {
		const { injected, created, revoked } = deps(async () => mp3());
		const source = await openMusicSource("asset://song.mp3", live(), injected);
		expect(source.url).toBe("blob:music-1");
		expect(created[0].type).toBe("audio/mp4");
		source.release();
		expect(revoked).toEqual(["blob:music-1"]);
	});

	test("the mp3 name is matched whatever its case", async () => {
		const { injected } = deps(async () => mp3());
		expect((await openMusicSource("asset://SONG.MP3", live(), injected)).url).toBe("blob:music-1");
	});

	test("a file of any other name plays from the asset url and is never read", async () => {
		const { injected, reads, created } = deps(async () => mp3());
		const source = await openMusicSource("asset://song.ogg", live(), injected);
		expect(source.url).toBe("asset://song.ogg");
		expect(reads).toHaveLength(0);
		expect(created).toHaveLength(0);
	});

	test("an .mp3 the remux declines plays from the asset url", async () => {
		const ogg = new Uint8Array(64);
		ogg.set([0x4f, 0x67, 0x67, 0x53], 0);
		const { injected, created } = deps(async () => ogg);
		const source = await openMusicSource("asset://song.mp3", live(), injected);
		expect(source.url).toBe("asset://song.mp3");
		expect(created).toHaveLength(0);
		source.release();
	});

	test("a file stated over the cap is turned away before its body", async () => {
		const { injected, reads, created } = deps(async () => null);
		const source = await openMusicSource("asset://song.mp3", live(), injected);
		expect(reads).toEqual([{ url: "asset://song.mp3", maxBytes: MAX_REMUX_BYTES }]);
		expect(source.url).toBe("asset://song.mp3");
		expect(created).toHaveLength(0);
	});

	test("a file whose size was never stated is not repackaged past the cap", async () => {
		const { injected, created } = deps(async () => mp3(MAX_REMUX_BYTES + 1));
		const source = await openMusicSource("asset://song.mp3", live(), injected);
		expect(source.url).toBe("asset://song.mp3");
		expect(created).toHaveLength(0);
	});

	test("a failed read falls back to the asset url rather than to silence", async () => {
		const { injected } = deps(async () => {
			throw new Error("scope denied");
		});
		expect((await openMusicSource("asset://song.mp3", live(), injected)).url).toBe("asset://song.mp3");
	});

	test("a read its scene outlived is never repackaged", async () => {
		const scene = new AbortController();
		const { injected, created } = deps(async () => {
			scene.abort();
			return mp3();
		});
		const source = await openMusicSource("asset://song.mp3", scene.signal, injected);
		expect(source.url).toBe("asset://song.mp3");
		expect(created).toHaveLength(0);
	});
});
