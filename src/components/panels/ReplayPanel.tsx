// the replay tab's panel body: accuracy/grade, the judgement bar, the score
// card, and the beatmap stat tiles. header + scrolling body together, so
// SidePanel can mount this as a single self-contained panel. a pure display
// of the derive layer's ReplayStats: counts, accuracy, grade, and max combo
// are simulated-primary (the engine re-judges every edit, so they go live
// the moment a delta lands) with the .osr header's value as the dimmed "was"
// reference wherever an edit has drifted them; score and geki/katu have no
// simulation to follow and sit grouped under the file-header caption

import { PanelHeader } from "@/components/shell/SidePanel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RankGrade, ReplayStat } from "@/lib/derive";
import { ticksToUnixMs } from "@/lib/format";
import {
	nativeStatistics,
	recordedInFile,
	replayHeaderTrailing,
	resultLabel,
	simulatedStatsLabel
} from "@/lib/replay-panel";
import { useViewerStore } from "@/state/store";

// osu!'s own logotype slant (see TopBar.tsx), reused for the grade tile so
// it reads as part of the same visual language; the counter-skew keeps the
// letter upright inside it
const TILE_SKEW = "skew-x-[-11.3deg]";
const TILE_COUNTER_SKEW = "skew-x-[11.3deg]";

// osucolour.cs's Blue/Green/Yellow/Red, also used by the judgement bar below
// and by renderer/drawables/judgement-tracks.ts's GRADE_COLOURS -- kept as a
// separate literal table here since that module's values are pixi tint
// numbers, not css colours
const GRADE_TILE_COLOURS: Record<RankGrade, { fill: string; text: string }> = {
	SS: { fill: "#66ccff", text: "#0a1218" },
	S: { fill: "#66ccff", text: "#0a1218" },
	A: { fill: "#88b300", text: "#11170a" },
	B: { fill: "#ffcc22", text: "#1a1400" },
	C: { fill: "#ffcc22", text: "#1a1400" },
	D: { fill: "#ed1121", text: "#1b0505" },
	F: { fill: "#ed1121", text: "#1b0505" }
};

// the four-letter tiles are the app's most compressed readout; each carries
// what the letters stand for and what raising the number actually does
const DIFFICULTY_TILES = [
	["cs", "circleSize", "circle size — larger values make every hit object smaller"],
	["ar", "approachRate", "approach rate — larger values give you less time to see an object before it must be hit"],
	["od", "overallDifficulty", "overall difficulty — larger values narrow the timing windows for a 300/100/50"],
	["hp", "hpDrainRate", "hp drain rate — larger values drain the life bar faster and punish misses harder"]
] as const;

/** the dimmed "was N" header reference a drifted row carries; nothing when
 * the row still matches the file (or nothing was simulated at all) -- the
 * reference would just repeat the value it sits beside */
function WasLabel({ stat, suffix = "" }: { stat: ReplayStat; suffix?: string }) {
	if (stat.value === stat.header) return null;
	return (
		<span className="text-[10px] text-[#71717a] tabular-nums">
			was {stat.header.toLocaleString()}
			{suffix}
		</span>
	);
}

