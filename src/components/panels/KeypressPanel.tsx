// the keys tab: live press editing over two rAF-driven display pieces. the
// key tiles are a single-active toggle -- clicking one filters the press
// table to that physical key and arms it as the key add-press writes;
// clicking it again clears both. the presses-near-playhead table reads
// playbackClock every animation frame and writes straight to dom refs, and
// its rows select (never seek) or double-click-seek. the operations block
// commits through the shared press-operations module: add at the playhead,
// delete, the nudge chevrons, and the realized-time fields that double as
// direct entry. every commit is an intent reading the press selection at
// dispatch, one undo step, feedback authoritative on the landing delta

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PanelHeader } from "@/components/shell/SidePanel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { frameEditGate } from "@/editor/gate";
import { addPressCommit, selectedPressCommit } from "@/editor/press-commits";
import { adjacentFrameTime, expandDeletePress, expandRetimePress, type PressEdit } from "@/editor/press-ops";
import { pressRunFromIndex, type PressRun } from "@/editor/press-runs";
import { pressLabel } from "@/editor/tool-commits";
import { isLeft, isRight, PHYSICAL_BUTTONS, type PhysicalKey } from "@/engine/buttons";
import type { Press } from "@/engine/interpolation";
import { formatTime } from "@/lib/format";
import type { FrameDto } from "@/lib/scene-types";
import { countAtOrBefore } from "@/lib/timeline";
import { frameCursor } from "@/playback/frame-cursor";
import { playbackClock } from "@/playback/instance";
import { useViewerStore, viewerStore } from "@/state/store";
import { InertNotice } from "./InertNotice";
import { SectionLabel } from "./SectionLabel";

const ROW_COUNT = 5;
const CENTER_ROW = 2;

// physical keys, not raw bits -- a keyboard tap must count as K1 alone,
// never K1 and M1 together (buttons.ts's PHYSICAL_BUTTONS)
const KEY_FILTERS = PHYSICAL_BUTTONS;

/** what each tile counts. the K/M distinction is what the counts hinge on:
 * stable writes the mouse bit alongside the keyboard bit for a keyboard tap,
 * so the naive reading of the bitfield double-counts one press as K1 *and*
 * M1 -- these four are physical keys, and the shared clause below says so */
const KEY_HARDWARE: Record<PhysicalKey, string> = {
	K1: "the left gameplay button, pressed on the keyboard",
	K2: "the right gameplay button, pressed on the keyboard",
	M1: "the left gameplay button, pressed on the mouse",
	M2: "the right gameplay button, pressed on the mouse"
};
const KEYS_ARE_PHYSICAL = "K and M are those same two buttons reached by different hardware, never two presses at once";

/** the frame time the held action first reads false again, i.e. the release
 * that follows this press's rising edge; null when the stream ends before it
 * releases -- press.action is the gameplay-action grouping pressEdges built
 * (K1/M1 as one "left" action), so the same grouping decides the release.
 * a press *run's* realized end can diverge from this (press-runs.ts) */
function releaseTime(frames: readonly FrameDto[], press: Press): number | null {
	const stillHeld = press.action === "left" ? isLeft : isRight;
	for (let i = press.frameIndex + 1; i < frames.length; i++) {
		if (!stillHeld(frames[i].buttons)) return frames[i].time;
	}
	return null;
}

// a fixed five rows, rendered once; the rAF loop below only ever rewrites
// their cell text and dataset flags, never creates or destroys a row
function PressRow({
	setRef,
	onActivate,
	onSeek,
	disabled
}: {
	setRef: (el: HTMLButtonElement | null) => void;
	onActivate: (e: MouseEvent<HTMLButtonElement>) => void;
	onSeek: (e: MouseEvent<HTMLButtonElement>) => void;
	disabled: boolean;
}) {
	return (
		<button
			type="button"
			ref={setRef}
			onClick={onActivate}
			onDoubleClick={onSeek}
			disabled={disabled}
			className="grid w-full grid-cols-[34px_1fr_1fr_54px] items-center gap-1.5 px-[9px] py-[3px] text-left font-mono text-[10px] text-[#e4e4e7] data-[state=center]:bg-primary/[.07] data-[state=selected]:bg-primary/[.16]"
		>
			{/* fixed child order -- the loop indexes into el.children */}
			<span className="text-[#8a8a93]" />
			<span className="text-[#a1a1aa]" />
			<span className="text-[#a1a1aa]" />
			<span className="text-right tabular-nums text-[#8a8a93]" />
		</button>
	);
}

