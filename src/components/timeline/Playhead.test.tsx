import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Playhead, playheadTransform } from "./Playhead";

// the point of extracting Playhead is that the head and the stem cannot round
// independently of one another, and that holds exactly when the two are
// children of the one element the tiers' rAF loops transform and neither
// re-centres itself. that is a property of the markup's shape, so no dom is
// needed to check it -- the ref is null here for the same reason
const markup = renderToStaticMarkup(<Playhead ref={null} />);

describe("Playhead", () => {
	test("the head and the stem are the only children of a single wrapper", () => {
		expect(markup).toMatch(/^<div [^>]*>(<div [^>]*><\/div>){2}<\/div>$/);
	});

	test("neither the head nor the stem carries a transform of its own", () => {
		expect(markup).not.toContain("translate");
	});

	test("the wrapper's whole movement is one snapped translate3d", () => {
		expect(playheadTransform(120.4, 1)).toBe("translate3d(120px, 0, 0)");
		expect(playheadTransform(120.4, 2)).toBe("translate3d(120.5px, 0, 0)");
	});
});
