// the history panel's one cross-boundary contract: the panel root has to
// decline the wheel handler's frame-stepping, because the pinned footer sits
// outside the scroll-area viewport the guard already recognises -- wheeling
// over the revert-all button must scroll or do nothing, never scrub the
// replay. prior art: FramesPanel.test.tsx, which renders a prop-only
// subcomponent to static markup and asks the real guard about the result

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { withinNativeWheelUi, type GuardElement } from "../../playback/shortcut-guards";
import { HistoryPanelBody } from "./HistoryPanel";

const markup = renderToStaticMarkup(
	<HistoryPanelBody
		osrPath="C:\\replays\\play.osr"
		labels={["move 12 frames", "delete 3 frames"]}
		cursor={2}
		dirty
		onRevertAll={() => {}}
	/>
);

/** the rendered root in the shape the guards walk, so what the guard is asked
 * about is the tag and attributes the panel actually ships */
function renderedRoot(): GuardElement {
	// from the first div, not the first tag: the scroll area hoists a <style>
	// for its own scrollbar rule ahead of everything the panel renders
	const start = markup.indexOf("<div");
	const rootTag = markup.slice(start, markup.indexOf(">", start) + 1);
	const attrs = new Map<string, string>();
	for (const [, name, value] of rootTag.matchAll(/([\w-]+)="([^"]*)"/g)) attrs.set(name, value);
	return {
		tagName: rootTag.slice(1, rootTag.search(/[\s>]/)).toUpperCase(),
		getAttribute: (name) => attrs.get(name) ?? null,
		parentElement: null
	};
}

describe("HistoryPanelBody", () => {
	test("the panel root opts the whole panel out of wheel frame-stepping", () => {
		expect(withinNativeWheelUi(renderedRoot())).toBe(true);
	});

	test("the footer's revert-all renders outside the scrolling list", () => {
		// the button must not sit inside the scroll-area viewport, which is what
		// pins it below however long the node list grows
		const viewportStart = markup.indexOf('data-slot="scroll-area-viewport"');
		expect(viewportStart).toBeGreaterThan(-1);
		expect(markup.indexOf("revert all")).toBeGreaterThan(viewportStart);
		expect(markup.lastIndexOf("</div>")).toBeGreaterThan(markup.indexOf("revert all"));
	});

	test("the nodes read chronologically, baseline first and newest last", () => {
		expect(markup.indexOf("baseline")).toBeLessThan(markup.indexOf("move 12 frames"));
		expect(markup.indexOf("move 12 frames")).toBeLessThan(markup.indexOf("delete 3 frames"));
	});
});
