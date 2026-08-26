// the video export flow: consent → install on first use, the typed core
// prefs plus the renderer's own section (every control of which reads and
// writes the opaque blob), the up-front save dialog, live stage/percent
// progress with cancel, and failures rendered in place with the renderer's
// log a click away. every decision -- the default name, the gate, the skin
// statement, the blob paths -- lives in lib/video-export-flow.ts and
// lib/danser-section.ts where the tests hold it; this component is the shell

import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { save } from "@tauri-apps/plugin-dialog";
import { Check, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SectionLabel } from "@/components/panels/SectionLabel";
import { ToggleRow } from "@/components/settings/ToggleRow";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VideoConsentSection } from "@/components/VideoConsentDialog";
import { DANSER_BACKEND_ID, DANSER_BACKGROUND_DIM, DANSER_ENCODER_CHOICES, DANSER_TOGGLES } from "@/lib/danser-section";
import { isIpcError, onVideoProgress } from "@/lib/ipc";
import type {
	IpcError,
	VideoExportResult,
	VideoProgressEvent,
	VideoRendererStatus,
	VideoResolution,
	VideoSkinPolicy
} from "@/lib/scene-types";
import {
	blobBool,
	blobNumber,
	blobString,
	defaultVideoFileName,
	defaultVideoSavePath,
	directoryOfPath,
	fileNameOfPath,
	PROBED_ENCODER_KEY,
	renderProgressLine,
	stageLabel,
	videoSkinStatement,
	withBlobValue
} from "@/lib/video-export-flow";
import { describeIpcError } from "@/state/errors";
import { useViewerStore } from "@/state/store";
import { DEFAULT_SKIN, DEFAULT_VIDEO } from "@/state/defaults";

type Phase =
	| { step: "loading" }
	| { step: "unavailable" }
	| { step: "consent" }
	| { step: "installing" }
	| { step: "form" }
	| { step: "exporting" }
	| { step: "done"; result: VideoExportResult };

const EXPORT_STAGES = ["staging", "rendering", "moving"] as const;
const RESOLUTIONS: VideoResolution[] = ["1280x720", "1920x1080", "2560x1440", "3840x2160"];

