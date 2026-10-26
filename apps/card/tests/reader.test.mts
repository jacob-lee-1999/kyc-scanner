import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { inflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
type Image = { data: Uint8Array; width: number; height: number };
type Cv = { Mat: unknown; then?: unknown };
type Box = number[];
type Char = { box: Box; hc: number; label: string; p: number };
type Fields = Record<"card" | "expiry" | "activation", { value: string; p: number } | null>;
type Model = { classes: string[] };
const reader = require("../public/reader-core.js") as {
  CARD_W: number;
  CARD_H: number;
  otsu: (gray: Uint8Array) => number;
  lineInk: (gray: Uint8Array) => Float64Array | null;
  segment: (ink: Float64Array, w: number, h: number) => { chars: Box[]; hc: number };
  glyph: (ink: Float64Array, w: number, h: number, box: Box) => Float32Array;
  runModel: (model: Model, input: Float32Array) => number[];
  runsOf: (chars: Char[]) => { text: string; p: number }[];
  readLine: (model: Model, gray: Uint8Array, w: number, h: number) => Char[];
  upright: (gray: Uint8Array, w: number, h: number) => Uint8Array;
  fieldsOf: (runs: { text: string; p: number }[]) => Fields;
  readCard: (cv: Cv, model: Model, card: Image) => Fields;
  readFrame: (cv: Cv, model: Model, image: Image) => Fields;
};
const model = require("../public/digit-model.js") as Model;

declare global {
  var Module: { Mat?: unknown; then?: unknown; onRuntimeInitialized?: () => void };
}

const cvReady: Promise<Cv> = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("opencv timed out")), 20000);
  globalThis.Module = {
    onRuntimeInitialized() {
      clearTimeout(timer);
      const cv = globalThis.Module;
      if (typeof cv.then === "function") delete cv.then;
      resolve(cv as Cv);
    },
  };
  require("@kyc-scanner/opencv");
});

type Line = {
  width: number; height: number; gray: string; otsu: number; inkSum: number; hc: number;
  chars: Box[]; glyphs: number[][]; probs: number[][];
};
const lines = JSON.parse(readFileSync(new URL("./fixtures/reader.json", import.meta.url), "utf8")) as Line[];

// training/reader.py cuts the glyphs the model learned from; the app must cut the same.
test("glyph steps match the Python twin the model was trained with", () => {
  for (const line of lines) {
    const gray = new Uint8Array(Buffer.from(line.gray, "base64"));
    assert.equal(reader.otsu(gray), line.otsu);
    const ink = reader.lineInk(gray)!;
    assert.ok(Math.abs(ink.reduce((a, b) => a + b, 0) - line.inkSum) < 1e-6);
    const { chars, hc } = reader.segment(ink, line.width, line.height);
    assert.equal(hc, line.hc);
    assert.equal(chars.length, line.chars.length);
    chars.forEach((box, i) => box.forEach((v, k) => assert.ok(Math.abs(v - line.chars[i][k]) < 1e-9)));
    line.glyphs.forEach((expected, i) => {
      const got = reader.glyph(ink, line.width, line.height, chars[i]);
      expected.forEach((v, k) => assert.ok(Math.abs(got[k] - v) < 1e-4, `glyph ${i} pixel ${k}: ${got[k]} vs ${v}`));
    });
  }
});

test("the hand-written model gives the PyTorch probabilities", () => {
  for (const line of lines) {
    const gray = new Uint8Array(Buffer.from(line.gray, "base64"));
    const ink = reader.lineInk(gray)!;
    const { chars } = reader.segment(ink, line.width, line.height);
    chars.forEach((box, i) => {
      const probs = reader.runModel(model, reader.glyph(ink, line.width, line.height, box));
      probs.forEach((p, k) => assert.ok(Math.abs(p - line.probs[i][k]) < 1e-3, `char ${i} class ${k}: ${p} vs ${line.probs[i][k]}`));
    });
  }
});

// Print leaning like that of a card tipped toward the camera is set back upright.
test("a leaning line is set upright before it is read", () => {
  const off = (a: Uint8Array, b: Uint8Array) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0);
  for (const line of lines) {
    const gray = new Uint8Array(Buffer.from(line.gray, "base64"));
    const { width: w, height: h } = line;
    for (const k of [-0.3, 0.3]) {
      const leaning = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) leaning[y * w + x] = gray[y * w + Math.min(w - 1, Math.max(0, Math.round(x - k * (y - h / 2))))];
      }
      assert.ok(off(reader.upright(leaning, w, h), gray) < 0.7 * off(leaning, gray), `shear ${k}`);
    }
  }
});

const char = (x: number, label: string, p = 0.99): Char => ({ box: [x, 0, 20, 36], hc: 36, label, p });
const typed = (text: string, start = 0, pitch = 28) =>
  [...text].flatMap((c, i) => (c === " " ? [] : [char(start + i * pitch, c)]));

