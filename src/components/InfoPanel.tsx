import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatAccuracy, formatMods } from "@/lib/format";
import { useViewerStore } from "@/state/store";

export function InfoPanel() {
	const scene = useViewerStore((s) => s.scene);
	const [openState, setOpen] = useState(true);
	if (scene === null) return null;
	const { replay, beatmap, simulation } = scene;
	// osu! standard accuracy: weighted hit value over total judged hits, straight
	// from the .osr header counts -- available even when simulation is off
	const judged = replay.count300 + replay.count100 + replay.count50 + replay.countMiss;
	const accuracy =
		judged === 0 ? 0 : (300 * replay.count300 + 100 * replay.count100 + 50 * replay.count50) / (300 * judged);
	const rows: [string, string][] = [
		["player", replay.playerName ?? "unknown"],
		["mods", formatMods(replay.mods)],
		["score", replay.totalScore.toLocaleString()],
		["combo", `${replay.maxCombo}x`],
		["accuracy", formatAccuracy(accuracy)],
		["hits", `${replay.count300} / ${replay.count100} / ${replay.count50} / ${replay.countMiss}`],
		["cs / ar / od", `${beatmap.circleSize} / ${beatmap.approachRate} / ${beatmap.overallDifficulty}`],
		["simulation", simulation.status === "authoritative" ? "authoritative" : `off (${simulation.reason})`]
	];
	return (
		// stacked above Controls.tsx's live combo readout (same bottom-left dock,
		// same left-3 anchor) rather than sharing its box: the combo counter sits
		// at bottom-24 with a fixed 36px (text-3xl line-height) height, so its top
		// edge is 132px up from the container bottom; bottom-36 (144px) clears
		// that with a 12px gap regardless of this panel's collapsed/expanded
		// height, since collapsing only ever shrinks the panel upward, never down
		// into the combo's box
		<aside className="pointer-events-auto absolute bottom-36 left-3 z-20 w-64 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/85 text-xs shadow-xl shadow-black/30 backdrop-blur">
			<Button
				variant="ghost"
				size="sm"
				className="w-full justify-between rounded-none px-3 font-medium text-zinc-300 hover:text-zinc-100"
				onClick={() => setOpen(!openState)}
			>
				replay info {openState ? <ChevronDown /> : <ChevronUp />}
			</Button>
			{openState && (
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 border-t border-zinc-800/80 px-3 py-3">
					{rows.map(([k, v]) => (
						<div key={k} className="contents">
							<dt className="text-zinc-500">{k}</dt>
							<dd className="truncate text-right tabular-nums text-zinc-200">{v}</dd>
						</div>
					))}
				</dl>
			)}
		</aside>
	);
}