export function VideoExportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const scene = useViewerStore((s) => s.scene);
	const editor = useViewerStore((s) => s.editor);
	const settings = useViewerStore((s) => s.settings);
	const exportVideo = useViewerStore((s) => s.exportVideo);
	const cancelVideoExport = useViewerStore((s) => s.cancelVideoExport);
	const getVideoRendererStatus = useViewerStore((s) => s.getVideoRendererStatus);
	const installVideoRenderer = useViewerStore((s) => s.installVideoRenderer);
	const saveVideoPrefs = useViewerStore((s) => s.saveVideoPrefs);
	const redetectVideoEncoder = useViewerStore((s) => s.redetectVideoEncoder);

	const [phase, setPhase] = useState<Phase>({ step: "loading" });
	const [status, setStatus] = useState<VideoRendererStatus | null>(null);
	const [error, setError] = useState<IpcError | null>(null);
	const [progress, setProgress] = useState<VideoProgressEvent | null>(null);

	// identifies the flow the dialog is currently showing, the ExportDialog
	// convention: re-entering a flow retires the in-flight request behind it
	// so a late answer cannot report over the newer one. deliberately NOT
	// bumped by a scene swap -- unlike the replay dialog, a video job outlives
	// the scene it started in, and retiring it would strand a live render
	const currentRequest = useRef(0);
	/** whether a backend video operation is running and still owns this
	 * dialog's phase -- a ref, not state, because the status effect has to
	 * read it without listing it as a dependency it would then re-run on */
	const operationInFlight = useRef(false);

	const video = settings?.video ?? DEFAULT_VIDEO;
	const rendererOptions = settings?.rendererOptions ?? {};
	const skin = settings?.skin ?? DEFAULT_SKIN;
	const backendId = status?.metadata.id ?? "";
	const busy = phase.step === "exporting" || phase.step === "installing";

	// the shared progress channel, subscribed while the dialog is open: one
	// video operation runs at a time app-wide, so every event during our
	// await belongs to the operation this dialog started
	useEffect(() => {
		if (!open) return;
		const unlisten = onVideoProgress(setProgress);
		return () => void unlisten.then((dispose) => dispose());
	}, [open]);

	// each opening starts over: fetch the renderer status and route to the
	// consent or the form
	useEffect(() => {
		if (!open) return;
		// ...on each OPENING, and on nothing else. the scene is deliberately
		// not a dependency here: a job owns copies of everything it needs the
		// moment staging ends (spec, job lifecycle), precisely so the user can
		// open another replay while it renders, and re-running on that scene
		// change would retire the request token the running job answers on --
		// discarding its result and replacing the progress and cancel surface
		// with a form while the job carried on writing to the destination.
		// nothing this effect fetches is scene-derived anyway: the renderer's
		// install state is app-wide, and the scene-dependent copy (the skin
		// statement, the default file name) is computed at render and export
		// time from live values, so it stays current without a reset.
		// the in-flight guard covers the remaining path, an `open` that
		// toggles while a job runs
		if (operationInFlight.current) return;
		const request = ++currentRequest.current;
		setPhase({ step: "loading" });
		setStatus(null);
		setError(null);
		setProgress(null);
		getVideoRendererStatus()
			.then((fresh) => {
				if (request !== currentRequest.current) return;
				setStatus(fresh);
				setPhase(fresh.installed ? { step: "form" } : { step: "consent" });
			})
			.catch((e) => {
				if (request !== currentRequest.current) return;
				setError(isIpcError(e) ? e : { kind: "internal", message: String(e) });
				setPhase({ step: "unavailable" });
			});
	}, [open, getVideoRendererStatus]);

	async function runInstall() {
		const request = currentRequest.current;
		setPhase({ step: "installing" });
		setError(null);
		// a previous operation's last event would otherwise still be sitting
		// here, and an earlier INSTALL's would even pass the stage check below
		// and arm the cancel button against a job id that is long gone
		setProgress(null);
		operationInFlight.current = true;
		try {
			const fresh = await installVideoRenderer();
			if (request !== currentRequest.current) return;
			setStatus(fresh);
			setPhase({ step: "form" });
		} catch (e) {
			if (request !== currentRequest.current) return;
			const typed = isIpcError(e) ? e : { kind: "internal" as const, message: String(e) };
			// a cancel is the user's own act; the consent step returns without a
			// scold, exactly as runExport's does
			if (typed.kind !== "cancelled") setError(typed);
			setPhase({ step: "consent" });
		} finally {
			operationInFlight.current = false;
		}
	}

	async function runExport() {
		if (scene === null) return;
		const fileName = defaultVideoFileName(scene, editor?.dirty === true);
		const picked = await save({
			defaultPath: defaultVideoSavePath(fileName, video.lastVideoDir),
			filters: [{ name: "mp4 video", extensions: ["mp4"] }]
		});
		if (typeof picked !== "string") return;
		// remember the picked directory for the next dialog's prefill
		const dir = directoryOfPath(picked);
		if (dir !== null && dir !== video.lastVideoDir) {
			void saveVideoPrefs({ ...video, lastVideoDir: dir }, rendererOptions);
		}

		const request = ++currentRequest.current;
		setPhase({ step: "exporting" });
		setError(null);
		setProgress(null);
		operationInFlight.current = true;
		try {
			const result = await exportVideo(picked);
			if (request !== currentRequest.current) return;
			setPhase({ step: "done", result });
		} catch (e) {
			if (request !== currentRequest.current) return;
			const typed: IpcError = isIpcError(e) ? e : { kind: "internal", message: String(e) };
			if (typed.kind !== "cancelled") setError(typed);
			// a cancel is the user's own act; the form returns without a scold
			setPhase({ step: "form" });
		} finally {
			operationInFlight.current = false;
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// the ExportDialog guard: while an install or an export is in
				// flight this dialog is the only progress/cancel surface, so no
				// dismissal route may take it down
				if (busy && !next) return;
				onOpenChange(next);
			}}
		>
			<DialogContent className="max-h-[calc(100dvh-4rem)] overflow-y-auto sm:max-w-[520px]">
				<DialogHeader>
					<DialogTitle>export video</DialogTitle>
					<DialogDescription>
						{phase.step === "consent" || phase.step === "installing"
							? "video export uses an external renderer, downloaded once with your consent"
							: "render the current document to an mp4 through the external renderer"}
					</DialogDescription>
				</DialogHeader>

				{phase.step === "loading" ? (
					<p className="flex items-center gap-2 text-[11.5px] text-[#8a8a93]">
						<Loader2 className="size-3.5 animate-spin" aria-hidden /> checking the renderer…
					</p>
				) : phase.step === "unavailable" ? (
					<>
						{error !== null && <ErrorPanel error={error} logPath={status?.logPath ?? null} />}
						<DialogFooter>
							<Button variant="ghost" onClick={() => onOpenChange(false)}>
								close
							</Button>
						</DialogFooter>
					</>
				) : phase.step === "consent" || phase.step === "installing" ? (
					<>
						{status !== null && (
							<VideoConsentSection
								metadata={status.metadata}
								busy={phase.step === "installing"}
								onAccept={() => void runInstall()}
								onDecline={() => onOpenChange(false)}
							/>
						)}
						{phase.step === "installing" && (
							<>
								<ProgressBar
									label={stageLabel("installing")}
									percent={progress?.stage === "installing" ? (progress.percent ?? null) : null}
								/>
								{/* an install holds the one video slot and this dialog
								    refuses every dismissal route while it runs, so
								    without this the user is pinned to the modal for the
								    whole of a slow download. the id is the install's own
								    job id, which rides the same progress channel an
								    export's does */}
								<DialogFooter>
									<Button
										variant="ghost"
										disabled={progress?.stage !== "installing"}
										onClick={() => {
											if (progress?.stage === "installing")
												void cancelVideoExport(progress.jobId);
										}}
									>
										cancel install
									</Button>
								</DialogFooter>
							</>
						)}
						{phase.step === "consent" && error !== null && (
							<ErrorPanel error={error} logPath={status?.logPath ?? null} />
						)}
					</>
				) : phase.step === "done" ? (
					<>
						<div className="rounded-[9px] border border-border bg-surface-card px-3 py-[9px]">
							<SectionLabel>written</SectionLabel>
							<p className="mt-2 flex items-center gap-1.5 text-[11px] text-[#a1a1aa]">
								<Check className="size-3 shrink-0 text-[#88b300]" aria-hidden />
								{phase.result.bytes.toLocaleString()} bytes rendered
							</p>
						</div>
						<p className="break-all text-[10.5px] text-[#8a8a93]">{phase.result.path}</p>
						<DialogFooter>
							<Button variant="secondary" onClick={() => void revealItemInDir(phase.result.path)}>
								show in folder
							</Button>
							<Button onClick={() => onOpenChange(false)}>close</Button>
						</DialogFooter>
					</>
				) : phase.step === "exporting" ? (
					<>
						<div className="space-y-2 rounded-[9px] border border-border bg-surface-card px-3 py-[9px]">
							{EXPORT_STAGES.map((stage) => {
								const currentIndex =
									progress === null
										? 0
										: EXPORT_STAGES.indexOf(progress.stage as (typeof EXPORT_STAGES)[number]);
								const index = EXPORT_STAGES.indexOf(stage);
								const state =
									index < currentIndex ? "done" : index === currentIndex ? "active" : "pending";
								return (
									<div
										key={stage}
										className={`flex items-center gap-2 text-[11.5px] ${
											state === "active"
												? "text-[#e4e4e7]"
												: state === "done"
													? "text-[#8a8a93]"
													: "text-[#52525b]"
										}`}
									>
										{state === "done" ? (
											<Check className="size-3 shrink-0 text-[#88b300]" aria-hidden />
										) : state === "active" ? (
											<Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
										) : (
											<span className="size-3 shrink-0" aria-hidden />
										)}
										{stageLabel(stage)}
										{stage === "rendering" && progress?.stage === "rendering" && (
											<span className="ml-auto font-mono text-[10.5px] tabular-nums text-[#a1a1aa]">
												{renderProgressLine(progress)}
											</span>
										)}
									</div>
								);
							})}
							{progress?.stage === "rendering" && progress.percent !== undefined && (
								<ProgressBar label={null} percent={progress.percent} />
							)}
						</div>
						<DialogFooter>
							<Button
								variant="ghost"
								disabled={progress === null}
								onClick={() => {
									if (progress !== null) void cancelVideoExport(progress.jobId);
								}}
							>
								cancel export
							</Button>
						</DialogFooter>
					</>
				) : (
					scene !== null &&
					status !== null && (
						<>
							<div className="space-y-2.5 rounded-[9px] border border-border bg-surface-card px-3 py-[9px]">
								<SectionLabel>video</SectionLabel>
								<PrefRow label="resolution">
									<ToggleGroup
										value={[video.resolution]}
										onValueChange={(next) => {
											const resolution = next[0] as VideoResolution | undefined;
											if (resolution !== undefined)
												void saveVideoPrefs({ ...video, resolution }, rendererOptions);
										}}
										className="h-6 rounded-lg border border-border bg-[#131316] p-0.5"
									>
										{RESOLUTIONS.map((preset) => (
											<ToggleGroupItem key={preset} value={preset} className={PRESET_ITEM}>
												{preset.split("x")[1]}p
											</ToggleGroupItem>
										))}
									</ToggleGroup>
								</PrefRow>
								<PrefRow label="frame rate">
									<ToggleGroup
										value={[String(video.fps)]}
										onValueChange={(next) => {
											const fps = Number(next[0]);
											if (fps === 30 || fps === 60)
												void saveVideoPrefs({ ...video, fps }, rendererOptions);
										}}
										className="h-6 rounded-lg border border-border bg-[#131316] p-0.5"
									>
										<ToggleGroupItem value="30" className={PRESET_ITEM}>
											30
										</ToggleGroupItem>
										<ToggleGroupItem value="60" className={PRESET_ITEM}>
											60
										</ToggleGroupItem>
									</ToggleGroup>
								</PrefRow>
								{/* the encoder ids are ffmpeg's, which is danser's bundled
								    vocabulary rather than a renderer-agnostic one: the core
								    pref holds whatever id is chosen, but only the backend
								    that probes and accepts these may offer them */}
								{backendId === DANSER_BACKEND_ID && (
									<PrefRow label="encoder">
										<span className="flex items-center gap-1">
											<ToggleGroup
												value={[video.encoder]}
												onValueChange={(next) => {
													const encoder = next[0];
													if (encoder !== undefined)
														void saveVideoPrefs({ ...video, encoder }, rendererOptions);
												}}
												className="h-6 rounded-lg border border-border bg-[#131316] p-0.5"
											>
												{DANSER_ENCODER_CHOICES.map((choice) => (
													<ToggleGroupItem
														key={choice.id}
														value={choice.id}
														className={PRESET_ITEM}
													>
														{choice.label}
													</ToggleGroupItem>
												))}
											</ToggleGroup>
											<Tooltip>
												<TooltipTrigger
													render={
														<Button
															size="icon-sm"
															variant="ghost"
															aria-label="re-detect encoder"
															onClick={() => void redetectVideoEncoder()}
														>
															<RefreshCw />
														</Button>
													}
												/>
												<TooltipContent>
													re-run the hardware encoder detection
													{blobString(
														rendererOptions,
														backendId,
														[PROBED_ENCODER_KEY],
														""
													) !== ""
														? ` (currently ${blobString(rendererOptions, backendId, [PROBED_ENCODER_KEY], "")})`
														: ""}
												</TooltipContent>
											</Tooltip>
										</span>
									</PrefRow>
								)}
								<PrefRow label="skin">
									<ToggleGroup
										value={[video.skinPolicy]}
										onValueChange={(next) => {
											const skinPolicy = next[0] as VideoSkinPolicy | undefined;
											if (skinPolicy !== undefined)
												void saveVideoPrefs({ ...video, skinPolicy }, rendererOptions);
										}}
										className="h-6 rounded-lg border border-border bg-[#131316] p-0.5"
									>
										<ToggleGroupItem value="followApp" className={PRESET_ITEM}>
											app skin
										</ToggleGroupItem>
										<ToggleGroupItem value="rendererDefault" className={PRESET_ITEM}>
											renderer default
										</ToggleGroupItem>
									</ToggleGroup>
								</PrefRow>
								<p className="text-[10.5px] text-[#8a8a93]">
									{videoSkinStatement(video.skinPolicy, skin, status.metadata.name)}
								</p>
							</div>

							{backendId === DANSER_BACKEND_ID && (
								<div className="space-y-2 rounded-[9px] border border-border bg-surface-card px-3 py-[9px]">
									<SectionLabel>{status.metadata.name} options</SectionLabel>
									{DANSER_TOGGLES.map((toggle) => (
										<ToggleRow
											key={toggle.label}
											label={toggle.label}
											description={toggle.description}
											checked={blobBool(rendererOptions, backendId, toggle.path, toggle.default)}
											onCheckedChange={(value) =>
												void saveVideoPrefs(
													video,
													withBlobValue(rendererOptions, backendId, toggle.path, value)
												)
											}
										/>
									))}
									{(() => {
										// stored as danser stores it (0-1), shown as the percent
										// slider every dim control in this app uses
										const dimPercent = Math.round(
											blobNumber(
												rendererOptions,
												backendId,
												DANSER_BACKGROUND_DIM.path,
												DANSER_BACKGROUND_DIM.default
											) * 100
										);
										return (
											<label className="flex items-center justify-between gap-4 text-sm">
												{DANSER_BACKGROUND_DIM.label}
												<span className="flex items-center gap-2">
													<Slider
														className="w-[110px] shrink-0"
														aria-label={DANSER_BACKGROUND_DIM.label}
														min={0}
														max={100}
														step={5}
														value={[dimPercent]}
														onValueChange={(v) => {
															const percent = Array.isArray(v) ? v[0] : v;
															void saveVideoPrefs(
																video,
																withBlobValue(
																	rendererOptions,
																	backendId,
																	DANSER_BACKGROUND_DIM.path,
																	percent / 100
																)
															);
														}}
													/>
													<span className="w-[30px] text-right font-mono text-[10.5px] text-[#71717a] tabular-nums">
														{dimPercent}%
													</span>
												</span>
											</label>
										);
									})()}
								</div>
							)}

							{error !== null && <ErrorPanel error={error} logPath={status.logPath} />}

							<DialogFooter>
								<Button variant="ghost" onClick={() => onOpenChange(false)}>
									cancel
								</Button>
								<Button onClick={() => void runExport()}>export video…</Button>
							</DialogFooter>
						</>
					)
				)}
			</DialogContent>
		</Dialog>
	);
}

