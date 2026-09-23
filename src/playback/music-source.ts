// what the music element loads for a scene's audio file. an mp3 is read
// whole and repackaged (mp3-remux.ts) so that a seek lands where it says it
// does; a file of any other name is never read at all, and any mp3 the
// repackaging declines, any mp3 too large to hold, any read that fails and
// any read its scene outlived plays from the asset url exactly as it always
// has, since the element reports its own load errors and a failed read must
// not become a silent scene

import { remuxMp3 } from "./mp3-remux";

export interface MusicSource {
	readonly url: string;
	/** frees whatever the url holds. the element must be done with it */
	release(): void;
}

export interface MusicSourceDeps {
	/** the whole file, or null -- without reading it -- when its stated size
	 * is over `maxBytes` */
	readBytes(url: string, signal: AbortSignal, maxBytes: number): Promise<Uint8Array | null>;
	createObjectUrl(blob: Blob): string;
	revokeObjectUrl(url: string): void;
}

const browserDeps: MusicSourceDeps = {
	readBytes: async (url, signal, maxBytes) => {
		// tauri's asset protocol reads a whole file into memory before it
		// answers a GET, but answers a HEAD from the file's metadata alone
		// (tauri/src/protocol/asset.rs), so the size is asked for first
		const head = await fetch(url, { method: "HEAD", signal });
		if (!head.ok) throw new Error(`audio read failed: ${head.status}`);
		const statedLength = head.headers.get("content-length");
		if (statedLength !== null && Number(statedLength) > maxBytes) return null;
		const response = await fetch(url, { signal });
		if (!response.ok) throw new Error(`audio read failed: ${response.status}`);
		return new Uint8Array(await response.arrayBuffer());
	},
	createObjectUrl: (blob) => URL.createObjectURL(blob),
	revokeObjectUrl: (url) => URL.revokeObjectURL(url)
};

/** the remux declines every other format, so reading one whole first would
 * only hold the element back and the file in memory. the name survives
 * convertFileSrc, which percent-encodes the path but never a dot or a letter */
const MP3_NAME = /\.mp3$/i;

/** the largest file repackaged; past it the element streams the file as it
 * is. the read, the mp4 and the blob's own copy are alive at once, so the
 * peak is about three times this -- for a song of some 45 minutes at 192kbps,
 * or 28 at 320 */
export const MAX_REMUX_BYTES = 64 * 1024 * 1024;

/** `signal` aborts once the scene that asked is gone: the read stops and
 * nothing is repackaged */
export async function openMusicSource(
	assetUrl: string,
	signal: AbortSignal,
	deps: MusicSourceDeps = browserDeps
): Promise<MusicSource> {
	const asIs: MusicSource = { url: assetUrl, release: () => {} };
	if (!MP3_NAME.test(assetUrl)) return asIs;
	let mp4: Uint8Array<ArrayBuffer> | null;
	try {
		const bytes = await deps.readBytes(assetUrl, signal, MAX_REMUX_BYTES);
		// a size the response never stated is only known once read, and still
		// spares the remux and the blob
		if (signal.aborted || bytes === null || bytes.byteLength > MAX_REMUX_BYTES) return asIs;
		mp4 = remuxMp3(bytes);
	} catch {
		return asIs;
	}
	if (mp4 === null) return asIs;
	const url = deps.createObjectUrl(new Blob([mp4], { type: "audio/mp4" }));
	return { url, release: () => deps.revokeObjectUrl(url) };
}
