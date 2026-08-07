// the replay tab's panel body: accuracy/grade, the judgement bar, the score
// card, and the beatmap stat tiles. header + scrolling body together, so
// SidePanel can mount this as a single self-contained panel

import { PanelHeader } from "@/components/shell/SidePanel";
import { ticksToUnixMs } from "@/lib/format";
import { useViewerStore } from "@/state/store";

// osu!'s own logotype slant (see TopBar.tsx), reused for the grade tile so
// it reads as part of the same visual language; the counter-skew keeps the
// letter upright inside it
const TILE_SKEW = "skew-x-[-11.3deg]";
const TILE_COUNTER_SKEW = "skew-x-[11.3deg]";

type Grade = "SS" | "S" | "A" | "B" | "C" | "D";

// osucolour.cs's Blue/Green/Yellow/Red, also used by the judgement bar below
// and by renderer/drawables/judgement-tracks.ts's GRADE_COLOURS -- kept as a
// separate literal table here since that module's values are pixi tint
// numbers, not css colours
const GRADE_TILE_COLOURS: Record<Grade, { fill: string; text: string }> = {
	SS: { fill: "#66ccff", text: "#0a1218" },
	S: { fill: "#66ccff", text: "#0a1218" },
	A: { fill: "#88b300", text: "#11170a" },
	B: { fill: "#ffcc22", text: "#1a1400" },
	C: { fill: "#ffcc22", text: "#1a1400" },
	D: { fill: "#ed1121", text: "#1b0505" }
};

// a miss always costs at least S, even when the count-share accuracy below
// still lands at or above the S threshold -- matches osu!'s own grading rule
function gradeFor(accuracy: number, countMiss: number): Grade {
	if (countMiss === 0 && accuracy >= 1) return "SS";
	if (countMiss === 0 && accuracy >= 0.95) return "S";
	if (accuracy >= 0.9) return "A";
	if (accuracy >= 0.8) return "B";
	if (accuracy >= 0.7) return "C";
	return "D";
}

function truncateMd5(md5: string): string {
	return md5.length > 8 ? `${md5.slice(0, 4)}…${md5.slice(-4)}` : md5;
}

const DIFFICULTY_TILES = [
	["cs", "circleSize"],
	["ar", "approachRate"],
	["od", "overallDifficulty"],
	["hp", "hpDrainRate"]
] as const;

export function ReplayPanel() {
	const scene = useViewerStore((s) => s.scene);
	if (scene === null) return null;
	const { replay, beatmap, renderPlan } = scene;

	// osu! standard accuracy: weighted hit value over total judged hits,
	// straight from the .osr header counts -- ported from InfoPanel.tsx
	const judged = replay.count300 + replay.count100 + replay.count50 + replay.countMiss;
	const accuracy =
		judged === 0 ? 0 : (300 * replay.count300 + 100 * replay.count100 + 50 * replay.count50) / (300 * judged);
	const grade = gradeFor(accuracy, replay.countMiss);
	const tile = GRADE_TILE_COLOURS[grade];

	const judgementSegments = [
		{ label: "300", count: replay.count300, colour: "#66ccff" },
		{ label: "100", count: replay.count100, colour: "#88b300" },
		{ label: "50", count: replay.count50, colour: "#ffcc22" },
		{ label: "miss", count: replay.countMiss, colour: "#ed1121" }
	];

	const playedMs = ticksToUnixMs(replay.timestampTicks);
	const playedText =
		playedMs === null
			? "unknown"
			: new Date(playedMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

	return (
		<>
			<PanelHeader title="replay" trailing={`v${replay.version}`} />
			<div
				data-native-wheel=""
				className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto overflow-x-hidden p-3.5"
			>
				{/* accuracy + grade tile */}
				<div className="flex items-center justify-between">
					<div>
						<div className="text-[9.5px] font-semibold tracking-[.14em] text-[#8a8a93] uppercase">
							accuracy
						</div>
						<div className="text-[30px] font-bold tracking-[-.02em] text-[#f4f4f5] tabular-nums">
							{(accuracy * 100).toFixed(2)}
							<span className="text-[17px] text-[#71717a]">%</span>
						</div>
					</div>
					<div
						className={`flex size-[42px] ${TILE_SKEW} items-center justify-center rounded-lg`}
						style={{ backgroundColor: tile.fill }}
					>
						<span className={`${TILE_COUNTER_SKEW} text-lg font-black`} style={{ color: tile.text }}>
							{grade}
						</span>
					</div>
				</div>

				{/* judgement bar + legend */}
				<div>
					<div className="flex h-[7px] gap-px rounded bg-[#18181b]">
						{judgementSegments.map((segment) => (
							<div
								key={segment.label}
								className="h-full"
								style={{
									width: judged > 0 ? `${(segment.count / judged) * 100}%` : 0,
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
								<span className="ml-auto text-[#e4e4e7] tabular-nums">
									{segment.count.toLocaleString()}
								</span>
							</div>
						))}
					</div>
				</div>

				{/* score card */}
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-[7px] rounded-[9px] border border-border bg-surface-card px-3 py-[11px] text-[11px]">
					<div className="contents">
						<dt className="text-[#8a8a93]">score</dt>
						<dd className="text-right text-[#e4e4e7] tabular-nums">{replay.totalScore.toLocaleString()}</dd>
					</div>
					<div className="contents">
						<dt className="text-[#8a8a93]">max combo</dt>
						<dd className="text-right text-[#e4e4e7] tabular-nums">{replay.maxCombo}x</dd>
					</div>
					<div className="contents">
						<dt className="text-[#8a8a93]">geki / katu</dt>
						<dd className="text-right text-[#e4e4e7] tabular-nums">
							{replay.countGeki} / {replay.countKatsu}
						</dd>
					</div>
					<div className="contents">
						<dt className="text-[#8a8a93]">perfect</dt>
						<dd className="text-right text-[#e4e4e7]">{replay.perfect ? "yes" : "no"}</dd>
					</div>
					<div className="contents">
						<dt className="text-[#8a8a93]">played</dt>
						<dd className="text-right text-[#e4e4e7] tabular-nums">{playedText}</dd>
					</div>
				</dl>

				{/* beatmap stats -- bpm and combo elements are not in LoadedScene,
				see TODO.md's kiai-flash item for what surfacing them needs */}
				<div className="grid grid-cols-4 gap-1.5">
					{DIFFICULTY_TILES.map(([label, key]) => (
						<div
							key={label}
							className="rounded-[7px] border border-border bg-surface-card px-1.5 py-[7px] text-center"
						>
							<div className="text-[9.5px] font-semibold tracking-[.14em] text-[#8a8a93] uppercase">
								{label}
							</div>
							<div className="text-[13px] font-semibold text-[#f4f4f5] tabular-nums">
								{beatmap[key].toFixed(1)}
							</div>
						</div>
					))}
				</div>
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-[7px] text-[11px]">
					<div className="contents">
						<dt className="text-[#8a8a93]">objects</dt>
						<dd className="text-right text-[#e4e4e7] tabular-nums">{renderPlan.objects.length}</dd>
					</div>
					<div className="contents">
						<dt className="text-[#8a8a93]">md5</dt>
						<dd className="truncate text-right font-mono text-[#e4e4e7]">{truncateMd5(beatmap.md5)}</dd>
					</div>
				</dl>
			</div>
		</>
	);
}
