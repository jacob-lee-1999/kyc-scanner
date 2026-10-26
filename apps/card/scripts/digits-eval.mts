// Measures number reading on photos of real cards. Photos stay where they are;
// nothing is copied into the repo.
//
//   pnpm --filter card eval:digits <folder>
//
// <folder> holds one folder per card: its photos (jpg, png) and a truth.json with
// what is printed on it, digits only:
//   { "card": "1234567812345678", "expiry": "0829", "activation": "123412341234" }
//
// Each photo is read the way the app reads a camera frame: the part around the
// guide (the photo standing in for the screen), READ_WIDTH wide, through readFrame.
// So frame photos like the app asks: the card about filling the guide in the middle.
// It reads one photo at a time; the app also needs two frames to agree (fields.ts
// VOTES_NEEDED), which this does not.
// Decodes through ffmpeg, which turns photos upright by their EXIF rotation.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { analysisSource, guideRect, READ_PAD } from "../src/lib/geometry.ts";

type Image = { data: Uint8Array; width: number; height: number };
type Cv = { Mat: unknown; then?: unknown };
type Field = "card" | "expiry" | "activation";
type Fields = Record<Field, { value: string; p: number } | null>;
const FIELDS: Field[] = ["card", "expiry", "activation"];
const require = createRequire(import.meta.url);
const reader = require("../public/reader-core.js") as {
  readFrame: (cv: Cv, model: unknown, image: Image) => Fields;
};
// Same as the app (components/scanner.tsx).
const READ_WIDTH = 1300;
const GUIDE_FRACTION = 0.72;
const model = require("../public/digit-model.js");

declare global {
  var Module: { Mat?: unknown; then?: unknown; onRuntimeInitialized?: () => void };
}

const folder = process.argv[2];
if (!folder) {
  console.error("usage: pnpm --filter card eval:digits <folder>");
  process.exit(1);
}

// PAM output carries the size, which is the size after EXIF rotation; ffprobe
// reports the stored, unrotated size.
function pam(path: string, filter: string): Image {
  const out = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vf", `${filter},format=rgba`, "-f", "image2pipe", "-c:v", "pam", "-"], { maxBuffer: 256 << 20 });
  const end = out.indexOf("ENDHDR\n") + 7;
  const header = out.subarray(0, end).toString();
  const width = Number(/WIDTH (\d+)/.exec(header)![1]);
  const height = Number(/HEIGHT (\d+)/.exec(header)![1]);
  return { data: new Uint8Array(out.buffer, out.byteOffset + end, width * height * 4), width, height };
}

const cv: Cv = await new Promise((resolve) => {
  globalThis.Module = {
    onRuntimeInitialized() {
      const api = globalThis.Module;
      if (typeof api.then === "function") delete api.then;
      resolve(api as Cv);
    },
  };
  require("@kyc-scanner/opencv");
});

type Tally = { photos: number; right: Record<Field, number>; wrong: Record<Field, number>; missing: Record<Field, number>; digits: number; digitsRight: number; ms: number };
const tally = (): Tally => ({ photos: 0, right: { card: 0, expiry: 0, activation: 0 }, wrong: { card: 0, expiry: 0, activation: 0 }, missing: { card: 0, expiry: 0, activation: 0 }, digits: 0, digitsRight: 0, ms: 0 });
const rows: [string, Tally][] = [];
const total = tally();

for (const name of readdirSync(folder).sort()) {
  const dir = join(folder, name);
  const truthPath = join(dir, "truth.json");
  if (!existsSync(truthPath)) continue;
  const truth = JSON.parse(readFileSync(truthPath, "utf8")) as Record<Field, string>;
  const t = tally();
  for (const file of readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort()) {
    const path = join(dir, file);
    const { width, height } = pam(path, "scale=64:64:force_original_aspect_ratio=decrease");
    const region = analysisSource(guideRect(width, height, GUIDE_FRACTION), READ_PAD, width, height);
    const crop = [region.width / width, region.height / height, region.x / width, region.y / height];
    const frame = pam(path, `crop=iw*${crop[0]}:ih*${crop[1]}:iw*${crop[2]}:ih*${crop[3]},scale=${READ_WIDTH}:-2:flags=area`);
    t.photos++;
    const started = performance.now();
    const fields = reader.readFrame(cv, model, frame);
    t.ms += performance.now() - started;
    const marks: string[] = [];
    for (const f of FIELDS) {
      const got = fields[f]?.value.replace("/", "");
      if (!got) { t.missing[f]++; marks.push(`${f} -`); continue; }
      t.digits += truth[f].length;
      for (let i = 0; i < truth[f].length; i++) if (got[i] === truth[f][i]) t.digitsRight++;
      if (got === truth[f]) { t.right[f]++; marks.push(`${f} ok`); } else { t.wrong[f]++; marks.push(`${f} WRONG`); }
    }
    console.log(`${name}/${file}: ${marks.join(", ")}`);
  }
  rows.push([name, t]);
  for (const k of ["photos", "digits", "digitsRight", "ms"] as const) total[k] += t[k];
  for (const f of FIELDS) { total.right[f] += t.right[f]; total.wrong[f] += t.wrong[f]; total.missing[f] += t.missing[f]; }
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
console.log("\n| card | photos | card no. right/wrong/missing | expiry | activation | digits right | ms/photo |");
console.log("|---|---|---|---|---|---|---|");
for (const [name, t] of [...rows, ["total", total] as [string, Tally]]) {
  const cell = (f: Field) => `${t.right[f]}/${t.wrong[f]}/${t.missing[f]}`;
  console.log(`| ${name} | ${t.photos} | ${cell("card")} | ${cell("expiry")} | ${cell("activation")} | ${pct(t.digitsRight, t.digits)} | ${(t.ms / Math.max(1, t.photos)).toFixed(0)} |`);
}
