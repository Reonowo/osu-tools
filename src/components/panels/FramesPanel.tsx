// the frames tab: an inert operations block (frame editing has no ipc
// surface yet) sitting under a table that genuinely works -- the frames
// near the playhead are pure display over scene.frames, read every animation
// frame straight off the clock, and each row clicked (or entered, once
// tabbed to) exact-selects that frame (frameCursor.select). header +
// scrolling body together, so SidePanel can mount this as a single
// self-contained panel

import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PanelHeader } from "@/components/shell/SidePanel";
import { frameEditGate } from "@/editor/gate";
import { editTargets, insertOps, nudgeOps, snapOps } from "@/editor/ops";
import { smoothMoveOps } from "@/editor/smooth";
import { countedLabel, movedFrameCount } from "@/editor/tool-commits";
import { formatButtons, formatTime } from "@/lib/format";
import { formatLatticeStep, isOnLattice } from "@/lib/lattice";
import { frameCursor } from "@/playback/frame-cursor";
import { keybindSuffix } from "@/playback/keybinds";
import { playbackClock } from "@/playback/instance";
import { useViewerStore, viewerStore } from "@/state/store";
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

/** shift-activation's frame selection: the contiguous inclusive index range
 * between the frame-cursor row (the anchor) and the activated row */
export function rangeSelection(anchor: number, activated: number): number[] {
	const lo = Math.max(0, Math.min(anchor, activated));
	const hi = Math.max(anchor, activated);
	const range: number[] = [];
	for (let i = lo; i <= hi; i++) range.push(i);
	return range;
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
			// wants the keyboard: without the opt-out, controlOwnsKeydown would
			// kill `,` `.` space arrows home while a tab-focused row holds
			// keyboard-visible focus -- stepping frames while walking the rows
			// is what the rows are for
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
	const editor = useViewerStore((s) => s.editor);
	const commitEdit = useViewerStore((s) => s.commitEdit);
	const setFrameSelection = useViewerStore((s) => s.setFrameSelection);
	const snapPref = useViewerStore((s) => s.editing.snapToLattice);
	const gate = scene !== null ? frameEditGate(scene) : null;
	const canFrameEdit = gate?.editable === true;
	const lattice = editor?.lattice ?? null;
	const featherMs = useViewerStore((s) => s.featherMs);
	const setFeatherMs = useViewerStore((s) => s.setFeatherMs);
	const smoothStrength = useViewerStore((s) => s.smoothStrength);
	const setSmoothStrength = useViewerStore((s) => s.setSmoothStrength);
	const keybinds = useViewerStore((s) => s.effectiveKeybinds);
	const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const frameCount = scene === null ? 0 : scene.frames.length;
	const [dxDraft, setDxDraft] = useState("0");
	const [dyDraft, setDyDraft] = useState("0");
	const [featherDraft, setFeatherDraft] = useState(String(featherMs));

	function commitNudge() {
		const dx = Number(dxDraft);
		const dy = Number(dyDraft);
		if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return;
		void commitEdit({
			label: "nudge",
			payload: {
				kind: "intent",
				expand: (frames, editor) =>
					nudgeOps(
						frames,
						editTargets(editor.frameSelection, frameCursor.currentIndex()),
						dx,
						dy,
						editor.lattice,
						snapPref
					)
			}
		});
		setDxDraft("0");
		setDyDraft("0");
	}

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
			// shift-activation extends the frame selection from the frame-cursor
			// row -- the keyboard route to range selection (a shift-enter on a
			// focused row arrives here too: keyboard activation synthesizes a
			// click that carries the modifier state). selecting never seeks, so
			// the window stays put and the activated row keeps its focus
			if (e.shiftKey) {
				setFrameSelection(rangeSelection(frameCursor.currentIndex(), index));
				return;
			}
			frameCursor.select(index);
			rowRefs.current[index - frameWindowStart(index, frameCount)]?.focus();
		},
		[frameCount, setFrameSelection]
	);

	useEffect(() => {
		if (scene === null || derived === null) return;
		const frames = scene.frames;
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
	}, [scene, derived, lattice]);

	if (scene === null || derived === null) return null;

	// shared with both branches below -- only the wrapper differs, gated by
	// whether the row needs a tooltip explaining why it's disabled
	const nudgeInsertButtons = (
		<>
			<Button variant="outline" size="sm" className="flex-1" disabled={!canFrameEdit} onClick={commitNudge}>
				nudge
			</Button>
			<Button
				variant="outline"
				size="sm"
				className="flex-1"
				disabled={!canFrameEdit}
				onClick={() => {
					// the playhead the user clicked at, not wherever playback has
					// drifted to by the time a queued intent expands
					const playheadTime = playbackClock.currentTime();
					void commitEdit({
						label: "insert frame",
						payload: {
							kind: "intent",
							expand: (frames, editor) => insertOps(frames, playheadTime, editor.lattice)
						}
					});
				}}
			>
				insert at playhead
			</Button>
		</>
	);

	return (
		<>
			<PanelHeader title="frames" />
			<div
				data-native-wheel=""
				className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto overflow-x-hidden p-3.5"
			>
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
						<Tooltip>
							<TooltipTrigger render={<span className="flex-1" />}>
								<Button
									variant="outline"
									size="sm"
									className="w-full"
									disabled={!canFrameEdit || lattice === null}
									onClick={() =>
										void commitEdit({
											label: "snap to lattice",
											payload: {
												kind: "intent",
												expand: (frames, editor) =>
													snapOps(
														frames,
														editTargets(editor.frameSelection, frameCursor.currentIndex()),
														editor.lattice
													)
											}
										})
									}
								>
									snap to lattice
								</Button>
							</TooltipTrigger>
							<TooltipContent side="left">
								{gate !== null && !gate.editable
									? gate.reason
									: lattice === null
										? "no input lattice could be inferred from these frames"
										: "move the selection (or the current frame) onto the inferred lattice"}
							</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger render={<span className="flex-1" />}>
								<Button
									variant="outline"
									size="sm"
									className="w-full"
									disabled={!canFrameEdit}
									onClick={() => {
										// the strength the user sees as they click, not whatever
										// the slider reads when a queued intent finally expands
										const strength = viewerStore.getState().smoothStrength;
										void commitEdit({
											label: (ops) => countedLabel("smooth", movedFrameCount(ops)),
											payload: {
												kind: "intent",
												expand: (frames, editor) =>
													smoothMoveOps(
														frames,
														editTargets(editor.frameSelection, frameCursor.currentIndex()),
														strength,
														editor.lattice,
														snapPref
													)
											}
										});
									}}
								>
									smooth
								</Button>
							</TooltipTrigger>
							<TooltipContent side="left">
								{gate !== null && !gate.editable
									? gate.reason
									: `smooth the selection (or the current frame) with the pinned gaussian kernel, blended by strength${keybindSuffix(keybinds, "smoothSelection")}`}
							</TooltipContent>
						</Tooltip>
					</div>
					<label className="mt-2.5 block text-[10px] text-[#8a8a93]">
						strength {smoothStrength}
						<Slider
							disabled={!canFrameEdit}
							value={[smoothStrength]}
							min={0}
							max={100}
							onValueChange={(value) => setSmoothStrength(Array.isArray(value) ? value[0] : value)}
							className="mt-1.5"
						/>
					</label>
					<div className="mt-2.5 grid grid-cols-2 gap-1.5">
						<label className="block text-[10px] text-[#8a8a93]">
							Δx
							<Input
								disabled={!canFrameEdit}
								type="number"
								value={dxDraft}
								onChange={(e) => setDxDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") commitNudge();
								}}
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
								disabled={!canFrameEdit}
								type="number"
								value={dyDraft}
								onChange={(e) => setDyDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") commitNudge();
								}}
								// Input's own base carries a *separate* md:text-sm alongside its
								// unprefixed text-base -- overriding only the unprefixed class
								// leaves md:text-sm undefeated (same trap task 10 hit twice), so
								// the md: scope needs its own override to actually win >=768px
								className="mt-1 h-7 text-[11px] md:text-[11px]"
							/>
						</label>
						<Tooltip>
							<TooltipTrigger
								render={
									<label className="block text-[10px] text-[#8a8a93]">
										feather ms
										<Input
											disabled={!canFrameEdit}
											type="number"
											min={0}
											value={featherDraft}
											onChange={(e) => {
												// commit-on-change, session-only. a cleared field is held
												// back here: Number("") is 0, not the NaN the store's
												// finite guard catches, and committing it would turn
												// "blank" into feather 0
												setFeatherDraft(e.target.value);
												if (e.target.value.trim() !== "") setFeatherMs(Number(e.target.value));
											}}
											onBlur={() => setFeatherDraft(String(viewerStore.getState().featherMs))}
											className="mt-1 h-7 text-[11px] md:text-[11px]"
										/>
									</label>
								}
							/>
							<TooltipContent side="left">
								the time window past a moved selection's edges over which the move tool blends into the
								surrounding path — 0 is a hard edge. the Δ nudge stays exact.
							</TooltipContent>
						</Tooltip>
					</div>
					{canFrameEdit ? (
						<div className="mt-1.5 flex gap-1.5">{nudgeInsertButtons}</div>
					) : (
						<Tooltip>
							<TooltipTrigger render={<div className="mt-1.5 flex gap-1.5" />}>
								{nudgeInsertButtons}
							</TooltipTrigger>
							<TooltipContent side="left">{gate?.reason}</TooltipContent>
						</Tooltip>
					)}
				</div>
			</div>
		</>
	);
}
