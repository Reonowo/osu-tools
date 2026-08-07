// the frames table's two cross-boundary contracts: a row must not switch the
// playback shortcuts off while it holds the focus a click gives it, and the
// window math row activation moves focus through has to be the same one the
// rAF loop fills the nine rows from

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { withinInteractiveControl, type GuardElement } from "../../playback/shortcut-guards";
import { FrameRow, frameWindowStart, suppressSpaceActivation } from "./FramesPanel";

const rowMarkup = renderToStaticMarkup(<FrameRow setRef={() => {}} onActivate={() => {}} />);

/** the rendered row in the shape the guards walk, so what the guard is asked
 * about is the tag and attributes the row actually ships */
function renderedRow(): GuardElement {
	const attrs = new Map<string, string>();
	for (const [, name, value] of rowMarkup.matchAll(/([\w-]+)="([^"]*)"/g)) attrs.set(name, value);
	return {
		tagName: rowMarkup.slice(1, rowMarkup.search(/[\s>]/)).toUpperCase(),
		getAttribute: (name) => attrs.get(name) ?? null,
		parentElement: null
	};
}

function pressed(key: string): boolean {
	let prevented = false;
	suppressSpaceActivation({
		key,
		preventDefault: () => {
			prevented = true;
		}
	});
	return prevented;
}

describe("FrameRow", () => {
	test("stays a button, so a pointer can click it and a tab can reach it", () => {
		expect(renderedRow().tagName).toBe("BUTTON");
	});

	test("opts out of the shortcut guard, keeping the playback keys alive under focus", () => {
		// a click focuses the row on windows/chromium, and the guard suppresses
		// every shortcut inside a button -- without the opt-out `,` `.` space
		// arrows home are all dead until the user clicks somewhere else
		expect(withinInteractiveControl(renderedRow())).toBe(false);
	});

	test("declines space so it cannot both toggle playback and select a frame", () => {
		expect(pressed(" ")).toBe(true);
		// enter is the row's own activation key and nothing else binds it
		expect(pressed("Enter")).toBe(false);
		expect(pressed("ArrowDown")).toBe(false);
	});
});

describe("frameWindowStart", () => {
	test("centres the selection wherever the replay has room on both sides", () => {
		expect(frameWindowStart(4, 500)).toBe(0);
		expect(frameWindowStart(5, 500)).toBe(1);
		expect(frameWindowStart(250, 500)).toBe(246);
	});

	test("clamps at both ends so the nine rows stay full", () => {
		expect(frameWindowStart(0, 500)).toBe(0);
		expect(frameWindowStart(499, 500)).toBe(491);
	});

	test("a replay shorter than the window always starts at zero", () => {
		expect(frameWindowStart(0, 5)).toBe(0);
		expect(frameWindowStart(4, 5)).toBe(0);
		// no frames at all: the loop passes -1 for the centre
		expect(frameWindowStart(-1, 0)).toBe(0);
	});

	test("the row a selection lands on is always one of the nine", () => {
		// this is exactly the row activation focuses, so it must exist -- at the
		// ends the selection is off-centre rather than out of the window
		const cases: [number, number, number][] = [
			[0, 500, 0],
			[3, 500, 3],
			[250, 500, 4],
			[498, 500, 7],
			[499, 500, 8],
			[2, 5, 2]
		];
		for (const [index, frameCount, row] of cases) {
			expect(index - frameWindowStart(index, frameCount)).toBe(row);
		}
	});
});
