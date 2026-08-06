import { useEffect, useState } from "react";
import { toast, Toaster } from "sonner";
import { Controls, HudReadout } from "@/components/Controls";
import { DropZone } from "@/components/DropZone";
import { InfoPanel } from "@/components/InfoPanel";
import { KeypressOverlay } from "@/components/KeypressOverlay";
import { MismatchDialog } from "@/components/MismatchDialog";
import { PlayerView } from "@/components/PlayerView";
import { SettingsDialog } from "@/components/SettingsDialog";
import { TopBar } from "@/components/TopBar";
import { WarningBanners } from "@/components/WarningBanners";
import { invokeSetViewerPrefs } from "@/lib/ipc";
import { installDropHandler, pickBeatmapFor } from "@/lib/openers";
import { describeIpcError } from "@/state/errors";
import { installPrefsPersistence } from "@/state/persist";
import { useViewerStore, viewerStore } from "@/state/store";

export default function App() {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const lastError = useViewerStore((s) => s.lastError);

	useEffect(() => {
		const cleanup = installDropHandler();
		return () => void cleanup.then((unlisten) => unlisten());
	}, []);

	// persistence is installed only after hydration resolves, so the loaded
	// values are not immediately written back. the cancelled flag covers
	// strict-mode's double mount, where the first effect is torn down while
	// its hydrate is still in flight
	useEffect(() => {
		let cancelled = false;
		let dispose: (() => void) | null = null;
		void viewerStore
			.getState()
			.hydrateSettings()
			.then(() => {
				if (cancelled) return;
				dispose = installPrefsPersistence(viewerStore, invokeSetViewerPrefs);
			});
		return () => {
			cancelled = true;
			dispose?.();
		};
	}, []);

	useEffect(() => {
		if (lastError === null) return;
		const { title, detail, recovery } = describeIpcError(lastError.error);
		toast.error(title, {
			description: detail,
			duration: recovery === null ? 6000 : 30_000,
			action:
				recovery === "pickBeatmap"
					? { label: "pick beatmap", onClick: () => void pickBeatmapFor(lastError.osrPath) }
					: undefined
		});
		viewerStore.getState().clearError();
	}, [lastError]);

	return (
		<div className="relative h-screen w-screen overflow-hidden bg-zinc-950 font-sans text-zinc-200">
			<main className="absolute inset-0">
				<PlayerView />
			</main>

			<TopBar onOpenSettings={() => setSettingsOpen(true)} />
			<WarningBanners />
			<DropZone />
			<InfoPanel />
			<Controls />
			<HudReadout />
			<KeypressOverlay />
			<MismatchDialog />
			<SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
			<Toaster theme="dark" position="bottom-right" richColors />
		</div>
	);
}
