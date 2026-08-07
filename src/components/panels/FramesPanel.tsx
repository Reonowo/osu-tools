// the frames tab: an inert operations block (frame editing has no ipc
// surface yet) sitting under a table that genuinely works -- the frames
// near the playhead are pure display over scene.frames, read every animation
// frame straight off the clock, and each row clicked (or entered, once
// tabbed to) exact-selects that frame (frameCursor.select). header +
// scrolling body together, so SidePanel can mount this as a single
// self-contained panel

import { useCallback, useEffect, useRef, type MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { PanelHeader } from "@/components/shell/SidePanel";
import { formatButtons, formatTime } from "@/lib/format";
import { formatLatticeStep, isOnLattice } from "@/lib/lattice";
import { frameCursor } from "@/playback/frame-cursor";
import { useViewerStore } from "@/state/store";
import { InertNotice } from "./InertNotice";
import { SectionLabel } from "./SectionLabel";

const ROW_COUNT = 9;
const CENTER_ROW = 4;

/** the frame index the top row shows with `centerIndex` selected: centred
 * where the replay has room on both sides, flush against whichever end it
 * does not. exported because row activation needs the same answer the rAF
 * loop below computes -- it is what says which row the frame it just selected
 * has moved to */
export function frameWindowStart(centerIndex: number, frameCount: number): number {
	return Math.max(0, Math.min(centerIndex - CENTER_ROW, frameCount - ROW_COUNT));
}

// enter activates a row; space stays the app's play/pause wherever focus sits,
// which is the whole point of the passthrough opt-out below. the shortcut
// hook's own preventDefault covers only the first keydown (it drops repeats),
// and a held space re-arms the button's native activation on every repeat it
// is allowed to default-handle -- so without this a hold would both toggle
// playback and select a frame on release
export function suppressSpaceActivation(e: { key: string; preventDefault(): void }) {
	if (e.key === " ") e.preventDefault();
}

// a fixed nine rows, rendered once; the rAF loop below only ever rewrites
// their cell text and dataset flags, never creates or destroys a row
export function FrameRow({
	setRef,
	onActivate
}: {
	setRef: (el: HTMLButtonElement | null) => void;
	onActivate: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
	return (
		<button
			type="button"
			ref={setRef}
			onClick={onActivate}
			onKeyDown={suppressSpaceActivation}
			// a row is a button to be clickable and tab-reachable, not because it
			// wants the keyboard: withinInteractiveControl would otherwise kill
			// `,` `.` space arrows home for as long as a clicked row keeps focus
			data-shortcut-passthrough=""
			className="grid w-full grid-cols-[40px_1fr_52px_52px_30px] items-center gap-1.5 px-[9px] py-[3px] text-left font-mono text-[10px] text-[#e4e4e7] data-[state=center]:bg-primary/[.07] data-[state=offlattice]:bg-[#ffcc22]/[.05]"
		>
			{/* fixed child order -- the rAF loop below indexes into el.children
			rather than re-querying by attribute every frame */}
			<span className="text-[#8a8a93]" />
			<span className="text-[#a1a1aa]" />
			<span className="text-right tabular-nums data-[off=true]:text-[#ffcc22]" />
			<span className="text-right tabular-nums data-[off=true]:text-[#ffcc22]" />
			<span className="text-right text-[#8a8a93]" />
		</button>
	);
}

export function FramesPanel() {
	const scene = useViewerStore((s) => s.scene);
	const derived = useViewerStore((s) => s.derived);
	const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const frameCount = scene === null ? 0 : scene.frames.length;

	// activation reads the frame index the rAF loop most recently wrote to this
	// row's own dataset, so it always seeks the row's live index even if a click
	// lands between two ticks -- and never touches play/pause, since select()
	// only ever calls the clock's seekTo(). the rows are positional, though:
	// selecting re-centres the window under the same nine nodes, so the row that
	// was activated goes on to name a different frame. focus therefore follows
	// the selection to whichever row it lands on, which keeps the focus ring on
	// the frame it selected and makes a second activation a no-op instead of
	// another step in the same direction
	const activateRow = useCallback(
		(e: MouseEvent<HTMLButtonElement>) => {
			const raw = e.currentTarget.dataset.frameIndex;
			if (raw === undefined) return;
			const index = Number(raw);
			frameCursor.select(index);
			rowRefs.current[index - frameWindowStart(index, frameCount)]?.focus();
		},
		[frameCount]
	);

	useEffect(() => {
		if (scene === null || derived === null) return;
		const frames = scene.frames;
		const lattice = derived.lattice;
		let raf = 0;
		const loop = () => {
			const centerIndex = frames.length > 0 ? frameCursor.currentIndex() : -1;
			const start = frameWindowStart(centerIndex, frames.length);
			for (let row = 0; row < ROW_COUNT; row++) {
				const el = rowRefs.current[row];
				if (el === null) continue;
				const frameIndex = start + row;
				const frame = frames[frameIndex];
				if (frame === undefined) {
					el.style.display = "none";
					el.disabled = true;
					continue;
				}
				el.style.display = "";
				el.disabled = false;
				el.dataset.frameIndex = String(frameIndex);
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
				(cells[4] as HTMLElement).textContent = formatButtons(frame.buttons);
				// the decoded label loses the raw bitfield -- keep it reachable on
				// hover, since it's what a future keypress-edit op would rewrite
				el.title = `raw buttons: ${frame.buttons}`;
				el.dataset.state = xOff || yOff ? "offlattice" : frameIndex === centerIndex ? "center" : "";
			}
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [scene, derived]);

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
									onActivate={activateRow}
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
