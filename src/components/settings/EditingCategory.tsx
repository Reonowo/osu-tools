// editing: how the editor behaves, the one genuinely mode-scoped category.
// tool hotkeys land here when the keybinding scheme does (TODO.md)

import { ToggleRow } from "@/components/settings/ToggleRow";
import { useViewerStore, type EditingSettings } from "@/state/store";

export const EDITING_TOGGLES: { key: keyof EditingSettings; label: string; description: string }[] = [
	{
		key: "snapToLattice",
		label: "snap frame edits to input lattice",
		description: "rounds edited coordinates onto the grid this replay's own untouched frames sit on"
	},
	{
		key: "warnOnOverwrite",
		label: "warn before overwriting a replay",
		description: "asks first when an export would replace an existing .osr"
	}
];

export function EditingCategory() {
	const editing = useViewerStore((s) => s.editing);
	const setEditing = useViewerStore((s) => s.setEditing);

	return (
		<div className="space-y-2">
			{EDITING_TOGGLES.map(({ key, label, description }) => (
				<ToggleRow
					key={key}
					label={label}
					description={description}
					checked={editing[key]}
					onCheckedChange={(v) => setEditing(key, v)}
				/>
			))}
			<p className="text-xs text-zinc-500">
				the lattice is inferred per replay from its own untouched frames. turning snapping off produces
				coordinates no real client would emit.
			</p>
		</div>
	);
}
