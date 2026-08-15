// whether a keybind capture is armed. the settings row that arms it is deep
// in the dialog tree, and the modules that must not act on the keystroke it is
// waiting for -- use-playback-shortcuts' guard, use-edit-tools' window
// listener -- have no way to see it. published here the way spacePan.armed,
// pressDrag.live and gestureLive.active already are, rather than as a fourth
// invented pattern.
//
// the settings modal's own dialog arm already makes every *hotkey* binding
// decline through controlOwnsKeydown. this exists for the listeners the hotkey
// manager does not mediate: use-edit-tools and the code-matched viewport
// reset attach their own window handlers, and neither would otherwise know

export class CaptureArm {
	private held = false;

	/** true from the moment a binding slot is armed until the capture is read,
	 * cancelled, or the slot loses focus */
	get armed(): boolean {
		return this.held;
	}

	set(armed: boolean): void {
		this.held = armed;
	}
}

/** app-wide, alongside spacePan, pressDrag and gestureLive */
export const captureArm = new CaptureArm();
