// the docked tab rail: six panel-switching triggers plus the panel-visibility
// toggle, right of the viewport row. driven by base-ui's Tabs (see the
// data-shadcn note below) with panelTab/panelOpen as the single source of
// truth -- each trigger reads its own active flag from the store rather than
// leaning on aria-selected/data-active css variants, so the rail never
// depends on an undocumented base-ui state attribute to look right

import { Activity, ChartSpline, History, Info, Keyboard, PanelRight, Tag, type LucideIcon } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useViewerStore, type PanelTab, type ViewerState } from "@/state/store";

export const PANEL_TABS: { id: PanelTab; label: string; Icon: LucideIcon }[] = [
	{ id: "replay", label: "replay", Icon: Info },
	{ id: "analysis", label: "analysis", Icon: Activity },
	{ id: "frames", label: "frames", Icon: ChartSpline },
	{ id: "keys", label: "keys", Icon: Keyboard },
	{ id: "meta", label: "meta", Icon: Tag },
	{ id: "history", label: "history", Icon: History }
];

// shared 38px-square geometry for every rail control -- the six panel
// triggers and the panel toggle all use the same box, differing only in
// which store field decides "active"
//
// flex-none is load-bearing: ui/tabs.tsx's TabsTrigger carries an
// unconditional flex-1, which is in the same tailwind-merge group as
// flex-none (cn() drops the earlier one), so this is a plain string-level
// cancel -- without it every trigger stretches to fill the rail's height
// instead of sitting at 38px, since flex-basis governs a column flex
// item's main-axis size over its own height.
//
// w-[38px]! and justify-center! need the importance flag for a different
// reason: once orientation="vertical" reaches TabsTrigger (see the Tabs
// block below), its base classes also carry group-data-vertical/tabs:w-full
// and group-data-vertical/tabs:justify-start. those live in a *different*
// tailwind-merge modifier scope than our plain w-[38px]/justify-center, so
// cn() cannot drop them, and in the compiled stylesheet both happen to land
// after our plain versions at equal (zero, via base-ui's :where() wrapper)
// specificity -- so they win the cascade unless ours are marked important.
// h-[38px] doesn't need the same treatment: it only has to beat
// TabsTrigger's *unconditional* h-[calc(100%-1px)], which is the ordinary
// same-scope cn() cancel flex-none also relies on
const RAIL_CONTROL_BASE =
	"relative flex h-[38px] w-[38px]! items-center justify-center! rounded-lg transition-colors flex-none";
// bg-primary/[.13]!, text-primary! and border-transparent! also need the
// importance flag, for a third reason distinct from the two above:
// TabsTrigger's base string carries dark:data-active:bg-input/30,
// dark:data-active:text-foreground, dark:data-active:border-input, and
// data-active:bg-background -- unprefixed and un-vertical-scoped, so those
// sit in a *different* tailwind-merge modifier scope than our plain
// bg-primary/[.13]/text-primary and cn() cannot drop them. in the compiled
// stylesheet the base rule's `:is(.dark *)` wrapper gives it higher
// specificity than our override too, so without `!` the active trigger
// renders the base's grey/bordered look instead of pink. text-[#71717a]!
// needs it for the matching reason on the inactive side (dark:text-muted-foreground)
const RAIL_CONTROL_ACTIVE = "bg-primary/[.13]! text-primary! border-transparent!";
const RAIL_CONTROL_INACTIVE = "text-[#71717a]!";
const RAIL_INDICATOR = "pointer-events-none absolute -left-1.5 top-2.5 bottom-2.5 w-0.5 rounded-[1px] bg-primary";

/** what a rail-tab click means. base-ui's Tab guards its own click handling
 * on !active, so for the selected tab this handler is the only thing that
 * runs -- and clicking the tab you are already on means "put that panel
 * away", not "open it again". an inactive tab runs both base-ui's
 * onValueChange and this, and setPanelTab is idempotent, so they agree.
 * exported because the click's meaning is the whole of this fix and the
 * headless suite has no dom to click through */
