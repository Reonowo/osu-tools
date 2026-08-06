import { describe, expect, test } from "bun:test";
import type { RenderPlan } from "../lib/scene-types";
import { loadFixture } from "../test/fixtures";
import { dist32, f32 } from "./vec";
import { curvePositionAt, dotnetTruncToI32, pathToProgress, positionAt, progressAt, spanAt } from "./slider-path";

// slider_path.json carries json's named float literals ("Infinity"/"NaN")
// in fields this test does not read (segment_ends_progress); typing them as
// unknown keeps the reader honest about that
interface SliderPathFixture {
  cases: {
    name: string;
    vertices: [number, number][];
    distance: number;
    position_at: { progress: number; pos: [number, number] }[];
    path_to_progress: { p0: number; p1: number; vertices: [number, number][] }[];
  }[];
}

interface BeatmapFixture {
  objects: {
    slider: { ball_samples: { progress: number; pos: [number, number] }[] } | null;
  }[];
}

/** lazer dumps give vertices only; rebuild the cumulative-length lut the way
 * the engine does (f64 accumulation of f32 vector distances). edge lengths
 * are computed on frounded vertices -- the same "json's shortest f32
 * round-trip parses as a slightly different f64" concern
 * slider-path.ts's interpolateVertices corrects for on read -- so the
 * summation lands on the bit-exact f32 edge length lazer itself used */
function geometryFrom(vertices: [number, number][], distance: number) {
  const flat: number[] = [];
  const cumulative: number[] = [];
  let sum = 0;
  vertices.forEach(([x, y], i) => {
    flat.push(x, y);
    if (i > 0) {
      const [px, py] = vertices[i - 1];
      sum += dist32(f32(px), f32(py), f32(x), f32(y));
    }
    cumulative.push(sum);
  });
  // sliderpath.cs:426 seeds the f64 accumulator at catmull's culled
  // optimised_length before summing edges, but index 0 is hardcoded to 0
  // regardless of that seed (see slider_path.rs:189-202). the fixture only
  // gives the final vertices/distance, not the seed itself, so recover it
  // as whatever gap remains between lazer's reported distance and this
  // plain re-summation of those same (frounded) vertices, and apply it from
  // index 1 onward the same way the engine's accumulator does
  const optimisedLengthSeed = distance - sum;
  const cumulativeLengths = cumulative.map((v, i) => (i === 0 ? 0 : v + optimisedLengthSeed));
  return { vertices: flat, cumulativeLengths, distance };
}

describe("positionAt / pathToProgress parity against lazer's slider_path dumps", () => {
  test("position samples land within tolerance", async () => {
    const fixture = await loadFixture<SliderPathFixture>("path", "slider_path.json");
    expect(fixture.cases.length).toBeGreaterThan(0);
    for (const c of fixture.cases) {
      const geo = geometryFrom(c.vertices, c.distance);
      for (const s of c.position_at) {
        const [x, y] = positionAt(geo, s.progress);
        expect(Math.abs(x - s.pos[0]), `${c.name} p=${s.progress} x`).toBeLessThanOrEqual(1e-4);
        expect(Math.abs(y - s.pos[1]), `${c.name} p=${s.progress} y`).toBeLessThanOrEqual(1e-4);
      }
    }
  });

  test("path_to_progress ranges reproduce lazer's vertex lists", async () => {
    const fixture = await loadFixture<SliderPathFixture>("path", "slider_path.json");
    for (const c of fixture.cases) {
      const geo = geometryFrom(c.vertices, c.distance);
      for (const r of c.path_to_progress) {
        const ours = pathToProgress(geo, r.p0, r.p1);
        expect(ours.length / 2, `${c.name} [${r.p0},${r.p1}] count`).toBe(r.vertices.length);
        r.vertices.forEach(([x, y], i) => {
          expect(Math.abs(ours[i * 2] - x), `${c.name} [${r.p0},${r.p1}] v${i} x`).toBeLessThanOrEqual(1e-4);
          expect(Math.abs(ours[i * 2 + 1] - y), `${c.name} [${r.p0},${r.p1}] v${i} y`).toBeLessThanOrEqual(1e-4);
        });
      }
    }
  });
});

describe("ball position parity: rust geometry × lazer ball_samples", () => {
  const stems = [
    "old-format-v4", "slider-zoo-v14", "spinners-combos-od10",
    "stacking-v14", "v7-tick-multiplier",
  ];

  test("every slider's whole-progress samples land within tolerance", async () => {
    let checkedSliders = 0;
    for (const stem of stems) {
      const plan = await loadFixture<RenderPlan>("render_plan", `${stem}.json`);
      const dump = await loadFixture<BeatmapFixture>("beatmap", `${stem}.json`);
      expect(plan.objects.length).toBe(dump.objects.length);
      plan.objects.forEach((obj, i) => {
        const theirs = dump.objects[i].slider;
        if (obj.kind.type !== "slider") {
          expect(theirs).toBeNull();
          return;
        }
        expect(theirs, `${stem} object ${i}`).not.toBeNull();
        checkedSliders++;
        for (const s of theirs!.ball_samples) {
          const [x, y] = curvePositionAt(obj.kind, obj.kind.spanCount, s.progress);
          expect(Math.abs(x - s.pos[0]), `${stem} obj ${i} p=${s.progress} x`).toBeLessThanOrEqual(1e-4);
          expect(Math.abs(y - s.pos[1]), `${stem} obj ${i} p=${s.progress} y`).toBeLessThanOrEqual(1e-4);
        }
      });
    }
    expect(checkedSliders).toBeGreaterThanOrEqual(8);
  });
});

describe("span folding (ihaspathwithrepeats.cs:24-49)", () => {
  test("three spans fold forward, back, forward", () => {
    expect(spanAt(3, 0)).toBe(0);
    // note: spanAt(3, 1/3) is 0, not 1 -- f64 gives 1/3*3 = 0.99999...,
    // and the truncating cast keeps that quirk (c# behaves identically)
    expect(spanAt(3, 0.34)).toBe(1);
    expect(spanAt(3, 0.99)).toBe(2);
    expect(progressAt(3, 1 / 6)).toBeCloseTo(0.5, 9);
    expect(progressAt(3, 1 / 3)).toBeCloseTo(1, 9); // exactly at the repeat: folded to 1
    expect(progressAt(3, 0.5)).toBeCloseTo(0.5, 9);
    expect(progressAt(3, 2 / 3)).toBeCloseTo(0, 9);
  });

  test("dotnet truncation matches the unchecked (int) cast", () => {
    expect(dotnetTruncToI32(2.9)).toBe(2);
    expect(dotnetTruncToI32(-2.9)).toBe(-2);
    expect(dotnetTruncToI32(Number.POSITIVE_INFINITY)).toBe(-2147483648);
    expect(dotnetTruncToI32(Number.NaN)).toBe(-2147483648);
    expect(dotnetTruncToI32(2147483648)).toBe(-2147483648);
  });
});
