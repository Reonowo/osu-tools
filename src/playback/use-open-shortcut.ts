// the open accelerator's own registration, kept out of use-playback-shortcuts
// for the reason use-help-shortcut is: that hook mounts with AppShell, which
// exists only once a scene is loaded, and this binding has to work on the start
// screen -- which is where a user would first try it.
//
// with a scene it opens the MENU, not the file picker: sending the keyboard
// route straight to a file dialog would skip the recents entirely, which is
// half of what the open menu exists to fix. browse… is the menu's first
// focusable row, so the picker is still one Enter away.
//
// on the start screen there is no menu to open, and no need for one: that
// screen already renders the recents in full, so the only part of the menu not
// already on the page is the browse row -- which is where this sends it. the
// rule the two branches share is "reach whatever this screen does not already
// show", never "reach the file dialog"

import { useMemo } from "react";
import { useHotkeys, type Hotkey, type UseHotkeyDefinition } from "@tanstack/react-hotkeys";
import { pickReplay } from "@/lib/openers";
import { captureArm } from "@/playback/capture-arm";
import { focusModality } from "@/playback/focus-modality";
import { keybindRow } from "@/playback/keybinds";
import { controlOwnsKeydown } from "@/playback/shortcut-guards";
import { useViewerStore, viewerStore } from "@/state/store";

export function useOpenShortcut() {
	const table = useViewerStore((s) => s.effectiveKeybinds);
	const bindings = keybindRow(table, "openMenu").bindings;

	const definitions = useMemo<UseHotkeyDefinition[]>(
		() =>
			bindings.map((binding) => ({
				// the Hotkey union enumerates the key names of the layouts the
				// library knows; a rebinding is not bound by that (keybinds.ts)
				hotkey: binding.hotkey as Hotkey,
				callback: (e: KeyboardEvent) => {
					// no scene check, deliberately -- see the module comment. the
					// focus rules still apply: a text field keeps its keys, and an
					// open dialog keeps its own, so ctrl+O while the discard prompt
					// is up does not stack another request behind it
					if (captureArm.armed) return;
					if (controlOwnsKeydown(e, focusModality.keyboardFocus)) return;
					// the webview has its own ctrl+O
					e.preventDefault();
					// after the claim, as everywhere else: a held chord stays
					// suppressed rather than reaching the webview on every repeat.
					// it has to be filtered at all because pickReplay awaits a
					// native dialog -- the repeats land in the ~half-second before
					// that dialog takes focus, and each one opens another
					if (e.repeat) return;
					const state = viewerStore.getState();
					if (state.scene === null) void pickReplay();
					else state.setOpenMenuOpen(true);
				}
			})),
		[bindings]
	);

	// the same disabled defaults every other registration in this app takes:
	// the explicit preventDefault above is the only event-flow mutation, and
	// controlOwnsKeydown covers what ignoreInputs was protecting
	useHotkeys(definitions, { preventDefault: false, stopPropagation: false, ignoreInputs: false });
}
