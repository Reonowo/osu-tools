// the skin lookup chain: an ordered list of sources, each of which may answer
// a lookup or decline, generic over what is being looked up.
//
// this is lazer's `SkinProvidingContainer.GetSample` (skinprovidingcontainer.cs:147-160)
// as a data structure. only the sample kind exists today; when the texture half
// of skinning lands it adds a kind and inherits this precedence rule rather
// than inventing a second one, which is the whole reason the chain is generic
// over the lookup rather than being a function about samples.

/**
 * what a source answers. all three values are load-bearing and the first two
 * must never be collapsed:
 *
 * - `found` -- here is the thing.
 * - `empty` -- **answered, with nothing.** the source made a decision: lazer's
 *   `Drawable.Empty()` for a judgement piece, its `SampleVirtual()` for a
 *   layered hit sound the skin switched off (legacyskintransformer.cs:31-32),
 *   a legacy skin's deliberately silent `.wav` or 1x1 transparent `.png`.
 * - `none` -- declined. lazer's `null`; the next source answers instead.
 *
 * collapsing `empty` into `none` is the easiest mistake here and the worst: a
 * `?? next()` written on autopilot falls through to a later source and
 * resurrects precisely what the user picked their skin to remove
 */
export type SourceAnswer<T> = { answer: "found"; value: T } | { answer: "empty" } | { answer: "none" };

/** a source of one kind of thing. `id` is for diagnosis only -- nothing about
 * precedence is keyed on it */
export interface LookupSource<Request, T> {
	readonly id: string;
	lookup(request: Request): SourceAnswer<T>;
}

/**
 * the first source that ANSWERS wins, whether it answered with something or
 * with nothing; a declining source passes the request on. sources are tried in
 * list order, so the list IS the precedence -- beatmap, then user skin, then
 * the bundled default.
 *
 * one caller-visible consequence, and it is the point: an `empty` answer is
 * returned as `empty`, never as `none`. a consumer that treats the two the
 * same has thrown away the distinction this function exists to preserve
 */
export function resolveThroughChain<Request, T>(
	sources: readonly LookupSource<Request, T>[],
	request: Request
): SourceAnswer<T> {
	for (const source of sources) {
		const answer = source.lookup(request);
		if (answer.answer !== "none") return answer;
	}
	return { answer: "none" };
}
