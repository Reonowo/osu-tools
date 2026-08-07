// the history tab: undo has no ipc surface yet, and the document has never
// been mutated (there is no mutation surface to mutate it with), so the only
// honest timeline is the single baseline node -- inventing edit entries here
// would misrepresent a document that has never changed. header + scrolling
// body together, so SidePanel can mount this as a single self-contained panel

import { Button } from "@/components/ui/button";
import { PanelHeader } from "@/components/shell/SidePanel";
import { useViewerStore } from "@/state/store";
import { InertNotice } from "./InertNotice";

/** the osr path's own name, whichever separator its platform used */
function basename(path: string): string {
	const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return idx === -1 ? path : path.slice(idx + 1);
}

export function HistoryPanel() {
	const scene = useViewerStore((s) => s.scene);
	const osrPath = useViewerStore((s) => s.osrPath);
	if (scene === null) return null;

	return (
		<>
			<PanelHeader title="history" />
			<div
				data-native-wheel=""
				className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto overflow-x-hidden p-3.5"
			>
				<InertNotice>undo history needs the replay-document ipc commands</InertNotice>

				<div className="flex items-start gap-2.5">
					<span className="mt-[3px] size-[7px] shrink-0 rounded-full border border-[#71717a]" />
					<div>
						<div className="text-[11px] text-[#71717a]">baseline</div>
						<div className="mt-0.5 font-mono text-[9.5px] text-[#8a8a93]">
							{/* osrPath is set in the same install() call as scene (store.ts),
							so by the time the scene !== null guard above has let this render,
							osrPath is guaranteed non-null too -- the null branch below is
							unreachable in practice. kept for type honesty (osrPath's type is
							string | null) rather than asserting it away with a `!` */}
							as loaded from {osrPath !== null ? basename(osrPath) : "an unrecorded path"}
						</div>
					</div>
				</div>

				<Button disabled variant="outline" size="sm" className="w-full">
					revert all
				</Button>

				<p className="text-[10.5px] leading-[1.55] text-[#8a8a93]">
					undoing back to baseline clears the dirty marker, so export re-emits the original unparsed trailing
					bytes verbatim.
				</p>
			</div>
		</>
	);
}
