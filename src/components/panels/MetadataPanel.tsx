// the meta tab: player name and timestamp (real editors), mods (read-only),
// then the locked list of header fields export regenerates from the
// judgement timeline rather than ever writing back. header + scrolling body
// together, so SidePanel can mount this as a single self-contained panel

import { useEffect, useState } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PanelHeader } from "@/components/shell/SidePanel";
import { ticksToUnixMs, unixMsToTicks } from "@/lib/format";
import { effectiveModRows, modProvenanceNote } from "@/lib/metadata-panel";
import { useViewerStore } from "@/state/store";
import { SectionLabel } from "./SectionLabel";

function LockedRow({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
	const Icon = warning ? TriangleAlert : Check;
	return (
		<div className="flex items-center justify-between gap-2 text-row">
			<span className="flex items-center gap-1.5 text-muted-foreground">
				<Icon
					className={warning ? "size-3 shrink-0 text-grade-meh" : "size-3 shrink-0 text-grade-ok"}
					aria-hidden
				/>
				{label}
			</span>
			<span className="text-right text-foreground tabular-nums">{value}</span>
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
	// the life bar row is the one field whose fate depends on WHICH export
	// this document would take: regenerated once frames are edited, carried
	// from the source otherwise. every other row here is a value, so only
	// this one has to read the dirty split
	const framesDirty = useViewerStore((s) => s.editor?.framesDirty ?? false);

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

	// the effective mods off the play configuration: a stable file's legacy
	// chips exactly as before, a lazer file's block entries with their changed
	// settings, and a provenance line when the list was inferred rather than
	// read
	const modRows = effectiveModRows(scene);
	const provenance = modProvenanceNote(scene);

	return (
		<>
			<PanelHeader title="meta" />
			<div
				data-native-wheel=""
				className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto overflow-x-hidden p-3.5"
			>
				<label className="block text-meta text-muted-foreground">
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

				<label className="block text-meta text-muted-foreground">
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
					<div className="mt-stack flex flex-wrap gap-1.5">
						{modRows.length === 0 && scene.configuration.provenance !== "unresolvable" && (
							<Badge variant="secondary">none</Badge>
						)}
						{modRows.map((mod) => (
							<Badge key={mod.acronym} variant="secondary" title={mod.settings.join(", ") || undefined}>
								{mod.acronym}
								{mod.settings.length > 0 && (
									<span className="ml-1 text-grade-meh">· {mod.settings.join(", ")}</span>
								)}
							</Badge>
						))}
					</div>
					{provenance !== null && <p className="mt-stack text-caption text-muted-foreground">{provenance}</p>}
				</div>

				<div className="card">
					<SectionLabel>regenerated on export</SectionLabel>
					<div className="mt-2 flex flex-col gap-stack">
						<LockedRow label="300" value={replay.count300.toLocaleString()} />
						<LockedRow label="100" value={replay.count100.toLocaleString()} />
						<LockedRow label="50" value={replay.count50.toLocaleString()} />
						<LockedRow label="miss" value={replay.countMiss.toLocaleString()} />
						<LockedRow label="geki / katu" value={`${replay.countGeki} / ${replay.countKatsu}`} />
						<LockedRow label="max combo" value={`${replay.maxCombo}x`} />
						<LockedRow label="perfect" value={replay.perfect ? "yes" : "no"} />
						<LockedRow label="total score" value={replay.totalScore.toLocaleString()} />
						<LockedRow label="life bar graph" value={framesDirty ? "regenerated" : "carried over"} />
					</div>
				</div>

				<p className="text-caption text-muted-foreground">
					these fields are derived from the simulated judgement timeline and regenerate on export; only the
					player name and timestamp above are directly editable. a frame-edited export regenerates the life
					bar graph from the re-simulated play; a metadata-only one carries the source's own over untouched.
				</p>
			</div>
		</>
	);
}
