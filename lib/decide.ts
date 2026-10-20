import {
  quadMatchesGuide,
  quadMotion,
  type Point,
  type Rect,
} from "./geometry.ts";

// Initial thresholds use synthetic fixtures and one A53 session (see README).
// Calibrate against real devices and card layouts before release.
export const LIMITS = {
  sharpMin: 180,
  glareRatioMax: 0.012,
  borderMin: 20,
  lumaMin: 50,
  lumaMax: 240,
  cornerTol: 0.1,
  motionMax: 0.035,
  stableFrames: 5,
  stableMs: 700,
  maxGapMs: 800,
};

export type Reason = "align" | "glare" | "dark" | "bright" | "blur" | "move" | "hold" | "ok";

export type FrameMetrics = {
  sharpness: number;
  glareRatio: number;
  hotspot: boolean;
  luma: number;
  borderScore: number;
  quad: Point[] | null;
  aspect: number | null;
};

export type Sample = {
  sharpness: number;
  glareRatio: number;
  hotspot: boolean;
  luma: number;
  borderScore: number;
  quadMatched: boolean;
  motion: number | null;
};

export type Stability = { count: number; quad: Point[] | null; since?: number; last?: number };

export const EMPTY_STABILITY: Stability = { count: 0, quad: null };

export function gate(sample: Sample): Exclude<Reason, "hold"> {
  const aligned = sample.quadMatched;
  if (!aligned) return "align";
  if (
    sample.hotspot ||
    !Number.isFinite(sample.glareRatio) ||
    sample.glareRatio > LIMITS.glareRatioMax
  ) {
    return "glare";
  }
  if (!Number.isFinite(sample.luma) || sample.luma < LIMITS.lumaMin) return "dark";
  if (sample.luma > LIMITS.lumaMax) return "bright";
  if (!Number.isFinite(sample.sharpness) || sample.sharpness < LIMITS.sharpMin) return "blur";
  if (sample.motion != null && sample.motion > LIMITS.motionMax) return "move";
  return "ok";
}

export function step(state: Stability, sample: Sample, quad: Point[] | null, now = performance.now()) {
  if (state.last != null && (now - state.last > LIMITS.maxGapMs || now < state.last)) state = EMPTY_STABILITY;
  const reason = gate(sample);
  if (reason === "move") return { state: { count: 0, quad }, reason, capture: false };
  if (reason !== "ok") return { state: { count: 0, quad: null }, reason, capture: false };
  const count = state.count + 1;
  const since = state.since ?? now;
  if (count >= LIMITS.stableFrames && now - since >= LIMITS.stableMs) {
    return { state: EMPTY_STABILITY, reason: "ok" as const, capture: true };
  }
  return { state: { count, quad, since, last: now }, reason: "hold" as const, capture: false };
}

export function evaluateFrame(state: Stability, metrics: FrameMetrics, inner: Rect, now = performance.now()) {
  const quadMatched =
    metrics.quad != null && quadMatchesGuide(metrics.quad, inner, LIMITS.cornerTol);
  const quad = quadMatched ? metrics.quad : null;
  const sample: Sample = {
    sharpness: metrics.sharpness,
    glareRatio: metrics.glareRatio,
    hotspot: metrics.hotspot,
    luma: metrics.luma,
    borderScore: metrics.borderScore,
    quadMatched,
    motion: quadMotion(state.quad, quad),
  };
  return { ...step(state, sample, quad, now), quad, sample };
}
