// what the vendored classic default set actually ships.
//
// generated from `public/skins/legacy/` and checked in beside it, on exactly
// the terms `playback/sample-manifest.ts` already sets for the bundled sample
// tiers: the files are vendored assets that change only when the pinned
// osu-resources version does, so deriving this at runtime would be a build step
// to keep in sync for no gain. `texture-sources.test.ts` walks the real
// directory and fails if the two ever disagree.
//
// the pin, the licence and the subset taken are recorded in `NOTICE` and
// `docs/adr/0006-classic-default-skin-assets.md`. every file is the `@2x`
// variant, which is what the upstream tree holds for almost everything -- the
// resolution factor is carried out of the lookup anyway, so a second
// lower-resolution copy would be a file to keep in sync for no visual gain.

/** the file names the set ships, and nothing more. a skin's own file map is
 * name -> absolute path, but the floor's paths are derived from the name
 * (`/skins/legacy/<name>`), so there is no second value to hold -- and one that
 * was held but never read is a field to keep in sync for nothing */
export const CLASSIC_FLOOR_FILES: readonly string[] = [
	"approachcircle@2x.png",
	"cursor@2x.png",
	"cursormiddle@2x.png",
	"cursortrail@2x.png",
	"default-0@2x.png",
	"default-1@2x.png",
	"default-2@2x.png",
	"default-3@2x.png",
	"default-4@2x.png",
	"default-5@2x.png",
	"default-6@2x.png",
	"default-7@2x.png",
	"default-8@2x.png",
	"default-9@2x.png",
	"followpoint@2x.png",
	"hit0@2x.png",
	"hit100@2x.png",
	"hit300@2x.png",
	"hit50@2x.png",
	"hitcircle@2x.png",
	"hitcircleoverlay@2x.png",
	"lighting@2x.png",
	"reversearrow@2x.png",
	"sliderb-nd@2x.png",
	"sliderb-spec@2x.png",
	"sliderb0@2x.png",
	"sliderb1@2x.png",
	"sliderb2@2x.png",
	"sliderb3@2x.png",
	"sliderb4@2x.png",
	"sliderb5@2x.png",
	"sliderb6@2x.png",
	"sliderb7@2x.png",
	"sliderb8@2x.png",
	"sliderb9@2x.png",
	"sliderfollowcircle@2x.png",
	"sliderscorepoint@2x.png",
	"spinner-approachcircle@2x.png",
	"spinner-bottom@2x.png",
	"spinner-circle@2x.png",
	"spinner-clear@2x.png",
	"spinner-glow@2x.png",
	"spinner-middle2@2x.png",
	"spinner-middle@2x.png",
	"spinner-rpm@2x.png",
	"spinner-spin@2x.png",
	"spinner-top@2x.png"
];
