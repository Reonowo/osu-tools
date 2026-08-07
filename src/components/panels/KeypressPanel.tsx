// the keys tab: an inert press-editing block sitting under two genuinely
// live pieces -- the key filter buttons total derived.edges (computed once
// per scene, so they're plain react values), and the presses-near-playhead
// table reads playbackClock every animation frame and writes straight to dom
// refs. header + scrolling body together, so SidePanel can mount this as a
// single self-contained panel

import { useEffect, useMemo, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PanelHeader } from "@/components/shell/SidePanel";
import { isLeft, isRight } from "@/engine/buttons";
import type { ButtonEdges, Press } from "@/engine/interpolation";
import { formatTime } from "@/lib/format";
import type { FrameDto } from "@/lib/scene-types";
import { playbackClock } from "@/playback/instance";
import { countAtOrBefore } from "@/renderer/overlays/analysis";
import { useViewerStore } from "@/state/store";
import { InertNotice } from "./InertNotice";
import { SectionLabel } from "./SectionLabel";

const ROW_COUNT = 5;
const CENTER_ROW = 2;

const KEY_FILTERS: { label: string; edges: keyof ButtonEdges }[] = [
	{ label: "K1", edges: "k1" },
	{ label: "K2", edges: "k2" },
	{ label: "M1", edges: "m1" },
	{ label: "M2", edges: "m2" }
];

/** the frame time the held action first reads false again, i.e. the release
 * that follows this press's rising edge; null when the stream ends before it
 * releases -- press.action is the gameplay-action grouping pressEdges built
 * (K1/M1 as one "left" action), so the same grouping decides the release */
function releaseTime(frames: readonly FrameDto[], press: Press): number | null {
	const stillHeld = press.action === "left" ? isLeft : isRight;
	for (let i = press.frameIndex + 1; i < frames.length; i++) {
		if (!stillHeld(frames[i].buttons)) return frames[i].time;
	}
	return null;
}

// a fixed five rows, rendered once; the rAF loop below only ever rewrites
// their cell text and the centre tint, never creates or destroys a row
function PressRow({ setRef }: { setRef: (el: HTMLDivElement | null) => void }) {
	return (
		<div
			ref={setRef}
			className="grid grid-cols-[34px_1fr_1fr_54px] items-center gap-1.5 px-[9px] py-[3px] font-mono text-[10px] text-[#e4e4e7] data-[state=center]:bg-primary/[.07]"
		>
			{/* fixed child order -- the loop indexes into el.children */}
			<span className="text-[#8a8a93]" />
			<span className="text-[#a1a1aa]" />
			<span className="text-[#a1a1aa]" />
			<span className="text-right tabular-nums text-[#8a8a93]" />
		</div>
	);
}

export function KeypressPanel() {
	const scene = useViewerStore((s) => s.scene);
	const derived = useViewerStore((s) => s.derived);
	const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

	const pressTimes = useMemo(() => derived?.presses.map((p) => p.time) ?? [], [derived]);
	// release times only depend on the (static, per-scene) frame stream and
	// press list, not on the playhead -- computed once so the rAF loop below
	// is a pure lookup, not a per-frame forward scan
	const releases = useMemo(() => {
		if (scene === null || derived === null) return [];
		return derived.presses.map((p) => releaseTime(scene.frames, p));
	}, [scene, derived]);

	useEffect(() => {
		if (derived === null) return;
		const presses = derived.presses;
		let raf = 0;
		const loop = () => {
			const t = playbackClock.currentTime();
			const centerIndex = presses.length > 0 ? Math.max(0, countAtOrBefore(pressTimes, t) - 1) : -1;
			const start = Math.max(0, Math.min(centerIndex - CENTER_ROW, presses.length - ROW_COUNT));
			for (let row = 0; row < ROW_COUNT; row++) {
				const el = rowRefs.current[row];
				if (el === null) continue;
				const pressIndex = start + row;
				const press = presses[pressIndex];
				if (press === undefined) {
					el.style.display = "none";
					continue;
				}
				el.style.display = "";
				const up = releases[pressIndex] ?? null;
				const cells = el.children;
				(cells[0] as HTMLElement).textContent = press.action === "left" ? "left" : "right";
				(cells[1] as HTMLElement).textContent = formatTime(press.time);
				(cells[2] as HTMLElement).textContent = up === null ? "—" : formatTime(up);
				(cells[3] as HTMLElement).textContent = up === null ? "—" : `${Math.round(up - press.time)}ms`;
				el.dataset.state = pressIndex === centerIndex ? "center" : "";
			}
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [derived, pressTimes, releases]);

	if (scene === null || derived === null) return null;

	return (
		<>
			<PanelHeader title="keys" />
			<div
				data-native-wheel=""
				className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto overflow-x-hidden p-3.5"
			>
				<InertNotice>press editing needs the replay-document ipc commands</InertNotice>

				<div>
					<SectionLabel>key filters</SectionLabel>
					<div className="mt-[7px] grid grid-cols-4 gap-1.5">
						{KEY_FILTERS.map((key) => (
							<Button
								key={key.label}
								disabled
								variant="outline"
								size="sm"
								className="h-auto flex-col gap-0.5 py-1.5"
							>
								<span className="text-[11px] font-semibold">{key.label}</span>
								<span className="text-[10px] tabular-nums text-[#8a8a93]">
									{derived.edges[key.edges].length}
								</span>
							</Button>
						))}
					</div>
				</div>

				<div>
					<SectionLabel>presses near playhead</SectionLabel>
					<div className="mt-[7px] overflow-hidden rounded-[9px] border border-border">
						<div className="grid grid-cols-[34px_1fr_1fr_54px] gap-1.5 border-b border-border bg-surface-panel px-[9px] py-[5px] font-mono text-[10px] text-[#8a8a93]">
							<span>key</span>
							<span>down</span>
							<span>up</span>
							<span className="text-right">held</span>
						</div>
						<div className="bg-surface-card">
							{Array.from({ length: ROW_COUNT }, (_, i) => (
								<PressRow
									key={i}
									setRef={(el) => {
										rowRefs.current[i] = el;
									}}
								/>
							))}
						</div>
					</div>
				</div>

				<div className="rounded-[9px] border border-border bg-surface-card px-3 py-[9px]">
					<SectionLabel>operations</SectionLabel>
					<Button disabled variant="outline" size="sm" className="mt-2 w-full">
						+ add press
					</Button>
					<div className="mt-1.5 flex gap-1.5">
						<Button disabled variant="outline" size="sm" aria-label="nudge earlier" className="flex-1">
							<ChevronLeft className="size-3.5" aria-hidden />
						</Button>
						<Button disabled variant="outline" size="sm" aria-label="nudge later" className="flex-1">
							<ChevronRight className="size-3.5" aria-hidden />
						</Button>
					</div>
				</div>
			</div>
		</>
	);
}
