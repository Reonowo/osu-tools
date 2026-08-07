// the meta tab: player name and mods (both real, both inert), then the
// locked list of header fields export regenerates from the judgement
// timeline rather than ever writing back. header + scrolling body together,
// so SidePanel can mount this as a single self-contained panel

import { Check, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PanelHeader } from "@/components/shell/SidePanel";
import { formatMods } from "@/lib/format";
import { useViewerStore } from "@/state/store";
import { InertNotice } from "./InertNotice";
import { SectionLabel } from "./SectionLabel";

function LockedRow({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
	const Icon = warning ? TriangleAlert : Check;
	return (
		<div className="flex items-center justify-between gap-2 text-[11px]">
			<span className="flex items-center gap-1.5 text-[#8a8a93]">
				<Icon
					className={warning ? "size-3 shrink-0 text-[#ffcc22]" : "size-3 shrink-0 text-[#88b300]"}
					aria-hidden
				/>
				{label}
			</span>
			<span className="text-right text-[#e4e4e7] tabular-nums">{value}</span>
		</div>
	);
}

export function MetadataPanel() {
	const scene = useViewerStore((s) => s.scene);
	if (scene === null) return null;
	const { replay } = scene;

	// formatMods joins active mod names with a space (or "none"); splitting
	// back into chips is still real data, just re-shaped for the badge row
	const modsText = formatMods(replay.mods);
	const modChips = modsText === "none" ? ["none"] : modsText.split(" ");

	return (
		<>
			<PanelHeader title="meta" />
			<div
				data-native-wheel=""
				className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto overflow-x-hidden p-3.5"
			>
				<InertNotice>metadata editing needs the replay-document ipc commands</InertNotice>

				<label className="block text-[10px] text-[#8a8a93]">
					player name
					<Input disabled readOnly value={replay.playerName ?? ""} className="mt-1" />
				</label>

				<div>
					<SectionLabel>mods</SectionLabel>
					<div className="mt-[7px] flex flex-wrap gap-1.5">
						{modChips.map((mod) => (
							<Badge key={mod} variant="secondary">
								{mod}
							</Badge>
						))}
					</div>
				</div>

				<div className="rounded-[9px] border border-border bg-surface-card px-3 py-[9px]">
					<SectionLabel>regenerated on export</SectionLabel>
					<div className="mt-2 flex flex-col gap-[7px]">
						<LockedRow label="300" value={replay.count300.toLocaleString()} />
						<LockedRow label="100" value={replay.count100.toLocaleString()} />
						<LockedRow label="50" value={replay.count50.toLocaleString()} />
						<LockedRow label="miss" value={replay.countMiss.toLocaleString()} />
						<LockedRow label="geki / katu" value={`${replay.countGeki} / ${replay.countKatsu}`} />
						<LockedRow label="max combo" value={`${replay.maxCombo}x`} />
						<LockedRow label="perfect" value={replay.perfect ? "yes" : "no"} />
						<LockedRow label="total score" value={replay.totalScore.toLocaleString()} />
						<LockedRow label="life bar graph" value="written empty" warning />
					</div>
				</div>

				<p className="text-[10.5px] leading-[1.55] text-[#8a8a93]">
					these fields are derived from the simulated judgement timeline and cannot be edited directly. an
					HP-drain port is still missing, so the life bar is written empty rather than carried over.
				</p>
			</div>
		</>
	);
}
