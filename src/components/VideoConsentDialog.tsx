// the download-on-first-use consent surface: rendered by VideoExportDialog
// when no renderer install is present. everything shown here -- name,
// version, size, source, the license notice and its expando -- comes from
// the backend-supplied metadata, so nothing renderer-specific is hardcoded
// on this side of the seam

import { ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { SectionLabel } from "@/components/panels/SectionLabel";
import { formatDownloadSize } from "@/lib/video-export-flow";
import type { RendererMetadata } from "@/lib/scene-types";

export function VideoConsentSection({
	metadata,
	busy,
	onAccept,
	onDecline
}: {
	metadata: RendererMetadata;
	busy: boolean;
	onAccept: () => void;
	onDecline: () => void;
}) {
	const [licensesOpen, setLicensesOpen] = useState(false);

	return (
		<>
			<div className="space-y-2 card">
				<SectionLabel>one-time download</SectionLabel>
				<p className="text-lede-loose text-foreground-soft">
					video export renders through{" "}
					<span className="font-semibold text-foreground">
						{metadata.name} {metadata.version}
					</span>
					, a {formatDownloadSize(metadata.downloadBytes)} download from {metadata.source}. it installs into
					this app's own data folder and runs only when you export.
				</p>
				<p className="flex items-start gap-1.5 text-caption text-muted-foreground">
					<ShieldCheck className="mt-px size-3 shrink-0 text-grade-ok" aria-hidden />
					the download is verified against a checksum pinned in this app before anything is unpacked
				</p>
			</div>

			<div className="card">
				<p className="text-caption text-muted-foreground">{metadata.notice}</p>
				<button
					type="button"
					onClick={() => setLicensesOpen((v) => !v)}
					className="mt-1.5 flex items-center gap-1 text-caption-plain font-medium text-foreground-soft hover:text-foreground"
				>
					{licensesOpen ? (
						<ChevronDown className="size-3" aria-hidden />
					) : (
						<ChevronRight className="size-3" aria-hidden />
					)}
					licenses
				</button>
				{licensesOpen && (
					<div className="mt-2 space-y-2">
						{metadata.licenses.map((license) => (
							<div key={license.name}>
								<div className="text-caption-plain font-semibold text-foreground-soft">
									{license.name}
								</div>
								{/* select-text: license text is a copy opt-in like the
								other diagnostic surfaces */}
								<p className="select-text text-meta-copy text-foreground-dim">{license.detail}</p>
							</div>
						))}
					</div>
				)}
			</div>

			<DialogFooter>
				<Button variant="ghost" disabled={busy} onClick={onDecline}>
					not now
				</Button>
				<Button disabled={busy} onClick={onAccept}>
					download &amp; install
				</Button>
			</DialogFooter>
		</>
	);
}
