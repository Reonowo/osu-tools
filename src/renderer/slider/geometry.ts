// port of osu-framework's path.drawnode.cs (tag 2026.731.0): loose segment
// quads for the distance-field prepass. every vertex carries its segment's
// endpoints; caps and joints round off in the fragment shader

/** path.drawnode.cs:21 -- smallest allowed segment length for the reduction pass */
const PRECISION = 0.01;
/** path.drawnode.cs:22 */
const MAX_RES = 24;

export interface PathQuads {
  positions: Float32Array;
  segStarts: Float32Array;
  segEnds: Float32Array;
  indices: Uint32Array;
  quadCount: number;
}

/** path.cs:175-202 -- origin-seeded so a path that never reaches (0,0) still
 * reports a bounds box that includes it */
export function pathBounds(flatVertices: ArrayLike<number>, radius: number) {
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (let i = 0; i < flatVertices.length; i += 2) {
    minX = Math.min(minX, flatVertices[i] - radius);
    minY = Math.min(minY, flatVertices[i + 1] - radius);
    maxX = Math.max(maxX, flatVertices[i] + radius);
    maxY = Math.max(maxY, flatVertices[i + 1] + radius);
  }
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

interface Segment {
  sx: number; sy: number; ex: number; ey: number;
  dx: number; dy: number; // normalized direction
  tlx: number; tly: number; trx: number; try_: number;
  blx: number; bly: number; brx: number; bry: number;
}

/** path.drawnode.cs:286-307 (DrawableSegment) */
function makeSegment(sx: number, sy: number, ex: number, ey: number, radius: number): Segment {
  let dx = ex - sx, dy = ey - sy;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < PRECISION * PRECISION) { dx = 1; dy = 0; }
  else { const len = Math.sqrt(lengthSquared); dx /= len; dy /= len; }
  const ox = -dy * radius, oy = dx * radius;
  return {
    sx, sy, ex, ey, dx, dy,
    tlx: sx + ox, tly: sy + oy, trx: ex + ox, try_: ey + oy,
    blx: sx - ox, bly: sy - oy, brx: ex - ox, bry: ey - oy,
  };
}

class QuadSink {
  positions: number[] = [];
  segStarts: number[] = [];
  segEnds: number[] = [];

  /** four corners + the segment both attributes replicate to each corner */
  add(corners: number[], sx: number, sy: number, ex: number, ey: number): void {
    this.positions.push(...corners);
    for (let i = 0; i < 4; i++) {
      this.segStarts.push(sx, sy);
      this.segEnds.push(ex, ey);
    }
  }
}

