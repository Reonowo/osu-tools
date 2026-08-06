import { describe, expect, test } from "bun:test";
import { loadFixture } from "./fixtures";

interface Meta {
  osu_pin: string;
  tolerances: { position: number; distance: number; ratio: number };
}

describe("fixture loader", () => {
  test("resolves the repo-root fixtures directory", async () => {
    const meta = await loadFixture<Meta>("meta.json");
    expect(meta.osu_pin).toBe("83b8a64bec19e1463353645c2d6d10c75e275b43");
    expect(meta.tolerances.position).toBe(1e-4);
  });
});
