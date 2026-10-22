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
  motionMax: 0.045,
  cardWidthMin: 600,
  stableFrames: 2,
  stableMs: 700,
  maxGapMs: 800,
};

// Found on the captured card by inspectDamage in detector-core.js.
export type Damage = "corner" | "split" | "hole" | "covered";

export type Reason = "align" | "closer" | "glare" | "dark" | "bright" | "blur" | "move" | "hold" | "ok" | Damage;

export type FrameMetrics = {
  cardWidth?: number;
  sharpness: number;
  glareRatio: number;
  hotspot: boolean;
  luma: number;
  borderScore: number;
  quad: Point[] | null;
  aspect: number | null;
  // Recent frames, merged, leave no part of the card washed out.
  glareCovered?: boolean;
};

export type Sample = {
  cardWidth?: number;
  sharpness: number;
  glareRatio: number;
  hotspot: boolean;
  luma: number;
  borderScore: number;
  quadMatched: boolean;
  motion: number | null;
  glareCovered?: boolean;
};

// skipped: this frame was bad and left out of a steady run.
export type Stability = { count: number; quad: Point[] | null; since?: number; last?: number; skipped?: boolean };

export const EMPTY_STABILITY: Stability = { count: 0, quad: null };

export function gate(sample: Sample): Exclude<Reason, "hold" | Damage> {
  const aligned = sample.quadMatched;
  if (!aligned) return "align";
  if (sample.cardWidth != null && (!Number.isFinite(sample.cardWidth) || sample.cardWidth < LIMITS.cardWidthMin)) return "closer";
  if (
    !sample.glareCovered &&
    (sample.hotspot || !Number.isFinite(sample.glareRatio) || sample.glareRatio > LIMITS.glareRatioMax)
  ) {
    return "glare";
  }
  if (!Number.isFinite(sample.luma) || sample.luma < LIMITS.lumaMin) return "dark";
  if (sample.luma > LIMITS.lumaMax) return "bright";
  if (!Number.isFinite(sample.sharpness) || sample.sharpness < LIMITS.sharpMin) return "blur";
  if (sample.motion != null && sample.motion > LIMITS.motionMax) return "move";
  return "ok";
}

export function step(state: Stability, sample: Sample, quad: Point[] | null, now = performance.now()): { state: Stability; reason: Exclude<Reason, Damage>; capture: boolean } {
  if (state.last != null && (now - state.last > LIMITS.maxGapMs || now < state.last)) state = EMPTY_STABILITY;
  const reason = gate(sample);
  // One bad frame in a steady run (an outline that missed or ran onto something
  // next to the card, a blurred frame) is left out; a second in a row starts over.
  if (reason !== "ok" && state.count > 0 && !state.skipped) {
    return { state: { ...state, skipped: true }, reason: "hold" as const, capture: false };
  }
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
    metrics.quad != null && quadMatchesGuide(metrics.quad, inner);
  const quad = quadMatched ? metrics.quad : null;
  const sample: Sample = {
    cardWidth: metrics.cardWidth,
    sharpness: metrics.sharpness,
    glareRatio: metrics.glareRatio,
    hotspot: metrics.hotspot,
    luma: metrics.luma,
    borderScore: metrics.borderScore,
    quadMatched,
    motion: quadMotion(state.quad, quad),
    glareCovered: metrics.glareCovered,
  };
  return { ...step(state, sample, quad, now), quad, sample };
}
