import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SampleLookup } from "../lib/scene-types";
import { resolveThroughChain, type SourceAnswer } from "./lookup-chain";
import { BUNDLED_SAMPLE_TIERS } from "./sample-manifest";
import {
	beatmapSampleSource,
	bundledSampleSource,
	lookupNames,
	namedRequest,
	resolveSample,
	sampleRequest,
	sampleSources,
	type ResolvedSample,
	type SampleSource
} from "./sample-sources";

function lookup(over: Partial<SampleLookup> = {}): SampleLookup {
	return { bank: "normal", name: "hitnormal", suffix: null, volume: 100, layered: false, filename: null, ...over };
}

const tier = (dir: string) => BUNDLED_SAMPLE_TIERS.find((t) => t.dir === dir)!;

describe("lookupNames", () => {
	test("follows HitSampleInfo's order, suffix first when there is one", () => {
		expect(lookupNames(lookup({ bank: "drum", name: "hitwhistle" }))).toEqual([
			"Gameplay/drum-hitwhistle",
			"Gameplay/hitwhistle"
		]);
		expect(lookupNames(lookup({ bank: "soft", name: "hitclap", suffix: 3 }))).toEqual([
			"Gameplay/soft-hitclap3",
			"Gameplay/soft-hitclap",
			"Gameplay/hitclap"
		]);
	});

	test("a file lookup leads with the filename and falls back to a plain hitnormal", () => {
		// converthitobjectparser.cs:693-697 -- the base list is a NORMAL-bank
		// hitnormal, never the object's own bank
		expect(lookupNames(lookup({ bank: "drum", filename: "custom-hit.wav" }))).toEqual([
			"custom-hit.wav",
			"custom-hit",
			"Gameplay/normal-hitnormal",
			"Gameplay/hitnormal"
		]);
	});

	test("mirrors the engine's own lookup_names, which is the point of both", () => {
		// the rule is written on both sides of the wire because the engine needs
		// it to widen the .osz extract allow-list and the chain needs it to
		// resolve; a divergence would extract one file and ask for another
		expect(lookupNames(lookup({ bank: "none" }))).toEqual(["Gameplay/none-hitnormal", "Gameplay/hitnormal"]);
	});
});

describe("the bundled default set", () => {
	const source = bundledSampleSource();

	test("resolves an ordinary hit sample in ArgonPro, the first tier", () => {
		expect(source.lookup(sampleRequest(lookup({ bank: "drum" })))).toEqual({
			answer: "found",
			value: { sourceId: "bundled", url: "/samples/Gameplay/ArgonPro/drum-hitnormal.wav" }
		});
	});

	test("a name ArgonPro does not ship falls through to Argon", () => {
		// ArgonPro ships only the per-bank hit and slider samples, so every
		// game-level sound is a real second-tier resolution
		expect(source.lookup(namedRequest("Gameplay/spinnerspin"))).toMatchObject({
			value: { url: "/samples/Gameplay/Argon/spinnerspin.wav" }
		});
		expect(source.lookup(namedRequest("Gameplay/combobreak"))).toMatchObject({
			value: { url: "/samples/Gameplay/Argon/combobreak.wav" }
		});
	});

	test("FALLBACK IS PER LOOKUP, NEVER PER SKIN: drum-sliderwhistle reaches the shared tier", () => {
		// the live proof case, on the real vendored files rather than a
		// synthetic stand-in: `Gameplay/Argon/` ships drum-sliderslide and
		// drum-slidertick but NO drum-sliderwhistle, while the shared tier does.
		// a chain that picked one skin and stayed there would answer nothing
		// here; the per-lookup chain finds it one tier down. asked against the
		// non-pro tier order, which is where the gap is
		const argonChain = bundledSampleSource([tier("Gameplay/Argon"), tier("Gameplay")]);
		expect(argonChain.lookup(sampleRequest(lookup({ bank: "drum", name: "hitnormal" })))).toMatchObject({
			value: { url: "/samples/Gameplay/Argon/drum-hitnormal.wav" }
		});
		expect(argonChain.lookup(namedRequest("Gameplay/drum-sliderwhistle"))).toMatchObject({
			value: { url: "/samples/Gameplay/drum-sliderwhistle.wav" }
		});
	});

	test("a suffixed lookup falls back to its unsuffixed name rather than to another tier's suffix", () => {
		// the loop nesting: names outer, tiers inner. no tier ships a custom
		// index, so `drum-hitnormal3` must land on ArgonPro's `drum-hitnormal`
		expect(source.lookup(sampleRequest(lookup({ bank: "drum", suffix: 3 })))).toMatchObject({
			value: { url: "/samples/Gameplay/ArgonPro/drum-hitnormal.wav" }
		});
	});

	test("the shared tier's mp3 is found through the same per-stem extension", () => {
		// almost everything vendored is a .wav; combobreak is not, in the shared
		// tier. the manifest carries the extension per stem for exactly this
		expect(bundledSampleSource([tier("Gameplay")]).lookup(namedRequest("Gameplay/combobreak"))).toMatchObject({
			value: { url: "/samples/Gameplay/combobreak.mp3" }
		});
	});

	test("declines a name it does not ship rather than answering empty", () => {
		// "this set does not have it" is not "this set says there is no sound".
		// the bundled set is last today, so the two look identical from here --
		// which is exactly why the distinction has to be kept at the source
		expect(source.lookup(sampleRequest(lookup({ bank: "none" }))).answer).toBe("none");
	});

	test("the manifest describes the files actually vendored", () => {
		// the manifest is checked in beside the assets; this is what stops the
		// two drifting when a tier gains or loses a file
		for (const t of BUNDLED_SAMPLE_TIERS) {
			const dir = join("public/samples", t.dir);
			const onDisk = readdirSync(dir).filter((entry) => statSync(join(dir, entry)).isFile());
			const declared = Object.entries(t.files).map(([stem, ext]) => `${stem}${ext}`);
			expect(onDisk.sort()).toEqual(declared.sort());
		}
	});
});

