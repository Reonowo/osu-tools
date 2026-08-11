import { useEffect, useState } from "react";
import { toast, Toaster } from "sonner";
import { AppShell } from "@/components/shell/AppShell";
import { ExportDialog } from "@/components/ExportDialog";
import { MismatchDialog } from "@/components/MismatchDialog";
import { SettingsDialog } from "@/components/SettingsDialog";
import { StartScreen } from "@/components/StartScreen";
import { TooltipProvider } from "@/components/ui/tooltip";
import { invokeSetViewerPrefs } from "@/lib/ipc";
import { installDropHandler, pickBeatmapFor } from "@/lib/openers";
import { describeIpcError } from "@/state/errors";
import { installPrefsPersistence } from "@/state/persist";
import { useViewerStore, viewerStore } from "@/state/store";

export default function App() {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [exportOpen, setExportOpen] = useState(false);
	const scene = useViewerStore((s) => s.scene);
	const lastError = useViewerStore((s) => s.lastError);

	useEffect(() => {
		const cleanup = installDropHandler();
		return () => void cleanup.then((unlisten) => unlisten());
	}, []);

	// ctrl+wheel is the webview's own page zoom, and nothing in this app is
	// ever meant to resize that way -- the gesture belongs to the viewport's
	// pointer-anchored zoom and the timeline dock's span zoom, both of which
	// read the event through their own (bubbling, so unaffected) handlers.
	// suppressed here, at the app root, so it also covers the start screen
	// and every dialog; non-passive because preventDefault is the whole point
	useEffect(() => {
		function onWheel(e: WheelEvent) {
			if (e.ctrlKey) e.preventDefault();
		}
		window.addEventListener("wheel", onWheel, { passive: false });
		return () => window.removeEventListener("wheel", onWheel);
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
		// one provider for the whole app: every Tooltip below already existed but
		// had no Provider above it, so they all ran on base-ui's own default
		// delay. 300ms is long enough not to fire on a cursor passing over an
		// icon and short enough to feel like an answer to hovering one
		<TooltipProvider delay={300}>
			{scene === null ? (
				<StartScreen onOpenSettings={() => setSettingsOpen(true)} />
			) : (
				<AppShell onOpenSettings={() => setSettingsOpen(true)} onOpenExport={() => setExportOpen(true)} />
			)}
			<MismatchDialog />
			<SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
			<ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
			{/* select-text: error toasts are diagnostic copy opt-ins (index.css) */}
			<Toaster theme="dark" position="bottom-right" richColors toastOptions={{ className: "select-text" }} />
		</TooltipProvider>
	);
}
