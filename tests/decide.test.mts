import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_STABILITY, evaluateFrame, gate, LIMITS, type Sample, step } from "../src/lib/decide.ts";

const inner = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
const quad = [
  { x: inner.x, y: inner.y },
  { x: inner.x + inner.width, y: inner.y },
  { x: inner.x + inner.width, y: inner.y + inner.height },
  { x: inner.x, y: inner.y + inner.height },
];

function sample(patch: Partial<Sample> = {}): Sample {
  return {
    sharpness: 2000,
    glareRatio: 0,
    hotspot: false,
    luma: 160,
    borderScore: 40,
    quadMatched: true,
    motion: 0,
    ...patch,
  };
}

test("alignment is reported before glare on an empty frame", () => {
  assert.equal(gate(sample({ quadMatched: false, borderScore: 0, hotspot: true })), "align");
});

test("glare wins over blur once the card is in the frame", () => {
  assert.equal(gate(sample({ hotspot: true, sharpness: 10 })), "glare");
  assert.equal(gate(sample({ glareRatio: LIMITS.glareRatioMax + 0.01, sharpness: 10 })), "glare");
});

test("dark, bright, and blur are separate", () => {
  assert.equal(gate(sample({ luma: 10 })), "dark");
  assert.equal(gate(sample({ luma: 250 })), "bright");
  assert.equal(gate(sample({ sharpness: LIMITS.sharpMin - 1 })), "blur");
  assert.equal(gate(sample({ sharpness: Number.NaN })), "blur");
});

test("motion above the limit does not count as ready", () => {
  assert.equal(gate(sample({ motion: LIMITS.motionMax + 0.01 })), "move");
  assert.equal(gate(sample({ motion: null })), "ok");
});

test("two steady frames capture when the minimum hold time is met", () => {
  let state = { ...EMPTY_STABILITY };
  let lastReason = "";
  let captured = false;
  for (let i = 0; i < LIMITS.stableFrames; i++) {
    const result = evaluateFrame(
      state,
      {
        sharpness: 2000,
        glareRatio: 0,
        hotspot: false,
        luma: 160,
        borderScore: 40,
        quad,
        aspect: 1.58,
      },
      inner,
      i * LIMITS.stableMs,
    );
    state = result.state;
    lastReason = result.reason;
    captured = result.capture;
    if (i < LIMITS.stableFrames - 1) assert.equal(result.reason, "hold");
  }
  assert.equal(lastReason, "ok");
  assert.equal(captured, true);
});

test("a jump resets the steady count", () => {
  const first = evaluateFrame(
    EMPTY_STABILITY,
    {
      sharpness: 2000,
      glareRatio: 0,
      hotspot: false,
      luma: 160,
      borderScore: 40,
      quad,
      aspect: 1.58,
    },
    inner,
  );
  assert.equal(first.reason, "hold");
  const shifted = quad.map((point) => ({ x: point.x + 0.2, y: point.y }));
  const second = evaluateFrame(
    first.state,
    {
      sharpness: 2000,
      glareRatio: 0,
      hotspot: false,
      luma: 160,
      borderScore: 0,
      quad: shifted,
      aspect: 1.58,
    },
    inner,
  );
  assert.equal(second.capture, false);
  assert.equal(second.state.count, 0);
});

test("a strong border without corners cannot authorize capture", () => {
  const result = evaluateFrame(
    EMPTY_STABILITY,
    {
      sharpness: 2000,
      glareRatio: 0,
      hotspot: false,
      luma: 160,
      borderScore: LIMITS.borderMin,
      quad: null,
      aspect: null,
    },
    inner,
  );
  assert.equal(result.reason, "align");
  assert.equal(result.quad, null);
});


test("rapid frames and long gaps cannot satisfy the hold interval", () => {
  let state = { ...EMPTY_STABILITY };
  for (let i = 0; i < 10; i++) {
    const result = step(state, sample(), quad, i * 10);
    assert.equal(result.capture, false);
    state = result.state;
  }
  const afterPause = step(state, sample(), quad, 2000);
  assert.equal(afterPause.capture, false);
  assert.equal(afterPause.state.count, 1);
});


test("4K analysis cadence can finish while genuine pauses reset the hold", () => {
  let state = { ...EMPTY_STABILITY };
  for (let i=0; i<3; i++) {
    const result = step(state, sample(), quad, i * 550);
    assert.equal(result.capture, i === 2);
    state = result.state;
  }
  const first = step(EMPTY_STABILITY, sample(), quad, 0);
  const paused = step(first.state, sample(), quad, LIMITS.maxGapMs + 1);
  assert.equal(paused.state.count, 1);
  assert.equal(paused.capture, false);
});

test('small native card resolution requires moving closer despite good metrics', () => {
  assert.equal(gate(sample({cardWidth:599})), 'closer');
  assert.equal(gate(sample({cardWidth:600})), 'ok');
});
