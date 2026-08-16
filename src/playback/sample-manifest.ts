// what the bundled default sample set actually ships, per tier.
//
// generated from `public/samples/Gameplay/` and checked in beside it: the tier
// files are vendored assets that change only when the pinned osu-resources
// version does, so a build step to derive this at runtime would be a build step
// to keep in sync for no gain. `sample-sources.test.ts` walks the real
// directory and fails if the two ever disagree.
//
// the tiers are lazer's own three, in the order `ArgonProSkin.GetSample`
// (argonproskin.cs:27-30) tries them: the skin's own files, then Argon's, then
// the shared set beside them

/** one tier: the path under `public/samples/` it lives at, and the extension
 * each stem it ships was vendored with (`.wav` for almost everything, `.mp3`
 * for the two lazer itself ships as mp3) */
export interface SampleTier {
	readonly dir: string;
	readonly files: Readonly<Record<string, string>>;
}

export const BUNDLED_SAMPLE_TIERS: readonly SampleTier[] = [
	{
		dir: "Gameplay/ArgonPro",
		files: {
			"drum-hitclap": ".wav",
			"drum-hitfinish": ".wav",
			"drum-hitnormal": ".wav",
			"drum-hitwhistle": ".wav",
			"drum-sliderslide": ".wav",
			"drum-slidertick": ".wav",
			"drum-sliderwhistle": ".wav",
			"normal-hitclap": ".wav",
			"normal-hitfinish": ".wav",
			"normal-hitnormal": ".wav",
			"normal-hitwhistle": ".wav",
			"normal-sliderslide": ".wav",
			"normal-slidertick": ".wav",
			"normal-sliderwhistle": ".wav",
			"soft-hitclap": ".wav",
			"soft-hitfinish": ".wav",
			"soft-hitnormal": ".wav",
			"soft-hitwhistle": ".wav",
			"soft-sliderslide": ".wav",
			"soft-slidertick": ".wav",
			"soft-sliderwhistle": ".wav"
		}
	},
	{
		dir: "Gameplay/Argon",
		files: {
			combobreak: ".wav",
			"drum-hitclap": ".wav",
			"drum-hitfinish": ".wav",
			"drum-hitnormal": ".wav",
			"drum-hitwhistle": ".wav",
			"drum-sliderslide": ".wav",
			"drum-slidertick": ".wav",
			"normal-hitclap": ".wav",
			"normal-hitfinish": ".wav",
			"normal-hitnormal": ".wav",
			"normal-hitwhistle": ".wav",
			"normal-sliderslide": ".wav",
			"normal-slidertick": ".wav",
			"normal-sliderwhistle": ".wav",
			"soft-hitclap": ".wav",
			"soft-hitfinish": ".wav",
			"soft-hitnormal": ".wav",
			"soft-hitwhistle": ".wav",
			"soft-sliderslide": ".wav",
			"soft-slidertick": ".wav",
			"soft-sliderwhistle": ".wav",
			"spinnerbonus-max": ".wav",
			spinnerbonus: ".wav",
			spinnerspin: ".wav"
		}
	},
	{
		dir: "Gameplay",
		files: {
			combobreak: ".mp3",
			"drum-hitclap": ".wav",
			"drum-hitfinish": ".wav",
			"drum-hitnormal": ".wav",
			"drum-hitwhistle": ".wav",
			"drum-sliderslide": ".wav",
			"drum-slidertick": ".wav",
			"drum-sliderwhistle": ".wav",
			"normal-hitclap": ".wav",
			"normal-hitfinish": ".wav",
			"normal-hitnormal": ".wav",
			"normal-hitwhistle": ".wav",
			"normal-sliderslide": ".wav",
			"normal-slidertick": ".wav",
			"normal-sliderwhistle": ".wav",
			"soft-hitclap": ".wav",
			"soft-hitfinish": ".wav",
			"soft-hitnormal": ".wav",
			"soft-hitwhistle": ".wav",
			"soft-sliderslide": ".wav",
			"soft-slidertick": ".wav",
			"soft-sliderwhistle": ".wav",
			spinnerbonus: ".wav",
			spinnerspin: ".wav"
		}
	}
];
