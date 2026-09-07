"use client";

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import { cn } from "@/lib/utils";

function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
	return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({ ...props }: ContextMenuPrimitive.Trigger.Props) {
	return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

function ContextMenuContent({ className, ...props }: ContextMenuPrimitive.Popup.Props) {
	return (
		<ContextMenuPrimitive.Portal>
			{/* the anchor is the pointer itself (the trigger records the click
			point); start-aligned so the popup hangs below-right of it the way
			every desktop context menu does, collisions flipping it automatically */}
			<ContextMenuPrimitive.Positioner align="start" side="bottom" className="isolate z-50">
				{/* popup-menu: lazer's OsuMenu, so it fades in while revealing
				downward and on the way out holds for an instant before fading, which
				is what makes a click on an item visibly taken before the menu leaves
				(index.css) */}
				<ContextMenuPrimitive.Popup
					data-slot="context-menu-content"
					data-motion-row="popup"
					className={cn(
						"popup-menu z-50 flex min-w-44 origin-(--transform-origin) flex-col rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden",
						className
					)}
					{...props}
				/>
			</ContextMenuPrimitive.Positioner>
		</ContextMenuPrimitive.Portal>
	);
}

function ContextMenuItem({ className, ...props }: ContextMenuPrimitive.Item.Props) {
	return (
		<ContextMenuPrimitive.Item
			data-slot="context-menu-item"
			className={cn(
				"flex cursor-default items-center justify-between gap-6 rounded-[5px] px-2 py-1.5 text-[11.5px] text-[#e4e4e7] outline-hidden select-none data-highlighted:bg-primary/[.12] data-highlighted:text-foreground data-[disabled]:text-[#8a8a93]",
				className
			)}
			{...props}
		/>
	);
}

export { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger };
