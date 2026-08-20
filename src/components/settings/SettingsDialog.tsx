// the settings dialog: a nav column and seven category panels inside the modal
// it has always been. still a modal because it is a modal-shaped task and has
// to be reachable with nothing loaded (the start screen needs the install
// path), so it can be neither a seventh panel tab nor a route -- there is no
// router. this file owns the container and the frame; the categories own
// their own contents

import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useViewerStore } from "@/state/store";
import { AnalysisCategory } from "./AnalysisCategory";
import { AudioCategory } from "./AudioCategory";
import { SETTINGS_CATEGORIES, type SettingsCategory } from "./categories";
import { EditingCategory } from "./EditingCategory";
import { GameplayCategory } from "./GameplayCategory";
import { GeneralCategory } from "./GeneralCategory";
import { KeybindsCategory } from "./KeybindsCategory";
import { SkinCategory } from "./SkinCategory";

// the vertical orientation costs less here than it does on the rail: a
// left-aligned full-width text row is what group-data-vertical/tabs already
// gives, so only the sizing and the active colours need cancelling.
//
// flex-none and h-8 are plain same-scope cancels of TabsTrigger's
// unconditional flex-1 and h-[calc(100%-1px)], which cn() drops for us.
// the active/inactive colours are not: TabsTrigger's base carries
// dark:data-active:{bg,text,border} and dark:text-muted-foreground, which sit
// in a different tailwind-merge modifier scope than these plain utilities and
// land later at higher specificity (:is(.dark *)) -- so they win the cascade
// unless ours are marked important. TabRail.tsx documents the same three
// mechanisms at length
const NAV_ITEM_BASE = "h-8 flex-none gap-2 px-2";
const NAV_ITEM_ACTIVE = "bg-primary/[.13]! text-primary! border-transparent!";
const NAV_ITEM_INACTIVE = "text-[#71717a]!";

