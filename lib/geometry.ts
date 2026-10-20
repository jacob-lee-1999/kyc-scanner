export const CARD_ASPECT = 85.6 / 53.98;
export const GUIDE_PAD = 0.14;
export const EDGE_WIDTH = 480;
export const DETAIL_MAX_WIDTH = 960;
export const DETAIL_MAX_HEIGHT = 640;

export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };
export type CoverMap = { scale: number; offsetX: number; offsetY: number };

// Width of a portrait 9:16 preview on the main lens, in radians.
// A53 main lens: 5.23mm on a 7.42×5.56mm sensor, cropped to 9:16, about 44°.
export function guideWidthFraction(closestMeters: number | null): number {
  if (closestMeters == null || !(closestMeters > 0)) return 0.88;
  const angle = 2 * Math.atan(0.0856 / 2 / closestMeters);
  const fraction = (angle / 0.76) * 0.92;
  return Math.min(0.88, Math.max(0.5, fraction));
}

export function guideRect(viewW: number, viewH: number, widthFraction = 0.88): Rect {
  const maxW = Math.max(1, viewW * widthFraction);
  const maxH = Math.max(1, viewH * 0.46);
  let width = maxW;
  let height = width / CARD_ASPECT;
  if (height > maxH) {
    height = maxH;
    width = height * CARD_ASPECT;
  }
  return {
    x: (viewW - width) / 2,
    y: Math.max(0, (viewH - height) / 2 - viewH * 0.04),
    width,
    height,
  };
}

export function coverMap(stageW: number, stageH: number, videoW: number, videoH: number): CoverMap {
  const scale = Math.max(stageW / videoW, stageH / videoH);
  return {
    scale,
    offsetX: (stageW - videoW * scale) / 2,
    offsetY: (stageH - videoH * scale) / 2,
  };
}

export function stageRectToVideo(rect: Rect, map: CoverMap): Rect {
  return {
    x: (rect.x - map.offsetX) / map.scale,
    y: (rect.y - map.offsetY) / map.scale,
    width: rect.width / map.scale,
    height: rect.height / map.scale,
  };
}

export function clampRect(rect: Rect, bounds: Rect): Rect {
  let x = rect.x;
  let y = rect.y;
  let width = rect.width;
  let height = rect.height;
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  if (x < bounds.x) {
    width -= bounds.x - x;
    x = bounds.x;
  }
  if (y < bounds.y) {
    height -= bounds.y - y;
    y = bounds.y;
  }
  if (x + width > right) width = right - x;
  if (y + height > bottom) height = bottom - y;
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
}

export function relativeInner(guide: Rect, source: Rect): Rect {
  const x = (guide.x - source.x) / source.width;
  const y = (guide.y - source.y) / source.height;
  const right = x + guide.width / source.width;
  const bottom = y + guide.height / source.height;
  const left = Math.min(1, Math.max(0, x));
  const top = Math.min(1, Math.max(0, y));
  const clampedRight = Math.min(1, Math.max(0, right));
  const clampedBottom = Math.min(1, Math.max(0, bottom));
  return {
    x: left,
    y: top,
    width: Math.max(0, clampedRight - left),
    height: Math.max(0, clampedBottom - top),
  };
}

export function analysisSource(
  guide: Rect,
  pad: number,
  videoW: number,
  videoH: number,
): { source: Rect; inner: Rect } {
  const expanded = clampRect(
    {
      x: guide.x - guide.width * pad,
      y: guide.y - guide.height * pad,
      width: guide.width * (1 + 2 * pad),
      height: guide.height * (1 + 2 * pad),
    },
    { x: 0, y: 0, width: videoW, height: videoH },
  );
  return { source: expanded, inner: relativeInner(guide, expanded) };
}