export function buildPathQuads(flatVertices: ArrayLike<number>, radius: number): PathQuads {
  const sink = new QuadSink();
  const count = flatVertices.length / 2;

  if (count >= 2 && radius > 0) {
    // raw consecutive segments (path.cs:257-270; bounds offset is the caller's business)
    const segments: [number, number, number, number][] = [];
    for (let i = 0; i < count - 1; i++) {
      segments.push([
        flatVertices[i * 2], flatVertices[i * 2 + 1],
        flatVertices[(i + 1) * 2], flatVertices[(i + 1) * 2 + 1],
      ]);
    }

    type Location = "outside" | "end" | "startOrMiddle";
    let toDraw = segments[0];
    let location: Location = "outside";
    let nextLocation: Location = "end";
    let lastDrawn = makeSegment(...segments[0], radius);

    // path.drawnode.cs:89-165 (drawSegment + drawQuad)
    const drawSegment = (segment: Segment, prev: Segment, loc: Location, endCap: boolean) => {
      let startCap = loc === "outside";
      let { tlx, tly, trx, try_: tryy, blx, bly, brx, bry } = segment;
      const offX = segment.dx * radius, offY = segment.dy * radius;

      if (loc === "end") {
        const d2x = -prev.dx, d2y = -prev.dy;
        const dot = segment.dx * d2x + segment.dy * d2y;
        if (dot >= 0) {
          startCap = true;
        } else {
          const pDot = segment.dx * d2y - segment.dy * d2x;
          const thetaDiff = Math.abs(Math.atan(pDot / dot));
          if (thetaDiff < Math.PI / MAX_RES) {
            if (pDot < 0) { tlx = prev.trx; tly = prev.try_; }
            else { blx = prev.brx; bly = prev.bry; }
          } else {
            const ox = segment.sx, oy = segment.sy;
            const fromX = pDot < 0 ? prev.trx : prev.brx;
            const fromY = pDot < 0 ? prev.try_ : prev.bry;
            const toX = pDot < 0 ? tlx : blx;
            const toY = pDot < 0 ? tly : bly;
            const tan = Math.tan(thetaDiff * 0.5);
            const outerX = toX - offX * tan;
            const outerY = toY - offY * tan;
            // inner vertex sits 10% past the origin to cover seam pixels
            const innerX = outerX + (ox - outerX) * 1.1;
            const innerY = outerY + (oy - outerY) * 1.1;
            // drawQuad(topLeft, topRight, bottomLeft, bottomRight, ...) pushes
            // topLeft, topRight, bottomRight, bottomLeft (path.drawnode.cs:157-165)
            // -- called here as drawQuad(from, outer, inner, to, origin, origin),
            // so the emitted order is [from, outer, to, inner], not [from, outer,
            // inner, to]. verified against path.drawnode.cs:137 directly: passing
            // (toConnect.StartPoint, outerVertex, innerVertex, toConnect.EndPoint)
            // binds topLeft=start, topRight=outer, bottomLeft=inner,
            // bottomRight=end, and drawQuad emits topLeft,topRight,bottomRight,
            // bottomLeft -- i.e. start, outer, end, inner
            sink.add([fromX, fromY, outerX, outerY, toX, toY, innerX, innerY], ox, oy, ox, oy);
          }
        }
      }

      if (startCap) { tlx -= offX; tly -= offY; blx -= offX; bly -= offY; }
      let trx2 = trx, try2 = tryy, brx2 = brx, bry2 = bry;
      if (endCap) { trx2 += offX; try2 += offY; brx2 += offX; bry2 += offY; }

      sink.add([tlx, tly, trx2, try2, brx2, bry2, blx, bly], segment.sx, segment.sy, segment.ex, segment.ey);
    };

    for (let i = 1; i < segments.length; i++) {
      const dirX = toDraw[2] - toDraw[0];
      const dirY = toDraw[3] - toDraw[1];
      const lengthSquared = dirX * dirX + dirY * dirY;
      const [, , nx, ny] = segments[i];

      // quirk preserved: lengthSquared compared against precision un-squared
      if (lengthSquared < PRECISION) {
        toDraw = [toDraw[0], toDraw[1], nx, ny];
        continue;
      }

      const d2x = nx - toDraw[0];
      const d2y = ny - toDraw[1];
      const pDot = dirX * d2y - dirY * d2x;

      if ((pDot * pDot) / lengthSquared < PRECISION * PRECISION) {
        nextLocation = "startOrMiddle";
        const dot = dirX * d2x + dirY * d2y;
        if (dot < 0) {
          toDraw = [nx, ny, toDraw[2], toDraw[3]];
          location = "outside";
        } else if (dot > lengthSquared) {
          toDraw = [toDraw[0], toDraw[1], nx, ny];
          nextLocation = "end";
        }
      } else {
        const segment = makeSegment(...toDraw, radius);
        drawSegment(segment, lastDrawn, location, nextLocation === "startOrMiddle");
        lastDrawn = segment;
        toDraw = segments[i];
        location = nextLocation;
        nextLocation = "end";
      }
    }

    const final = makeSegment(...toDraw, radius);
    drawSegment(final, lastDrawn, location, true);
  }

  const quadCount = sink.positions.length / 8;
  const indices = new Uint32Array(quadCount * 6);
  for (let q = 0; q < quadCount; q++) {
    indices.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
  }
  return {
    positions: new Float32Array(sink.positions),
    segStarts: new Float32Array(sink.segStarts),
    segEnds: new Float32Array(sink.segEnds),
    indices,
    quadCount,
  };
}
