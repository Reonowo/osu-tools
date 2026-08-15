// keybinds: every key the app binds, listed and rebindable. the fifth
// category, and the surface keybinds.ts was built for -- until it existed the
// table's inventory was discoverable only by reading the source, and nothing
// the app bound could be moved.
//
// this file is presentation and one armed listener. every rule about what an
// override may be -- the fold, the steal, what clearing means -- lives in
// keybinds.ts, so the category can only ask it questions

import { useEffect, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { SectionLabel } from "@/components/panels/SectionLabel";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { captureArm } from "@/playback/capture-arm";
import {
	applyCapture,
	clearBinding,
	formatBinding,
	KEYBIND_GROUPS,
	MAX_BINDING_SLOTS,
	NO_KEYBIND_OVERRIDES,
	readCapture,
	revertKeybind,
	type DisplacedKeybind,
	type EffectiveKeybind,
	type KeybindAction
} from "@/playback/keybinds";
import { useViewerStore } from "@/state/store";

/** which slot of which row is armed, or null. one at a time: the capture
 * listener is app-wide, and two armed slots would both claim one keypress */
interface ArmedSlot {
	action: KeybindAction;
	slot: number;
}

const SLOT_LABELS = ["primary", "alternate"];

const SLOT_CLASS =
	"h-7 min-w-[7.5rem] rounded-md border border-border bg-zinc-800/60 px-2 text-xs text-[#e4e4e7] " +
	"hover:border-primary/40 focus-visible:border-primary focus-visible:outline-none disabled:opacity-50";

/** what a slot shows: the key, or the reason it shows no key */
function slotText(row: EffectiveKeybind, slot: number, armed: boolean): string {
	if (armed) return "press a key…";
	const binding = row.bindings[slot];
	if (binding !== undefined) return formatBinding(binding);
	return slot === 0 ? "unbound" : "add";
}

function KeybindSlot({
	row,
	slot,
	armed,
	onArm,
	onClear,
	onCancel
}: {
	row: EffectiveKeybind;
	slot: number;
	armed: boolean;
	onArm: () => void;
	onClear: () => void;
	onCancel: () => void;
}) {
	const binding = row.bindings[slot];
	const locked = row.locked !== null;
	return (
		<div className="flex items-center gap-1">
			<button
				type="button"
				disabled={locked}
				aria-label={`${row.label}, ${SLOT_LABELS[slot] ?? "binding"}: ${slotText(row, slot, false)}`}
				onClick={onArm}
				// an armed slot that loses focus disarms: one left armed behind a
				// closed dialog would eat the next keypress the app took
				onBlur={() => armed && onCancel()}
				className={cn(
					SLOT_CLASS,
					armed && "border-primary bg-primary/[.13] text-primary",
					binding === undefined && !armed && "text-zinc-500 italic"
				)}
			>
				{slotText(row, slot, armed)}
			</button>
			{/* a distinct control, never a magic key: clearing and capturing must
			    not be confusable with each other, and the keys the library's own
			    recorder reserves for clearing are erase selection's own defaults */}
			<button
				type="button"
				aria-label={`clear ${row.label} ${SLOT_LABELS[slot] ?? "binding"}`}
				disabled={locked || binding === undefined}
				onClick={onClear}
				className="rounded p-1 text-zinc-500 hover:text-[#e4e4e7] disabled:invisible"
			>
				<Trash2 aria-hidden className="size-3.5" />
			</button>
		</div>
	);
}

/** one action: what it does on the left, the keys it answers to on the right */
function KeybindRow({
	row,
	armed,
	notice,
	onArm,
	onClear,
	onCancel,
	onRevert
}: {
	row: EffectiveKeybind;
	armed: number | null;
	/** what this row lost to a capture elsewhere, said where the user will look */
	notice: string | null;
	onArm: (slot: number) => void;
	onClear: (slot: number) => void;
	onCancel: () => void;
	onRevert: () => void;
}) {
	return (
		<div className="flex items-start justify-between gap-3 py-1 text-sm">
			<div className="min-w-0">
				<div className={row.locked !== null ? "text-zinc-500" : undefined}>{row.label}</div>
				{row.locked !== null && <div className="mt-0.5 text-xs text-zinc-500">locked — {row.locked}</div>}
				{notice !== null && <div className="mt-0.5 text-xs text-[#ffcc22]">{notice}</div>}
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				{Array.from({ length: MAX_BINDING_SLOTS }, (_, slot) => (
					<KeybindSlot
						key={slot}
						row={row}
						slot={slot}
						armed={armed === slot}
						onArm={() => onArm(slot)}
						onClear={() => onClear(slot)}
						onCancel={onCancel}
					/>
				))}
				{/* only on an overridden row, so its presence is also the indicator
				    that the row is the user's rather than the app's */}
				<Tooltip>
					<TooltipTrigger render={<span />}>
						<button
							type="button"
							aria-label={`revert ${row.label} to its default`}
							disabled={!row.overridden}
							onClick={onRevert}
							className="rounded p-1 text-primary hover:text-[#e4e4e7] disabled:invisible"
						>
							<RotateCcw aria-hidden className="size-3.5" />
						</button>
					</TooltipTrigger>
					<TooltipContent side="left">revert to the default</TooltipContent>
				</Tooltip>
			</div>
		</div>
	);
}

/** the rows, grouped the way a user thinks about them rather than by where
 * each one is registered. read-only when no handlers are passed, which is what
 * the help overlay renders */
export function KeybindList({
	table,
	armed,
	notices,
	onArm,
	onClear,
	onCancel,
	onRevert
}: {
	table: readonly EffectiveKeybind[];
	armed?: ArmedSlot | null;
	notices?: Partial<Record<KeybindAction, string>>;
	onArm?: (action: KeybindAction, slot: number) => void;
	onClear?: (action: KeybindAction, slot: number) => void;
	onCancel?: () => void;
	onRevert?: (action: KeybindAction) => void;
}) {
	const interactive =
		onArm !== undefined && onClear !== undefined && onRevert !== undefined && onCancel !== undefined;
	return (
		<div className="space-y-3">
			{KEYBIND_GROUPS.map(({ id, label }) => {
				const rows = table.filter((row) => row.group === id);
				if (rows.length === 0) return null;
				return (
					<div key={id} className="space-y-1">
						<SectionLabel>{label}</SectionLabel>
						{rows.map((row) =>
							interactive ? (
								<KeybindRow
									key={row.action}
									row={row}
									armed={armed?.action === row.action ? armed.slot : null}
									notice={notices?.[row.action] ?? null}
									onArm={(slot) => onArm(row.action, slot)}
									onClear={(slot) => onClear(row.action, slot)}
									onCancel={onCancel}
									onRevert={() => onRevert(row.action)}
								/>
							) : (
								<ReadOnlyRow key={row.action} row={row} />
							)
						)}
					</div>
				);
			})}
		</div>
	);
}

function ReadOnlyRow({ row }: { row: EffectiveKeybind }) {
	return (
		<div className="flex items-baseline justify-between gap-3 py-0.5 text-sm">
			<span className={row.bindings.length === 0 ? "text-zinc-500" : undefined}>{row.label}</span>
			<span className="shrink-0 font-mono text-xs text-[#a1a1aa]">
				{row.bindings.length === 0 ? (
					<span className="text-zinc-600 italic">unbound</span>
				) : (
					row.bindings.map((binding) => formatBinding(binding)).join(" / ")
				)}
			</span>
		</div>
	);
}

/** the notice a displaced row carries until the next capture */
function displacementNotices(displaced: DisplacedKeybind[], takenBy: string): Partial<Record<KeybindAction, string>> {
	const notices: Partial<Record<KeybindAction, string>> = {};
	for (const { action, binding } of displaced) {
		notices[action] = `lost ${formatBinding(binding)} to ${takenBy}`;
	}
	return notices;
}

export function KeybindsCategory() {
	const table = useViewerStore((s) => s.effectiveKeybinds);
	const overrides = useViewerStore((s) => s.keybinds);
	const setKeybinds = useViewerStore((s) => s.setKeybinds);
	const [armed, setArmed] = useState<ArmedSlot | null>(null);
	const [notices, setNotices] = useState<Partial<Record<KeybindAction, string>>>({});

	useEffect(() => {
		// the flag the listeners the hotkey manager does not mediate read
		// (use-edit-tools', the code-matched viewport reset). the modal's own
		// dialog arm already makes the registered bindings decline
		captureArm.set(armed !== null);
		if (armed === null) return;
		// a hoisted function declaration is checked against the flow state at the
		// top of the block, where `armed` is still nullable (Viewport.tsx's rule)
		const slot = armed;

		const onKeyDown = (e: KeyboardEvent) => {
			const read = readCapture(e);
			// Tab keeps its own job -- moving focus off the slot -- so it is read
			// before anything is suppressed: capturing it would take the key the
			// app is navigated by and leave no way off the control
			if (read.kind === "passthrough") {
				setArmed(null);
				return;
			}
			// the capture phase at the window, ahead of every other listener: the
			// dialog primitive closes on Escape natively, so cancelling a capture
			// would otherwise also close the surface the user is configuring
			e.preventDefault();
			e.stopPropagation();
			// a press that is only modifiers keeps the slot armed: the user is
			// still on their way to a chord
			if (read.kind === "incomplete") return;
			if (read.kind === "cancelled") {
				setArmed(null);
				return;
			}
			if (read.kind === "unsupported") {
				// said on the row rather than swallowed: a key that does nothing
				// twice reads as a broken capture control
				setNotices({ [slot.action]: "that key cannot be bound" });
				setArmed(null);
				return;
			}
			const row = table.find((candidate) => candidate.action === slot.action);
			const outcome = applyCapture(overrides, table, slot.action, slot.slot, read.binding);
			if (outcome.refused !== null) {
				setNotices({ [slot.action]: outcome.refused });
				setArmed(null);
				return;
			}
			setKeybinds(outcome.overrides);
			setNotices(displacementNotices(outcome.displaced, row?.label ?? slot.action));
			setArmed(null);
		};

		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () => {
			captureArm.set(false);
			window.removeEventListener("keydown", onKeyDown, { capture: true });
		};
	}, [armed, overrides, setKeybinds, table]);

	// a category switch or a closed dialog unmounts this panel; the effect's
	// teardown drops the flag, and the armed slot goes with the state
	return (
		<div className="space-y-3">
			<KeybindList
				table={table}
				armed={armed}
				notices={notices}
				onArm={(action, slot) => setArmed({ action, slot })}
				onCancel={() => setArmed(null)}
				// a notice describes the last capture; anything else the user does
				// makes it stale, so it goes rather than sitting on a row that no
				// longer lost anything
				onClear={(action, slot) => {
					setArmed(null);
					setNotices({});
					setKeybinds(clearBinding(overrides, table, action, slot));
				}}
				onRevert={(action) => {
					setArmed(null);
					setNotices({});
					setKeybinds(revertKeybind(overrides, action));
				}}
			/>
			<div className="flex items-center justify-between gap-3 border-t border-border pt-3">
				<p className="text-xs text-zinc-500">
					click a key to rebind it; Escape cancels. changes apply at once and save themselves.
				</p>
				<Button
					size="sm"
					variant="ghost"
					disabled={Object.keys(overrides).length === 0}
					onClick={() => {
						setArmed(null);
						setNotices({});
						setKeybinds(NO_KEYBIND_OVERRIDES);
					}}
				>
					restore defaults
				</Button>
			</div>
		</div>
	);
}
