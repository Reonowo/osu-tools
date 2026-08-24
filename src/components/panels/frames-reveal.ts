// the frames panel's reveal request: the context menu's offset… item raises
// the frames tab and asks for the Δx field, which may not be mounted yet at
// the moment of asking (the tab switch and the mount land on react's next
// commit). a one-shot latch bridges the gap: request() fires the live target
// when the panel is mounted and latches until the mount otherwise.
//
// deliberately a private mirror of the keypress panel's post-add focus latch
// rather than a generalised reveal-in-panel seam: two consumers with
// different shapes (one keyed to a landing delta, one to a mount) do not yet
// make a pattern, and the third consumer is the right moment to unify them.
// module-scoped the way spacePan and gestureLive are, because the requester
// (the menu shell) and the consumer (the panel) share no react ancestry

export class FramesReveal {
	private pending = false;
	private target: (() => void) | null = null;

	/** focus the Δx field with its content selected, now or on the panel's
	 * next mount -- whichever comes first */
	requestOffsetFocus(): void {
		if (this.target !== null) this.target();
		else this.pending = true;
	}

	/** the mounted panel's focus action; returns the detach. a request that
	 * arrived while nothing was mounted fires immediately */
	attach(target: () => void): () => void {
		this.target = target;
		if (this.pending) {
			this.pending = false;
			target();
		}
		return () => {
			if (this.target === target) this.target = null;
		};
	}
}

/** app-wide, alongside spacePan, pressDrag and gestureLive */
export const framesReveal = new FramesReveal();