export function SettingsDialog({
	category,
	onCategoryChange,
	onClose
}: {
	/** the category being shown, or null for a closed dialog */
	category: SettingsCategory | null;
	onCategoryChange: (category: SettingsCategory) => void;
	onClose: () => void;
}) {
	const isOpen = category !== null;
	const setOverlay = useViewerStore((s) => s.setOverlay);
	const overlays = useViewerStore((s) => s.overlays);
	const setAudio = useViewerStore((s) => s.setAudio);
	const audioOffset = useViewerStore((s) => s.audio.offsetMs);
	const loadSettings = useViewerStore((s) => s.loadSettings);
	const saveStablePath = useViewerStore((s) => s.saveStablePath);
	const selectSkin = useViewerStore((s) => s.selectSkin);
	const importSkin = useViewerStore((s) => s.importSkin);

	// the install-path lock lives here for the same reason the draft below
	// does: general unmounts on a category switch and on close, so a lock held
	// inside it is gone by the time the write it guards resolves, and the
	// remounted panel offers an enabled browse button over a write still in
	// flight. saveStablePath publishes whatever the backend hands back with no
	// sequence guard of its own -- unlike loadSettings -- so two overlapping
	// writes can land in either order. this dialog is mounted for the app's
	// lifetime, which is the lifetime the lock had before the panels existed
	const [saving, setSaving] = useState(false);

	// both skin pickers live here rather than in SkinCategory: the panels
	// unmount on a category switch, and a native dialog that outlived its panel
	// would resolve into a component that is gone
	async function pickSkinFolder() {
		const dir = await open({ directory: true, multiple: false });
		if (typeof dir !== "string") return;
		await selectSkin({ kind: "folder", path: dir });
	}

	async function pickSkinArchive() {
		const path = await open({ multiple: false, filters: [{ name: "osu! skin", extensions: ["osk"] }] });
		if (typeof path !== "string") return;
		await importSkin(path);
	}

	async function pickInstall() {
		const dir = await open({ directory: true, multiple: false });
		if (typeof dir !== "string") return;
		setSaving(true);
		await saveStablePath(dir).finally(() => setSaving(false));
	}

	// the field holds its own draft so a half-typed "5" of "500" is not clamped
	// to the 200 floor between keystrokes; the store only sees committed values
	// (blur, stepper press, arrow key) and clamps them there. it lives here
	// rather than in AnalysisCategory because the panels unmount on a category
	// switch, and a half-typed value must survive one
	const displayLength = overlays.displayLength;
	const [draftLength, setDraftLength] = useState<number | null>(displayLength);
	useEffect(() => setDraftLength(displayLength), [displayLength]);

	function commitLength(value: number | null) {
		// an emptied field commits null: restore the last good value rather than
		// leaving the input blank with the store silently unchanged
		if (value === null) setDraftLength(displayLength);
		else setOverlay("displayLength", value);
	}

	// the audio offset's draft, hoisted for exactly the reason display length's
	// is: a half-typed "-1" of "-120" must survive a category switch, and it
	// must not be clamped to the -500 floor between keystrokes
	const [draftOffset, setDraftOffset] = useState<number | null>(audioOffset);
	useEffect(() => setDraftOffset(audioOffset), [audioOffset]);

	function commitOffset(value: number | null) {
		if (value === null) setDraftOffset(audioOffset);
		else setAudio("offsetMs", value);
	}

	useEffect(() => {
		if (isOpen) void loadSettings();
	}, [isOpen, loadSettings]);

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-2xl">
				<DialogHeader>
					{/* the accessible name for the whole dialog, so it stays "settings"
					    whichever category is showing -- the primitive already announces
					    the category through each panel's tie to its nav item */}
					<DialogTitle>settings</DialogTitle>
				</DialogHeader>

				<Tabs
					orientation="vertical"
					// null only ever reaches here on a closed dialog, whose panel
					// subtree is unmounted anyway; the fallback keeps Tabs controlled
					value={category ?? SETTINGS_CATEGORIES[0].id}
					onValueChange={(value) => onCategoryChange(value as SettingsCategory)}
					className="min-h-0 gap-4"
				>
					{/* the nav is a sibling of the scroll viewport, never inside it, so
					    no scroll state can move it */}
					<TabsList className="w-[160px] shrink-0 gap-0.5 bg-transparent p-0">
						{SETTINGS_CATEGORIES.map(({ id, label, Icon }) => (
							<TabsTrigger
								key={id}
								value={id}
								className={cn(NAV_ITEM_BASE, id === category ? NAV_ITEM_ACTIVE : NAV_ITEM_INACTIVE)}
							>
								<Icon aria-hidden="true" />
								{label}
							</TabsTrigger>
						))}
					</TabsList>

					{/* the viewport's height is a pinned constant, not the tallest
					    category: letting the content set it would move the modal's
					    height every time anyone added a row, release over release, and
					    the empty space under a short category is the accepted cost of a
					    frame that holds still. 26rem plus the header and padding sits
					    inside the 608px a 640px-tall window leaves (tauri.conf.json
					    pins minHeight 640); max-h-full is the graceful cap below that.
					    scrollbar-gutter is the same requirement on the other axis: the
					    app's global scrollbar is 8px and layout-consuming, so without a
					    reserved gutter a scrolling category would render its rows 8px
					    narrower and every switch would reflow the toggles sideways.
					    horizontal overflow is clipped the way every panel body clips
					    it: the switch control's deliberately oversized hit target pokes
					    past this box, and without the clip that gap becomes a
					    scrollbar. one shared viewport, so every category opens at its
					    top rather than wherever it was last left */}
					<div className="h-[26rem] max-h-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
						<TabsContent value="general">
							<GeneralCategory saving={saving} onPickInstall={() => void pickInstall()} />
						</TabsContent>
						<TabsContent value="gameplay">
							<GameplayCategory />
						</TabsContent>
						<TabsContent value="skin">
							<SkinCategory
								onBrowseFolder={() => void pickSkinFolder()}
								onImportArchive={() => void pickSkinArchive()}
							/>
						</TabsContent>
						<TabsContent value="audio">
							<AudioCategory
								draftOffset={draftOffset}
								onDraftOffsetChange={setDraftOffset}
								onCommitOffset={commitOffset}
							/>
						</TabsContent>
						<TabsContent value="analysis">
							<AnalysisCategory
								draftLength={draftLength}
								onDraftChange={setDraftLength}
								onCommit={commitLength}
							/>
						</TabsContent>
						<TabsContent value="editing">
							<EditingCategory />
						</TabsContent>
						<TabsContent value="keybinds">
							<KeybindsCategory />
						</TabsContent>
					</div>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}