describe("the chain's three-valued answer", () => {
	// the single most important property of this seam, and the easiest to lose
	// to a `?? next()` written on autopilot
	const found = (url: string): SampleSource => ({
		id: url,
		lookup: () => ({ answer: "found", value: { sourceId: url, url } })
	});
	const empty: SampleSource = { id: "empty", lookup: () => ({ answer: "empty" }) };
	const declines: SampleSource = { id: "declines", lookup: () => ({ answer: "none" }) };
	const request = sampleRequest(lookup());

	test("a source that ANSWERS WITH NOTHING stops the chain", () => {
		// the case this test exists for: a skin that deliberately ships silence
		// -- lazer's SampleVirtual for a layered hit sound the skin switched off
		// (legacyskintransformer.cs:31-32), or a legacy skin's silent .wav.
		// falling through here would resurrect precisely what the user picked
		// that skin to remove
		const answer: SourceAnswer<ResolvedSample> = resolveThroughChain([empty, found("later")], request);
		expect(answer).toEqual({ answer: "empty" });
	});

	test("a source that DECLINES passes the lookup on", () => {
		expect(resolveThroughChain([declines, found("later")], request)).toMatchObject({
			answer: "found",
			value: { url: "later" }
		});
	});

	test("an exhausted chain declines rather than answering empty", () => {
		expect(resolveThroughChain([declines, declines], request)).toEqual({ answer: "none" });
	});

	test("earlier sources win outright", () => {
		expect(resolveThroughChain([found("first"), found("second")], request)).toMatchObject({
			value: { url: "first" }
		});
	});
});

describe("the source list", () => {
	test("is beatmap first, bundled last -- the list IS the precedence", () => {
		const beatmap: SampleSource = {
			id: "beatmap",
			lookup: () => ({ answer: "found", value: { sourceId: "beatmap", url: "map.wav" } })
		};
		expect(sampleSources(beatmap).map((s) => s.id)).toEqual(["beatmap", "bundled"]);
		expect(resolveSample(sampleSources(beatmap), sampleRequest(lookup()))).toMatchObject({
			value: { url: "map.wav" }
		});
		// with no beatmap source the bundled set answers, which is the whole
		// no-custom-hitsounds path
		expect(resolveSample(sampleSources(null), sampleRequest(lookup()))).toMatchObject({
			value: { url: "/samples/Gameplay/ArgonPro/normal-hitnormal.wav" }
		});
	});
});

