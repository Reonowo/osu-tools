import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import { Minus, Plus } from "lucide-react";

import { cn } from "@/lib/utils";

function NumberField({ className, ...props }: NumberFieldPrimitive.Root.Props) {
	return (
		<NumberFieldPrimitive.Root className={cn("inline-flex", className)} data-slot="number-field" {...props}>
			<NumberFieldPrimitive.Group
				data-slot="number-field-group"
				className="inline-flex items-center overflow-hidden rounded-md border border-input bg-transparent data-disabled:opacity-50"
			>
				<NumberFieldPrimitive.Decrement
					data-slot="number-field-decrement"
					aria-label="decrease"
					className="flex size-7 shrink-0 items-center justify-center text-muted-foreground select-none hover:bg-muted hover:text-foreground focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
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
					className="flex size-7 shrink-0 items-center justify-center text-muted-foreground select-none hover:bg-muted hover:text-foreground focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
				>
					<Plus className="size-3" />
				</NumberFieldPrimitive.Increment>
			</NumberFieldPrimitive.Group>
		</NumberFieldPrimitive.Root>
	);
}

export { NumberField };
