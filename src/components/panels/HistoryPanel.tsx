// the history tab: the label list mirrors the store's undo stack exactly, with
// the cursor position marking which node is live. header / scrolling node list
// / pinned footer, so SidePanel can mount this as a single self-contained
// panel and revert-all stays reachable however deep the stack grows

import { useEffect, useRef, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PanelHeader } from "@/components/shell/SidePanel";
import { useViewerStore } from "@/state/store";

/** the osr path's own name, whichever separator its platform used */
function basename(path: string): string {
	const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return idx === -1 ? path : path.slice(idx + 1);
}

export function HistoryPanel() {
	const osrPath = useViewerStore((s) => s.osrPath);
	const editor = useViewerStore((s) => s.editor);
	const revertAll = useViewerStore((s) => s.revertAll);

	return (
		<HistoryPanelBody
			osrPath={osrPath}
			labels={editor?.history.labels ?? []}
			cursor={editor?.history.cursor ?? 0}
			dirty={editor?.dirty === true}
			onRevertAll={() => void revertAll()}
		/>
	);
}

/** the panel proper, prop-only so the rendered-markup contract test can render
 * it without a store -- the same treatment FramesPanel gives FrameRow */
export function HistoryPanelBody({
	osrPath,
	labels,
	cursor,
	dirty,
	onRevertAll
}: {
	osrPath: string | null;
	labels: string[];
	cursor: number;
	dirty: boolean;
	onRevertAll: () => void;
}) {
	const currentRef = useRef<HTMLDivElement>(null);

	// on any cursor change, not just a new edit: undo and redo are precisely
	// when the user wants to see where they landed. instant rather than
	// smooth, because a smooth scroll visibly lags a held ctrl+Z
	useEffect(() => {
		currentRef.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
	}, [cursor]);

	return (
		// the opt-out sits on the root rather than on the list: the pinned
		// footer is outside the scroll-area viewport (which the wheel guard
		// already recognises by its slot), and wheeling over the button would
		// otherwise frame-step the replay
		<div data-native-wheel="" className="flex min-h-0 flex-1 flex-col">
			<PanelHeader title="history" trailing={labels.length > 0 ? `${cursor}/${labels.length}` : undefined} />
			{/* the only scrolling region, so the header's count and the footer's
			    action both stay anchored however long the stack grows */}
			<ScrollArea className="min-h-0 flex-1">
				<div className="flex min-w-0 flex-col gap-2.5 p-3.5">
					{/* chronological: baseline first, newest last, undone entries
					    dimmed below the cursor -- reversing it would invert the
					    spatial relationship that dimming encodes */}
					<HistoryNode
						label="baseline"
						detail={`as loaded from ${osrPath !== null ? basename(osrPath) : "an unrecorded path"}`}
						state={cursor === 0 ? "current" : "applied"}
						nodeRef={cursor === 0 ? currentRef : undefined}
					/>
					{labels.map((label, i) => {
						const state = i >= cursor ? "undone" : i === cursor - 1 ? "current" : "applied";
						return (
							<HistoryNode
								key={i}
								label={label}
								detail={`edit ${i + 1}`}
								state={state}
								nodeRef={state === "current" ? currentRef : undefined}
							/>
						);
					})}
				</div>
			</ScrollArea>

			<div className="flex flex-col gap-2.5 border-t border-border p-3.5">
				<Button variant="outline" size="sm" className="w-full" disabled={!dirty} onClick={onRevertAll}>
					revert all
				</Button>

				<p className="text-[10.5px] leading-[1.55] text-[#8a8a93]">
					undoing back to baseline clears the dirty marker, so export re-emits the original unparsed trailing
					bytes verbatim. revert all restores the baseline directly, as one more undoable step.
				</p>
			</div>
		</div>
	);
}

function HistoryNode({
	label,
	detail,
	state,
	nodeRef
}: {
	label: string;
	detail: string;
	state: "applied" | "current" | "undone";
	nodeRef?: RefObject<HTMLDivElement | null>;
}) {
	return (
		<div
			ref={nodeRef}
			className={state === "undone" ? "flex items-start gap-2.5 opacity-45" : "flex items-start gap-2.5"}
		>
			<span
				className={
					state === "current"
						? "mt-[3px] size-[7px] shrink-0 rounded-full bg-primary"
						: "mt-[3px] size-[7px] shrink-0 rounded-full border border-[#71717a]"
				}
			/>
			<div>
				<div className={state === "current" ? "text-[11px] text-[#e4e4e7]" : "text-[11px] text-[#a1a1aa]"}>
					{label}
				</div>
				<div className="mt-0.5 font-mono text-[9.5px] text-[#8a8a93]">{detail}</div>
			</div>
		</div>
	);
}
