// the frames tab: an inert operations block (frame editing has no ipc
// surface yet) sitting under a table that genuinely works -- the frames
// near the playhead are pure display over scene.frames, read every animation
// frame straight off the clock. header + scrolling body together, so
// SidePanel can mount this as a single self-contained panel

import { useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { PanelHeader } from "@/components/shell/SidePanel";
import { formatTime } from "@/lib/format";
import { formatLatticeStep, isOnLattice } from "@/lib/lattice";
import { playbackClock } from "@/playback/instance";
import { countAtOrBefore } from "@/renderer/overlays/analysis";
import { useViewerStore } from "@/state/store";
import { InertNotice } from "./InertNotice";
import { SectionLabel } from "./SectionLabel";

const ROW_COUNT = 9;
const CENTER_ROW = 4;

// a fixed nine rows, rendered once; the rAF loop below only ever rewrites
// their cell text and dataset flags, never creates or destroys a row
function FrameRow({ setRef }: { setRef: (el: HTMLDivElement | null) => void }) {
	return (
		<div
			ref={setRef}
			className="grid grid-cols-[40px_1fr_52px_52px_30px] items-center gap-1.5 px-[9px] py-[3px] font-mono text-[10px] text-[#e4e4e7] data-[state=center]:bg-primary/[.07] data-[state=offlattice]:bg-[#ffcc22]/[.05]"
		>
			{/* fixed child order -- the rAF loop below indexes into el.children
			rather than re-querying by attribute every frame */}
			<span className="text-[#8a8a93]" />
			<span className="text-[#a1a1aa]" />
			<span className="text-right tabular-nums data-[off=true]:text-[#ffcc22]" />
			<span className="text-right tabular-nums data-[off=true]:text-[#ffcc22]" />
			<span className="text-right text-[#8a8a93]" />
		</div>
	);
}

export function FramesPanel() {
	const scene = useViewerStore((s) => s.scene);
	const derived = useViewerStore((s) => s.derived);
	const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

	// recomputed only when a new scene installs, not every animation frame --
	// the loop below just binary-searches this array each tick
	const frameTimes = useMemo(() => scene?.frames.map((f) => f.time) ?? [], [scene]);

	useEffect(() => {
		if (scene === null || derived === null) return;
		const frames = scene.frames;
		const lattice = derived.lattice;
		let raf = 0;
		const loop = () => {
			const t = playbackClock.currentTime();
			const centerIndex = frames.length > 0 ? Math.max(0, countAtOrBefore(frameTimes, t) - 1) : -1;
			const start = Math.max(0, Math.min(centerIndex - CENTER_ROW, frames.length - ROW_COUNT));
			for (let row = 0; row < ROW_COUNT; row++) {
				const el = rowRefs.current[row];
				if (el === null) continue;
				const frameIndex = start + row;
				const frame = frames[frameIndex];
				if (frame === undefined) {
					el.style.display = "none";
					continue;
				}
				el.style.display = "";
				const cells = el.children;
				(cells[0] as HTMLElement).textContent = String(frameIndex);
				(cells[1] as HTMLElement).textContent = formatTime(frame.time);
				const xOff = lattice !== null && !isOnLattice(frame.x, lattice.step);
				const yOff = lattice !== null && !isOnLattice(frame.y, lattice.step);
				const xCell = cells[2] as HTMLElement;
				const yCell = cells[3] as HTMLElement;
				xCell.textContent = frame.x.toFixed(1);
				xCell.dataset.off = String(xOff);
				yCell.textContent = frame.y.toFixed(1);
				yCell.dataset.off = String(yOff);
				(cells[4] as HTMLElement).textContent = String(frame.buttons);
				el.dataset.state = xOff || yOff ? "offlattice" : frameIndex === centerIndex ? "center" : "";
			}
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [scene, derived, frameTimes]);

	if (scene === null || derived === null) return null;
	const { lattice } = derived;

	return (
		<>
			<PanelHeader title="frames" />
			<div
				data-native-wheel=""
				className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto overflow-x-hidden p-3.5"
			>
				<InertNotice>
					frame editing needs the replay-document ipc commands; the engine's ReplayDocument is ready, the
					tauri layer is not
				</InertNotice>

				<div>
					<SectionLabel>frames near playhead</SectionLabel>
					<div className="mt-[7px] overflow-hidden rounded-[9px] border border-border">
						<div className="grid grid-cols-[40px_1fr_52px_52px_30px] gap-1.5 border-b border-border bg-surface-panel px-[9px] py-[5px] font-mono text-[10px] text-[#8a8a93]">
							<span>#</span>
							<span>time</span>
							<span className="text-right">x</span>
							<span className="text-right">y</span>
							<span className="text-right">k</span>
						</div>
						<div className="bg-surface-card">
							{Array.from({ length: ROW_COUNT }, (_, i) => (
								<FrameRow
									key={i}
									setRef={(el) => {
										rowRefs.current[i] = el;
									}}
								/>
							))}
						</div>
					</div>
					<p className="mt-1.5 text-[10px] leading-[1.5] text-[#8a8a93]">
						{lattice !== null ? (
							<>
								off-lattice values are highlighted. this replay's inferred lattice is{" "}
								{formatLatticeStep(lattice)} (scale {lattice.scale}).
							</>
						) : (
							"no input lattice could be inferred from these frames"
						)}
					</p>
				</div>

				<div className="rounded-[9px] border border-border bg-surface-card px-3 py-[9px]">
					<SectionLabel>operations</SectionLabel>
					<div className="mt-2 flex gap-1.5">
						<Button disabled variant="outline" size="sm" className="flex-1">
							snap to lattice
						</Button>
						<Button disabled variant="outline" size="sm" className="flex-1">
							smooth
						</Button>
					</div>
					<label className="mt-2.5 block text-[10px] text-[#8a8a93]">
						strength
						<Slider disabled value={[0]} min={0} max={100} onValueChange={() => {}} className="mt-1.5" />
					</label>
					<div className="mt-2.5 grid grid-cols-2 gap-1.5">
						<label className="block text-[10px] text-[#8a8a93]">
							Δx
							<Input
								disabled
								type="number"
								placeholder="0"
								// Input's own base carries a *separate* md:text-sm alongside its
								// unprefixed text-base -- overriding only the unprefixed class
								// leaves md:text-sm undefeated (same trap task 10 hit twice), so
								// the md: scope needs its own override to actually win >=768px
								className="mt-1 h-7 text-[11px] md:text-[11px]"
							/>
						</label>
						<label className="block text-[10px] text-[#8a8a93]">
							Δy
							<Input
								disabled
								type="number"
								placeholder="0"
								// Input's own base carries a *separate* md:text-sm alongside its
								// unprefixed text-base -- overriding only the unprefixed class
								// leaves md:text-sm undefeated (same trap task 10 hit twice), so
								// the md: scope needs its own override to actually win >=768px
								className="mt-1 h-7 text-[11px] md:text-[11px]"
							/>
						</label>
					</div>
				</div>
			</div>
		</>
	);
}
