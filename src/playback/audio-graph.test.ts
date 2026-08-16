// the one decision in audio-graph.ts that needs no AudioContext: what rate hit
// samples decode at. the graph itself is outside `bun test` like Pixi's render
// path, but this number decides whether a map's hit sounds survive the byte
// budget at all, so it is tested rather than trusted.

import { describe, expect, test } from "bun:test";
import { MAX_SAMPLE_DECODE_RATE, sampleDecodeRate } from "./audio-graph";

describe("sampleDecodeRate", () => {
	test("caps a high-rate output device rather than following it", () => {
		// the bug this exists for: `decodeAudioData` resamples into whichever
		// context decodes, so a 192kHz device inflated every 44.1kHz hit sample
		// more than fourfold and blew the decoded-byte budget -- 405MB against a
		// 256MiB cap on one real map, which silently dropped 64 of its 215 sample
		// files for the whole session
		expect(sampleDecodeRate(192000)).toBe(MAX_SAMPLE_DECODE_RATE);
		expect(sampleDecodeRate(96000)).toBe(MAX_SAMPLE_DECODE_RATE);
	});

	test("a device below the cap decodes natively instead of being upsampled to it", () => {
		// meeting the cap from underneath would spend memory to add nothing: the
		// files are 44.1kHz to begin with
		expect(sampleDecodeRate(44100)).toBe(44100);
		expect(sampleDecodeRate(22050)).toBe(22050);
	});

	test("the cap is at or above every rate a hit sample carries content at", () => {
		// hit samples are 44.1kHz files; 48k's Nyquist is 24kHz, so nothing
		// audible is lost, and lowering this below 44.1k would start to
		expect(MAX_SAMPLE_DECODE_RATE).toBeGreaterThanOrEqual(44100);
	});

	test("a nonsense rate falls back to the cap rather than to zero or NaN", () => {
		// an OfflineAudioContext built at 0 or NaN throws, and the decode path
		// treats a throw as a silent sample -- the whole map would go quiet
		expect(sampleDecodeRate(0)).toBe(MAX_SAMPLE_DECODE_RATE);
		expect(sampleDecodeRate(-48000)).toBe(MAX_SAMPLE_DECODE_RATE);
		expect(sampleDecodeRate(Number.NaN)).toBe(MAX_SAMPLE_DECODE_RATE);
		expect(sampleDecodeRate(Number.POSITIVE_INFINITY)).toBe(MAX_SAMPLE_DECODE_RATE);
	});
});
