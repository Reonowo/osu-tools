// the live replay export flow: destination prefilled from the source path
// with an " (edited)" suffix, a native save picker, the path expectation
// keyed off the document's dirty split, the overwrite confirmation
// honouring warnOnOverwrite, and the post-export summary. failures render
// in place as typed reasons, never as vanishing toasts

import { save } from "@tauri-apps/plugin-dialog";
import { Check, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SectionLabel } from "@/components/panels/SectionLabel";
import {
	defaultExportPath,
	expectationCopy,
	exportPathKind,
	initialOverwriteConsent,
	offersOverwriteConfirm,
	outcomeCopy,
	regeneratedSummaryRows
} from "@/lib/export-flow";
import { isIpcError } from "@/lib/ipc";
import type { ExportResult, IpcError } from "@/lib/scene-types";
import { describeIpcError } from "@/state/errors";
import { useViewerStore } from "@/state/store";

type Phase =
	| { step: "form" }
	| { step: "exporting" }
	| { step: "confirmOverwrite" }
	| { step: "done"; result: ExportResult };

export function ExportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const osrPath = useViewerStore((s) => s.osrPath);
	const incompleteness = useViewerStore((s) => s.scene?.incompleteness ?? null);
	// the session identity, not the path: reloading the same .osr installs a
	// new scene under an unchanged osrPath, and that still has to reset the
	// dialog and retire any request belonging to the session it replaced
	const sceneId = useViewerStore((s) => s.sceneId);
	const editor = useViewerStore((s) => s.editor);
	const warnOnOverwrite = useViewerStore((s) => s.editing.warnOnOverwrite);
	const exportReplay = useViewerStore((s) => s.exportReplay);

	const [destination, setDestination] = useState("");
	const [phase, setPhase] = useState<Phase>({ step: "form" });
	const [error, setError] = useState<IpcError | null>(null);

	// identifies the export the dialog is currently showing. a reset can land
	// while a request is still in flight -- a native drop swaps osrPath under
	// an open dialog, which reruns the effect below and clears `exporting` --
	// so every request checks that it is still the current one before it
	// writes an outcome, and never reports over a newer session's dialog
	const currentRequest = useRef(0);

	// each opening starts the flow over from the prefilled default; state
	// left over from a previous export would describe a different file
	useEffect(() => {
		if (open) {
			currentRequest.current += 1;
			setDestination(osrPath === null ? "" : defaultExportPath(osrPath));
			setPhase({ step: "form" });
			setError(null);
		}
	}, [open, osrPath, sceneId]);

	const pathKind = exportPathKind(editor?.framesDirty ?? false, editor?.metadataDirty ?? false);
	const busy = phase.step === "exporting";

	async function browse() {
		const picked = await save({
			defaultPath: destination === "" ? undefined : destination,
			filters: [{ name: "osu! replay", extensions: ["osr"] }]
		});
		if (typeof picked === "string") setDestination(picked);
	}

	async function runExport(overwrite: boolean) {
		const request = ++currentRequest.current;
		setPhase({ step: "exporting" });
		setError(null);
		try {
			const result = await exportReplay(destination, overwrite);
			if (request !== currentRequest.current) return;
			setPhase({ step: "done", result });
		} catch (e) {
			if (request !== currentRequest.current) return;
			const typed: IpcError = isIpcError(e) ? e : { kind: "internal", message: String(e) };
			if (offersOverwriteConfirm(typed)) {
				// only reachable with the warning on: consent was withheld and
				// the destination exists, so overwriting becomes a decision
				setPhase({ step: "confirmOverwrite" });
			} else {
				setError(typed);
				setPhase({ step: "form" });
			}
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// every dismissal route -- the close button, escape, a click
				// outside -- funnels through here, so one guard keeps the only
				// success/error surface on screen while the write is in flight.
				// it also stops a settling export from landing its result in a
				// dialog the user has since reopened for a different destination
				if (busy && !next) return;
				onOpenChange(next);
			}}
		>
			<DialogContent className="sm:max-w-[452px]">
				<DialogHeader>
					<DialogTitle>export replay</DialogTitle>
					<DialogDescription>{expectationCopy(pathKind, incompleteness !== null)}</DialogDescription>
				</DialogHeader>

				{phase.step === "done" ? (
					<>
						<div className="rounded-[9px] border border-border bg-surface-card px-3 py-[9px]">
							<SectionLabel>
								{phase.result.regenerated === null ? "written" : "regenerated fields"}
							</SectionLabel>
							{phase.result.regenerated === null ? (
								<p className="mt-2 text-[11px] text-[#a1a1aa]">
									{outcomeCopy(pathKind, phase.result.bytes)}
								</p>
							) : (
								<div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-[7px]">
									{regeneratedSummaryRows(phase.result.regenerated).map(({ label, value }) => (
										<span
											key={label}
											className="flex items-center justify-between gap-2 text-[11px]"
										>
											<span className="flex items-center gap-1.5 text-[#8a8a93]">
												<Check className="size-3 shrink-0 text-[#88b300]" aria-hidden />
												{label}
											</span>
											<span className="tabular-nums text-[#e4e4e7]">{value}</span>
										</span>
									))}
								</div>
							)}
						</div>
						<p className="break-all text-[10.5px] text-[#8a8a93]">{phase.result.path}</p>
						<DialogFooter>
							<Button onClick={() => onOpenChange(false)}>close</Button>
						</DialogFooter>
					</>
				) : phase.step === "confirmOverwrite" ? (
					<>
						<div className="flex items-start gap-2 rounded-[9px] border border-[rgba(245,158,11,.35)] bg-[rgba(69,26,3,.55)] px-3 py-2.5 text-[10.5px] leading-[1.55] text-[#fbbf24]">
							<TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
							<p className="break-all">{destination} already exists. replace it?</p>
						</div>
						<DialogFooter>
							<Button variant="ghost" onClick={() => setPhase({ step: "form" })}>
								back
							</Button>
							<Button onClick={() => void runExport(true)}>replace</Button>
						</DialogFooter>
					</>
				) : (
					<>
						<div className="space-y-2">
							<SectionLabel>destination</SectionLabel>
							<div className="flex items-center gap-2 text-sm">
								<Input
									value={destination}
									onChange={(e) => setDestination(e.target.value)}
									disabled={busy}
									className="min-w-0 flex-1"
									spellCheck={false}
								/>
								<Button size="sm" variant="secondary" disabled={busy} onClick={() => void browse()}>
									browse
								</Button>
							</div>
						</div>

						{error !== null &&
							(() => {
								const { title, detail } = describeIpcError(error);
								return (
									<div className="flex items-start gap-2 rounded-[9px] border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[10.5px] leading-[1.55] text-destructive">
										<TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
										<p>
											{title}: {detail}
										</p>
									</div>
								);
							})()}

						<DialogFooter>
							<Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
								cancel
							</Button>
							<Button
								disabled={busy || destination.trim() === ""}
								onClick={() => void runExport(initialOverwriteConsent(warnOnOverwrite))}
							>
								{busy ? "exporting…" : "export .osr"}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
