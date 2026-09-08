// the replay browser's own registration, the third binding kept out of
// use-playback-shortcuts for the reason the other two are: that hook mounts
// with AppShell, which exists only once a scene is loaded, and this one has
// to work on the start screen -- which is where a user with no replay open is
// most likely to reach for it.
//
// it is a chord beside the open accelerator rather than a replacement for it:
// Ctrl+O reaches the file picker and the recents, Ctrl+Shift+O reaches
// everything the osu! client itself knows about

import { useMemo } from "react";
import { useHotkeys, type Hotkey, type UseHotkeyDefinition } from "@tanstack/react-hotkeys";
import { captureArm } from "@/playback/capture-arm";
import { focusModality } from "@/playback/focus-modality";
import { keybindRow } from "@/playback/keybinds";
import { controlOwnsKeydown } from "@/playback/shortcut-guards";
import { useViewerStore, viewerStore } from "@/state/store";

export function useBrowserShortcut() {
	const table = useViewerStore((s) => s.effectiveKeybinds);
	const bindings = keybindRow(table, "replayBrowser").bindings;

	const definitions = useMemo<UseHotkeyDefinition[]>(
		() =>
			bindings.map((binding) => ({
				// the Hotkey union enumerates the key names of the layouts the
				// library knows; a rebinding is not bound by that (keybinds.ts)
				hotkey: binding.hotkey as Hotkey,
				callback: (e: KeyboardEvent) => {
					// no scene check, deliberately -- see the module comment. the
					// focus rules still apply: a text field keeps its keys, and an
					// open dialog keeps its own, so the chord pressed inside the
					// browser's own search box does not toggle it shut
					if (captureArm.armed) return;
					if (controlOwnsKeydown(e, focusModality.keyboardFocus)) return;
					// the webview has its own ctrl+shift+O in some builds
					e.preventDefault();
					// after the claim, as everywhere else: a held chord stays
					// suppressed rather than reaching the webview on every repeat
					if (e.repeat) return;
					viewerStore.getState().setBrowserOpen(true);
				}
			})),
		[bindings]
	);

	// the same disabled defaults every other registration in this app takes:
	// the explicit preventDefault above is the only event-flow mutation, and
	// controlOwnsKeydown covers what ignoreInputs was protecting
	useHotkeys(definitions, { preventDefault: false, stopPropagation: false, ignoreInputs: false });
}
