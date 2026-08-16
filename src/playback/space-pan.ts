// space's two jobs in the viewer: tapped it toggles playback, held it arms
// the viewport's pan drag. tap and drag are only told apart by the release, so
// this is the scrap of state that decides which one a release was. it lives
// outside react because both halves are imperative -- the key handlers in
// use-playback-shortcuts, the pointer handlers in Viewport -- and between them
// they render nothing but a cursor.
//
// THE TOGGLE IS SPLIT ACROSS THE PRESS AND THE RELEASE, and deliberately. the
// whole toggle used to wait for the keyup, which meant a replay went on
// playing -- and hitsounding -- for however long the key was held down; at a
// normal 120ms press that is several hits of a stream after the user asked for
// silence, and it reads as the pause being broken. so the PAUSE half runs on
// the press, where it is instant, and only the PLAY half waits to find out
// whether this was a tap (nobody hears a play start 120ms late). a hold that
// turned out to be a drag puts back whatever the press interrupted, which is
// why this has to remember it.

export class SpacePan {
	private held = false;
	private dragged = false;
	/** the main key of the binding that armed this hold. a hold has to end on
	 * the key that began it: play/pause can carry an alternate binding, and a
	 * keyup for the *other* one is not this press ending */
	private armedBy: string | null = null;
	/** whether the transport was playing when this hold began. the press pauses
	 * it, so this is the only surviving record of what that interrupted */
	private playingAtPress = false;
	private listeners = new Set<(armed: boolean) => void>();

	/** true while space is down, which is when a left-drag pans instead of
	 * doing whatever a left-drag would otherwise do */
	get armed(): boolean {
		return this.held;
	}

	/** call on space keydown, after the same guards that used to gate the whole
	 * toggle, passing whether the transport is playing right now. auto-repeat
	 * must not reach here: re-arming mid-hold would forget a drag already in
	 * progress, and would also re-read a playing flag the press itself just
	 * cleared -- so the release would resume a replay the user paused */
	press(mainKey: string, playing: boolean): void {
		// the guard comes FIRST, `dragged` after it: clearing the drag marker
		// before checking would forget a drag already in progress, which is the
		// thing this guard exists to prevent. play/pause can carry a second
		// binding, so a keydown arriving mid-hold is a real key rather than only
		// auto-repeat, and a forgotten drag makes the original key's release
		// read as a tap -- panning through a paused replay would start it
		if (this.held) return;
		this.dragged = false;
		this.held = true;
		this.armedBy = mainKey;
		this.playingAtPress = playing;
		this.notify();
	}

	/** true when `mainKey` is letting go of the hold that is actually armed. a
	 * keyup for any other key -- a second binding on the same action, or a key
	 * pressed mid-hold that happens to be one -- is not this press ending and
	 * must not end it */
	heldBy(mainKey: string): boolean {
		return this.held && this.armedBy === mainKey;
	}

	/**
	 * call on space keyup. answers whether the transport should be PLAYING now
	 * that this release has been handled -- an absolute state rather than the
	 * toggle this used to return, because the press has already moved playback
	 * underneath it and a second toggle would undo the pause the user asked for.
	 *
	 * null when this release is not this latch's to answer: space was never
	 * armed here, which is a focused button's own space activation, or a keyup
	 * that arrived after a blur already dropped the hold.
	 *
	 * a TAP inverts what the press found (the toggle space has always been); a
	 * DRAG restores it, so panning through a playing replay resumes it and
	 * panning through a paused one leaves it alone
	 */
	release(): boolean | null {
		if (!this.held) {
			this.dragged = false;
			this.armedBy = null;
			return null;
		}
		const tapped = !this.dragged;
		const wasPlaying = this.playingAtPress;
		this.dragged = false;
		this.armedBy = null;
		this.held = false;
		this.notify();
		return tapped ? !wasPlaying : wasPlaying;
	}

	/** the window lost focus, so the keyup that would have ended this hold will
	 * be delivered somewhere else and never arrive. without it the latch stays
	 * armed for good: the viewport keeps its grab cursor and plain left-drags
	 * pan with no space held. deliberately not release(): a blur must not move
	 * playback, which is precisely what release()'s return value asks its caller
	 * to do. a blur therefore leaves a replay the press paused paused, which is
	 * the safe end of that -- alt-tabbing away is not a request to keep playing */
	cancel(): void {
		this.dragged = false;
		this.armedBy = null;
		if (!this.held) return;
		this.held = false;
		this.notify();
	}

	/** a pointer moved while a pan drag was live, so this hold is a drag */
	noteDrag(): void {
		this.dragged = true;
	}

	subscribe(listener: (armed: boolean) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) listener(this.held);
	}
}

/** app-wide, alongside playbackClock and frameCursor */
export const spacePan = new SpacePan();
