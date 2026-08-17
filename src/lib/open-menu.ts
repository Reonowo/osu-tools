// the open menu's one rule that is a decision rather than a layout: which
// recents it offers. pure and separate from the component so `bun test src`
// can assert it without a dom (AGENTS.md's frontend testability pattern)

import type { RecentReplay } from "./scene-types";

/**
 * the recents the open menu lists: every entry except the replay already on
 * screen.
 *
 * `record_recent` moves the loaded replay to `recents[0]` on every successful
 * load, so the unfiltered list always opens with a row meaning "you are already
 * here" -- and this menu answers exactly one question, "give me a *different*
 * replay". the start screen lists all of them unfiltered, because there a row
 * means "open this" and nothing is open.
 *
 * `loadedOsrPath` is the store's `osrPath`, which names the displayed scene and
 * is null before the first load -- in which case nothing is excluded.
 */
export function menuRecents(recents: readonly RecentReplay[], loadedOsrPath: string | null): readonly RecentReplay[] {
	if (loadedOsrPath === null) return recents;
	return recents.filter((entry) => entry.osrPath !== loadedOsrPath);
}
