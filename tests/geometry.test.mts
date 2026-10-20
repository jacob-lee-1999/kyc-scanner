import assert from "node:assert/strict";
import test from "node:test";
import {
  CARD_ASPECT,
  analysisSource,
  coverMap,
  detailWindow,
  detailSize,
  guideRect,
  guideWidthFraction,
  outputSize,
  quadMatchesGuide,
  quadMotion,
  stageRectToVideo,
} from "../src/lib/geometry.ts";

test("guide matches the closest distance the lens can focus", () => {
  const close = guideWidthFraction(0.11);
  assert.ok(close > 0.85);
  assert.ok(close <= 0.88);
  assert.equal(guideWidthFraction(null), 0.88);
  const guide = guideRect(390, 844, close);
  assert.ok(Math.abs(guide.width / guide.height - CARD_ASPECT) < 0.001);
});

test("guide matches an ID-1 card and stays on screen", () => {
  const guide = guideRect(390, 844);
  assert.ok(Math.abs(guide.width / guide.height - CARD_ASPECT) < 0.001);
  assert.ok(guide.x >= 0 && guide.y >= 0);
  assert.ok(guide.x + guide.width <= 390 + 0.01);
  assert.ok(guide.y + guide.height <= 844 + 0.01);
});

test("stage center maps to the video center", () => {
  const map = coverMap(390, 844, 1080, 1920);
  const center = stageRectToVideo({ x: 195, y: 422, width: 0, height: 0 }, map);
  assert.ok(Math.abs(center.x - 540) < 1e-6);
  assert.ok(Math.abs(center.y - 960) < 1e-6);
});

test("analysis inner rect maps back onto the guide", () => {
  const guide = { x: 400, y: 200, width: 800, height: 504 };
  const { source, inner } = analysisSource(guide, 0.14, 2000, 2000);
  assert.ok(Math.abs(source.x + inner.x * source.width - guide.x) < 1e-6);
  assert.ok(Math.abs(source.y + inner.y * source.height - guide.y) < 1e-6);
  assert.ok(Math.abs(inner.width * source.width - guide.width) < 1e-6);
});

test("clamped expansion still points at the visible guide", () => {
  const guide = { x: 0, y: 100, width: 300, height: 189 };
  const { source, inner } = analysisSource(guide, 0.14, 1000, 1000);
  assert.equal(source.x, 0);
  assert.ok(Math.abs(source.x + inner.x * source.width - guide.x) < 1e-6);
  assert.ok(inner.width * source.width <= guide.width + 1e-6);
});

test("text window stays inside the guide and is capped", () => {
  const guide = { x: 100, y: 50, width: 800, height: 500 };
  const sample = detailWindow(guide);
  assert.ok(sample.x >= guide.x - 1e-6);
  assert.ok(sample.y >= guide.y - 1e-6);
  assert.ok(sample.x + sample.width <= guide.x + guide.width + 1e-6);
  assert.ok(sample.y + sample.height <= guide.y + guide.height + 1e-6);
  assert.ok(detailSize(sample).width <= 660);
  assert.ok(detailSize(sample).height <= 440);
});

test("moderate rotation is accepted while clipped corners are rejected", () => {
  const inner = { x: 0.109375, y: 0.109375, width: 0.78125, height: 0.78125 };
  const corners = [
    { x: inner.x, y: inner.y },
    { x: inner.x + inner.width, y: inner.y },
    { x: inner.x + inner.width, y: inner.y + inner.height },
    { x: inner.x, y: inner.y + inner.height },
  ];
  const turn = (degrees: number) => {
    const angle = (degrees * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return corners.map((point) => {
      const dx = point.x - 0.5;
      const dy = point.y - 0.5;
      return { x: 0.5 + dx * cos - dy * sin, y: 0.5 + dx * sin + dy * cos };
    });
  };
  assert.equal(quadMatchesGuide(corners, inner), true);
  assert.equal(quadMatchesGuide(turn(10), inner), true);
  assert.equal(quadMatchesGuide(turn(15), inner), true);
});

test("output keeps the card aspect and does not upscale past 2400", () => {
  const fitted = outputSize([
    { x: 0, y: 0 },
    { x: 1000, y: 0 },
    { x: 1000, y: 600 },
    { x: 0, y: 600 },
  ]);
  assert.equal(fitted.width, 1000);
  assert.ok(Math.abs(fitted.width / fitted.height - CARD_ASPECT) < 0.02);
  const capped = outputSize([
    { x: 0, y: 0 },
    { x: 3000, y: 0 },
    { x: 3000, y: 1200 },
    { x: 0, y: 1200 },
  ]);
  assert.equal(capped.width, 2400);
});


test("analysis covers the entire inner card even with a 4K source", () => {
  const a = detailWindow({x:100,y:100,width:740,height:466});
  const b = detailWindow({x:200,y:200,width:1480,height:932});
  assert.equal(b.width, a.width * 2);
  assert.equal(b.height, a.height * 2);
  assert.ok(detailSize(b).width <= 660);
});


test("a centered trapezoid passes without matching guide corners", () => {
  const inner={x:0.1,y:0.1,width:0.8,height:0.8};
  const trapezoid=[{x:0.25,y:0.18},{x:0.75,y:0.12},{x:0.88,y:0.88},{x:0.12,y:0.82}];
  assert.equal(quadMatchesGuide(trapezoid,inner),true);
  assert.equal(quadMatchesGuide([trapezoid[0],trapezoid[2],trapezoid[1],trapezoid[3]],inner),false);
  assert.equal(quadMatchesGuide(trapezoid.map(p=>({x:p.x+0.2,y:p.y})),inner),false);
  assert.equal(quadMatchesGuide(trapezoid.map(p=>({x:0.5+(p.x-0.5)*0.25,y:p.y})),inner),false);
});

test('a smaller off-center card and a larger card can pass the reference guide', () => {
  const inner={x:0.2,y:0.2,width:0.6,height:0.6};
  const smaller=[{x:0.50,y:0.32},{x:0.86,y:0.32},{x:0.86,y:0.68},{x:0.50,y:0.68}];
  assert.equal(quadMatchesGuide(smaller,inner),true);
  const larger=[{x:0.14,y:0.14},{x:0.86,y:0.14},{x:0.86,y:0.86},{x:0.14,y:0.86}];
  assert.equal(quadMatchesGuide(larger,inner),true);
  assert.equal(quadMatchesGuide(smaller.map(p=>({x:0.5+(p.x-0.68)*0.5,y:0.5+(p.y-0.5)*0.5})),inner),false);
});

test('motion is measured relative to the card size rather than the search window', () => {
  const big=[{x:0.2,y:0.2},{x:0.8,y:0.2},{x:0.8,y:0.8},{x:0.2,y:0.8}];
  const small=big.map(p=>({x:0.5+(p.x-0.5)*0.5,y:0.5+(p.y-0.5)*0.5}));
  const bigMotion=quadMotion(big,big.map(p=>({x:p.x+0.01,y:p.y})))!;
  const smallMotion=quadMotion(small,small.map(p=>({x:p.x+0.005,y:p.y})))!;
  assert.ok(Math.abs(bigMotion-smallMotion)<1e-6);
});
