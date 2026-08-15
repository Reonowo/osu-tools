// the keybind list on F1: a read-only presentation of the same rows the
// keybinds settings category lists, not a second list -- so it shows the
// user's own rebindings rather than a stock app's, and a keybind declared in
// the table later appears here for free.
//
// reachable with no replay loaded, the way the settings dialog already is: a
// keybind list is most useful to someone who has not started yet

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KeybindList } from "@/components/settings/KeybindsCategory";
import { formatBindings, keybindRow } from "@/playback/keybinds";
import { useViewerStore } from "@/state/store";

export function HelpOverlay() {
	const open = useViewerStore((s) => s.helpOpen);
	const setHelpOpen = useViewerStore((s) => s.setHelpOpen);
	const table = useViewerStore((s) => s.effectiveKeybinds);
	// the help key names itself, since a user who unbound it has no other way
	// back to this overlay than the settings category
	const helpKeys = formatBindings(keybindRow(table, "showHelp").bindings);

	return (
		<Dialog open={open} onOpenChange={setHelpOpen}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>keybinds</DialogTitle>
					<DialogDescription>
						{helpKeys === null ? "settings → keybinds" : `${helpKeys} anywhere`} — change any of these in
						settings → keybinds
					</DialogDescription>
				</DialogHeader>
				{/* the same pinned viewport the settings dialog uses, for the same
				    reason: the list grows with the inventory and the frame should
				    not move every time it does */}
				<div className="min-h-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
					<KeybindList table={table} />
				</div>
			</DialogContent>
		</Dialog>
	);
}
