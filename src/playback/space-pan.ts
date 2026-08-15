// space's two jobs in the viewer: tapped it toggles playback, held it arms
// the viewport's pan drag. both cannot fire on keydown, so the toggle moved to
// keyup and this is the scrap of state that decides whether a release was a
// tap or the end of a drag. it lives outside react because both halves are
// imperative -- the key handlers in use-playback-shortcuts, the pointer
// handlers in Viewport -- and between them they render nothing but a cursor

export class SpacePan {
	private held = false;
	private dragged = false;
	/** the main key of the binding that armed this hold. a hold has to end on
	 * the key that began it: play/pause can carry an alternate binding, and a
	 * keyup for the *other* one is not this press ending */
	private armedBy: string | null = null;
	private listeners = new Set<(armed: boolean) => void>();

	/** true while space is down, which is when a left-drag pans instead of
	 * doing whatever a left-drag would otherwise do */
	get armed(): boolean {
		return this.held;
	}

	/** call on space keydown, after the same guards that used to gate the
	 * toggle. auto-repeat must not reach here: re-arming mid-hold would forget
	 * a drag already in progress and let the release toggle playback */
	press(mainKey: string): void {
		this.dragged = false;
		if (this.held) return;
		this.held = true;
		this.armedBy = mainKey;
		this.notify();
	}

	/** true when `mainKey` is letting go of the hold that is actually armed. a
	 * keyup for any other key -- a second binding on the same action, or a key
	 * pressed mid-hold that happens to be one -- is not this press ending and
	 * must not end it */
	heldBy(mainKey: string): boolean {
		return this.held && this.armedBy === mainKey;
	}

	/** call on space keyup. true when the release should still toggle playback:
	 * space was armed here (so a focused button's own space activation, which
	 * never armed anything, toggles nothing) and nothing dragged while it was
	 * held */
	release(): boolean {
		const tapped = this.held && !this.dragged;
		this.dragged = false;
		this.armedBy = null;
		if (this.held) {
			this.held = false;
			this.notify();
		}
		return tapped;
	}

	/** the window lost focus, so the keyup that would have ended this hold will
	 * be delivered somewhere else and never arrive. without it the latch stays
	 * armed for good: the viewport keeps its grab cursor and plain left-drags
	 * pan with no space held. deliberately not release(): a blur must not
	 * toggle playback, which is precisely what release()'s return value asks
	 * its caller to do */
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
