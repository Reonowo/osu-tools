// skin: the picker. every row's decision surface lives in `skin/picker.ts`,
// which is covered headlessly; this file is the jsx over it.
//
// no thumbnails, deliberately: skins do not ship one, and generating one means
// standing up a second offscreen render target for something that is one click
// from being visible on the real playfield.

import { useEffect } from "react";
import { AlertTriangle, Check, FolderOpen, Import } from "lucide-react";
import { Button } from "@/components/ui/button";
import { rowLabel, skinRows, SOURCE_LABELS, fallbackNotice } from "@/skin/picker";
import { useViewerStore } from "@/state/store";
import { cn } from "@/lib/utils";

export function SkinCategory({
	onBrowseFolder,
	onImportArchive
}: {
	/** both pickers live in the dialog rather than here: the panels unmount on
	 * a category switch, and a native dialog that outlived its panel would
	 * resolve into a component that is gone */
	onBrowseFolder: () => void;
	onImportArchive: () => void;
}) {
	const skins = useViewerStore((s) => s.skins);
	const active = useViewerStore((s) => s.skin);
	const skinNotice = useViewerStore((s) => s.skinNotice);
	const refreshSkins = useViewerStore((s) => s.refreshSkins);
	const selectSkin = useViewerStore((s) => s.selectSkin);

	// re-walked on open rather than held live: a stable install with a hundred
	// skins is a directory walk, not a subscription, and a skin the user added
	// outside the app should appear without a restart
	useEffect(() => {
		void refreshSkins();
	}, [refreshSkins]);

	// import.meta.env.DEV is vite's build-time flag, so the gate compiles out
	// of a shipped bundle rather than being a runtime branch someone can trip
	const rows = skinRows(skins, active);
	// two different things to say, and they can both be true: the fallback
	// notice explains what loaded, the skin notice explains what did not
	const notice = fallbackNotice(active);

	return (
		<div className="flex flex-col gap-3 text-sm">
			{skinNotice !== null && (
				<div className="flex items-start gap-2 rounded border border-amber-700/50 bg-amber-950/40 px-2 py-1.5 text-xs text-amber-200">
					<AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
					<span className="min-w-0">{skinNotice}</span>
				</div>
			)}

			{notice !== null && (
				<div className="flex items-start gap-2 rounded border border-amber-700/50 bg-amber-950/40 px-2 py-1.5 text-xs text-amber-200">
					<AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
					<span className="min-w-0">{notice}</span>
				</div>
			)}

			<div className="flex flex-col gap-1">
				{rows.map((row) => (
					<button
						key={`${row.locator.kind}:${row.locator.kind === "bundled" ? "" : row.locator.path}`}
						type="button"
						disabled={!row.selectable}
						aria-pressed={row.selected}
						onClick={() => void selectSkin(row.locator)}
						className={cn(
							"flex items-center gap-2 rounded px-2 py-1.5 text-left",
							row.selectable ? "hover:bg-zinc-800" : "cursor-not-allowed opacity-60",
							row.selected && "bg-zinc-800"
						)}
					>
						<Check
							className={cn("size-3.5 shrink-0", row.selected ? "opacity-100" : "opacity-0")}
							aria-hidden
						/>
						<span className="min-w-0 flex-1">
							<span className="block truncate">{rowLabel(row)}</span>
							{row.author.trim() !== "" && (
								<span className="block truncate text-xs text-zinc-400">{row.author}</span>
							)}
							{/* a refused skin still shows -- omitting it would leave the
							    user hunting for a skin they can see on disk */}
							{row.refusal !== null && (
								<span className="block truncate text-xs text-amber-400">{row.refusal}</span>
							)}
						</span>
						<span className="shrink-0 rounded bg-zinc-700/60 px-1.5 py-0.5 text-[0.65rem] text-zinc-300">
							{SOURCE_LABELS[row.source]}
						</span>
					</button>
				))}
			</div>

			<div className="flex items-center gap-2">
				<Button size="sm" variant="secondary" onClick={onBrowseFolder}>
					<FolderOpen className="size-3.5" aria-hidden />
					browse…
				</Button>
				<Button size="sm" variant="secondary" onClick={onImportArchive}>
					<Import className="size-3.5" aria-hidden />
					import .osk
				</Button>
			</div>
		</div>
	);
}