describe("the beatmap's own sample files", () => {
	const files = {
		"normal-hitnormal": "C:/map/normal-hitnormal.wav",
		"soft-hitclap3": "C:/map/soft-hitclap3.wav",
		"kick.wav": "C:/map/kick.wav",
		hitwhistle: "C:/map/hitwhistle.wav"
	};
	const source = (ignoreBeatmapHitsounds = false) =>
		beatmapSampleSource({ files, toUrl: (path) => `asset://${path}`, ignoreBeatmapHitsounds });

	test("answers a default lookup by its last path piece", () => {
		// legacyskin.cs:634-641 -- `Gameplay/normal-hitnormal` reaches a beatmap
		// folder's `normal-hitnormal.wav`, which is how a map ships its own
		// hitsounding at all
		expect(source().lookup(sampleRequest(lookup()))).toEqual({
			answer: "found",
			value: { sourceId: "beatmap", url: "asset://C:/map/normal-hitnormal.wav" }
		});
	});

	test("a SUFFIXED lookup may not fall back to the map's own unsuffixed file", () => {
		// legacyskin.cs:612-621 with UseCustomSampleBanks true: "if the skin can
		// use custom sample banks, it MUST use the custom sample bank suffix. it
		// is not allowed to fall back to a non-custom sound". so a custom index
		// the map does not ship falls through to the NEXT SOURCE
		expect(source().lookup(sampleRequest(lookup({ bank: "soft", name: "hitclap", suffix: 3 })))).toMatchObject({
			value: { url: "asset://C:/map/soft-hitclap3.wav" }
		});
		// index 4 is not shipped; the map's own soft-hitclap must NOT answer
		expect(source().lookup(sampleRequest(lookup({ bank: "soft", name: "hitclap", suffix: 4 }))).answer).toBe(
			"none"
		);
	});

	test("the bare universal name answers when no banked file does", () => {
		// legacyskin.cs:628-632 -- stable allowed a bankless sample and lazer
		// keeps it for compatibility
		expect(source().lookup(sampleRequest(lookup({ bank: "drum", name: "hitwhistle" })))).toMatchObject({
			value: { url: "asset://C:/map/hitwhistle.wav" }
		});
	});

	test("a NON-hit-sample request gets no universal fallback", () => {
		// legacyskin.cs:590-593 -- a plain SampleInfo takes the other branch,
		// which expands the lookup names and stops. without the distinction,
		// `Gameplay/drum-sliderwhistle` would acquire a `sliderwhistle`
		// fallback lazer never offers it
		const withUniversal = { ...namedRequest("Gameplay/drum-hitwhistle"), universalName: null };
		expect(source().lookup(withUniversal).answer).toBe("none");
		// the same names asked for as a HIT sample do reach the universal file
		expect(source().lookup(sampleRequest(lookup({ bank: "drum", name: "hitwhistle" }))).answer).toBe("found");
	});

	test("an explicit hitSample filename answers by its own name", () => {
		expect(source().lookup(sampleRequest(lookup({ filename: "Kick.WAV" })))).toMatchObject({
			value: { url: "asset://C:/map/kick.wav" }
		});
	});

	test("declines a name it does not have, so the bundled default answers", () => {
		expect(source().lookup(sampleRequest(lookup({ bank: "drum", name: "hitfinish" }))).answer).toBe("none");
		expect(
			resolveSample(sampleSources(source()), sampleRequest(lookup({ bank: "drum", name: "hitfinish" })))
		).toMatchObject({
			value: { url: "/samples/Gameplay/ArgonPro/drum-hitfinish.wav" }
		});
	});

	test("IGNORE BEATMAP HITSOUNDS declines rather than answering empty", () => {
		// beatmapskinprovidingcontainer.cs:26 -- the container declines the
		// lookup, so the next source answers. declining rather than answering
		// empty is what makes the toggle "use the default files" rather than
		// "make this object silent"
		expect(source(true).lookup(sampleRequest(lookup())).answer).toBe("none");
		expect(resolveSample(sampleSources(source(true)), sampleRequest(lookup()))).toMatchObject({
			value: { url: "/samples/Gameplay/ArgonPro/normal-hitnormal.wav" }
		});
	});

	test("the storyboard exemption is written into the gate, unreachable today", () => {
		// beatmapskinprovidingcontainer.cs:26 is
		// `sampleInfo is StoryboardSampleInfo || BeatmapHitsounds.Value`: a
		// storyboard sample is answered by the beatmap even with beatmap
		// hitsounds off, because it is the storyboard's sound rather than the
		// map's hitsounding. nothing produces one yet
		const storyboard = { names: ["normal-hitnormal"], storyboard: true, universalName: null };
		expect(source(true).lookup(storyboard)).toMatchObject({ answer: "found" });
	});
});