export function railTabClick(
	active: boolean,
	id: PanelTab,
	actions: Pick<ViewerState, "setPanelTab" | "togglePanel">
): void {
	if (active) actions.togglePanel();
	else actions.setPanelTab(id);
}

function RailTrigger({ id, label, Icon }: (typeof PANEL_TABS)[number]) {
	// selecting a boolean per trigger keeps a panelTab change from
	// re-rendering all six -- only the one whose active flag actually flips
	const active = useViewerStore((s) => s.panelTab === id);
	const setPanelTab = useViewerStore((s) => s.setPanelTab);
	const togglePanel = useViewerStore((s) => s.togglePanel);
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<TabsTrigger
						value={id}
						aria-label={label}
						onClick={() => railTabClick(active, id, { setPanelTab, togglePanel })}
						className={cn(RAIL_CONTROL_BASE, active ? RAIL_CONTROL_ACTIVE : RAIL_CONTROL_INACTIVE)}
					>
						<Icon className="size-4" />
						{active && <span className={RAIL_INDICATOR} />}
					</TabsTrigger>
				}
			/>
			<TooltipContent side="right">{label}</TooltipContent>
		</Tooltip>
	);
}

export function TabRail() {
	const setPanelTab = useViewerStore((s) => s.setPanelTab);
	const panelOpen = useViewerStore((s) => s.panelOpen);
	const togglePanel = useViewerStore((s) => s.togglePanel);
	const panelTab = useViewerStore((s) => s.panelTab);

	return (
		<nav className="flex w-[46px] shrink-0 flex-col items-center gap-0.5 border-l border-border bg-surface-rail py-1.5">
			{/* data-shadcn: the plan expected Tabs to drive both the rail and the
			panel it switches, but Tabs.Root only threads context through its own
			react subtree -- the aside lives in a sibling grid cell, not inside
			this tree, so Tabs.Panel was never an option here. Tabs.Tab doesn't
			require one to exist, though: it just leaves aria-controls unset, so
			the rail still gets real role="tab"/keyboard-arrow wiring from Tabs
			while SidePanel switches independently off the same panelTab state */}
			<Tabs
				orientation="vertical"
				value={panelTab}
				onValueChange={(value) => setPanelTab(value as PanelTab)}
				className="contents"
			>
				<TabsList className="contents">
					{PANEL_TABS.slice(0, 2).map((tab) => (
						<RailTrigger key={tab.id} {...tab} />
					))}
					{/* flex-none is defensive, not required: this div never carried a
					flex-grow utility, so it was never at risk of the trigger's
					stretch bug -- but display:contents on Tabs/TabsList (below)
					flattens it into being a direct flex child of nav's column too,
					so it gets the same explicit pin as everything else here rather
					than relying on the browser's implicit flex-grow:0 default */}
					<div aria-hidden="true" className="my-[5px] h-px w-[22px] flex-none bg-border" />
					{PANEL_TABS.slice(2).map((tab) => (
						<RailTrigger key={tab.id} {...tab} />
					))}
				</TabsList>
			</Tabs>

			<div className="flex-1" />

			<Tooltip>
				<TooltipTrigger
					render={
						<button
							type="button"
							aria-label={panelOpen ? "hide panel" : "show panel"}
							aria-pressed={panelOpen}
							onClick={togglePanel}
							className={cn(RAIL_CONTROL_BASE, panelOpen ? RAIL_CONTROL_ACTIVE : RAIL_CONTROL_INACTIVE)}
						>
							<PanelRight className="size-4" />
							{panelOpen && <span className={RAIL_INDICATOR} />}
						</button>
					}
				/>
				<TooltipContent side="right">{panelOpen ? "hide panel" : "show panel"}</TooltipContent>
			</Tooltip>
		</nav>
	);
}
