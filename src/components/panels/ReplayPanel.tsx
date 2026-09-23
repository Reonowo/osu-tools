// the replay tab's panel body: accuracy/grade, the judgement bar, the score
// card, and the beatmap stat tiles. header + scrolling body together, so
// SidePanel can mount this as a single self-contained panel. a pure display
// of the derive layer's ReplayStats: counts, accuracy, grade, and max combo
// are simulated-primary (the engine re-judges every edit, so they go live
// the moment a delta lands) with the .osr header's value as the dimmed "was"
// reference wherever an edit has drifted them; score and geki/katu have no
// simulation to follow and sit grouped under the file-header caption

import { PanelHeader } from "@/components/shell/SidePanel";
import { SectionLabel } from "@/components/panels/SectionLabel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GRADE_COLOUR, GRADE_ON_COLOUR } from "@/engine/osu-colours";
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
const TILE_SKEW = "skew-x-brand";
const TILE_COUNTER_SKEW = "skew-x-brand-inverse";

// osucolour.cs's Blue/Green/Yellow/Red (engine/osu-colours.ts), also used by
// the judgement bar below; renderer/drawables/judgement-tracks.ts keeps its
// own pixi-tint table since those values are tints, not css colours
const GRADE_TILE_COLOURS: Record<RankGrade, { fill: string; text: string }> = {
	SS: { fill: GRADE_COLOUR.great, text: GRADE_ON_COLOUR.great },
	S: { fill: GRADE_COLOUR.great, text: GRADE_ON_COLOUR.great },
	A: { fill: GRADE_COLOUR.ok, text: GRADE_ON_COLOUR.ok },
	B: { fill: GRADE_COLOUR.meh, text: GRADE_ON_COLOUR.meh },
	C: { fill: GRADE_COLOUR.meh, text: GRADE_ON_COLOUR.meh },
	D: { fill: GRADE_COLOUR.miss, text: GRADE_ON_COLOUR.miss },
	F: { fill: GRADE_COLOUR.miss, text: GRADE_ON_COLOUR.miss }
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
		<span className="text-meta text-foreground-dim tabular-nums">
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
		{ label: "300", stat: stats.count300, colour: GRADE_COLOUR.great },
		{ label: "100", stat: stats.count100, colour: GRADE_COLOUR.ok },
		{ label: "50", stat: stats.count50, colour: GRADE_COLOUR.meh },
		{ label: "miss", stat: stats.countMiss, colour: GRADE_COLOUR.miss }
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
					<div className="rounded-segment border border-grade-meh/[.251] bg-grade-meh/[.059] px-2.5 py-1.5 text-caption-plain text-grade-meh">
						simulated {statsLabel}
					</div>
				)}

				{/* accuracy + grade tile, simulated-primary; the "was" line keeps
				the header readout visible once an edit drifts it */}
				<div className="flex items-center justify-between">
					<div>
						<SectionLabel>accuracy</SectionLabel>
						<div className="text-accuracy font-bold text-foreground-bright tabular-nums select-text">
							{(stats.accuracy.value * 100).toFixed(2)}
							<span className="text-percent-suffix text-foreground-dim">%</span>
						</div>
						{accuracyDrifted && (
							<div className="text-caption-plain text-foreground-dim tabular-nums select-text">
								was {(stats.accuracy.header * 100).toFixed(2)}% · {stats.grade.header}
							</div>
						)}
					</div>
					<div
						className={`flex size-tile-grade ${TILE_SKEW} items-center justify-center rounded-lg`}
						style={{ backgroundColor: tile.fill }}
					>
						<span className={`${TILE_COUNTER_SKEW} text-lg font-black`} style={{ color: tile.text }}>
							{stats.grade.value}
						</span>
					</div>
				</div>

				{/* judgement bar + legend, live counts */}
				<div>
					<div className="flex h-swatch gap-px rounded bg-surface-chip">
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
					<div className="mt-stack grid grid-cols-2 gap-x-3.5 gap-y-tight">
						{judgementSegments.map((segment) => (
							<div key={segment.label} className="flex items-center gap-1.5 text-row">
								<span
									className="size-swatch shrink-0 rounded-bar"
									style={{ backgroundColor: segment.colour }}
								/>
								<span className="text-foreground-soft">{segment.label}</span>
								<span className="ml-auto flex items-baseline gap-1.5 select-text">
									<WasLabel stat={segment.stat} />
									<span className="text-foreground tabular-nums">
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
						<div className="mt-stack border-t border-border pt-stack">
							<SectionLabel className="mb-tight">native results</SectionLabel>
							<div className="grid grid-cols-2 gap-x-3.5 gap-y-tight">
								{native.map((entry) => (
									<div key={entry.result} className="flex items-center gap-1.5 text-row">
										<span className="text-foreground-soft">{resultLabel(entry.result)}</span>
										<span className="ml-auto flex items-baseline gap-1.5 select-text">
											{entry.recorded !== null && entry.recorded !== entry.count && (
												<span className="text-meta text-muted-foreground tabular-nums">
													was {entry.recorded.toLocaleString()}
												</span>
											)}
											<span className="text-foreground tabular-nums">
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
					<div className="mt-stack flex items-center gap-1.5 text-row">
						<span className="text-foreground-soft">max combo</span>
						<span className="ml-auto flex items-baseline gap-1.5 select-text">
							<WasLabel stat={stats.maxCombo} suffix="x" />
							<span className="text-foreground tabular-nums">{stats.maxCombo.value}x</span>
						</span>
					</div>
					<div className="mt-tight flex items-center gap-1.5 text-row">
						<span className="text-foreground-soft">score</span>
						<span className="ml-auto flex items-baseline gap-1.5 select-text">
							<WasLabel stat={stats.totalScore} />
							<span className="text-foreground tabular-nums">
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
					<SectionLabel className="mb-tight">recorded in file</SectionLabel>
					<dl className="grid dl-grid gap-x-3 gap-y-stack rounded-card border border-border bg-surface-card px-3 py-card-loose text-row">
						<div className="contents">
							<dt className="text-muted-foreground">geki / katu</dt>
							<dd className="text-right text-foreground tabular-nums select-text">
								{stats.countGeki} / {stats.countKatsu}
							</dd>
						</div>
						<div className="contents">
							<dt className="text-muted-foreground">perfect</dt>
							<dd className="text-right text-foreground select-text">{replay.perfect ? "yes" : "no"}</dd>
						</div>
						<div className="contents">
							<dt className="text-muted-foreground">played</dt>
							<dd className="text-right text-foreground tabular-nums select-text">{playedText}</dd>
						</div>
					</dl>
					{/* the file's own score-info block, kept apart from the header
					fields above it and from the simulated stats: what lazer wrote,
					or the stated reason there is nothing to show */}
					<div className="mt-2 card text-row">
						<SectionLabel className="mb-tight">score-info block</SectionLabel>
						{recorded.kind !== "present" ? (
							<p className="leading-caption-tight text-muted-foreground">{recorded.note}</p>
						) : (
							<>
								<dl className="grid dl-grid gap-x-3 gap-y-tight">
									{recorded.rows.map((row) => (
										<div key={row.label} className="contents">
											<dt className="text-muted-foreground">{row.label}</dt>
											<dd className="text-right text-foreground tabular-nums select-text">
												{row.value}
											</dd>
										</div>
									))}
								</dl>
								<SectionLabel className="mt-stack">statistics</SectionLabel>
								<dl className="mt-inset grid dl-grid gap-x-3 gap-y-inset">
									{recorded.statistics.map((entry) => (
										<div key={entry.result} className="contents">
											<dt className="text-muted-foreground">{resultLabel(entry.result)}</dt>
											<dd className="text-right text-foreground tabular-nums select-text">
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
								<div className="rounded-segment border border-border bg-surface-card px-1.5 py-stack text-center">
									<SectionLabel>{label}</SectionLabel>
									<div className="text-value font-semibold text-foreground-bright tabular-nums select-text">
										{beatmap[key].toFixed(1)}
									</div>
								</div>
							</TooltipTrigger>
							<TooltipContent>{description}</TooltipContent>
						</Tooltip>
					))}
				</div>
				<dl className="grid dl-grid gap-x-3 gap-y-stack text-row">
					<div className="contents">
						<dt className="text-muted-foreground">objects</dt>
						<dd className="text-right text-foreground tabular-nums select-text">
							{renderPlan.objects.length}
						</dd>
					</div>
					<div className="contents">
						<dt className="text-muted-foreground">md5</dt>
						{/* the full hash in the dom, clipped by css rather than cut in
						the string: copying must yield the whole value */}
						<dd className="truncate text-right font-mono text-foreground select-text">{beatmap.md5}</dd>
					</div>
				</dl>
			</div>
		</>
	);
}
