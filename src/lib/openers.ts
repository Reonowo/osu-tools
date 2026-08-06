import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { toast } from "sonner";
import { viewerStore } from "../state/store";

export async function pickReplay(): Promise<void> {
	const path = await open({
		multiple: false,
		filters: [{ name: "osu! replay", extensions: ["osr"] }]
	});
	if (typeof path === "string") await viewerStore.getState().openReplay(path);
}

export async function pickBeatmapFor(osrPath: string): Promise<void> {
	const path = await open({
		multiple: false,
		filters: [{ name: "beatmap", extensions: ["osu", "osz"] }]
	});
	if (typeof path === "string") await viewerStore.getState().openWithBeatmap(osrPath, path);
}

function extensionOf(path: string): string {
	return path.slice(path.lastIndexOf(".") + 1).toLowerCase();
}

/** routes native file drops; returns the unlisten fn */
export async function installDropHandler(): Promise<() => void> {
	return await getCurrentWebview().onDragDropEvent((event) => {
		if (event.payload.type !== "drop") return;
		const paths = event.payload.paths;
		const osr = paths.find((p) => extensionOf(p) === "osr");
		if (osr !== undefined) {
			void viewerStore.getState().openReplay(osr);
			return;
		}
		const beatmap = paths.find((p) => ["osu", "osz"].includes(extensionOf(p)));
		if (beatmap !== undefined) {
			// pendingRecovery outlives lastError, which App.tsx clears synchronously
			// once its toast is raised (see the field's doc comment in state/store.ts)
			const { pendingRecovery } = viewerStore.getState();
			if (pendingRecovery !== null) {
				void viewerStore.getState().openWithBeatmap(pendingRecovery, beatmap);
			} else {
				toast("drop a .osr replay first — a beatmap alone can't be opened");
			}
		}
	});
}
