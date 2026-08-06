import { FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pickReplay } from "@/lib/openers";
import { useViewerStore } from "@/state/store";

export function DropZone() {
  const scene = useViewerStore((s) => s.scene);
  const loading = useViewerStore((s) => s.loading);
  if (scene !== null) return null;
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center">
      <div className="flex w-96 flex-col items-center gap-3 rounded-xl border-2 border-dashed border-zinc-700 bg-zinc-900/60 px-8 py-12 text-center backdrop-blur">
        <FileUp className="size-8 text-zinc-500" />
        <p className="text-sm text-zinc-300">drop a <code>.osr</code> replay anywhere</p>
        <p className="text-xs text-zinc-500">
          the beatmap is found through your osu! stable install; you'll be asked for it if it can't be
        </p>
        <Button onClick={() => void pickReplay()} disabled={loading} className="mt-2">
          {loading ? "loading…" : "browse for a replay"}
        </Button>
      </div>
    </div>
  );
}