export function drawable(rect: Rect, videoW: number, videoH: number): Rect | null {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(videoW, Math.floor(rect.x + rect.width));
  const bottom = Math.min(videoH, Math.floor(rect.y + rect.height));
  const width = right - x;
  const height = bottom - y;
  if (width < 4 || height < 4) return null;
  return { x, y, width, height };
}

export function edgeSize(source: Rect): { width: number; height: number } {
  return {
    width: EDGE_WIDTH,
    height: Math.max(1, Math.round(source.height * (EDGE_WIDTH / source.width))),
  };
}

// Sample the same fraction of the card at every camera resolution.
export function detailWindow(guide: Rect): Rect {
  return { x: guide.x + guide.width * 0.06, y: guide.y + guide.height * 0.09,
    width: guide.width * 0.88, height: guide.height * 0.82 };
}

export function detailSize(source: Rect) {
  const scale = Math.min(1, 660 / source.width, 440 / source.height);
  return { width: Math.max(3, Math.round(source.width * scale)), height: Math.max(3, Math.round(source.height * scale)) };
}

export function quadMatchesGuide(quad: Point[], inner: Rect, tol: number): boolean {
  if (quad.length !== 4 || inner.width <= 0 || inner.height <= 0) return false;
  if (quad.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x <= 0.01 || p.y <= 0.01 || p.x >= 0.99 || p.y >= 0.99)) return false;
  const points = quad.map(p => ({x:(p.x-inner.x)/inner.width,y:(p.y-inner.y)/inner.height}));
  const center = points.reduce((c,p)=>({x:c.x+p.x/4,y:c.y+p.y/4}),{x:0,y:0});
  if (Math.abs(center.x-0.5)>tol*1.5 || Math.abs(center.y-0.5)>tol*1.5) return false;
  let twiceArea = 0;
  const lengths: number[] = [];
  for(let i=0;i<4;i++) {
    const a=points[i], b=points[(i+1)%4], c=points[(i+2)%4];
    const ab={x:b.x-a.x,y:b.y-a.y}, bc={x:c.x-b.x,y:c.y-b.y};
    const length=Math.hypot(ab.x,ab.y), next=Math.hypot(bc.x,bc.y);
    // Convex, consistently ordered corners and no nearly collapsed angles.
    if (length<0.35 || (ab.x*bc.y-ab.y*bc.x)/(length*next)<0.3) return false;
    lengths.push(length);
    twiceArea+=a.x*b.y-a.y*b.x;
  }
  const area=twiceArea/2;
  const ratio=(a:number,b:number)=>Math.max(a,b)/Math.min(a,b);
  return area>=0.55 && area<=1.35 && ratio(lengths[0],lengths[2])<=2.3 && ratio(lengths[1],lengths[3])<=2.3;

}

export function quadMotion(prev: Point[] | null, next: Point[] | null): number | null {
  if (!prev || !next || prev.length !== 4 || next.length !== 4) return null;
  let total = 0;
  for (let i = 0; i < 4; i++) total += Math.hypot(prev[i].x - next[i].x, prev[i].y - next[i].y);
  return total / 4;
}

export function normalizedQuadToPixels(quad: Point[], source: Rect): Point[] {
  return quad.map((point) => ({
    x: point.x * source.width,
    y: point.y * source.height,
  }));
}

export function innerCorners(inner: Rect, source: Rect): Point[] {
  return [
    { x: inner.x * source.width, y: inner.y * source.height },
    { x: (inner.x + inner.width) * source.width, y: inner.y * source.height },
    {
      x: (inner.x + inner.width) * source.width,
      y: (inner.y + inner.height) * source.height,
    },
    { x: inner.x * source.width, y: (inner.y + inner.height) * source.height },
  ];
}

export function outputSize(corners: Point[]): { width: number; height: number } {
  const top = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
  const bottom = Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y);
  const width = Math.round(Math.min(2400, Math.max(1, Math.max(top, bottom))));
  return { width, height: Math.max(1, Math.round(width / CARD_ASPECT)) };
}
