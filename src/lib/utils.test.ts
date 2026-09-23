import { describe, expect, test } from "bun:test";
import { CHROME_TOKENS } from "./chrome-tokens";
import { cn } from "./utils";

const fontClasses = Object.keys(CHROME_TOKENS)
	.filter((name) => /^--text-[a-z0-9-]+$/.test(name) && !name.slice(2).includes("--"))
	.map((name) => name.slice(2));

const spacingRoles = Object.keys(CHROME_TOKENS)
	.filter((name) => /^--spacing-[a-z0-9-]+$/.test(name))
	.map((name) => name.slice("--spacing-".length));

/** the role names under one theme prefix, companions (`--x--line-height`) left out */
function rolesOf(prefix: string): string[] {
	return Object.keys(CHROME_TOKENS)
		.filter((name) => name.startsWith(prefix) && !name.slice(2).includes("--"))
		.map((name) => name.slice(prefix.length));
}

describe("chrome class merging", () => {
	test("the replay browser dimensions replace dialog defaults", () => {
		expect(cn("w-full h-auto", "w-browser-dialog-w h-browser-dialog-h")).toBe(
			"w-browser-dialog-w h-browser-dialog-h"
		);
		expect(cn("w-browser-dialog-w h-browser-dialog-h", "w-full h-auto")).toBe("w-full h-auto");
		expect(cn("max-w-dialog sm:max-w-sm", "max-w-none sm:max-w-none")).toBe("max-w-none sm:max-w-none");
	});

	test("dialog height caps override each other and standard caps", () => {
		for (const cap of ["max-h-dialog", "max-h-dialog-tall", "max-h-dialog-taller"]) {
			expect(cn("max-h-full", cap)).toBe(cap);
			expect(cn(cap, "max-h-screen")).toBe("max-h-screen");
		}
		expect(cn("max-h-dialog", "max-h-dialog-tall", "max-h-dialog-taller")).toBe("max-h-dialog-taller");
	});

	// the whole vocabulary, not the handful of roles a caller happens to
	// override today: an unregistered role is not a merge tailwind-merge can
	// report, it is a class it does not recognise, so both survive and the
	// stylesheet's own order picks the winner
	test("every measurement role replaces the primitive it stands in for", () => {
		expect(spacingRoles.length).toBeGreaterThan(30);
		for (const role of spacingRoles) {
			expect(cn("p-4", `p-${role}`)).toBe(`p-${role}`);
			expect(cn(`p-${role}`, "p-4")).toBe("p-4");
		}
	});

	// a component base (Button's, Toggle's, ToggleGroup's rounded-lg) is emitted
	// AFTER every role radius, so an unmerged pair renders the base
	test("every shape role replaces the primitive a component base sets", () => {
		const shapes: [prefix: string, utility: string, primitive: string][] = [
			["--radius-", "rounded", "rounded-lg"],
			["--shadow-", "shadow", "shadow-sm"],
			["--blur-", "backdrop-blur", "backdrop-blur-sm"],
			["--leading-", "leading", "leading-none"],
			["--border-width-", "border", "border-2"],
			["--skew-", "skew-x", "skew-x-2"]
		];
		for (const [prefix, utility, primitive] of shapes) {
			const roles = rolesOf(prefix);
			expect(roles.length).toBeGreaterThan(0);
			for (const role of roles) {
				expect(cn(primitive, `${utility}-${role}`)).toBe(`${utility}-${role}`);
				expect(cn(`${utility}-${role}`, primitive)).toBe(primitive);
			}
		}
		expect(cn("border-border-strong", "border-hairline")).toBe("border-border-strong border-hairline");
	});

	test("the segmented recipe replaces a component base's radius, border, fill and padding", () => {
		expect(cn("flex rounded-lg border-2 border-input bg-muted p-1", "h-control segmented")).toBe(
			"flex h-control segmented"
		);
		expect(cn("segmented", "rounded-md")).toBe("segmented rounded-md");
	});

	test("a role width at a breakpoint replaces the primitive cap at that breakpoint", () => {
		expect(cn("sm:max-w-sm", "sm:max-w-dialog-export-w")).toBe("sm:max-w-dialog-export-w");
		expect(cn("sm:max-w-sm", "sm:max-w-dialog-video-w")).toBe("sm:max-w-dialog-video-w");
		expect(cn("max-w-dialog sm:max-w-sm", "sm:max-w-dialog-video-w")).toBe("max-w-dialog sm:max-w-dialog-video-w");
	});

	test("a caller clears a component's role padding and its role translate", () => {
		expect(cn("p-inset", "p-0")).toBe("p-0");
		expect(cn("translate-y-arrow-centre", "translate-y-1/2")).toBe("translate-y-1/2");
		expect(cn("translate-y-1/2", "translate-y-arrow-centre")).toBe("translate-y-arrow-centre");
	});

	test("every font role survives a text color in either order", () => {
		expect(fontClasses.length).toBeGreaterThan(0);
		for (const size of fontClasses) {
			expect(cn(size, "text-muted-foreground")).toBe(`${size} text-muted-foreground`);
			expect(cn("text-muted-foreground", size)).toBe(`text-muted-foreground ${size}`);
		}
	});

	test("custom and standard sizes override each other without removing the color", () => {
		for (const size of fontClasses) {
			expect(cn("text-sm text-primary", size)).toBe(`text-primary ${size}`);
			expect(cn(size, "text-primary text-sm")).toBe("text-primary text-sm");
		}
		expect(cn("text-caption text-primary", "text-row text-foreground")).toBe("text-row text-foreground");
	});

	test("variants retain independent typography and color overrides", () => {
		expect(cn("hover:text-caption hover:text-primary", "hover:text-row hover:text-foreground")).toBe(
			"hover:text-row hover:text-foreground"
		);
		expect(cn("text-caption text-primary", "hover:text-row hover:text-foreground")).toBe(
			"text-caption text-primary hover:text-row hover:text-foreground"
		);
	});

	test("HUD key color is independent from its count font and other colors", () => {
		expect(cn("text-hud-key-count text-foreground", "text-hud-key")).toBe("text-hud-key-count text-hud-key");
		expect(cn("text-hud-key-count text-hud-key", "text-percent-suffix")).toBe("text-hud-key text-percent-suffix");
	});
});
