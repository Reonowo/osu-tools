import { AlertTriangle } from "lucide-react";
import { formatMods } from "@/lib/format";
import type { LoadedSceneWarning } from "@/lib/scene-types";
import { useViewerStore, type ViewerState } from "@/state/store";

export function warningText(w: LoadedSceneWarning): string {
	switch (w.kind) {
		case "audioMissing":
			return "audio file missing — playing silently on the internal clock";
		case "modsNotSimulated":
			return `mods not simulated (${formatMods(w.mods)}) — judgements, combo, and accuracy are hidden`;
		case "beatmapMismatch":
			return "beatmap doesn't match the replay (explicit override) — geometry may be wrong; judgements disabled";
	}
}

/**
 * pairs each warning with its display text, preserving array order exactly --
 * the backend pushes warnings in a fixed mismatch -> mods -> audio order and
 * that order is never sorted or reindexed on the way to the banners
 */
export function bannersFor(warnings: LoadedSceneWarning[]): { kind: LoadedSceneWarning["kind"]; text: string }[] {
	return warnings.map((w) => ({ kind: w.kind, text: warningText(w) }));
}

// a store selector feeds useSyncExternalStore, which compares each snapshot to
// the previous one by reference -- returning a fresh `[]` per call would make
// the snapshot never equal itself and re-render until react's depth limit trips.
// scene is null until a replay loads, so this default is the startup path
const NO_WARNINGS: LoadedSceneWarning[] = [];

export const selectWarnings = (s: ViewerState): LoadedSceneWarning[] => s.scene?.warnings ?? NO_WARNINGS;

export function WarningBanners() {
	const warnings = useViewerStore(selectWarnings);
	if (warnings.length === 0) return null;
	return (
		<div className="pointer-events-none absolute inset-x-0 top-14 z-20 flex flex-col items-center gap-1.5 px-3">
			{bannersFor(warnings).map((banner) => (
				<div
					key={banner.kind}
					className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-950/90 px-3 py-1.5 text-xs text-amber-200 shadow-lg shadow-black/20 backdrop-blur"
				>
					<AlertTriangle className="size-3.5 shrink-0" />
					{banner.text}
				</div>
			))}
		</div>
	);
}
