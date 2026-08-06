import { join } from "node:path";

// bun tests execute from arbitrary cwds; anchor on this file's location
// (src/test/) and walk up to the repo root, matching the engine's
// CARGO_MANIFEST_DIR convention for the same directory
const repoRoot = join(import.meta.dir, "..", "..");

export function fixturePath(...segments: string[]): string {
	return join(repoRoot, "fixtures", ...segments);
}

export async function loadFixture<T>(...segments: string[]): Promise<T> {
	return (await Bun.file(fixturePath(...segments)).json()) as T;
}
