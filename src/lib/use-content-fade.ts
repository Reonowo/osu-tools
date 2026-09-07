// the thin hook over lib/content-fade.ts, on the same terms as
// use-presence.ts: the pure fold does the deciding and this only holds it in
// react state.
//
// the fold is applied during render rather than in an effect, and it returns
// its own input unchanged when nothing moved -- so the comparison IS the
// reducer, and there is no second copy of "what counts as a change" here

import { useState } from "react";
import { contentFadeStep, initialContentFade, type ContentFade } from "@/lib/content-fade";

export function useContentFade<Key>(key: Key | null, fallback: Key): ContentFade<Key> {
	const [state, setState] = useState<ContentFade<Key>>(() => initialContentFade(key, fallback));
	const next = contentFadeStep(state, key);
	if (next !== state) setState(next);
	return next;
}
