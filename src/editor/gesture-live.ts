// whether a cursor-path gesture is under way. the gesture controller is local
// to use-edit-tools' effect, so a module that must not act mid-drag -- the
// tool keybinds, which would otherwise swap the tool out from under a live
// gesture -- has no way to see it. published here the way spacePan.armed and
// pressDrag.live already are, rather than as a second invented pattern

export class GestureLive {
	private held = false;

	/** true from pointer-down until the gesture ends, however it ends:
	 * release, pointer cancellation, Escape, or a structural splice
	 * invalidating the gesture base */
	get active(): boolean {
		return this.held;
	}

	set(active: boolean): void {
		this.held = active;
	}
}

/** app-wide, alongside spacePan, pressDrag and gesturePreview */
export const gestureLive = new GestureLive();
