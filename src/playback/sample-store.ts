// decoded hit samples, cached by RESOLVED SOURCE PATH.
//
// the cache key is the file, not the lookup: several lookups legitimately
// resolve to one file (every bank falls back to the same shared sample when a
// tier is missing one, and a suffixed lookup falls back to its unsuffixed
// name), so keying on the lookup would decode the same bytes several times.
//
// fetch and decode are injected, which is what lets `bun test` drive this
// without a webview: the store is the whole policy -- one decode per url,
// failures remembered rather than retried, a byte budget, and a clear on scene
// swap -- and none of that needs a real AudioContext to be worth testing.

/** engine::limits::MAX_SAMPLE_BYTES, mirrored. the engine declares it beside
 * the sample-count cap it works with; this is the decode side that charges it,
 * and the `.osz` extractor charges the same budget on the extract side.
 *
 * decoded PCM runs roughly 10x its compressed size, which is why the budget is
 * counted on decoded bytes rather than on downloaded ones */
export const MAX_SAMPLE_BYTES = 256 * 1024 * 1024;

/** what an AudioBuffer actually costs resident: float32 per sample per
 * channel. `AudioBuffer.length` is per channel, so the product is the whole of
 * it */
export function decodedBytes(buffer: Pick<AudioBuffer, "length" | "numberOfChannels">): number {
	return buffer.length * buffer.numberOfChannels * 4;
}

export interface SampleStoreDeps {
	/** the bytes at a url, or a rejection. the store never retries a rejection */
	fetchBytes(url: string): Promise<ArrayBuffer>;
	decode(bytes: ArrayBuffer): Promise<AudioBuffer>;
}

/** a decode that has been started but not yet committed. `cancelled` is what a
 * scene swap sets: the fetch and the decode cannot be called back, but their
 * RESULT can be refused, which is the part that would otherwise charge the new
 * scene's budget for the old scene's file */
interface PendingLoad {
	promise: Promise<void>;
	cancelled: boolean;
}

export class SampleStore {
	/** url -> its buffer, or null for a url that failed or did not fit. a
	 * remembered null is what stops a missing file being re-fetched once per
	 * object it is asked for */
	private readonly decoded = new Map<string, AudioBuffer | null>();
	private readonly inFlight = new Map<string, PendingLoad>();
	private bytes = 0;

	constructor(
		private readonly deps: SampleStoreDeps,
		private readonly budget = MAX_SAMPLE_BYTES
	) {}

	/** decoded bytes currently held; the budget this charges against */
	get residentBytes(): number {
		return this.bytes;
	}

	/** the buffer for a url if it is already decoded. the scheduler reads only
	 * this: a sample that has not finished decoding by the time its judgement
	 * arrives is silent rather than late, because a hit sound that lands after
	 * the hit is worse than one that does not land */
	get(url: string): AudioBuffer | null {
		return this.decoded.get(url) ?? null;
	}

	/** whether this url has been resolved one way or the other */
	has(url: string): boolean {
		return this.decoded.has(url);
	}

	/**
	 * decode a url once. concurrent callers join the in-flight decode rather
	 * than starting a second one, and a url already decided -- decoded, failed,
	 * or refused for budget -- resolves immediately.
	 *
	 * never rejects: a missing or undecodable sample is a silence, not a load
	 * failure. the scene is still perfectly watchable without it
	 */
	async load(url: string): Promise<void> {
		if (this.decoded.has(url)) return;
		const existing = this.inFlight.get(url);
		if (existing !== undefined) return existing.promise;

		const pending: PendingLoad = { cancelled: false, promise: Promise.resolve() };
		pending.promise = (async () => {
			try {
				const buffer = await this.deps.decode(await this.deps.fetchBytes(url));
				// the scene this was started for is gone: committing now would
				// charge the NEW scene's budget for a file it never asked about,
				// and `clear` has already walked past this url, so nothing would
				// drop it until the swap after next
				if (pending.cancelled) return;
				const cost = decodedBytes(buffer);
				if (this.bytes + cost > this.budget) {
					// refused, and REMEMBERED as refused: retrying every time the
					// sample is asked for would spend the fetch and the decode
					// over and over to reach the same answer
					this.decoded.set(url, null);
					return;
				}
				this.bytes += cost;
				this.decoded.set(url, buffer);
			} catch {
				// a cancelled load leaves no verdict either way: remembering the
				// failure would deny the url to a later scene that does want it
				if (!pending.cancelled) this.decoded.set(url, null);
			} finally {
				// only if this load is still the one on record -- a cancelled
				// load must not evict the fresh one that replaced it
				if (this.inFlight.get(url) === pending) this.inFlight.delete(url);
			}
		})();
		this.inFlight.set(url, pending);
		return pending.promise;
	}

	/** load many, in parallel, ignoring failures -- the eager warm-up path */
	async loadAll(urls: Iterable<string>): Promise<void> {
		await Promise.all([...urls].map((url) => this.load(url)));
	}

	/** drop everything decoded from a scene's own files. the bundled default
	 * set is decoded once at startup and deliberately survives, since it is the
	 * same files for every scene */
	clear(keep: ReadonlySet<string>): void {
		// deleting the entry the iterator is standing on is defined behaviour for
		// a Map -- the walk resumes at the next live entry -- so no snapshot
		for (const [url, buffer] of this.decoded) {
			if (keep.has(url)) continue;
			if (buffer !== null) this.bytes -= decodedBytes(buffer);
			this.decoded.delete(url);
		}
		// the loads still in the air are the other half of a swap. warm-up is
		// fire and forget, so a decode started for the previous scene routinely
		// lands after this and would re-enter the cache behind it -- resident
		// bytes charged to a scene that never asked for them, which is how the
		// budget runs out and the CURRENT scene's samples get refused. a kept
		// url is spared: the bundled set warms once at startup and a scene load
		// arriving mid-warm-up must not cancel it into permanent silence
		for (const [url, pending] of this.inFlight) {
			if (keep.has(url)) continue;
			pending.cancelled = true;
			this.inFlight.delete(url);
		}
	}
}
