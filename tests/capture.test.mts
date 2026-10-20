import test from 'node:test';
import assert from 'node:assert/strict';
import { paddedCapture, preferCandidate } from '../lib/capture.ts';

const card = [{x:100,y:100},{x:900,y:100},{x:900,y:600},{x:100,y:600}];
test('capture keeps six percent real background on all four sides', () => {
  const crop = paddedCapture(card, 1100, 800)!;
  assert.ok(crop);
  const expanded = crop.corners.map(p => ({x:p.x+crop.source.x,y:p.y+crop.source.y}));
  assert.deepEqual(expanded, [{x:52,y:70},{x:948,y:70},{x:948,y:630},{x:52,y:630}]);
  assert.equal(crop.size.width, 896);
});
test('rejects cards without room for actual background and invalid corners', () => {
  assert.equal(paddedCapture(card.map(p=>({x:p.x-100,y:p.y})),1100,800), null);
  assert.equal(paddedCapture([{x:NaN,y:0},...card.slice(1)],1100,800), null);
  assert.equal(paddedCapture(Array(4).fill({x:100,y:100}),1100,800), null);
});
test('perspective margin remains outside every original card edge', () => {
  const tilted = [{x:200,y:200},{x:850,y:150},{x:900,y:600},{x:150,y:650}];
  const crop = paddedCapture(tilted,1100,800)!;
  assert.ok(crop);
  const q=crop.corners.map(p=>({x:p.x+crop.source.x,y:p.y+crop.source.y}));
  for(let i=0;i<4;i++) for(const p of tilted) {
    const a=q[i], b=q[(i+1)%4];
    assert.ok((b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x)>0);
  }
});
test('keeps the sharpest recent candidate, replaces expired candidates', () => {
  assert.equal(preferCandidate(null,300,100),true);
  assert.equal(preferCandidate({score:300,at:100},200,300),false);
  assert.equal(preferCandidate({score:300,at:100},400,300),true);
  assert.equal(preferCandidate({score:300,at:100},200,1400),true);
  assert.equal(preferCandidate(null,NaN,100),false);
});
