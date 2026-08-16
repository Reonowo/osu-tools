// the app's hit-sound singletons and the one place they are wired together.
//
// module singletons for the same reason `playbackClock` is one: there is
// exactly one output device, one decode cache and one currently simulated
// play, and every consumer has to be talking about the same ones. the pieces
// themselves take their dependencies as parameters, so the tests build their
// own rather than reaching for these.

import { audioGraph } from "./audio-graph";
import { HitsoundScheduler } from "./hitsound-scheduler";
import { BUNDLED_SAMPLE_TIERS } from "./sample-manifest";
import { sampleSources, type SampleSource } from "./sample-sources";
import { SampleStore } from "./sample-store";

/** the beatmap's own sample files, when the loaded scene ships any. null until
 * a scene with custom hitsounds installs one; the chain then reads it first */
let beatmapSource: SampleSource | null = null;

export const sampleStore = new SampleStore({
	fetchBytes: async (url) => {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`${response.status} ${url}`);
		return response.arrayBuffer();
	},
	// the graph owns the decode, because it owns the RATE the decode lands at:
	// decoding through the output context would inflate every 44.1kHz sample to
	// whatever the device runs at and spend the byte budget below on the
	// padding (audio-graph.ts's MAX_SAMPLE_DECODE_RATE)
	decode: (bytes) => audioGraph.decodeSample(bytes)
});

export const hitsoundScheduler = new HitsoundScheduler({
	graph: audioGraph,
	store: sampleStore,
	// read live rather than captured: the beatmap source appears and vanishes
	// with the scene, and the scheduler must not hold a stale list across a
	// swap
	sources: () => sampleSources(beatmapSource)
});

export function setBeatmapSampleSource(source: SampleSource | null): void {
	beatmapSource = source;
}

/** every url the bundled default set can resolve to. decoded eagerly at
 * startup and never cleared: it is the same handful of files for every scene,
 * and a hit sound that has to wait for a fetch is a hit sound that arrives
 * after its hit */
export function bundledSampleUrls(): string[] {
	const urls: string[] = [];
	for (const tier of BUNDLED_SAMPLE_TIERS) {
		for (const [stem, extension] of Object.entries(tier.files)) {
			urls.push(`/samples/${tier.dir}/${stem}${extension}`);
		}
	}
	return urls;
}

/** the urls the eager warm-up must not drop on a scene swap */
export function bundledSampleUrlSet(): ReadonlySet<string> {
	return new Set(bundledSampleUrls());
}

/**
 * decode the bundled set once, at app start.
 *
 * the continuous loops (`sliderslide`, `sliderwhistle`, `spinnerspin`) are
 * vendored but never scheduled, so they are skipped here -- decoding several
 * megabytes of sound the app cannot play would spend the byte budget on
 * silence. resolving them stays possible the moment loops land, since the
 * chain reads the manifest rather than this list
 */
export async function warmBundledSamples(): Promise<void> {
	const playable = bundledSampleUrls().filter((url) => !/slider(slide|whistle)|spinnerspin/.test(url));
	await sampleStore.loadAll(playable);
}
