import { describe, expect, test } from "bun:test";
import { applyDevicePixelRatio, watchDevicePixelRatio, type DevicePixelRatioView } from "./GameplayRenderer";

// GameplayRenderer itself cannot be constructed headlessly (Application.init
// wants a real webgl context), so what is covered here is the pair of pure
// pieces the class composes for a dpr change: the watcher that notices one,
// and the renderer update it drives

/** a window stand-in whose devicePixelRatio can be moved, matching how the
 * real one changes under the app: a matchMedia query already registered
 * against the old ratio stops matching and fires `change` */
function fakeWindow(devicePixelRatio: number) {
	const queries: { query: string; listeners: Set<() => void> }[] = [];
	const view: DevicePixelRatioView = {
		devicePixelRatio,
		matchMedia(query: string) {
			const entry = { query, listeners: new Set<() => void>() };
			queries.push(entry);
			return {
				addEventListener: (_type: "change", listener: () => void) => void entry.listeners.add(listener),
				removeEventListener: (_type: "change", listener: () => void) => void entry.listeners.delete(listener)
			};
		}
	};
	return {
		view,
		queries,
		/** the query strings that still hold a live listener */
		armed: () => queries.filter((q) => q.listeners.size > 0).map((q) => q.query),
		moveTo(next: number) {
			// snapshot first: every query armed *before* the move was built
			// against a ratio that is no longer current and so stops matching,
			// while the ones its listeners register are already up to date
			const stale = queries.filter((entry) => entry.listeners.size > 0);
			view.devicePixelRatio = next;
			for (const entry of stale) for (const listener of Array.from(entry.listeners)) listener();
		}
	};
}

describe("devicePixelRatio watching", () => {
	test("registers a resolution query against the current ratio", () => {
		const win = fakeWindow(1.5);
		watchDevicePixelRatio(win.view, () => {});

		expect(win.armed()).toEqual(["(resolution: 1.5dppx)"]);
	});

	test("reports the new ratio and re-registers against it, so a second move is caught too", () => {
		const win = fakeWindow(1);
		const seen: number[] = [];
		watchDevicePixelRatio(win.view, (dpr) => seen.push(dpr));

		win.moveTo(2);
		expect(seen).toEqual([2]);
		// exactly one live query, and against the ratio that is now current --
		// a query built for 1dppx would never fire again
		expect(win.armed()).toEqual(["(resolution: 2dppx)"]);

		win.moveTo(1.25);
		expect(seen).toEqual([2, 1.25]);
		expect(win.armed()).toEqual(["(resolution: 1.25dppx)"]);
	});

	test("unsubscribing leaves nothing armed", () => {
		const win = fakeWindow(1);
		const seen: number[] = [];
		const stop = watchDevicePixelRatio(win.view, (dpr) => seen.push(dpr));

		win.moveTo(2);
		stop();
		expect(win.armed()).toEqual([]);

		win.moveTo(3);
		expect(seen).toEqual([2]);
	});
});

describe("a dpr change updates the renderer", () => {
	function fakeRenderer() {
		return {
			resolution: 1,
			resizes: [] as [number, number][],
			resize(w: number, h: number) {
				this.resizes.push([w, h]);
			}
		};
	}

	test("the backing store takes the new ratio and is resized at the unchanged css size", () => {
		const renderer = fakeRenderer();
		applyDevicePixelRatio(renderer, 2, 800, 600);

		expect(renderer.resolution).toBe(2);
		expect(renderer.resizes).toEqual([[800, 600]]);
	});

	test("wired to the watcher, moving the window to another display re-resolves the renderer", () => {
		const win = fakeWindow(1);
		const renderer = fakeRenderer();
		watchDevicePixelRatio(win.view, (dpr) => applyDevicePixelRatio(renderer, dpr, 1280, 720));

		expect(renderer.resolution).toBe(1); // nothing happens until it actually changes

		win.moveTo(2.5);
		expect(renderer.resolution).toBe(2.5);
		expect(renderer.resizes).toEqual([[1280, 720]]);
	});
});