export function ReplayPanel() {
	const scene = useViewerStore((s) => s.scene);
	const stats = useViewerStore((s) => s.derived?.stats ?? null);
	if (scene === null || stats === null) return null;
	const { replay, beatmap, renderPlan } = scene;

	const tile = GRADE_TILE_COLOURS[stats.grade.value];
	const accuracyDrifted = stats.accuracy.value !== stats.accuracy.header || stats.grade.value !== stats.grade.header;

	const judgementSegments = [
		{ label: "300", stat: stats.count300, colour: "#66ccff" },
		{ label: "100", stat: stats.count100, colour: "#88b300" },
		{ label: "50", stat: stats.count50, colour: "#ffcc22" },
		{ label: "miss", stat: stats.countMiss, colour: "#ed1121" }
	];
	const judged = judgementSegments.reduce((sum, segment) => sum + segment.stat.value, 0);

	const playedMs = ticksToUnixMs(replay.timestampTicks);
	const playedText =
		playedMs === null
			? "unknown"
			: new Date(playedMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
	// the approximate label rides beside the stats it qualifies, and the
	// file's own block is read into the recorded-in-file card, both off the
	// panel's pure selectors
	const statsLabel = simulatedStatsLabel(scene);
	const recorded = recordedInFile(replay.scoreInfo, scene.configuration.profile);
	// the native statistics row: what lazer counted beyond the four tiles,
	// with the block's own count as the frozen "was"
	const native = nativeStatistics(scene);

	return (
		<>
			<PanelHeader title="replay" trailing={replayHeaderTrailing(scene)} />
			<div
				data-native-wheel=""
				className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-x-hidden overflow-y-auto p-3.5"
			>
				{/* an approximate simulation is labelled where its numbers start,
				naming the profile it ran under, so the stats below are never read
				as the play's own */}
				{statsLabel !== null && (
					<div className="rounded-[7px] border border-[#ffcc2240] bg-[#ffcc220f] px-2.5 py-1.5 text-[10.5px] text-[#ffcc22]">
						simulated {statsLabel}
					</div>
				)}

				{/* accuracy + grade tile, simulated-primary; the "was" line keeps
				the header readout visible once an edit drifts it */}
				<div className="flex items-center justify-between">
					<div>
						<div className="text-[9.5px] font-semibold tracking-[.14em] text-[#8a8a93] uppercase">
							accuracy
						</div>
						<div className="text-[30px] font-bold tracking-[-.02em] text-[#f4f4f5] tabular-nums select-text">
							{(stats.accuracy.value * 100).toFixed(2)}
							<span className="text-[17px] text-[#71717a]">%</span>
						</div>
						{accuracyDrifted && (
							<div className="text-[10.5px] text-[#71717a] tabular-nums select-text">
								was {(stats.accuracy.header * 100).toFixed(2)}% · {stats.grade.header}
							</div>
						)}
					</div>
					<div
						className={`flex size-[42px] ${TILE_SKEW} items-center justify-center rounded-lg`}
						style={{ backgroundColor: tile.fill }}
					>
						<span className={`${TILE_COUNTER_SKEW} text-lg font-black`} style={{ color: tile.text }}>
							{stats.grade.value}
						</span>
					</div>
				</div>

				{/* judgement bar + legend, live counts */}
				<div>
					<div className="flex h-[7px] gap-px rounded bg-[#18181b]">
						{judgementSegments.map((segment) => (
							<div
								key={segment.label}
								className="h-full"
								style={{
									width: judged > 0 ? `${(segment.stat.value / judged) * 100}%` : 0,
									backgroundColor: segment.colour
								}}
							/>
						))}
					</div>
					<div className="mt-[7px] grid grid-cols-2 gap-x-3.5 gap-y-[5px]">
						{judgementSegments.map((segment) => (
							<div key={segment.label} className="flex items-center gap-1.5 text-[11px]">
								<span
									className="size-[7px] shrink-0 rounded-[2px]"
									style={{ backgroundColor: segment.colour }}
								/>
								<span className="text-[#a1a1aa]">{segment.label}</span>
								<span className="ml-auto flex items-baseline gap-1.5 select-text">
									<WasLabel stat={segment.stat} />
									<span className="text-[#e4e4e7] tabular-nums">
										{segment.stat.value.toLocaleString()}
									</span>
								</span>
							</div>
						))}
					</div>
					{/* the native statistics row: every result kind lazer counted beyond
					the four tiles, in lazer's own order, the block's own count as the
					frozen "was" wherever it differs */}
					{native !== null && native.length > 0 && (
						<div className="mt-[7px] border-t border-border pt-[7px]">
							<div className="mb-[5px] text-[9.5px] font-semibold tracking-[.14em] text-[#8a8a93] uppercase">
								native results
							</div>
							<div className="grid grid-cols-2 gap-x-3.5 gap-y-[5px]">
								{native.map((entry) => (
									<div key={entry.result} className="flex items-center gap-1.5 text-[11px]">
										<span className="text-[#a1a1aa]">{resultLabel(entry.result)}</span>
										<span className="ml-auto flex items-baseline gap-1.5 select-text">
											{entry.recorded !== null && entry.recorded !== entry.count && (
												<span className="text-[10px] text-[#8a8a93] tabular-nums">
													was {entry.recorded.toLocaleString()}
												</span>
											)}
											<span className="text-[#e4e4e7] tabular-nums">
												{entry.count.toLocaleString()}
											</span>
										</span>
									</div>
								))}
							</div>
						</div>
					)}
					{/* max combo and the score ride with the simulated stats, not the header
					card: the simulation recounts one and re-folds the other on every
					edit */}
					<div className="mt-[7px] flex items-center gap-1.5 text-[11px]">
						<span className="text-[#a1a1aa]">max combo</span>
						<span className="ml-auto flex items-baseline gap-1.5 select-text">
							<WasLabel stat={stats.maxCombo} suffix="x" />
							<span className="text-[#e4e4e7] tabular-nums">{stats.maxCombo.value}x</span>
						</span>
					</div>
					<div className="mt-[5px] flex items-center gap-1.5 text-[11px]">
						<span className="text-[#a1a1aa]">score</span>
						<span className="ml-auto flex items-baseline gap-1.5 select-text">
							<WasLabel stat={stats.totalScore} />
							<span className="text-[#e4e4e7] tabular-nums">
								{stats.totalScore.value.toLocaleString()}
							</span>
						</span>
					</div>
				</div>

				{/* the header card: everything simulation cannot recount. geki and
				katu stay the file's own numbers until export regenerates them --
				taking them live needs a derive_score call per resimulation, which
				TODO.md records -- so they are grouped under this caption rather than
				mixed into the live rows above */}
				<div>
					<div className="mb-[5px] text-[9.5px] font-semibold tracking-[.14em] text-[#8a8a93] uppercase">
						recorded in file
					</div>
					<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-[7px] rounded-[9px] border border-border bg-surface-card px-3 py-[11px] text-[11px]">
						<div className="contents">
							<dt className="text-[#8a8a93]">geki / katu</dt>
							<dd className="text-right text-[#e4e4e7] tabular-nums select-text">
								{stats.countGeki} / {stats.countKatsu}
							</dd>
						</div>
						<div className="contents">
							<dt className="text-[#8a8a93]">perfect</dt>
							<dd className="text-right text-[#e4e4e7] select-text">{replay.perfect ? "yes" : "no"}</dd>
						</div>
						<div className="contents">
							<dt className="text-[#8a8a93]">played</dt>
							<dd className="text-right text-[#e4e4e7] tabular-nums select-text">{playedText}</dd>
						</div>
					</dl>
					{/* the file's own score-info block, kept apart from the header
					fields above it and from the simulated stats: what lazer wrote,
					or the stated reason there is nothing to show */}
					<div className="mt-2 rounded-[9px] border border-border bg-surface-card px-3 py-[9px] text-[11px]">
						<div className="mb-[5px] text-[9.5px] font-semibold tracking-[.14em] text-[#8a8a93] uppercase">
							score-info block
						</div>
						{recorded.kind !== "present" ? (
							<p className="leading-[1.5] text-[#8a8a93]">{recorded.note}</p>
						) : (
							<>
								<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-[5px]">
									{recorded.rows.map((row) => (
										<div key={row.label} className="contents">
											<dt className="text-[#8a8a93]">{row.label}</dt>
											<dd className="text-right text-[#e4e4e7] tabular-nums select-text">
												{row.value}
											</dd>
										</div>
									))}
								</dl>
								<div className="mt-[7px] text-[9.5px] font-semibold tracking-[.14em] text-[#8a8a93] uppercase">
									statistics
								</div>
								<dl className="mt-[3px] grid grid-cols-[auto_1fr] gap-x-3 gap-y-[3px]">
									{recorded.statistics.map((entry) => (
										<div key={entry.result} className="contents">
											<dt className="text-[#8a8a93]">{resultLabel(entry.result)}</dt>
											<dd className="text-right text-[#e4e4e7] tabular-nums select-text">
												{entry.count.toLocaleString()}
												{(() => {
													const max = recorded.maximumStatistics.find(
														(m) => m.result === entry.result
													);
													return max === undefined ? "" : ` / ${max.count.toLocaleString()}`;
												})()}
											</dd>
										</div>
									))}
								</dl>
							</>
						)}
					</div>
				</div>

				{/* beatmap stats -- bpm and combo elements are not in LoadedScene,
				see TODO.md's kiai-flash item for what surfacing them needs */}
				<div className="grid grid-cols-4 gap-1.5">
					{DIFFICULTY_TILES.map(([label, key, description]) => (
						<Tooltip key={label}>
							{/* a div, not a span: the tile itself is a block, and the
							wrapper is what the grid lays out */}
							<TooltipTrigger render={<div />}>
								<div className="rounded-[7px] border border-border bg-surface-card px-1.5 py-[7px] text-center">
									<div className="text-[9.5px] font-semibold tracking-[.14em] text-[#8a8a93] uppercase">
										{label}
									</div>
									<div className="text-[13px] font-semibold text-[#f4f4f5] tabular-nums select-text">
										{beatmap[key].toFixed(1)}
									</div>
								</div>
							</TooltipTrigger>
							<TooltipContent>{description}</TooltipContent>
						</Tooltip>
					))}
				</div>
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-[7px] text-[11px]">
					<div className="contents">
						<dt className="text-[#8a8a93]">objects</dt>
						<dd className="text-right text-[#e4e4e7] tabular-nums select-text">
							{renderPlan.objects.length}
						</dd>
					</div>
					<div className="contents">
						<dt className="text-[#8a8a93]">md5</dt>
						{/* the full hash in the dom, clipped by css rather than cut in
						the string: copying must yield the whole value */}
						<dd className="truncate text-right font-mono text-[#e4e4e7] select-text">{beatmap.md5}</dd>
					</div>
				</dl>
			</div>
		</>
	);
}
