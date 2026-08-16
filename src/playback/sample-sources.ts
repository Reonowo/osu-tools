// the sample half of the lookup chain: how a skin-independent SampleLookup
// becomes a file to fetch, and in what order the sources get asked.
//
// the split follows lazer's exactly. `HitSampleInfo.LookupNames` produces the
// ordered candidate names (hitsampleinfo.cs:87-98) and each source answers a
// NAME; the engine never emits a path and no source ever sees a bank or a
// suffix. that is what makes the source list substitutable.

import type { SampleLookup } from "@/lib/scene-types";
import { resolveThroughChain, type LookupSource, type SourceAnswer } from "./lookup-chain";
import { BUNDLED_SAMPLE_TIERS, type SampleTier } from "./sample-manifest";

/** what a source is asked for: lazer's `ISampleInfo`, reduced to the two
 * things a source actually reads */
export interface SampleRequest {
	/** ordered candidate filenames, most preferred first */
	names: readonly string[];
	/** a storyboard sample is answered by the beatmap even when beatmap
	 * hitsounds are switched off (beatmapskinprovidingcontainer.cs:26). always
	 * false today -- storyboard samples are out of scope -- and carried so that
	 * gate can be written as lazer's rule rather than as a bare toggle */
	storyboard: boolean;
	/** the bare sample name a LEGACY source falls back to as a last resort --
	 * lazer's `yield return hitSample.Name` (legacyskin.cs:628-632).
	 *
	 * null for a request that is not a hit sample: that branch of
	 * `LegacySkin.GetSample` (:590-593) expands the lookup names and stops,
	 * with no universal fallback at all, so a plain `SampleInfo` must not
	 * acquire one by having its name guessed back out of its lookup names */
	universalName: string | null;
}

/** where a lookup's bytes are. one url per FILE, which is the identity the
 * decode cache keys on -- several lookups legitimately resolve to one file */
export interface ResolvedSample {
	/** which source answered; diagnosis only, nothing depends on it */
	sourceId: string;
	url: string;
}

export type SampleSource = LookupSource<SampleRequest, ResolvedSample>;

/**
 * hitsampleinfo.cs:87-98 -- every filename that may source this lookup, most
 * preferred first: the suffixed banked name when there is a suffix, then the
 * banked name, then the bare one.
 *
 * a lookup that names an explicit `hitSample` file
 * (converthitobjectparser.cs:693-697) prepends that filename and its
 * extension-stripped form, then falls back to the plain normal-bank
 * `hitnormal` its `FileHitSampleInfo` is built as -- NOT to the object's own
 * bank. mirrors the engine's `HitSample::lookup_names`; the two are one rule
 * expressed on both sides of the wire, like every other part of this contract
 */
export function lookupNames(lookup: SampleLookup): string[] {
	if (lookup.filename !== null) {
		const names = [lookup.filename];
		const stem = stripExtension(lookup.filename);
		if (stem !== null) names.push(stem);
		return [...names, "Gameplay/normal-hitnormal", "Gameplay/hitnormal"];
	}
	const names: string[] = [];
	if (lookup.suffix !== null) names.push(`Gameplay/${lookup.bank}-${lookup.name}${lookup.suffix}`);
	names.push(`Gameplay/${lookup.bank}-${lookup.name}`);
	names.push(`Gameplay/${lookup.name}`);
	return names;
}

/** an object's hit sample, as a request */
export function sampleRequest(lookup: SampleLookup): SampleRequest {
	return {
		names: lookupNames(lookup),
		storyboard: false,
		// a file sample's own Name is hitnormal, which is what a
		// FileHitSampleInfo is constructed as
		universalName: lookup.filename === null ? lookup.name : "hitnormal"
	};
}

/** a sound the game itself makes rather than an object: lazer's plain
 * `SampleInfo("Gameplay/combobreak")`, whose only lookup name is itself and
 * which takes the non-hit-sample branch of a legacy source's lookup */
export function namedRequest(name: string): SampleRequest {
	return { names: [name], storyboard: false, universalName: null };
}

/** `Path.ChangeExtension(name, null)`: strips from the last `.` in the file
 * name, and answers null when there is nothing to strip */
function stripExtension(filename: string): string | null {
	const nameStart = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\")) + 1;
	const dot = filename.slice(nameStart).lastIndexOf(".");
	return dot === -1 ? null : filename.slice(0, nameStart + dot);
}

/**
 * the bundled default set, as ONE source spanning three tiers.
 *
 * argonproskin.cs:25-34 -- and the loop nesting is the whole point. the
 * LOOKUP NAMES are the outer loop and the tiers are the inner one, so
 * **fallback is per lookup, never per skin**: a suffixed name found in a later
 * tier beats an unsuffixed name in an earlier one, and a name absent from an
 * earlier tier still resolves in a later one rather than dragging the whole
 * lookup down with it. `drum-sliderwhistle` is the live proof -- `Argon` ships
 * no such file and the shared tier does.
 *
 * it is one source rather than three because that is what lazer makes it: the
 * three tiers are one skin's `GetSample`, and a user skin inserted later goes
 * BETWEEN this and the beatmap, never between the tiers
 */
