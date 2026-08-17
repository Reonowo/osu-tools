import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";

import { cn } from "@/lib/utils";

function ScrollArea({ className, children, ...props }: ScrollAreaPrimitive.Root.Props) {
	return (
		<ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn("relative", className)} {...props}>
			{/* max-h-[inherit] is what makes a `max-h-*` on the root actually cap
			    the scrolling box. the viewport's own `h-full` does not get there:
			    base-ui ships an unlayered height for it, and an unlayered
			    declaration beats every tailwind utility (which live in
			    @layer utilities), so the viewport grows to its content and spills
			    out of the root. inheriting the root's max-height clamps it
			    regardless of who won the height. a root with no max-height
			    inherits `none`, so nothing changes for the flex-sized callers */}
			<ScrollAreaPrimitive.Viewport
				data-slot="scroll-area-viewport"
				className="size-full max-h-[inherit] rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
			>
				{children}
			</ScrollAreaPrimitive.Viewport>
			<ScrollBar />
			<ScrollAreaPrimitive.Corner />
		</ScrollAreaPrimitive.Root>
	);
}

function ScrollBar({ className, orientation = "vertical", ...props }: ScrollAreaPrimitive.Scrollbar.Props) {
	return (
		<ScrollAreaPrimitive.Scrollbar
			data-slot="scroll-area-scrollbar"
			data-orientation={orientation}
			orientation={orientation}
			className={cn(
				"flex touch-none p-px transition-colors select-none data-[orientation=horizontal]:h-2.5 data-[orientation=horizontal]:flex-col data-[orientation=horizontal]:border-t data-[orientation=horizontal]:border-t-transparent data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2.5 data-[orientation=vertical]:border-l data-[orientation=vertical]:border-l-transparent",
				className
			)}
			{...props}
		>
			<ScrollAreaPrimitive.Thumb
				data-slot="scroll-area-thumb"
				className="relative flex-1 rounded-full bg-border"
			/>
		</ScrollAreaPrimitive.Scrollbar>
	);
}

export { ScrollArea, ScrollBar };
