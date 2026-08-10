// the meta tab: player name and timestamp (real editors), mods (read-only),
// then the locked list of header fields export regenerates from the
// judgement timeline rather than ever writing back. header + scrolling body
// together, so SidePanel can mount this as a single self-contained panel

import { useEffect, useState } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PanelHeader } from "@/components/shell/SidePanel";
import { formatMods, ticksToUnixMs, unixMsToTicks } from "@/lib/format";
import { useViewerStore } from "@/state/store";
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

/** local wall-clock "YYYY-MM-DDTHH:mm:ss" for a datetime-local input */
function toLocalInput(unixMs: number): string {
	const d = new Date(unixMs);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
		d.getMinutes()
	)}:${pad(d.getSeconds())}`;
}

export function MetadataPanel() {
	const scene = useViewerStore((s) => s.scene);
	const commitEdit = useViewerStore((s) => s.commitEdit);

	// the epoch is in both draft-sync deps so a replay swap resets the drafts
	// even when the new scene renders the identical value
	const [nameDraft, setNameDraft] = useState(scene?.replay.playerName ?? "");
	useEffect(() => setNameDraft(scene?.replay.playerName ?? ""), [scene?.epoch, scene?.replay.playerName]);

	// datetime-local speaks local wall-clock time at second granularity; the
	// draft only commits when it differs from what the current ticks render
	// to, so an untouched field never rewrites sub-second precision. ticks
	// that fail to parse (or predate the unix epoch) have no local rendering,
	// so the field falls back to empty rather than throwing
	const playedMs = scene === null ? null : ticksToUnixMs(scene.replay.timestampTicks);
	const playedLocal = playedMs === null ? "" : toLocalInput(playedMs);
	const [timeDraft, setTimeDraft] = useState(playedLocal);
	useEffect(() => setTimeDraft(playedLocal), [scene?.epoch, playedLocal]);

	if (scene === null) return null;
	const { replay } = scene;

	function commitName() {
		// the ui cannot distinguish null from empty; an emptied field commits
		// null, the honest "no name"
		const name = nameDraft.trim() === "" ? null : nameDraft;
		if (name === replay.playerName) return;
		void commitEdit({
			label: "player name",
			payload: { kind: "ops", ops: [{ kind: "setPlayerName", name }] }
		});
	}

	function commitTimestamp() {
		if (timeDraft === playedLocal) return;
		const ms = new Date(timeDraft).getTime();
		if (!Number.isFinite(ms)) {
			setTimeDraft(playedLocal);
			return;
		}
		void commitEdit({
			label: "timestamp",
			payload: { kind: "ops", ops: [{ kind: "setTimestamp", ticks: unixMsToTicks(ms) }] }
		});
	}

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
				<label className="block text-[10px] text-[#8a8a93]">
					player name
					<Input
						value={nameDraft}
						onChange={(e) => setNameDraft(e.target.value)}
						onBlur={commitName}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitName();
						}}
						className="mt-1"
					/>
				</label>

				<label className="block text-[10px] text-[#8a8a93]">
					played
					<Input
						type="datetime-local"
						step={1}
						value={timeDraft}
						onChange={(e) => setTimeDraft(e.target.value)}
						onBlur={commitTimestamp}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitTimestamp();
						}}
						className="mt-1"
					/>
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
					these fields are derived from the simulated judgement timeline and regenerate on export; only the
					player name and timestamp above are directly editable. an HP-drain port is still missing, so the
					life bar is written empty rather than carried over.
				</p>
			</div>
		</>
	);
}
