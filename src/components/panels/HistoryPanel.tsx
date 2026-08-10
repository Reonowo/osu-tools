// the history tab: the label list mirrors the store's undo stack exactly, with
// the cursor position marking which node is live. header + scrolling body
// together, so SidePanel can mount this as a single self-contained panel

import { Button } from "@/components/ui/button";
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

	const labels = editor?.history.labels ?? [];
	const cursor = editor?.history.cursor ?? 0;

	return (
		<div className="flex min-h-0 flex-col">
			<PanelHeader title="history" trailing={labels.length > 0 ? `${cursor}/${labels.length}` : undefined} />
			<div
				data-native-wheel=""
				className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto overflow-x-hidden p-3.5"
			>
				<div className="flex flex-col gap-2.5">
					<HistoryNode
						label="baseline"
						detail={`as loaded from ${osrPath !== null ? basename(osrPath) : "an unrecorded path"}`}
						state={cursor === 0 ? "current" : "applied"}
					/>
					{labels.map((label, i) => (
						<HistoryNode
							key={i}
							label={label}
							detail={`edit ${i + 1}`}
							state={i >= cursor ? "undone" : i === cursor - 1 ? "current" : "applied"}
						/>
					))}
				</div>

				<Button
					variant="outline"
					size="sm"
					className="w-full"
					disabled={editor?.dirty !== true}
					onClick={() => void revertAll()}
				>
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
	state
}: {
	label: string;
	detail: string;
	state: "applied" | "current" | "undone";
}) {
	return (
		<div className={state === "undone" ? "flex items-start gap-2.5 opacity-45" : "flex items-start gap-2.5"}>
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