test("spaces inside a number keep it whole; a wide gap or a letter ends it", () => {
  assert.deepEqual(reader.runsOf(typed("1234 5678")).map(r => r.text), ["12345678"]);
  const far = [...typed("1234"), ...typed("5678", 4 * 28 + 60)];
  assert.deepEqual(reader.runsOf(far).map(r => r.text), ["1234", "5678"]);
  // Digits set against a letter belong to something longer and are dropped.
  assert.deepEqual(reader.runsOf([char(0, "1"), char(28, "other"), char(56, "2")]).map(r => r.text), []);
});

test("a run set against an unread character is dropped, so its tail is no field", () => {
  // "9410 2385 7716 0451" with its fifth digit misread: "238577160451" alone would
  // pass for an activation number.
  const chars = typed("9410 2385 7716 0451");
  chars[4].label = "other";
  // The group before it is a word space away and stays; it is no field either.
  assert.deepEqual(reader.runsOf(chars).map(r => r.text), ["9410"]);
  // A label a word space away does not drop the number after it.
  const labelled = [char(0, "other"), char(28, "other"), ...typed("08/29", 28 + 20 + 30)];
  assert.deepEqual(reader.runsOf(labelled).map(r => r.text), ["08/29"]);
});

test("a run's confidence is its least sure character", () => {
  const chars = typed("1234");
  chars[2].p = 0.6;
  assert.equal(reader.runsOf(chars)[0].p, 0.6);
});

test("fields are told apart by shape", () => {
  const runs = [
    { text: "9410238577160451", p: 0.9 },
    { text: "08/29", p: 0.9 },
    { text: "330719465821", p: 0.9 },
    { text: "2026", p: 0.99 },
  ];
  const fields = reader.fieldsOf(runs);
  assert.equal(fields.card?.value, "9410238577160451");
  assert.equal(fields.expiry?.value, "08/29");
  assert.equal(fields.activation?.value, "330719465821");
});

test("no card number that fails its check digit", () => {
  assert.equal(reader.fieldsOf([{ text: "9410238577160452", p: 1 }]).card, null);
});

test("no field from a near miss: 15 digits, month 13, two-digit year missing", () => {
  const fields = reader.fieldsOf([{ text: "941023857716045", p: 1 }, { text: "13/29", p: 1 }, { text: "08/2", p: 1 }]);
  assert.deepEqual(fields, { card: null, expiry: null, activation: null });
});

test("the more confident of two runs of one shape wins", () => {
  const fields = reader.fieldsOf([{ text: "111122223333", p: 0.7 }, { text: "444455556666", p: 0.95 }]);
  assert.equal(fields.activation?.value, "444455556666");
});

type CardFixture = { width: number; height: number; data: string; truth: Record<string, string> };
const fixture = JSON.parse(readFileSync(new URL("./fixtures/card.json", import.meta.url), "utf8")) as CardFixture;
const card: Image = {
  width: fixture.width, height: fixture.height,
  data: new Uint8Array(inflateSync(Buffer.from(fixture.data, "base64"))),
};
const values = (fields: Fields) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v?.value.replace("/", "")]));

test("a whole card is read past its labels and logo", async () => {
  const cv = await cvReady;
  assert.equal(card.width, reader.CARD_W);
  assert.equal(card.height, reader.CARD_H);
  assert.deepEqual(values(reader.readCard(cv, model, card)), fixture.truth);
});

test("a card held upside down is read turned around", async () => {
  const cv = await cvReady;
  const n = card.width * card.height;
  const data = new Uint8Array(card.data.length);
  for (let i = 0; i < n; i++) data.set(card.data.subarray(i * 4, i * 4 + 4), (n - 1 - i) * 4);
  assert.deepEqual(values(reader.readCard(cv, model, { ...card, data })), fixture.truth);
});

// The camera's view of the guide: the card smaller than the frame, on a desk, turned
// by `degrees`. Bilinear samples of the fixture card.
function inFrame(degrees: number): Image {
  const width = 1000, height = Math.round(width / (85.6 / 53.98));
  const scale = 0.8, a = (degrees * Math.PI) / 180;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - width / 2, dy = y - height / 2;
      const u = (dx * Math.cos(a) + dy * Math.sin(a)) / scale + card.width / 2;
      const v = (-dx * Math.sin(a) + dy * Math.cos(a)) / scale + card.height / 2;
      const o = (y * width + x) * 4;
      if (u < 0 || v < 0 || u >= card.width - 1 || v >= card.height - 1) {
        data.set([200, 200, 200, 255], o);
        continue;
      }
      const u0 = Math.floor(u), v0 = Math.floor(v), fu = u - u0, fv = v - v0;
      for (let c = 0; c < 4; c++) {
        const at = (px: number, py: number) => card.data[(py * card.width + px) * 4 + c];
        data[o + c] = Math.round(at(u0, v0) * (1 - fu) * (1 - fv) + at(u0 + 1, v0) * fu * (1 - fv) + at(u0, v0 + 1) * (1 - fu) * fv + at(u0 + 1, v0 + 1) * fu * fv);
      }
    }
  }
  return { width, height, data };
}

test("a card turned in the guide is read without finding its outline", async () => {
  const cv = await cvReady;
  for (const degrees of [-7, 6]) assert.deepEqual(values(reader.readFrame(cv, model, inFrame(degrees))), fixture.truth, `${degrees} degrees`);
});
