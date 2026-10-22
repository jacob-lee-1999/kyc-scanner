import { type Point, type Rect, CARD_ASPECT, outputSize, PASSPORT_ASPECT } from './geometry.ts';

export const CAPTURE_MARGIN = 0.06;
export const CANDIDATE_MAX_AGE_MS = 1200;

export function preferCandidate(previous: { score: number; at: number } | null, score: number, at: number) {
  return Number.isFinite(score) && (!previous || at < previous.at || at - previous.at > CANDIDATE_MAX_AGE_MS || score > previous.score);
}

// Extend the card's projective plane, preserving real background around all corners.
export function paddedCapture(corners: Point[], width: number, height: number, aspect = CARD_ASPECT) {
  if (corners.length !== 4 || corners.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const [a, b, c, d] = corners;
  const dx1 = b.x - c.x, dx2 = d.x - c.x, dx3 = a.x - b.x + c.x - d.x;
  const dy1 = b.y - c.y, dy2 = d.y - c.y, dy3 = a.y - b.y + c.y - d.y;
  const det = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(det) < 1e-6) return null;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  const project = (u: number, v: number): Point => {
    const denominator = g * u + h * v + 1;
    if (denominator <= 0.01) return { x: NaN, y: NaN };
    return {
      x: ((b.x - a.x + g * b.x) * u + (d.x - a.x + h * d.x) * v + a.x) / denominator,
      y: ((b.y - a.y + g * b.y) * u + (d.y - a.y + h * d.y) * v + a.y) / denominator,
    };
  };
  const p = CAPTURE_MARGIN;
  const expanded = [project(-p, -p), project(1+p, -p), project(1+p, 1+p), project(-p, 1+p)];
  if (expanded.some(v => !Number.isFinite(v.x) || !Number.isFinite(v.y) || v.x < 1 || v.y < 1 || v.x > width - 2 || v.y > height - 2)) return null;
  const x = Math.floor(Math.min(...expanded.map(p => p.x)));
  const y = Math.floor(Math.min(...expanded.map(p => p.y)));
  const source: Rect = { x, y, width: Math.ceil(Math.max(...expanded.map(p => p.x))) + 1 - x, height: Math.ceil(Math.max(...expanded.map(p => p.y))) + 1 - y };
  return { source, corners: expanded.map(p => ({x: p.x - x, y: p.y - y})), size: outputSize(expanded, aspect) };
}

// A passport zone (TD3) is missed on many single frames (glare, blur) and
// text around a card can pass for one now and then, so the document kind
// follows the last few frames of the card: 2 of 5 with a zone make a passport.
export const KIND_FRAMES = 5;
export type DocumentKind = "card" | "passport";

export function documentKind(zones: (string | null)[]): DocumentKind {
  return zones.slice(-KIND_FRAMES).filter(z => z === "TD3").length >= 2 ? "passport" : "card";
}

export const KIND_ASPECT: Record<DocumentKind, number> = { card: CARD_ASPECT, passport: PASSPORT_ASPECT };

// Glare cells of one frame, in card coordinates (glareCells in detector-core.js).
export type GlareFrame = { cells: number[] };

// Every cell washed out in this frame is clean in at least one other frame.
export function glareCovered(cells: number[] | null, others: GlareFrame[]) {
  return cells != null && cells.every((hot, i) => !hot || others.some(f => f.cells.length === cells.length && !f.cells[i]));
}

// Fewest other frames that together are clean where this frame is washed out.
export function coveringFrames<T extends GlareFrame>(cells: number[], others: T[]): T[] {
  const need = new Set(cells.flatMap((hot, i) => (hot ? [i] : [])));
  const chosen: T[] = [];
  while (need.size) {
    const gain = (f: T) => [...need].filter(i => f.cells.length === cells.length && !f.cells[i]).length;
    const next = others.filter(f => !chosen.includes(f)).sort((a, b) => gain(b) - gain(a))[0];
    if (!next || gain(next) === 0) break;
    for (const i of [...need]) if (!next.cells[i]) need.delete(i);
    chosen.push(next);
  }
  return chosen;
}
