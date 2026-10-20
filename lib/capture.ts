import { type Point, type Rect, outputSize } from './geometry.ts';

export const CAPTURE_MARGIN = 0.06;
export const CANDIDATE_MAX_AGE_MS = 1200;

export function preferCandidate(previous: { score: number; at: number } | null, score: number, at: number) {
  return Number.isFinite(score) && (!previous || at < previous.at || at - previous.at > CANDIDATE_MAX_AGE_MS || score > previous.score);
}

// Extend the card's projective plane, preserving real background around all corners.
export function paddedCapture(corners: Point[], width: number, height: number) {
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
  return { source, corners: expanded.map(p => ({x: p.x - x, y: p.y - y})), size: outputSize(expanded) };
}
