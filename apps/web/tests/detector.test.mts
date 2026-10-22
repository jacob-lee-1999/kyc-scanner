import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { LIMITS } from "../src/lib/decide.ts";
import { quadMatchesGuide } from "../src/lib/geometry.ts";

const require = createRequire(import.meta.url);
const { analyzeFrame, warpCard, detectQuad } = require("../public/detector-core.js") as {
  detectQuad: (cv: Cv, image: Image) => { quad: { x: number; y: number }[] } | null;
  analyzeFrame: (
    cv: Cv,
    edge: Image,
    detail: Image,
    inner: { x: number; y: number; width: number; height: number },
  ) => {
    sharpness: number;
    glareRatio: number;
    hotspot: boolean;
    luma: number;
    borderScore: number;
    quad: { x: number; y: number }[] | null;
  };
  warpCard: (
    cv: Cv,
    image: Image,
    corners: { x: number; y: number }[],
    outWidth: number,
    outHeight: number,
  ) => { width: number; height: number; data: Uint8Array };
};

type Image = { data: Uint8ClampedArray; width: number; height: number };
type Cv = { Mat: unknown; then?: unknown };

declare global {
  var Module: {
    Mat?: unknown;
    then?: unknown;
    onRuntimeInitialized?: () => void;
  };
}

const inner = { x: 0.14 / 1.28, y: 0.14 / 1.28, width: 1 / 1.28, height: 1 / 1.28 };

function image(width: number, height: number, fill: [number, number, number]): Image {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

function rect(img: Image, x: number, y: number, width: number, height: number, color: [number, number, number]) {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(img.width, x + width);
  const y1 = Math.min(img.height, y + height);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const index = (yy * img.width + xx) * 4;
      img.data[index] = color[0];
      img.data[index + 1] = color[1];
      img.data[index + 2] = color[2];
    }
  }
}

function boxOf(img: Image) {
  return {
    x: Math.round(inner.x * img.width),
    y: Math.round(inner.y * img.height),
    width: Math.round(inner.width * img.width),
    height: Math.round(inner.height * img.height),
  };
}

function card() {
  const edge = image(640, 404, [40, 40, 40]);
  const box = boxOf(edge);
  rect(edge, box.x, box.y, box.width, box.height, [205, 205, 200]);
  return edge;
}

function sharpText(): Image {
  const detail = image(400, 180, [205, 205, 200]);
  for (let row = 12; row < 168; row += 9) rect(detail, 16, row, 240, 1, [70, 70, 70]);
  return detail;
}

function blur(src: Image, radius: number): Image {
  const out = image(src.width, src.height, [0, 0, 0]);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= src.height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= src.width) continue;
          const index = (yy * src.width + xx) * 4;
          red += src.data[index];
          green += src.data[index + 1];
          blue += src.data[index + 2];
          count += 1;
        }
      }
      const index = (y * src.width + x) * 4;
      out.data[index] = red / count;
      out.data[index + 1] = green / count;
      out.data[index + 2] = blue / count;
    }
  }
  return out;
}

const cvReady: Promise<Cv> = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("opencv timed out")), 20000);
  globalThis.Module = {
    onRuntimeInitialized() {
      clearTimeout(timer);
      const cv = globalThis.Module;
      if (!cv?.Mat) reject(new Error("opencv Mat missing"));
      else {
        if (typeof cv.then === "function") delete cv.then;
        resolve(cv as Cv);
      }
    },
  };
  require("@kyc-scanner/opencv");
});

test("opencv accepts a sharp card and rejects blur, glare, and an empty frame", async () => {
  const cv = await cvReady;
  const edge = card();
  const detail = sharpText();
  const sharp = analyzeFrame(cv, edge, detail, inner);
  assert.ok(sharp.sharpness >= LIMITS.sharpMin);
  assert.ok(sharp.borderScore >= LIMITS.borderMin);
  assert.equal(sharp.hotspot, false);
  assert.ok(sharp.glareRatio <= LIMITS.glareRatioMax);
  assert.ok(sharp.quad);
  assert.equal(quadMatchesGuide(sharp.quad, inner), true);

  const slightBlur = analyzeFrame(cv, edge, blur(detail, 1), inner);
  assert.ok(slightBlur.sharpness < sharp.sharpness);
  const soft = analyzeFrame(cv, edge, blur(detail, 4), inner);
  assert.ok(soft.sharpness < LIMITS.sharpMin);

  const glaringText = sharpText();
  rect(glaringText, 40, 40, 24, 24, [255, 255, 255]);
  const textGlare = analyzeFrame(cv, edge, glaringText, inner);
  assert.equal(textGlare.hotspot, true);

  const glare = card();
  const glareBox = boxOf(glare);
  rect(glare, glareBox.x + 80, glareBox.y + 70, 22, 22, [255, 255, 255]);
  const blown = analyzeFrame(cv, glare, detail, inner);
  assert.equal(blown.hotspot, true);

  const empty = analyzeFrame(cv, image(640, 404, [90, 90, 90]), image(400, 180, [90, 90, 90]), inner);
  assert.ok(empty.borderScore < LIMITS.borderMin);
  assert.equal(empty.quad, null);

  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    analyzeFrame(cv, edge, detail, inner);
    times.push(performance.now() - started);
  }
  assert.ok(Math.max(...times) < 40, `frame took ${Math.max(...times).toFixed(1)}ms`);
});

