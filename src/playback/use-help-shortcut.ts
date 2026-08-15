// the help overlay's own registration, kept out of use-playback-shortcuts for
// one reason: that hook mounts with AppShell, which exists only once a scene
// is loaded, and this binding has to work on the start screen. App is the
// lifetime this needs, so App is where it registers.
//
// it is also the one global binding that is not scene-gated. every other one
// declines with no scene loaded; this one does not, because a keybind list is
// most useful to someone who has not opened a replay yet -- the same reason
// the settings dialog is reachable there

import { useMemo } from "react";
import { useHotkeys, type Hotkey, type UseHotkeyDefinition } from "@tanstack/react-hotkeys";
import { captureArm } from "@/playback/capture-arm";
import { focusModality } from "@/playback/focus-modality";
import { keybindRow } from "@/playback/keybinds";
import { controlOwnsKeydown } from "@/playback/shortcut-guards";
import { useViewerStore, viewerStore } from "@/state/store";

export function useHelpShortcut() {
	const table = useViewerStore((s) => s.effectiveKeybinds);
	const bindings = keybindRow(table, "showHelp").bindings;

	const definitions = useMemo<UseHotkeyDefinition[]>(
		() =>
			bindings.map((binding) => ({
				// the Hotkey union enumerates the key names of the layouts the
				// library knows; a rebinding is not bound by that (keybinds.ts)
				hotkey: binding.hotkey as Hotkey,
				callback: (e: KeyboardEvent) => {
					// no scene check, deliberately -- see the module comment. the
					// focus rules still apply: a text field keeps its keys, and an
					// open dialog keeps its own, so F1 over the settings modal does
					// not stack a second one on top of it
					if (captureArm.armed) return;
					if (controlOwnsKeydown(e, focusModality.keyboardFocus)) return;
					// the webview has no F1 default, but a rebinding might land on a
					// key that does
					e.preventDefault();
					viewerStore.getState().setHelpOpen(true);
				}
			})),
		[bindings]
	);

	// the same disabled defaults every other registration in this app takes:
	// the explicit preventDefault above is the only event-flow mutation, and
	// controlOwnsKeydown covers what ignoreInputs was protecting
	useHotkeys(definitions, { preventDefault: false, stopPropagation: false, ignoreInputs: false });
}
