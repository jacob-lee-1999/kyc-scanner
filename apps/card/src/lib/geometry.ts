export const CARD_ASPECT = 85.6 / 53.98;
// The frame read around the guide, as a fraction of its size on each side, so a
// card held a little larger than the guide is still whole.
export const READ_PAD = 0.15;

export type Rect = { x: number; y: number; width: number; height: number };
export type CoverMap = { scale: number; offsetX: number; offsetY: number };

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

export function analysisSource(
  guide: Rect,
  pad: number,
  videoW: number,
  videoH: number,
): Rect {
  return clampRect(
    {
      x: guide.x - guide.width * pad,
      y: guide.y - guide.height * pad,
      width: guide.width * (1 + 2 * pad),
      height: guide.height * (1 + 2 * pad),
    },
    { x: 0, y: 0, width: videoW, height: videoH },
  );
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

