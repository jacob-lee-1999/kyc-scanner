import assert from "node:assert/strict";
import test from "node:test";
import { cameraFailure, canFocusClose, closestFocusDistance, mainLensScore, mainZoom, tuneTrack, refocus } from "../lib/camera.ts";

test("camera errors map to a screen the user can act on", () => {
  assert.equal(cameraFailure(new DOMException("no", "NotAllowedError")), "permission");
  assert.equal(cameraFailure(new DOMException("no", "NotFoundError")), "missing");
  assert.equal(cameraFailure(new DOMException("no", "SecurityError")), "insecure");
  assert.equal(cameraFailure(new DOMException("no", "NotSupportedError")), "unsupported");
  assert.equal(cameraFailure(new DOMException("no", "NotReadableError")), "busy");
  assert.equal(cameraFailure(new Error("other")), "unknown");
});

test("the main wide lens outranks a fixed ultrawide and a smaller sensor", () => {
  const main = mainLensScore({ pixels: 4000 * 3000, canFocus: true });
  const ultra = mainLensScore({ pixels: 4000 * 3000, canFocus: false });
  const tele = mainLensScore({ pixels: 2000 * 1500, canFocus: true });
  assert.ok(main > ultra);
  assert.ok(main > tele);
  assert.equal(canFocusClose({ focusMode: ["manual"], focusDistance: { min: 0, max: 3.6 } }), false);
  assert.equal(canFocusClose({ focusMode: ["continuous"] }), true);
  assert.equal(mainZoom({ min: 0.5, max: 8 }), 1);
  assert.equal(mainZoom({ min: 1, max: 8 }), null);
});

test("closest focus sits just inside the near stop, and 0 means infinity", () => {
  assert.equal(closestFocusDistance({ min: 0.1, max: 3.6, step: 0.01 }), 0.11);
  assert.equal(closestFocusDistance({ min: 0, max: 3.6, step: 0.01 }), 0.01);
  assert.equal(closestFocusDistance(undefined), null);
});



test("autofocus wins over manual near focus, including refocus", async () => {
  const calls: unknown[] = [];
  const track = {
    getCapabilities: () => ({ focusMode: ["manual", "continuous"], focusDistance: { min: 0.1, max: 4 } }),
    applyConstraints: async (constraints: unknown) => { calls.push(constraints); },
  } as unknown as MediaStreamTrack;
  await tuneTrack(track);
  await refocus(track);
  assert.deepEqual(calls, [
    { advanced: [{ focusMode: "continuous" }] },
    { advanced: [{ focusMode: "continuous" }] },
  ]);
});

test("unsupported autofocus preserves browser defaults", async () => {
  let called = false;
  await tuneTrack({
    getCapabilities: () => ({ focusMode: ["manual"] }),
    applyConstraints: async () => { called = true; },
  } as unknown as MediaStreamTrack);
  assert.equal(called, false);
});