export function bundledSampleSource(tiers: readonly SampleTier[] = BUNDLED_SAMPLE_TIERS): SampleSource {
	return {
		id: "bundled",
		lookup(request) {
			for (const name of request.names) {
				// the tier files are keyed on the name with `Gameplay/` stripped,
				// exactly as lazer's own `lookup.Replace("Gameplay/", ...)` rewrite
				// leaves it
				const stem = name.startsWith("Gameplay/") ? name.slice("Gameplay/".length) : name;
				for (const tier of tiers) {
					const extension = tier.files[stem];
					if (extension !== undefined) {
						return {
							answer: "found",
							value: { sourceId: "bundled", url: `/samples/${tier.dir}/${stem}${extension}` }
						};
					}
				}
			}
			// the bundled set is the LAST source, so declining here means silence
			// -- but it still declines rather than answering empty, because
			// "this set does not have it" is not the same statement as "this set
			// says there is no sound", and a source inserted after it would be
			// entitled to answer
			return { answer: "none" };
		}
	};
}

/**
 * the ordered source list: beatmap, then user skin, then bundled default --
 * `SkinProvidingContainer`'s own order (skinprovidingcontainer.cs:149-159),
 * which is why the list is the precedence and nothing else needs to encode it.
 *
 * the middle slot is deliberately empty for now: the user-skin source was
 * deferred at ticketing, and filling it later is a list insert, which is the
 * point of the seam
 */
export function sampleSources(beatmap: SampleSource | null): readonly SampleSource[] {
	return beatmap === null ? [bundledSampleSource()] : [beatmap, bundledSampleSource()];
}

export function resolveSample(sources: readonly SampleSource[], request: SampleRequest): SourceAnswer<ResolvedSample> {
	return resolveThroughChain(sources, request);
}

/**
 * the beatmap's own sample files -- the chain's FIRST source, ahead of the
 * bundled default, which is what makes a map that ships its own hitsounding
 * sound like itself.
 *
 * legacyskin.cs:608-632 is the lookup rule, and it is not the bundled tiers':
 *
 * - every lookup name is tried both whole and as its last path piece
 *   (:634-641), which is how `Gameplay/normal-hitnormal` reaches a beatmap
 *   folder's `normal-hitnormal.wav`;
 * - a SUFFIXED sample must use its suffix here and may not fall back to the
 *   unsuffixed file (:612-621, `UseCustomSampleBanks` is true for a beatmap
 *   skin) -- a map with custom index 3 and no `normal-hitnormal3` falls
 *   through to the NEXT SOURCE, not to its own `normal-hitnormal`;
 * - and last, the bare name is tried as a "universal" sample (:628-632).
 *
 * `ignoreBeatmapHitsounds` gates the whole source, exactly as
 * `BeatmapSkinProvidingContainer.AllowSampleLookup` does
 * (beatmapskinprovidingcontainer.cs:26): it DECLINES rather than answering
 * empty, so the bundled default answers instead. that is why the toggle drops
 * the map's own sample FILES while its banks, additions and per-object volumes
 * -- which are object data, resolved engine-side -- keep applying
 */
export function beatmapSampleSource(options: {
	/** lookup name -> absolute path, as the scene carries it */
	files: Readonly<Record<string, string>>;
	/** absolute path -> a url the webview may fetch */
	toUrl: (path: string) => string;
	ignoreBeatmapHitsounds: boolean;
}): SampleSource {
	return {
		id: "beatmap",
		lookup(request) {
			// the storyboard exemption is lazer's own and is written here now,
			// unreachable until storyboard samples land: a storyboard sample is
			// answered by the beatmap even with beatmap hitsounds switched off,
			// because it is the storyboard's sound rather than the map's
			// hitsounding
			if (options.ignoreBeatmapHitsounds && !request.storyboard) return { answer: "none" };
			for (const name of legacyLookupNames(request)) {
				const path = options.files[name];
				if (path !== undefined) {
					return { answer: "found", value: { sourceId: "beatmap", url: options.toUrl(path) } };
				}
			}
			return { answer: "none" };
		}
	};
}

/** legacyskin.cs:608-641 -- the names a LEGACY (or beatmap) skin tries, which
 * differ from a lazer skin's in three ways the doc on `beatmapSampleSource`
 * spells out. lowercased, because osu!'s own file lookups are */
export function legacyLookupNames(request: SampleRequest): string[] {
	const expanded = request.names.flatMap((name) => {
		const piece = name.split("/").pop() ?? name;
		return piece === name ? [name] : [name, piece];
	});
	// the suffix a custom sample bank produced, recovered from the names
	// themselves: the request carries names, not fields, exactly as an
	// ISampleInfo does
	const suffix = customBankSuffix(request.names);
	const filtered =
		suffix === null
			? expanded
			: // UseCustomSampleBanks is true for a beatmap skin: it MUST use the
				// suffix and is not allowed to fall back to a non-custom sound
				expanded.filter((name) => name.endsWith(suffix));
	// and last, the "universal" sample -- a bare `hitnormal` with no bank at
	// all, which stable allowed and lazer keeps for compatibility. only a HIT
	// sample gets it: the other branch of LegacySkin.GetSample expands the
	// lookup names and stops
	const names = request.universalName === null ? filtered : [...filtered, request.universalName];
	return names.map((name) => name.toLowerCase());
}

/** the custom-bank suffix a name list declares, or null. the suffixed name is
 * the FIRST one when there is one (hitsampleinfo.cs:91-96), and it differs
 * from the second only by that trailing index */
function customBankSuffix(names: readonly string[]): string | null {
	const [first, second] = names;
	if (first === undefined || second === undefined) return null;
	if (!first.startsWith(second)) return null;
	const suffix = first.slice(second.length);
	return /^\d+$/.test(suffix) ? suffix : null;
}
