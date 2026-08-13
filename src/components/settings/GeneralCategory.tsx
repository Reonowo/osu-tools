// general: the osu! stable install path. later, the custom Songs directory
// and the resolved-install status -- both bespoke controls like this one,
// which is why this category owns no per-key pref (categories.ts)

import { Button } from "@/components/ui/button";
import { useViewerStore } from "@/state/store";

export function GeneralCategory({
	saving,
	onPickInstall
}: {
	/** a path write is in flight, so both buttons are locked. owned by the
	 * dialog rather than by this panel: the panels unmount on a category
	 * switch, and a lock that unmounted with its panel would be gone by the
	 * time the write it guards resolves */
	saving: boolean;
	onPickInstall: () => void;
}) {
	const settings = useViewerStore((s) => s.settings);
	const saveStablePath = useViewerStore((s) => s.saveStablePath);

	return (
		<div className="flex items-center gap-2 text-sm">
			<code className="min-w-0 flex-1 truncate rounded bg-zinc-800 px-2 py-1 text-xs">
				{settings?.osuStablePath ?? "auto-detect"}
			</code>
			<Button size="sm" variant="secondary" disabled={saving} onClick={onPickInstall}>
				browse
			</Button>
			<Button
				size="sm"
				variant="ghost"
				disabled={saving || settings?.osuStablePath == null}
				onClick={() => void saveStablePath(null)}
			>
				reset
			</Button>
		</div>
	);
}