export function KeypressPanel() {
	const scene = useViewerStore((s) => s.scene);
	const derived = useViewerStore((s) => s.derived);
	const mode = useViewerStore((s) => s.mode);
	const editor = useViewerStore((s) => s.editor);
	const commitEdit = useViewerStore((s) => s.commitEdit);
	const setPressSelection = useViewerStore((s) => s.setPressSelection);
	const armedKey = useViewerStore((s) => s.armedKey);
	const setArmedKey = useViewerStore((s) => s.setArmedKey);
	const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const startInputRef = useRef<HTMLInputElement | null>(null);
	const focusStartRef = useRef(false);
	const [startDraft, setStartDraft] = useState<string | null>(null);
	const [endDraft, setEndDraft] = useState<string | null>(null);

	const pressSelection = editor?.pressSelection ?? null;
	const gate = scene !== null ? frameEditGate(scene) : null;
	const canPressEdit = mode === "edit" && gate?.editable === true;
	const editBlocker =
		mode !== "edit"
			? "press editing is available in edit mode"
			: gate !== null && !gate.editable
				? gate.reason
				: null;

	// the armed tile filters the browsing surface itself: the table shows one
	// physical key's rows while armed, all of them otherwise. the filter is
	// an editing affordance, so watch mode shows the full table -- the tiles
	// are disabled there and could not clear it -- and the armed tile takes
	// effect again on returning to edit mode
	const armedFilter = mode === "edit" ? armedKey : null;
	const filtered = useMemo(() => {
		const presses = derived?.presses ?? [];
		return armedFilter === null ? presses : presses.filter((p) => p.key === armedFilter);
	}, [derived, armedFilter]);
	const pressTimes = useMemo(() => filtered.map((p) => p.time), [filtered]);
	// release times only depend on the (per-scene) frame stream and press
	// list, not on the playhead -- computed once so the rAF loop below is a
	// pure lookup, not a per-frame forward scan
	const releases = useMemo(() => {
		if (scene === null) return [];
		return filtered.map((p) => releaseTime(scene.frames, p));
	}, [scene, filtered]);

	/** the selected press resolved to its run -- the realized times the edit
	 * controls display and rewrite, which can differ from a row's displayed
	 * release */
	const selectedRun = useMemo(() => {
		if (scene === null || pressSelection === null) return null;
		return pressRunFromIndex(scene.frames, pressSelection.key, pressSelection.startIndex);
	}, [scene, pressSelection]);

	// a landed delta or a selection change makes a half-typed draft stale
	useEffect(() => {
		setStartDraft(null);
		setEndDraft(null);
	}, [pressSelection, scene]);

	// add-press auto-selects its outcome with the fields hot: the start field
	// focuses once the new selection lands, so a typed retime follows in the
	// same breath
	useEffect(() => {
		if (focusStartRef.current && pressSelection !== null) {
			focusStartRef.current = false;
			startInputRef.current?.focus();
			startInputRef.current?.select();
		}
	}, [pressSelection]);

	useEffect(() => {
		if (derived === null) return;
		let raf = 0;
		const loop = () => {
			const t = playbackClock.currentTime();
			const selected = viewerStore.getState().editor?.pressSelection ?? null;
			const centerIndex = filtered.length > 0 ? Math.max(0, countAtOrBefore(pressTimes, t) - 1) : -1;
			const start = Math.max(0, Math.min(centerIndex - CENTER_ROW, filtered.length - ROW_COUNT));
			for (let row = 0; row < ROW_COUNT; row++) {
				const el = rowRefs.current[row];
				if (el === null) continue;
				const pressIndex = start + row;
				const press = filtered[pressIndex];
				if (press === undefined) {
					el.style.display = "none";
					continue;
				}
				el.style.display = "";
				el.dataset.pressIndex = String(pressIndex);
				const up = releases[pressIndex] ?? null;
				const cells = el.children;
				(cells[0] as HTMLElement).textContent = press.key;
				(cells[1] as HTMLElement).textContent = formatTime(press.time);
				(cells[2] as HTMLElement).textContent = up === null ? "—" : formatTime(up);
				(cells[3] as HTMLElement).textContent = up === null ? "—" : `${Math.round(up - press.time)}ms`;
				const isSelected =
					selected !== null && selected.key === press.key && selected.startIndex === press.frameIndex;
				el.dataset.state = isSelected ? "selected" : pressIndex === centerIndex ? "center" : "";
			}
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [derived, filtered, pressTimes, releases]);

	if (scene === null || derived === null) return null;
	const frames = scene.frames;

	// selecting never seeks: a row click only names the press the next
	// operation will touch
	const activateRow = (e: MouseEvent<HTMLButtonElement>) => {
		const raw = e.currentTarget.dataset.pressIndex;
		if (raw === undefined) return;
		const press = filtered[Number(raw)];
		if (press === undefined) return;
		setPressSelection({ key: press.key, startIndex: press.frameIndex });
	};

	// double-click is the one deliberate seek affordance
	const seekRow = (e: MouseEvent<HTMLButtonElement>) => {
		const raw = e.currentTarget.dataset.pressIndex;
		if (raw === undefined) return;
		const press = filtered[Number(raw)];
		if (press === undefined) return;
		frameCursor.select(press.frameIndex);
	};

	/** the shared retime pipeline (press-commits.ts): an intent on the press
	 * selection as of dispatch, which is what makes queued chevron clicks
	 * compound instead of repeating */
	const commitRetime = (
		label: (key: PhysicalKey) => string,
		action: string,
		buildEdit: (frames: readonly FrameDto[], run: PressRun) => PressEdit | null
	) => {
		void commitEdit(
			selectedPressCommit(label, (dispatchFrames, run, ed) => {
				const edit = buildEdit(dispatchFrames, run);
				return edit === null ? null : expandRetimePress(dispatchFrames, run, edit, ed.lattice, action);
			})
		);
	};

	const onNudge = (edge: "start" | "end", direction: -1 | 1) => {
		if (pressSelection === null) return;
		commitRetime(
			(key) => pressLabel("nudge", key, edge),
			"this nudge",
			(dispatchFrames, run) => {
				const from = edge === "start" ? run.startTime : run.endTime;
				const target = adjacentFrameTime(dispatchFrames, from, direction);
				if (target === null) return null;
				return edge === "start" ? { start: target } : { end: target };
			}
		);
	};

	const commitEdgeField = (edge: "start" | "end") => {
		const draft = edge === "start" ? startDraft : endDraft;
		if (draft === null) return;
		if (edge === "start") setStartDraft(null);
		else setEndDraft(null);
		if (pressSelection === null || selectedRun === null || draft.trim() === "") return;
		const ms = Number(draft);
		if (!Number.isFinite(ms)) return;
		const current = edge === "start" ? selectedRun.startTime : selectedRun.endTime;
		if (Math.round(ms) === current) return;
		commitRetime(
			(key) => pressLabel("retime", key, edge),
			"this retime",
			() => (edge === "start" ? { start: ms } : { end: ms })
		);
	};

	const onDeletePress = () => {
		if (pressSelection === null) return;
		// the delete expansion's outcome is null, so the selection never
		// outlives its press
		void commitEdit(
			selectedPressCommit(
				(key) => pressLabel("delete", key),
				(dispatchFrames, run) => expandDeletePress(dispatchFrames, run)
			)
		);
	};

	const onAddPress = () => {
		const key = armedKey;
		if (key === null) return;
		// the playhead the user clicked at, not wherever playback has drifted
		// to by the time a queued intent expands
		const playheadTime = playbackClock.currentTime();
		const commit = addPressCommit(pressLabel("add", key), key, playheadTime);
		void commitEdit({
			...commit,
			// the hot-fields flag arms only when the add's own outcome lands a
			// selection: arming at click time would leave it set when a
			// fullFrames landing clears the selection instead (this callback
			// never runs), and would let a delta landing ahead in the queue
			// steal focus early -- either way the next unrelated selection
			// change would inherit the focus
			pressOutcome: (frames) => {
				const selection = commit.pressOutcome?.(frames) ?? null;
				focusStartRef.current = selection !== null;
				return selection;
			}
		});
	};

	const stepTargets =
		selectedRun === null
			? null
			: {
					startEarlier: adjacentFrameTime(frames, selectedRun.startTime, -1),
					startLater: adjacentFrameTime(frames, selectedRun.startTime, 1),
					endEarlier: adjacentFrameTime(frames, selectedRun.endTime, -1),
					endLater: adjacentFrameTime(frames, selectedRun.endTime, 1)
				};

	const hasSelection = canPressEdit && selectedRun !== null;
	const selectFirst = "select a press first — click its row or its hold span";

	const edgeRow = (
		edge: "start" | "end",
		draft: string | null,
		setDraft: (v: string | null) => void,
		earlier: number | null,
		later: number | null,
		inputRef?: typeof startInputRef
	) => {
		const realized = selectedRun === null ? null : edge === "start" ? selectedRun.startTime : selectedRun.endTime;
		return (
			<div className="mt-2">
				<span className="text-[10px] text-[#8a8a93]">
					{edge}
					{selectedRun !== null && edge === "end" && selectedRun.open ? " (open press)" : ""}
					{realized !== null ? ` — ${formatTime(realized)}` : ""}
				</span>
				<div className="mt-1 flex items-center gap-1.5">
					<Button
						variant="outline"
						size="sm"
						aria-label={`nudge ${edge} earlier`}
						className="h-7 w-7 shrink-0 p-0"
						disabled={!hasSelection || earlier === null}
						onClick={() => onNudge(edge, -1)}
					>
						<ChevronLeft className="size-3.5" aria-hidden />
					</Button>
					<Input
						ref={inputRef}
						disabled={!hasSelection}
						type="number"
						value={draft ?? (realized === null ? "" : String(realized))}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitEdgeField(edge);
						}}
						onBlur={() => commitEdgeField(edge)}
						aria-label={`${edge} time in milliseconds`}
						// Input's own base carries a *separate* md:text-sm alongside its
						// unprefixed text-base, so the md: scope needs its own override
						// (FramesPanel's trap)
						className="h-7 text-[11px] md:text-[11px]"
					/>
					<Button
						variant="outline"
						size="sm"
						aria-label={`nudge ${edge} later`}
						className="h-7 w-7 shrink-0 p-0"
						disabled={!hasSelection || later === null}
						onClick={() => onNudge(edge, 1)}
					>
						<ChevronRight className="size-3.5" aria-hidden />
					</Button>
				</div>
			</div>
		);
	};

	const operations = (
		<>
			<div className="mt-2 flex gap-1.5">
				<Tooltip>
					<TooltipTrigger render={<span className="flex-1" />}>
						<Button
							variant="outline"
							size="sm"
							className="w-full"
							disabled={!canPressEdit || armedKey === null}
							onClick={onAddPress}
						>
							+ add press
						</Button>
					</TooltipTrigger>
					<TooltipContent side="left">
						{editBlocker ??
							(armedKey === null
								? "arm a key tile first — a new press lands on the armed key at the playhead"
								: `add a ${armedKey} press at the playhead, sized to this replay's own median ${armedKey} press`)}
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger render={<span className="flex-1" />}>
						<Button
							variant="outline"
							size="sm"
							className="w-full"
							disabled={!hasSelection}
							onClick={onDeletePress}
						>
							delete press
						</Button>
					</TooltipTrigger>
					<TooltipContent side="left">
						{editBlocker ??
							(selectedRun === null
								? selectFirst
								: "clear the key's bits across the selected press — a paired mouse hold survives only where it genuinely continues")}
					</TooltipContent>
				</Tooltip>
			</div>
			<Tooltip>
				<TooltipTrigger render={<div />}>
					{edgeRow(
						"start",
						startDraft,
						setStartDraft,
						stepTargets?.startEarlier ?? null,
						stepTargets?.startLater ?? null,
						startInputRef
					)}
					{edgeRow(
						"end",
						endDraft,
						setEndDraft,
						stepTargets?.endEarlier ?? null,
						stepTargets?.endLater ?? null
					)}
				</TooltipTrigger>
				<TooltipContent side="left">
					{editBlocker ??
						(selectedRun === null
							? selectFirst
							: "chevrons step the edge one existing frame — never inserting; a typed time commits on enter or blur under the hybrid rule, and the field shows the realized landing")}
				</TooltipContent>
			</Tooltip>
		</>
	);

	return (
		<>
			<PanelHeader title="keys" />
			<div
				data-native-wheel=""
				className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto overflow-x-hidden p-3.5"
			>
				{editBlocker !== null && <InertNotice>{editBlocker}</InertNotice>}

				<div>
					<SectionLabel>key filters</SectionLabel>
					<div className="mt-[7px] grid grid-cols-4 gap-1.5">
						{/* disabled tiles need a wrapping span for their tooltip
						(ToolPalette.tsx's pattern) -- and these are the tiles whose
						meaning most needs explaining */}
						{KEY_FILTERS.map((key) => {
							const armed = armedKey === key.label;
							return (
								<Tooltip key={key.label}>
									<TooltipTrigger render={<span />}>
										<Button
											disabled={!canPressEdit}
											variant="outline"
											size="sm"
											data-armed={armed ? "" : undefined}
											onClick={() => setArmedKey(armed ? null : key.label)}
											className="h-auto w-full flex-col gap-0.5 py-1.5 data-[armed]:border-primary/70 data-[armed]:bg-primary/[.12] data-[armed]:text-primary"
										>
											<span className="text-[11px] font-semibold">{key.label}</span>
											<span className="text-[10px] tabular-nums text-[#8a8a93]">
												{derived.edges[key.edgesKey].length}
											</span>
										</Button>
									</TooltipTrigger>
									<TooltipContent side="left">
										{KEY_HARDWARE[key.label]} — {KEYS_ARE_PHYSICAL}.{" "}
										{editBlocker ??
											(armed
												? "armed: the table shows only this key, and add-press writes it. click again to clear"
												: "click to filter the table to this key and arm it for add-press")}
									</TooltipContent>
								</Tooltip>
							);
						})}
					</div>
				</div>

				<div>
					<SectionLabel>
						{armedFilter === null ? "presses near playhead" : `${armedFilter} presses near playhead`}
					</SectionLabel>
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
									onActivate={activateRow}
									onSeek={seekRow}
									disabled={!canPressEdit}
								/>
							))}
						</div>
					</div>
					{canPressEdit && (
						<p className="mt-1.5 text-[10px] leading-[1.5] text-[#8a8a93]">
							click a row to select its press — selecting never moves the playhead. double-click to jump
							there. a row's displayed release can outlive its press; the fields below show the run the
							model actually rewrites.
						</p>
					)}
				</div>

				<div className="rounded-[9px] border border-border bg-surface-card px-3 py-[9px]">
					<SectionLabel>operations</SectionLabel>
					{operations}
				</div>
			</div>
		</>
	);
}