test("perspective crop keeps the card corner color", async () => {
  const cv = await cvReady;
  const source = image(200, 120, [0, 0, 255]);
  rect(source, 0, 0, 100, 60, [255, 0, 0]);
  const warped = warpCard(
    cv,
    source,
    [
      { x: 10, y: 10 },
      { x: 180, y: 14 },
      { x: 176, y: 100 },
      { x: 16, y: 108 },
    ],
    160,
    100,
  );
  assert.equal(warped.width, 160);
  assert.equal(warped.height, 100);
  assert.ok(warped.data[0] > 200);
  assert.ok(warped.data[2] < 40);
});


test("isolated highlights pass but a saturated patch blocks capture", async () => {
  const cv = await cvReady;
  const detail = sharpText();
  rect(detail, 30, 30, 2, 2, [255, 255, 255]);
  const isolated = analyzeFrame(cv, card(), detail, inner);
  assert.equal(isolated.hotspot, false);
  assert.ok(isolated.glareRatio < LIMITS.glareRatioMax);
  rect(detail, 40, 40, 24, 24, [249, 249, 249]);
  assert.equal(analyzeFrame(cv, card(), detail, inner).hotspot, true);
});

test("a sharp upper strip cannot hide blurred lower text", async () => {
  const detail = sharpText();
  const soft = blur(detail, 4);
  detail.data.set(soft.data.subarray(60 * detail.width * 4), 60 * detail.width * 4);
  assert.ok(analyzeFrame(await cvReady, card(), detail, inner).sharpness < LIMITS.sharpMin);
});


test("a blank middle band does not hide sharp text above and below", async () => {
  const detail = sharpText();
  rect(detail, 0, 60, detail.width, 60, [170, 190, 180]);
  const metrics = analyzeFrame(await cvReady, card(), detail, inner);
  assert.ok(metrics.sharpness >= LIMITS.sharpMin);
});

test("low contrast text passes while its defocused version fails", async () => {
  const detail = image(400, 180, [205, 205, 205]);
  for (let row = 12; row < 168; row += 9) rect(detail, 16, row, 240, 1, [160, 160, 160]);
  const cv = await cvReady;
  assert.ok(analyzeFrame(cv, card(), detail, inner).sharpness >= LIMITS.sharpMin);
  assert.ok(analyzeFrame(cv, card(), blur(detail, 1), inner).sharpness < LIMITS.sharpMin);
});

test("padded perspective warp retains actual background around card corners", async () => {
  const { paddedCapture } = await import('../src/lib/capture.ts');
  const source = image(240, 180, [20, 30, 40]);
  rect(source, 40, 40, 160, 100, [200, 200, 200]);
  const plan = paddedCapture([{x:40,y:40},{x:200,y:40},{x:200,y:140},{x:40,y:140}],240,180)!;
  const crop = image(plan.source.width, plan.source.height, [0,0,0]);
  for(let y=0;y<crop.height;y++) {
    const start=((plan.source.y+y)*source.width+plan.source.x)*4;
    crop.data.set(source.data.subarray(start,start+crop.width*4),y*crop.width*4);
  }
  const result=warpCard(await cvReady,crop,plan.corners,plan.size.width,plan.size.height);
  for(const [x,y] of [[2,2],[result.width-3,2],[2,result.height-3],[result.width-3,result.height-3]]) {
    const i=(y*result.width+x)*4;
    assert.ok(result.data[i] < 50 && result.data[i+2] >= 30);
  }
  assert.ok(result.data[(Math.floor(result.height/2)*result.width+Math.floor(result.width/2))*4]>180);
});