const PRESET_ITEM =
	"h-5 rounded-md px-2 text-[10.5px] font-semibold text-[#71717a] aria-pressed:bg-primary aria-pressed:text-primary-foreground";

function PrefRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-4 text-sm">
			{label}
			{children}
		</div>
	);
}

function ProgressBar({ label, percent }: { label: string | null; percent: number | null }) {
	return (
		<div className="space-y-1.5">
			{label !== null && (
				<p className="flex items-center gap-2 text-[11.5px] text-[#a1a1aa]">
					<Loader2 className="size-3 animate-spin" aria-hidden />
					{label}
					{percent !== null && (
						<span className="ml-auto font-mono text-[10.5px] tabular-nums">{Math.round(percent)}%</span>
					)}
				</p>
			)}
			<div className="h-1.5 overflow-hidden rounded-full bg-[#1c1c20]">
				<div
					className="h-full rounded-full bg-primary transition-[width] duration-200"
					style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }}
				/>
			</div>
		</div>
	);
}

/** the failure surface: the typed reason with its detail selectable (the
 * sonner select-text convention -- render failures carry danser's own last
 * lines), plus the renderer log a click away.
 *
 * every colour here is measured against this panel's own tinted surface
 * (`--destructive` at 10% over `--popover`, ~#281216), not against the page:
 * `--destructive` itself lands at 3.96:1 there, under the 4.5:1 text bar, so
 * the two text roles are lightened off it, and the log button -- which was a
 * `bg-secondary` slab separated from the panel by 1.06:1, no visible edge at
 * all -- carries the full-strength red as its border for 3.96:1 of boundary */
function ErrorPanel({ error, logPath }: { error: IpcError; logPath: string | null }) {
	const { title, detail } = describeIpcError(error);
	return (
		<div className="space-y-2 rounded-[9px] border border-destructive/40 bg-destructive/10 px-3 py-2.5">
			<p className="flex items-start gap-2 text-[10.5px] font-semibold text-[#ff8a90]">
				<TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
				{title}
			</p>
			<p className="max-h-40 select-text overflow-y-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-[1.55] text-[#f1c9cc]">
				{detail}
			</p>
			{logPath !== null && (
				// labelled after the file it reveals, so a swapped backend's
				// log names itself with no change here
				<Button
					size="sm"
					variant="secondary"
					className="border-destructive bg-destructive/15 text-foreground hover:bg-destructive/25"
					onClick={() => void revealItemInDir(logPath)}
				>
					show {fileNameOfPath(logPath)}
				</Button>
			)}
		</div>
	);
}
