// one row of the recents, rendered identically by both surfaces that list
// them: the start screen's aside and the top bar's open menu. one list in two
// places rather than two lists -- which is also why it takes a plain
// `onOpen(osrPath)` rather than reading the store itself: the menu has to close
// as well as load, and the start screen has nothing to close.
//
// sized for the start screen's 400px aside, which is what sets the open menu's
// popover width (it is wider than the primitive's w-72 default for this reason)

import { formatAccuracy, formatRelativeTime } from "@/lib/format";
import type { RecentReplay } from "@/lib/scene-types";

export function RecentEntry({
	entry,
	nowMs,
	onOpen
}: {
	entry: RecentReplay;
	nowMs: number;
	onOpen: (osrPath: string) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onOpen(entry.osrPath)}
			className="flex w-full flex-col gap-1 rounded-[9px] border border-transparent px-2.5 py-[9px] text-left hover:bg-[#16161a]"
		>
			<div className="truncate text-[12px] font-medium text-[#e4e4e7]">
				{entry.title} <span className="text-[#71717a]">[{entry.version}]</span>
			</div>
			<div className="truncate font-mono text-[10px] text-[#71717a]">
				{entry.playerName ?? "unknown"} · {formatAccuracy(entry.accuracy)} · {entry.maxCombo}x ·{" "}
				{formatRelativeTime(entry.openedAtMs, nowMs)}
			</div>
		</button>
	);
}