test("perspective correction straightens a trapezoid and its vertical center line", async () => {
  const source=image(320,220,[20,20,20]);
  for(let y=40;y<=180;y++) {
    const t=(y-40)/140;
    const left=80-60*t, right=240+60*t;
    for(let x=Math.ceil(left);x<=Math.floor(right);x++) {
      const index=(y*source.width+x)*4;
      const color=x<(left+right)/2 ? [220,30,30] : [30,30,220];
      source.data.set([...color,255],index);
    }
  }
  const result=warpCard(await cvReady,source,[{x:80,y:40},{x:240,y:40},{x:300,y:180},{x:20,y:180}],280,177);
  for(const y of [15,60,120,160]) {
    const red=(y*280+110)*4, blue=(y*280+170)*4;
    assert.ok(result.data[red]>180 && result.data[red+2]<60);
    assert.ok(result.data[blue]<60 && result.data[blue+2]>180);
  }
});

const analyzeScanFrame = (require('../public/detector-core.js') as {
  analyzeScanFrame: (cv: Cv, edge: Image, source: Image) => ReturnType<typeof analyzeFrame>;
}).analyzeScanFrame;

function offsetCard() {
  const source=image(1024,768,[40,40,40]);
  rect(source,380,280,520,328,[205,205,200]);
  for(let row=300;row<588;row+=16) rect(source,405,row,270,2,[70,70,70]);
  return source;
}
function halfImage(source: Image) {
  const result=image(source.width/2,source.height/2,[0,0,0]);
  for(let y=0;y<result.height;y++) for(let x=0;x<result.width;x++) {
    const i=(y*2*source.width+x*2)*4;
    result.data.set(source.data.subarray(i,i+4),(y*result.width+x)*4);
  }
  return result;
}

test('production scan detects a smaller shifted card and measures its actual text', async () => {
  const source=offsetCard();
  const metrics=analyzeScanFrame(await cvReady,halfImage(source),source);
  assert.ok(metrics.quad);
  assert.ok(metrics.sharpness>=LIMITS.sharpMin, `sharpness ${metrics.sharpness}`);
  assert.equal(quadMatchesGuide(metrics.quad,{x:0.2,y:0.2,width:0.6,height:0.6}),true);
  assert.equal(metrics.hotspot,false);
});

test('bright background outside the detected card is excluded from glare analysis', async () => {
  const source=offsetCard();
  rect(source,100,100,65,65,[255,255,255]);
  const metrics=analyzeScanFrame(await cvReady,halfImage(source),source);
  assert.ok(metrics.quad);
  assert.equal(metrics.hotspot,false);
  assert.ok(metrics.glareRatio<=LIMITS.glareRatioMax);
});

test('sharp background cannot approve a blurred detected card', async () => {
  const source=blur(offsetCard(),4);
  for(let row=20;row<720;row+=9) rect(source,20,row,190,1,[255,255,255]);
  const metrics=analyzeScanFrame(await cvReady,halfImage(source),source);
  assert.ok(metrics.quad);
  assert.ok(metrics.sharpness<LIMITS.sharpMin, `sharpness ${metrics.sharpness}`);
});

test('reflection on the shifted card still blocks the production scan', async () => {
  const source=offsetCard();
  rect(source,420,320,40,40,[255,255,255]);
  const metrics=analyzeScanFrame(await cvReady,halfImage(source),source);
  assert.ok(metrics.quad);
  assert.equal(metrics.hotspot,true);
});


test('actual worker protocol analyzes the source frame and preserves its frame ID', async () => {
  const cv=await cvReady;
  const messages: Array<ReturnType<typeof analyzeFrame> & {type:string;frameId:number}> = [];
  const scope: {cvApi:Cv;detectorCore:unknown;postMessage:(value:typeof messages[number])=>void;onmessage?:(event:{data:unknown})=>void} = {
    cvApi:cv,detectorCore:require('../public/detector-core.js'),postMessage:value=>messages.push(value),
  };
  runInNewContext(readFileSync(new URL('../public/detector.worker.js',import.meta.url),'utf8'), {
    self:scope,performance,importScripts:()=>undefined,
  });
  const source=offsetCard(), edge=halfImage(source);
  scope.onmessage!({data:{type:'frame',frameId:42,
    edge:{buffer:edge.data.buffer,width:edge.width,height:edge.height},
    source:{buffer:source.data.buffer,width:source.width,height:source.height},
  }});
  assert.equal(messages.length,1);
  assert.equal(messages[0].type,'metrics');
  assert.equal(messages[0].frameId,42);
  assert.ok(messages[0].quad);
  assert.ok(messages[0].sharpness>=LIMITS.sharpMin);
});

