import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import { Minus, Plus } from "lucide-react";
import type { PointerEvent } from "react";

import { cn } from "@/lib/utils";

// a stepper's sibling can incorrectly match :hover too: hovering increment (the
// dom-later sibling) also flags decrement as hovered, while the reverse doesn't
// happen. confirmed deterministic (6/6 trials) in driven, non-webview2 chromium
// -- not a webview2-only quirk -- and base ui's number-field never calls
// setPointerCapture (unlike its scroll-area/slider/toast), so it isn't the
// press-and-hold pointer capture that was first suspected. a static clone of
// the same dom+css doesn't reproduce it, so the exact blink trigger is
// unconfirmed (spec 2026-08-06, item 2). sidestep :hover entirely and drive the
// highlight from pointer events instead.
//
// this is delegated to the group, not attached per-stepper: a stepper that
// hits min/max mid-hold gets the native `disabled` attribute (see
// useNumberFieldStepperButton.js), and a disabled button stops receiving
// pointer events altogether, so a handler living on the button itself would
// never see the pointerleave that should clear its stale `data-hovered`. the
// group instead re-derives the truth on every pointermove/pointerenter inside
// it: find the (necessarily enabled, since disabled steppers don't hit-test)
// stepper under the event target and mark only that one, sweeping the
// attribute off every other stepper in the group -- including one that went
// stale while disabled. reaching the other stepper to bring a boundary-capped
// value back into range requires moving the pointer through the group, so the
// sweep always runs before that re-enable becomes visible; leaving the group
// entirely clears both (spec 2026-08-06, item 2 follow-up)
const STEPPER_SELECTOR = '[data-slot$="crement"]';
const highlightHoveredStepper = (e: PointerEvent<HTMLElement>) => {
	const hoveredStepper = (e.target as Element).closest(STEPPER_SELECTOR);
	for (const stepper of e.currentTarget.querySelectorAll(STEPPER_SELECTOR)) {
		stepper.toggleAttribute("data-hovered", stepper === hoveredStepper);
	}
};
const clearAllStepperHighlights = (e: PointerEvent<HTMLElement>) => {
	for (const stepper of e.currentTarget.querySelectorAll(STEPPER_SELECTOR)) {
		stepper.removeAttribute("data-hovered");
	}
};
const groupHoverHandlers = {
	onPointerEnter: highlightHoveredStepper,
	onPointerMove: highlightHoveredStepper,
	onPointerLeave: clearAllStepperHighlights,
	onPointerCancel: clearAllStepperHighlights,
	onLostPointerCapture: clearAllStepperHighlights
};

function NumberField({ className, ...props }: NumberFieldPrimitive.Root.Props) {
	return (
		<NumberFieldPrimitive.Root className={cn("inline-flex", className)} data-slot="number-field" {...props}>
			<NumberFieldPrimitive.Group
				data-slot="number-field-group"
				className="inline-flex items-center overflow-hidden rounded-md border border-input bg-transparent data-disabled:opacity-50"
				{...groupHoverHandlers}
			>
				<NumberFieldPrimitive.Decrement
					data-slot="number-field-decrement"
					aria-label="decrease"
					className="flex size-7 shrink-0 items-center justify-center text-muted-foreground select-none data-hovered:bg-muted data-hovered:text-foreground focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
				>
					<Minus className="size-3" />
				</NumberFieldPrimitive.Decrement>
				<NumberFieldPrimitive.Input
					data-slot="number-field-input"
					className="w-14 bg-transparent px-1 py-1 text-right text-sm tabular-nums focus-visible:outline-hidden"
				/>
				<NumberFieldPrimitive.Increment
					data-slot="number-field-increment"
					aria-label="increase"
					className="flex size-7 shrink-0 items-center justify-center text-muted-foreground select-none data-hovered:bg-muted data-hovered:text-foreground focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
				>
					<Plus className="size-3" />
				</NumberFieldPrimitive.Increment>
			</NumberFieldPrimitive.Group>
		</NumberFieldPrimitive.Root>
	);
}

export { NumberField };
