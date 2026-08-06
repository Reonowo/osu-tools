import { describe, expect, test } from "bun:test";
import { describeIpcError } from "./errors";

describe("ipc error mapping", () => {
  test("recoveries", () => {
    expect(describeIpcError({ kind: "beatmapNotFound", md5: "abc" }).recovery).toBe("pickBeatmap");
    expect(describeIpcError({ kind: "osuDbNotFound", searched: [] }).recovery).toBe("pickBeatmap");
    expect(describeIpcError({ kind: "beatmapMismatch", expectedMd5: "a", actualMd5: "b" }).recovery).toBe("offerMismatch");
    expect(describeIpcError({ kind: "replayParse", message: "x" }).recovery).toBeNull();
  });

  test("details carry the payload", () => {
    const d = describeIpcError({ kind: "resourceLimit", cap: "MAX_OSZ_ENTRIES", limit: 1, actual: 2 });
    expect(d.detail).toContain("MAX_OSZ_ENTRIES");
    const db = describeIpcError({ kind: "osuDbNotFound", searched: ["C:\\a", "C:\\b"] });
    expect(db.detail).toContain("C:\\a");
  });
});