// A floor tile line around the card makes a larger quad than the card, with the
// same surface on both sides of its lines; the card must outrank it. A dark photo
// frame inside the card has strong edges too, but must not outrank the outline.
test("the card outranks a larger floor tile around it and print inside it", async () => {
  const cv = await cvReady;
  const card = { x0: 120, y0: 115, x1: 360, y1: 266 };
  for (const withTile of [true, false]) {
    const scene = image(480, 380, [120, 120, 120]);
    if (withTile) {
      for (const [x, y, w, h] of [[38, 28, 404, 4], [38, 348, 404, 4], [38, 28, 4, 324], [438, 28, 4, 324]]) rect(scene, x, y, w, h, [70, 70, 70]);
    }
    rect(scene, card.x0, card.y0, card.x1 - card.x0, card.y1 - card.y0, [205, 205, 200]);
    rect(scene, 135, 135, 70, 90, [30, 30, 30]);
    rect(scene, 140, 140, 60, 80, [150, 140, 130]);
    const found = detectQuad(cv, scene);
    assert.ok(found, `withTile ${withTile}`);
    const corners = found.quad.map((p) => ({ x: p.x * scene.width, y: p.y * scene.height }));
    const truth = [{ x: card.x0, y: card.y0 }, { x: card.x1, y: card.y0 }, { x: card.x1, y: card.y1 }, { x: card.x0, y: card.y1 }];
    corners.forEach((p, i) => assert.ok(Math.hypot(p.x - truth[i].x, p.y - truth[i].y) < 5, JSON.stringify({ withTile, corners })));
  }
});

test("a dark card on a dark mat keeps its faint outline over bright print near the edge", async () => {
  const cv = await cvReady;
  const source = image(1024, 768, [40, 40, 40]);
  // Grainy mat, as a leather pad looks to the camera.
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let y = 0; y < 768; y += 2) for (let x = 0; x < 1024; x += 2) {
    const v = 25 + Math.round(rand() * 35);
    rect(source, x, y, 2, 2, [v, v, v]);
  }
  const card = { x: 250, y: 220, w: 520, h: 328 };
  rect(source, card.x - 2, card.y - 2, card.w + 4, card.h + 4, [70, 70, 70]);
  rect(source, card.x, card.y, card.w, card.h, [42, 42, 42]);
  rect(source, card.x + 20, card.y + 12, card.w - 40, 40, [230, 230, 230]);
  const metrics = analyzeScanFrame(cv, halfImage(source), source);
  assert.ok(metrics.quad);
  const top = metrics.quad.slice(0, 2).map((p) => p.y * source.height);
  top.forEach((y) => assert.ok(Math.abs(y - card.y) < 5, JSON.stringify(top)));
});

// A thin rim on a same-coloured surface disappears in the camera's 480px
// area downsample. Keep the higher-resolution source from the same snapshot.
test('detail retry recovers a thin outline lost at preview resolution', async () => {
  const cv = await cvReady;
  for (const bg of [40, 120, 200]) {
    const source = image(960, 720, [bg, bg, bg]);
    rect(source, 220, 190, 520, 328, [bg + 40, bg + 40, bg + 40]);
    rect(source, 223, 193, 514, 322, [bg, bg, bg]);
    const edge = halfImage(source);
    for (let y = 0; y < edge.height; y++) for (let x = 0; x < edge.width; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          sum += source.data[((y * 2 + dy) * source.width + x * 2 + dx) * 4 + c];
        }
        edge.data[(y * edge.width + x) * 4 + c] = sum / 4;
      }
    }
    assert.equal(detectQuad(cv, edge), null);
    const result = analyzeScanFrame(cv, edge, source);
    assert.ok(result.quad);
    const expected = [[220, 190], [740, 190], [740, 518], [220, 518]];
    result.quad.forEach((p, i) => assert.ok(
      Math.hypot(p.x * source.width - expected[i][0], p.y * source.height - expected[i][1]) < 4,
      JSON.stringify(result.quad),
    ));
  }
});

test('detail retry keeps empty and vignetted backgrounds empty', async () => {
  const cv = await cvReady;
  for (const vignette of [false, true]) {
    const source = image(960, 720, [120, 120, 120]);
    if (vignette) for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
      const value = 120 - 20 * ((x / 960 - 0.5) ** 2 + (y / 720 - 0.5) ** 2);
      for (let c = 0; c < 3; c++) source.data[(y * source.width + x) * 4 + c] = value;
    }
    assert.equal(analyzeScanFrame(cv, halfImage(source), source).quad, null);
  }
});

test('a business card is not taken for an ID-1 card', async () => {
  const cv=await cvReady;
  const card=analyzeScanFrame(cv,halfImage(offsetCard()),offsetCard());
  assert.ok(card.quad);
  // 90×50mm, drawn as wide as the card.
  const business=image(1024,768,[40,40,40]);
  rect(business,380,280,520,289,[205,205,200]);
  assert.equal(analyzeScanFrame(cv,halfImage(business),business).quad,null);
});
