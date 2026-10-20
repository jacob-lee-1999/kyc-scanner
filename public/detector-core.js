// OpenCV pipeline for one scan frame. The worker calls this; tests call it too.
// Frames stay small so the camera preview never waits on this work.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.detectorCore = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  function release(mats) {
    for (let i = mats.length - 1; i >= 0; i--) {
      const mat = mats[i];
      if (mat && typeof mat.delete === "function") mat.delete();
    }
  }

  function rgbaMat(cv, image) {
    const mat = new cv.Mat(image.height, image.width, cv.CV_8UC4);
    mat.data.set(image.data);
    return mat;
  }

  function innerPixels(width, height, inner) {
    const x = Math.max(0, Math.round(inner.x * width));
    const y = Math.max(0, Math.round(inner.y * height));
    let w = Math.round(inner.width * width);
    let h = Math.round(inner.height * height);
    if (x + w > width) w = width - x;
    if (y + h > height) h = height - y;
    return { x, y, width: Math.max(1, w), height: Math.max(1, h) };
  }

  function clampBand(x, y, width, height, maxW, maxH) {
    let rx = Math.round(x);
    let ry = Math.round(y);
    let rw = Math.round(width);
    let rh = Math.round(height);
    if (rx < 0) {
      rw += rx;
      rx = 0;
    }
    if (ry < 0) {
      rh += ry;
      ry = 0;
    }
    if (rx + rw > maxW) rw = maxW - rx;
    if (ry + rh > maxH) rh = maxH - ry;
    if (rw < 1 || rh < 1) return null;
    return { x: rx, y: ry, width: rw, height: rh };
  }

  function meanBand(cv, mat, band) {
    if (!band) return 0;
    const roi = mat.roi(new cv.Rect(band.x, band.y, band.width, band.height));
    const mean = cv.mean(roi)[0];
    roi.delete();
    return mean;
  }

  function borderScore(cv, gray, inner) {
    const box = innerPixels(gray.cols, gray.rows, inner);
    const band = 4;
    const gx = new cv.Mat();
    const gy = new cv.Mat();
    const ax = new cv.Mat();
    const ay = new cv.Mat();
    cv.Sobel(gray, gx, cv.CV_16S, 1, 0, 3);
    cv.Sobel(gray, gy, cv.CV_16S, 0, 1, 3);
    cv.convertScaleAbs(gx, ax);
    cv.convertScaleAbs(gy, ay);
    const top = meanBand(cv, ay, clampBand(box.x, box.y - band, box.width, band * 2, gray.cols, gray.rows));
    const bottom = meanBand(
      cv,
      ay,
      clampBand(box.x, box.y + box.height - band, box.width, band * 2, gray.cols, gray.rows),
    );
    const left = meanBand(cv, ax, clampBand(box.x - band, box.y, band * 2, box.height, gray.cols, gray.rows));
    const right = meanBand(
      cv,
      ax,
      clampBand(box.x + box.width - band, box.y, band * 2, box.height, gray.cols, gray.rows),
    );
    gx.delete();
    gy.delete();
    ax.delete();
    ay.delete();
    return Math.min(top, bottom, left, right);
  }

  function glareOn(cv, gray, inner) {
    const box = innerPixels(gray.cols, gray.rows, inner);
    const roi = gray.roi(new cv.Rect(box.x, box.y, box.width, box.height));
    const luma = cv.mean(roi)[0];
    const mask = new cv.Mat();
    cv.threshold(roi, mask, 247, 255, cv.THRESH_BINARY);
    const glareRatio = cv.countNonZero(mask) / (roi.cols * roi.rows);
    // Isolated bright pixels are not glare. Require a connected saturated patch.
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let largest = 0;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      largest = Math.max(largest, cv.contourArea(contour));
      contour.delete();
    }
    const hotspot = largest >= Math.max(64, roi.cols * roi.rows * 0.002);
    contours.delete();
    hierarchy.delete();
    mask.delete();
    roi.delete();
    return { luma, glareRatio, hotspot };
  }

  function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  function orderPoints(pts) {
    const center = pts.reduce((c,p) => ({x:c.x+p.x/4,y:c.y+p.y/4}), {x:0,y:0});
    const sorted = pts.slice().sort((a,b) => Math.atan2(a.y-center.y,a.x-center.x)-Math.atan2(b.y-center.y,b.x-center.x));
    let first=0;
    for(let i=1;i<4;i++) if(sorted[i].x+sorted[i].y < sorted[first].x+sorted[first].y) first=i;
    return sorted.slice(first).concat(sorted.slice(0,first));
  }

  function quadAspect(pts) {
    const width = Math.max(dist(pts[0], pts[1]), dist(pts[3], pts[2]));
    const height = Math.max(dist(pts[0], pts[3]), dist(pts[1], pts[2]));
    if (height < 1) return null;
    return width / height;
  }

  function approxPoints(approx) {
    const pts = [];
    const data = approx.data32S;
    if (data && data.length >= approx.rows * 2) {
      for (let i = 0; i < approx.rows; i++) pts.push({ x: data[i * 2], y: data[i * 2 + 1] });
      return pts;
    }
    for (let i = 0; i < approx.rows; i++) pts.push({ x: approx.intAt(i, 0), y: approx.intAt(i, 1) });
    return pts;
  }

  function findQuad(cv, gray) {
    const blur = new cv.Mat();
    const edges = new cv.Mat();
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.Canny(blur, edges, 40, 120);
    cv.dilate(edges, edges, kernel);
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const frameArea = gray.rows * gray.cols;
    let best = null;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < frameArea * 0.3 || area > frameArea * 0.92) {
        cnt.delete();
        continue;
      }
      const peri = cv.arcLength(cnt, true);
      let chosen = null;
      for (let k = 0; k < 3; k++) {
        const eps = [0.02, 0.035, 0.05][k] * peri;
        const approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, eps, true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          chosen = approx;
          break;
        }
        approx.delete();
      }
      cnt.delete();
      if (!chosen) continue;
      const ordered = orderPoints(approxPoints(chosen));
      chosen.delete();
      const aspect = quadAspect(ordered);
      if (aspect == null || aspect < 0.9 || aspect > 2.7) continue;
      if (!best || area > best.area) {
        best = {
          area,
          aspect,
          quad: ordered.map((p) => ({ x: p.x / gray.cols, y: p.y / gray.rows })),
        };
      }
    }
    contours.delete();
    hierarchy.delete();
    kernel.delete();
    edges.delete();
    blur.delete();
    return best;
  }

  function sharpnessOf(cv, detail) {
    const src = rgbaMat(cv, detail);
    const gray = new cv.Mat();
    const lap = new cv.Mat();
    const mean = new cv.Mat();
    const std = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.Laplacian(gray, lap, cv.CV_64F);
    cv.meanStdDev(lap, mean, std);
    const value = std.doubleAt(0) * std.doubleAt(0);
    std.delete();
    mean.delete();
    lap.delete();
    gray.delete();
    src.delete();
    return value;
  }

  function analyzeFrame(cv, edge, detail, inner) {
    const src = rgbaMat(cv, edge);
    const gray = new cv.Mat();
    const detailSrc = rgbaMat(cv, detail);
    const detailGray = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.cvtColor(detailSrc, detailGray, cv.COLOR_RGBA2GRAY);
      const border = borderScore(cv, gray, inner);
      const cardGlare = glareOn(cv, gray, inner);
      // Text sample stays at camera resolution so a small reflection is not averaged away.
      const textGlare = glareOn(cv, detailGray, { x: 0, y: 0, width: 1, height: 1 });
      const found = findQuad(cv, gray);
      // Find detailed content in each horizontal band. A blank/privacy-covered
      // region must not dominate, but one sharp edge cannot approve the card.
      const rows = [];
      for (let row = 0; row < 3; row++) {
        const top = Math.floor(detail.height * row / 3);
        const bottom = Math.floor(detail.height * (row + 1) / 3);
        let best = 0;
        for (let col = 0; col < 3; col++) {
          const left = Math.floor(detail.width * col / 3);
          const right = Math.floor(detail.width * (col + 1) / 3);
          const width = right - left;
          const height = bottom - top;
          const data = new Uint8Array(width * height * 4);
          for (let y = 0; y < height; y++) {
            const offset = ((top + y) * detail.width + left) * 4;
            data.set(detail.data.subarray(offset, offset + width * 4), y * width * 4);
          }
          best = Math.max(best, sharpnessOf(cv, { width, height, data }));
        }
        rows.push(best);
      }
      const sharpness = rows.sort((a, b) => a - b)[1];
      return {
        sharpness,
        glareRatio: Math.max(cardGlare.glareRatio, textGlare.glareRatio),
        hotspot: cardGlare.hotspot || textGlare.hotspot,
        luma: cardGlare.luma,
        borderScore: border,
        quad: found ? found.quad : null,
        aspect: found ? found.aspect : null,
      };
    } finally {
      detailGray.delete();
      detailSrc.delete();
      gray.delete();
      src.delete();
    }
  }

  function warpCard(cv, image, corners, outWidth, outHeight) {
    const src = rgbaMat(cv, image);
    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      corners[0].x,
      corners[0].y,
      corners[1].x,
      corners[1].y,
      corners[2].x,
      corners[2].y,
      corners[3].x,
      corners[3].y,
    ]);
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0,
      0,
      outWidth,
      0,
      outWidth,
      outHeight,
      0,
      outHeight,
    ]);
    const transform = cv.getPerspectiveTransform(srcPts, dstPts);
    const dst = new cv.Mat();
    cv.warpPerspective(src, dst, transform, new cv.Size(outWidth, outHeight), cv.INTER_LINEAR);
    const width = dst.cols;
    const height = dst.rows;
    if (dst.channels() !== 4) {
      dst.delete();
      transform.delete();
      dstPts.delete();
      srcPts.delete();
      src.delete();
      throw new Error("expected RGBA");
    }
    const copy = new Uint8Array(width * height * 4);
    copy.set(dst.data.subarray(0, copy.length));
    dst.delete();
    transform.delete();
    dstPts.delete();
    srcPts.delete();
    src.delete();
    return { width, height, data: copy };
  }

  return { analyzeFrame, warpCard };
});
