// the body-fade rule, once, for the two sites that share it (spec decision
// 11): the side panel's body on a **panel tab** change and the settings
// dialog's on a **settings category** change. one rule, two sites, and the
// rule is subtler than "did the key change".
//
// a body fades in only when the key changes INSIDE a surface that was already
// open. the surface's own entry is not a content change -- opening the panel
// by clicking a rail tab must be the slide alone, with no second fade on top
// of it, and opening the settings dialog must show its first category in
// place under the dialog's own motion.
//
// the other half of the job is what a CLOSING surface shows. base-ui keeps a
// closing dialog mounted for its whole exit and the presence helper does the
// same for the panel, so both keep rendering a body for as long as they take
// to leave -- and it has to be the body they were closed on. `null` means the
// surface is closed, and the last key is held rather than replaced

export interface ContentFade<Key> {
	/** the key whose body is on screen. a closed surface keeps the last one it
	 * showed, so nothing swaps under the user while it leaves */
	shown: Key;
	/** whether that body should carry the enter fade */
	fading: boolean;
	/** whether the surface is open, which is what tells a key change apart
	 * from the surface's own entry */
	open: boolean;
}

export function initialContentFade<Key>(key: Key | null, fallback: Key): ContentFade<Key> {
	return { shown: key ?? fallback, fading: false, open: key !== null };
}

/** the state after the surface reports its key, `null` for closed. returns the
 * SAME object when nothing changed, so a caller can fold it on every render
 * and set state only when the reference moves */
export function contentFadeStep<Key>(state: ContentFade<Key>, key: Key | null): ContentFade<Key> {
	if (key === null) {
		// leaving is not a change of content: hold the body being shown and
		// clear the fade, so a reopen onto a DIFFERENT key is still an entry
		// rather than a change
		if (!state.open && !state.fading) return state;
		return { shown: state.shown, fading: false, open: false };
	}
	// an entry, whichever key it lands on
	if (!state.open) return { shown: key, fading: false, open: true };
	if (key === state.shown) return state;
	return { shown: key, fading: true, open: true };
}
