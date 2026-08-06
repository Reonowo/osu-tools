import { FolderOpen, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pickReplay } from "@/lib/openers";
import { useViewerStore } from "@/state/store";

export function TopBar({ onOpenSettings }: { onOpenSettings: () => void }) {
	const scene = useViewerStore((s) => s.scene);
	const loading = useViewerStore((s) => s.loading);
	return (
		<header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center gap-3 bg-gradient-to-b from-black/55 to-transparent px-4 py-3">
			<span className="pointer-events-auto text-[0.7rem] font-medium tracking-[0.12em] text-zinc-500 uppercase">
				osu! replay viewer
			</span>
			{scene !== null && (
				<span className="pointer-events-auto truncate text-sm font-medium text-zinc-100">
					{scene.beatmap.artist} <span className="text-zinc-500">—</span> {scene.beatmap.title}{" "}
					<span className="text-zinc-400">[{scene.beatmap.version}]</span>
				</span>
			)}
			<div className="pointer-events-auto ml-auto flex items-center gap-1">
				<Button size="sm" variant="ghost" onClick={() => void pickReplay()} disabled={loading}>
					<FolderOpen /> open replay
				</Button>
				<Button size="icon" variant="ghost" aria-label="settings" onClick={onOpenSettings}>
					<Settings2 />
				</Button>
			</div>
		</header>
	);
}
