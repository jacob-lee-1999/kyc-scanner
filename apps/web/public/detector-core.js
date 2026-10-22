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

  function cross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  // Monotone chain; avoids adding convexHull to the trimmed OpenCV build.
  function convexHull(points) {
    const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    if (pts.length < 3) return pts;
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }

  function intersect(a, b, c, d) {
    const den = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
    if (Math.abs(den) < 1e-9) return null;
    const s = a.x * b.y - a.y * b.x;
    const t = c.x * d.y - c.y * d.x;
    return { x: (s * (c.x - d.x) - (a.x - b.x) * t) / den, y: (s * (c.y - d.y) - (a.y - b.y) * t) / den };
  }

  function convex(pts) {
    let sign = 0;
    for (let i = 0; i < pts.length; i++) {
      const c = cross(pts[i], pts[(i + 1) % pts.length], pts[(i + 2) % pts.length]);
      if (Math.abs(c) < 1e-9) return false;
      if (sign && Math.sign(c) !== sign) return false;
      sign = Math.sign(c);
    }
    return true;
  }

  function fitLine(points) {
    const n = points.length;
    if (n < 2) return null;
    const mx = points.reduce((s, p) => s + p.x, 0) / n;
    const my = points.reduce((s, p) => s + p.y, 0) / n;
    let xx = 0;
    let xy = 0;
    let yy = 0;
    for (const p of points) {
      xx += (p.x - mx) ** 2;
      xy += (p.x - mx) * (p.y - my);
      yy += (p.y - my) ** 2;
    }
    const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
    return { a: { x: mx, y: my }, b: { x: mx + Math.cos(angle), y: my + Math.sin(angle) } };
  }

  // Points every 2px along a closed polygon.
  function densify(poly) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const n = Math.max(1, Math.ceil(dist(a, b) / 2));
      for (let k = 0; k < n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
    }
    return out;
  }

  // Card corners are the intersections of the four longest hull sides, so a
  // rounded or broken corner (a short hull edge) does not pull a corner inward.
  function longestSides(cv, points, area, solid = true) {
    const hull = convexHull(points);
    if (hull.length < 4) return null;
    const mat = cv.matFromArray(hull.length, 1, cv.CV_32SC2, hull.flatMap((p) => [p.x, p.y]));
    const approx = new cv.Mat();
    const peri = cv.arcLength(mat, true);
    cv.approxPolyDP(mat, approx, 0.005 * peri, true);
    const pts = approxPoints(approx);
    approx.delete();
    mat.delete();
    // A finger or other object merged with the card makes the outline concave.
    if (solid && area < 0.9 * polygonArea(pts)) return null;
    const edges = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const last = edges[edges.length - 1];
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      if (last && Math.abs(Math.sin(angle - last.angle)) < 0.07) {
        last.b = b;
        last.length = dist(last.a, b);
      } else {
        edges.push({ a, b, angle, length: dist(a, b) });
      }
    }
    if (edges.length < 4) return null;
    const sides = edges
      .map((edge, index) => ({ ...edge, index }))
      .sort((x, y) => y.length - x.length)
      .slice(0, 4)
      .sort((x, y) => x.index - y.index);
    if (sides.reduce((sum, side) => sum + side.length, 0) < 0.75 * peri) return null;
    const quad = [];
    for (let i = 0; i < 4; i++) {
      const p = intersect(sides[i].a, sides[i].b, sides[(i + 1) % 4].a, sides[(i + 1) % 4].b);
      if (!p) return null;
      quad.push(p);
    }
    return convex(quad) ? quad : null;
  }

  // Coarse fallback: tape overhanging the edge splits hull sides into pieces,
  // but a coarse polygon still absorbs it.
  function coarseQuad(cv, cnt) {
    const peri = cv.arcLength(cnt, true);
    for (const k of [0.02, 0.035, 0.05]) {
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, k * peri, true);
      const pts = approx.rows === 4 && cv.isContourConvex(approx) ? approxPoints(approx) : null;
      approx.delete();
      if (pts) return pts;
    }
    return null;
  }

  // Refit each side to the outline along its middle: simplification can fold a
  // rounded corner into a side and tilt it, and bumps off the side are ignored.
  function refitQuad(quad, outline) {
    const lines = quad.map((a, i) => {
      const b = quad[(i + 1) % 4];
      const length = dist(a, b);
      const dx = (b.x - a.x) / length;
      const dy = (b.y - a.y) / length;
      const near = outline.filter((p) => {
        const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / length;
        const off = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx);
        return t > 0.15 && t < 0.85 && off < Math.max(3, length * 0.015);
      });
      return fitLine(near) ?? { a, b };
    });
    const out = [];
    for (let i = 0; i < 4; i++) {
      const p = intersect(lines[(i + 3) % 4].a, lines[(i + 3) % 4].b, lines[i].a, lines[i].b);
      if (!p) return null;
      out.push(p);
    }
    return convex(out) ? out : null;
  }

  function polygonArea(pts) {
    let sum = 0;
    for (let i = 0; i < pts.length; i++) sum += cross({ x: 0, y: 0 }, pts[i], pts[(i + 1) % pts.length]);
    return Math.abs(sum) / 2;
  }

  // Pixels that stand out from the surface, plus edges. On a surface close to the
  // card's colour (white paper) the outline breaks up, but the card's tint and
  // background print still set it apart. The surface colour comes from the
  // image border, which the guide keeps clear of the card.
  function cardRegion(cv, src, edges) {
    const W = src.cols;
    const H = src.rows;
    const b = src.data;
    const m = Math.max(2, Math.round(Math.min(W, H) * 0.04));
    // Median per channel from a histogram: sorting the border samples took longer.
    const counts = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    let samples = 0;
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        if (x >= m && y >= m && x < W - m && y < H - m) continue;
        const i = (y * W + x) * 4;
        for (let k = 0; k < 3; k++) counts[k][b[i + k]] += 1;
        samples += 1;
      }
    }
    const surface = counts.map((count) => {
      let seen = 0;
      for (let v = 0; v < 256; v++) if ((seen += count[v]) > samples / 2) return v;
      return 255;
    });
    const raw = new cv.Mat(H, W, cv.CV_8UC1);
    const d = raw.data;
    for (let i = 0; i < W * H; i++) {
      const r = b[i * 4] - surface[0];
      const g = b[i * 4 + 1] - surface[1];
      const u = b[i * 4 + 2] - surface[2];
      const l = (r + g + u) / 3;
      // A tint difference counts more than a brightness one, which lighting also causes.
      // Math.hypot is several times slower than sqrt in V8, and this runs per pixel.
      d[i] = Math.min(255, 4 * Math.sqrt((r - l) ** 2 + (g - l) ** 2 + (u - l) ** 2) + Math.abs(l));
    }
    // Blurring the one-channel difference instead of the colour image costs a quarter.
    const diff = new cv.Mat();
    cv.GaussianBlur(raw, diff, new cv.Size(9, 9), 0);
    raw.delete();
    const mask = new cv.Mat();
    const level = cv.threshold(diff, mask, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    diff.delete();
    // Nothing stands out from the surface: lens vignetting on an empty view
    // reaches about 20, a card on white paper about 38.
    if (level < 30) {
      mask.delete();
      return null;
    }
    const md = mask.data;
    const ed = edges.data;
    for (let i = 0; i < md.length; i++) if (ed[i]) md[i] = 255;
    return mask;
  }

  function regionContours(cv, region, mode) {
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(region, contours, hierarchy, cv.RETR_EXTERNAL, mode);
    hierarchy.delete();
    return contours;
  }

  // Fraction of each side of a quad that runs along detected edges (within 2px).
  function sideSupport(quad, edges) {
    const W = edges.cols;
    const H = edges.rows;
    const data = edges.data;
    const on = (x, y) => {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = Math.round(x) + dx;
          const yy = Math.round(y) + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H && data[yy * W + xx]) return true;
        }
      }
      return false;
    };
    return quad.map((a, i) => {
      const b = quad[(i + 1) % 4];
      const n = Math.max(1, Math.round(dist(a, b) / 2));
      let hits = 0;
      for (let k = 0; k <= n; k++) if (on(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n)) hits += 1;
      return hits / (n + 1);
    });
  }

  // Lines are free to combine, so a quad made of them must also look like a card
  // seen from roughly above: near right angles, matching opposite sides, card
  // proportions. A desk edge plus one card side makes a skewed quad instead.
  function cardShaped(quad, aspect) {
    if (aspect == null || aspect < 1.2 || aspect > 2.1) return false;
    const side = (i) => dist(quad[i], quad[(i + 1) % 4]);
    if (Math.min(side(0), side(2)) < 0.75 * Math.max(side(0), side(2))) return false;
    if (Math.min(side(1), side(3)) < 0.75 * Math.max(side(1), side(3))) return false;
    return quad.every((p, i) => {
      const a = quad[(i + 3) % 4];
      const b = quad[(i + 1) % 4];
      const cos = ((a.x - p.x) * (b.x - p.x) + (a.y - p.y) * (b.y - p.y)) / (dist(a, p) * dist(b, p));
      return Math.abs(cos) <= Math.cos((70 * Math.PI) / 180);
    });
  }

  // When the outline joined another line (a desk edge) or broke up: take straight
  // segments, merge those on one line, and pair roughly parallel lines into quads
  // that run along edges on every side.
  function lineQuads(cv, thin, edges) {
    const W = thin.cols;
    const H = thin.rows;
    const found = new cv.Mat();
    const minLength = Math.round(Math.min(W, H) * 0.15);
    cv.HoughLinesP(thin, found, 1, Math.PI / 180, 30, minLength, 12);
    const gap = (a, b) => {
      const d = Math.abs(a - b) % Math.PI;
      return Math.min(d, Math.PI - d);
    };
    const offsetOf = (p, angle) => -p.x * Math.sin(angle) + p.y * Math.cos(angle);
    const lines = [];
    const segments = [];
    for (let i = 0; i < found.rows; i++) {
      const [x1, y1, x2, y2] = found.data32S.slice(i * 4, i * 4 + 4);
      const angle = ((Math.atan2(y2 - y1, x2 - x1) % Math.PI) + Math.PI) % Math.PI;
      segments.push({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, angle, length: Math.hypot(x2 - x1, y2 - y1) });
    }
    found.delete();
    for (const seg of segments.sort((p, q) => q.length - p.length)) {
      const same = lines.find((l) => gap(l.angle, seg.angle) < 0.05 && Math.abs(offsetOf(seg.a, l.angle) - offsetOf(l.a, l.angle)) < 6);
      if (same) same.length += seg.length;
      else lines.push({ ...seg });
    }
    lines.sort((p, q) => q.length - p.length).splice(20);
    const pairs = [];
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const [p, q] = [lines[i], lines[j]];
        if (gap(p.angle, q.angle) < 0.2 && Math.abs(offsetOf(q.a, p.angle) - offsetOf(p.a, p.angle)) > minLength * 0.5) pairs.push([p, q]);
      }
    }
    const frameArea = W * H;
    const quads = [];
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const [p1, p2] = pairs[i];
        const [q1, q2] = pairs[j];
        if (gap(p1.angle, q1.angle) < 0.8) continue;
        const corners = [[p1, q1], [q1, p2], [p2, q2], [q2, p1]].map(([l, m]) => intersect(l.a, l.b, m.a, m.b));
        if (corners.some((c) => !c || c.x < -0.02 * W || c.y < -0.02 * H || c.x > 1.02 * W || c.y > 1.02 * H)) continue;
        const quad = orderPoints(corners);
        const area = polygonArea(quad);
        const aspect = quadAspect(quad);
        if (!convex(quad) || area < frameArea * 0.08 || area > frameArea * 0.92 || !cardShaped(quad, aspect)) continue;
        // Print inside the card (text lines, a photo frame) also makes supported
        // quads; quadScore ranks the card outline above them.
        if (Math.min(...sideSupport(quad, edges)) >= 0.6) quads.push({ quad, area });
      }
    }
    return quads;
  }

  // ID-1 cards (ISO/IEC 7810) and ID-3 passport data pages, in millimetres.
  const DOCS = { card: { w: 85.6, h: 53.98 }, passport: { w: 125, h: 88 } };
  const DOC_ASPECTS = Object.values(DOCS).map((doc) => doc.w / doc.h);

  // How well a quad fits a document outline: the colour step from just inside to
  // just outside each side (the weakest side counts, a grid square on a mat has
  // the same surface on both sides of its lines), closeness to a document
  // aspect, and size, so print inside the card does not outrank its outline.
  function quadScore(src, quad, aspect) {
    const W = src.cols;
    const H = src.rows;
    const d = src.data;
    const read = (x, y) => {
      const i = (Math.min(H - 1, Math.max(0, Math.round(y))) * W + Math.min(W - 1, Math.max(0, Math.round(x)))) * 4;
      return [d[i], d[i + 1], d[i + 2]];
    };
    const center = quad.reduce((c, p) => ({ x: c.x + p.x / 4, y: c.y + p.y / 4 }), { x: 0, y: 0 });
    const sides = quad.map((a, i) => {
      const b = quad[(i + 1) % 4];
      const length = dist(a, b);
      let nx = -(b.y - a.y) / length;
      let ny = (b.x - a.x) / length;
      if ((center.x - a.x) * nx + (center.y - a.y) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      const steps = [];
      for (let k = 0; k < 20; k++) {
        const t = 0.15 + (0.7 * k) / 19;
        const qx = a.x + (b.x - a.x) * t;
        const qy = a.y + (b.y - a.y) * t;
        const diff = [0, 0, 0];
        for (let s = 2; s <= 4; s++) {
          const inside = read(qx + nx * s, qy + ny * s);
          const outside = read(qx - nx * s, qy - ny * s);
          for (let c = 0; c < 3; c++) diff[c] += (inside[c] - outside[c]) / 3;
        }
        const l = (diff[0] + diff[1] + diff[2]) / 3;
        steps.push(Math.abs(l) + 2 * Math.hypot(diff[0] - l, diff[1] - l, diff[2] - l));
      }
      return median(steps);
    });
    const fit = Math.max(...DOC_ASPECTS.map((target) => Math.exp(-((Math.log(aspect / target) / 0.15) ** 2) / 2)));
    return Math.min(...sides) * Math.max(0.2, fit) * Math.sqrt(polygonArea(quad) / (W * H));
  }

  function quadOf(cv, cnt, area, solid = true) {
    const points = approxPoints(cnt);
    const quad = longestSides(cv, points, area, solid) ?? coarseQuad(cv, cnt);
    return quad && refitQuad(quad, densify(points));
  }

  const WEAK_SCORE = 10;

  function findQuad(cv, gray, src) {
    const blur = new cv.Mat();
    const thin = new cv.Mat();
    const edges = new cv.Mat();
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    // CLAHE lifts a faint outline, such as a card on white paper, enough for
    // Canny to close it.
    const clahe = new cv.CLAHE(4, new cv.Size(8, 8));
    const lifted = new cv.Mat();
    clahe.apply(gray, lifted);
    clahe.delete();
    cv.GaussianBlur(lifted, blur, new cv.Size(5, 5), 0);
    lifted.delete();
    cv.Canny(blur, thin, 40, 120);
    cv.dilate(thin, edges, kernel);
    const frameArea = gray.rows * gray.cols;
    let best = null;
    // Fallback quads (a hull, a colour region) are guesses and must look like a
    // card inside the view; a closed outline only needs a card-like aspect.
    const consider = (pts, area, guessed = false) => {
      if (!pts) return;
      const ordered = orderPoints(pts);
      const aspect = quadAspect(ordered);
      if (aspect == null || aspect < 0.9 || aspect > 2.7) return;
      if (guessed && (!cardShaped(ordered, aspect) || ordered.some((p) => p.x < -0.02 * gray.cols || p.y < -0.02 * gray.rows || p.x > 1.02 * gray.cols || p.y > 1.02 * gray.rows))) return;
      const score = quadScore(src, ordered, aspect);
      if (!best || score > best.score) {
        best = {
          area,
          score,
          aspect,
          quad: ordered.map((p) => ({ x: p.x / gray.cols, y: p.y / gray.rows })),
        };
      }
    };
    const scan = (map) => {
      // RETR_LIST: background grid lines touching the card merge with its outline,
      // leaving the card edge only as an inner contour.
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      cv.findContours(map, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);
        if (area >= frameArea * 0.08 && area <= frameArea * 0.92) {
          // Print near the edge can join a faint outline and dent it; then take the
          // hull, but only if all four sides really run along edges.
          const quad = quadOf(cv, cnt, area);
          if (quad) {
            consider(quad, area);
          } else {
            const hull = quadOf(cv, cnt, area, false);
            if (hull && Math.min(...sideSupport(hull, edges)) >= 0.6) consider(hull, area, true);
          }
        }
        cnt.delete();
      }
      hierarchy.delete();
      contours.delete();
    };
    // Thickened edges close small gaps in the outline; if that also joins the card
    // to a nearby line (a desk edge), the thin edges keep them apart.
    scan(edges);
    scan(thin);
    // The slower paths run while nothing fits well: a closed outline of a card
    // scores 30 and up, while a quad around texture or the view scores under 10.
    const weak = () => !best || best.score < WEAK_SCORE;
    if (weak()) {
      for (const found of lineQuads(cv, thin, edges)) consider(found.quad, found.area, true);
    }
    const region = weak() ? cardRegion(cv, src, edges) : null;
    if (region) {
      const blobs = regionContours(cv, region, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < blobs.size(); i++) {
        const cnt = blobs.get(i);
        const area = cv.contourArea(cnt);
        // Glare can wash out part of the card, so the region may be ragged; the
        // quad only needs to be close, refineQuad places it on the edge.
        if (area >= frameArea * 0.08 && area <= frameArea * 0.92) consider(quadOf(cv, cnt, area, false), area, true);
        cnt.delete();
      }
      blobs.delete();
      region.delete();
    }
    kernel.delete();
    edges.delete();
    thin.delete();
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

  function qualityMetrics(cv, edge, detail, inner) {
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
      };
    } finally {
      detailGray.delete();
      detailSrc.delete();
      gray.delete();
      src.delete();
    }
  }

  function detectQuad(cv, image) {
    const src = rgbaMat(cv, image);
    const gray = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      return findQuad(cv, gray, src);
    } finally {
      gray.delete();
      src.delete();
    }
  }

  function analyzeFrame(cv, edge, detail, inner) {
    const found = detectQuad(cv, edge);
    return { ...qualityMetrics(cv, edge, detail, inner),
      quad: found ? found.quad : null, aspect: found ? found.aspect : null };
  }

  // Cells of the warped card that a reflection washes out. Cells are in card
  // coordinates, so frames taken from slightly different angles can be compared.
  const GLARE_GRID = { w: 22, h: 14 };

  function glareCells(card) {
    const { width, height, data } = card;
    const hot = new Array(GLARE_GRID.w * GLARE_GRID.h).fill(0);
    const seen = new Array(hot.length).fill(0);
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const i = (y * width + x) * 4;
        const cell = Math.floor((x * GLARE_GRID.w) / width) + Math.floor((y * GLARE_GRID.h) / height) * GLARE_GRID.w;
        seen[cell] += 1;
        if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] >= 247) hot[cell] += 1;
      }
    }
    return hot.map((n, cell) => (n > seen[cell] * 0.02 ? 1 : 0));
  }

  // Replaces washed-out pixels of the sharpest capture with the darkest of the
  // same pixel in other captures warped to the same card. A reflection only adds
  // light, so the darkest value is the real print; every pixel is still a real
  // capture, nothing is painted in. Pixels away from glare stay untouched.
  function fuseGlare(base, extras) {
    const { width, height } = base;
    const data = new Uint8Array(base.data);
    if (!extras.length) return { width, height, data };
    const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    // Glare plus a halo around it, by running sums along rows then columns.
    const r = Math.max(2, Math.round(width * 0.004));
    const hot = new Uint8Array(width * height);
    for (let p = 0; p < hot.length; p++) if (lum(data, p * 4) >= 235) hot[p] = 1;
    const rows = new Uint8Array(hot.length);
    for (let y = 0; y < height; y++) {
      let n = 0;
      for (let x = -r; x < width; x++) {
        if (x + r < width && hot[y * width + x + r]) n += 1;
        if (x - r - 1 >= 0 && hot[y * width + x - r - 1]) n -= 1;
        if (x >= 0) rows[y * width + x] = n > 0 ? 1 : 0;
      }
    }
    for (let x = 0; x < width; x++) {
      let n = 0;
      for (let y = -r; y < height; y++) {
        if (y + r < height && rows[(y + r) * width + x]) n += 1;
        if (y - r - 1 >= 0 && rows[(y - r - 1) * width + x]) n -= 1;
        if (y < 0 || n === 0) continue;
        const i = (y * width + x) * 4;
        let best = lum(data, i);
        for (const extra of extras) {
          const value = lum(extra.data, i);
          if (value < best) {
            best = value;
            data[i] = extra.data[i];
            data[i + 1] = extra.data[i + 1];
            data[i + 2] = extra.data[i + 2];
          }
        }
      }
    }
    return { width, height, data };
  }

  // Moves each side of a coarse quad onto the card edge in a sharper image: where
  // the mean colour just outside differs most from the mean just inside. A faint
  // outline on white paper is still such a step in brightness or tint, while thin
  // background print inside the card averages out over the bands.
  function refineQuad(image, corners, reachFraction = 0.04, shiftFraction = 0.06) {
    const { data, width, height } = image;
    const at = (x, y) => (Math.min(height - 1, Math.max(0, Math.round(y))) * width + Math.min(width - 1, Math.max(0, Math.round(x)))) * 4;
    const center = corners.reduce((c, p) => ({ x: c.x + p.x / 4, y: c.y + p.y / 4 }), { x: 0, y: 0 });
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      const length = dist(a, b);
      if (length < 20) return corners;
      const tx = (b.x - a.x) / length;
      const ty = (b.y - a.y) / length;
      // Inward normal, toward the quad centre.
      let nx = -ty;
      let ny = tx;
      if ((center.x - a.x) * nx + (center.y - a.y) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      const reach = Math.max(6, Math.round(length * reachFraction));
      const depth = Math.max(2, Math.round(length * 0.006));
      const along = Math.max(3, Math.round(length * 0.02));
      const strip = new Float64Array((reach + depth) * 6 + 3);
      const found = [];
      for (let k = 0; k < 48; k++) {
        const t = 0.12 + (0.76 * k) / 47;
        const qx = a.x + (b.x - a.x) * t;
        const qy = a.y + (b.y - a.y) * t;
        // Mean colour of a short strip parallel to the side, at each offset. Flat
        // arrays and no Math.hypot: this loop was a slow step on a phone.
        const span = reach + depth;
        let n = 0;
        for (let w = -along; w <= along; w += 2) n += 1;
        for (let s = -span; s <= span; s++) {
          let r = 0;
          let g = 0;
          let u = 0;
          for (let w = -along; w <= along; w += 2) {
            const i = at(qx + nx * s + tx * w, qy + ny * s + ty * w);
            r += data[i];
            g += data[i + 1];
            u += data[i + 2];
          }
          const o = (s + span) * 3;
          strip[o] = r / n;
          strip[o + 1] = g / n;
          strip[o + 2] = u / n;
        }
        let best = { s: 0, score: -1 };
        for (let s = -reach; s <= reach; s++) {
          let d0 = 0;
          let d1 = 0;
          let d2 = 0;
          for (let j = 1; j <= depth; j++) {
            const inside = (s + j + span) * 3;
            const outside = (s - j + span) * 3;
            d0 += (strip[inside] - strip[outside]) / depth;
            d1 += (strip[inside + 1] - strip[outside + 1]) / depth;
            d2 += (strip[inside + 2] - strip[outside + 2]) / depth;
          }
          const l = (d0 + d1 + d2) / 3;
          const score = Math.abs(l) + 6 * Math.sqrt((d0 - l) ** 2 + (d1 - l) ** 2 + (d2 - l) ** 2);
          if (score > best.score) best = { s, score };
        }
        found.push({ x: qx + nx * best.s, y: qy + ny * best.s, score: best.score });
      }
      // Drop weak samples, then refit while discarding outliers.
      const strong = median(found.map((p) => p.score)) * 0.3;
      let kept = found.filter((p) => p.score >= strong);
      let line = null;
      for (let round = 0; round < 3 && kept.length >= 2; round++) {
        line = fitLine(kept);
        const ux = line.b.x - line.a.x;
        const uy = line.b.y - line.a.y;
        const off = (p) => Math.abs((p.x - line.a.x) * uy - (p.y - line.a.y) * ux);
        const spread = median(kept.map(off));
        kept = kept.filter((p) => off(p) <= Math.max(1, 2.5 * spread));
      }
      lines.push(kept.length >= found.length * 0.4 && line ? fitLine(kept) : { a, b });
    }
    const refined = [];
    for (let i = 0; i < 4; i++) {
      const p = intersect(lines[(i + 3) % 4].a, lines[(i + 3) % 4].b, lines[i].a, lines[i].b);
      if (!p || dist(p, corners[i]) > Math.max(9, dist(corners[i], corners[(i + 1) % 4]) * shiftFraction)) return corners;
      refined.push(p);
    }
    return convex(refined) ? refined : corners;
  }

  // Machine readable zone: two (passport, TD3) or three (ID card, TD1) long,
  // thin, parallel text lines of equal length. Characters are found as strong
  // horizontal gradients and joined along the line; nothing is read.
  // `docWidth` is a guess of the document width in pixels, to size the joining.
  function findMrz(cv, image, docWidth) {
    const src = rgbaMat(cv, image);
    const gray = new cv.Mat();
    const gx = new cv.Mat();
    const strokes = new cv.Mat();
    const joined = new cv.Mat();
    // About one character pitch (2.54mm on a 125mm page): bridges the gaps
    // between characters, not the gap between lines.
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(3, Math.round(docWidth * 0.02)), 1));
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    const lines = [];
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.Sobel(gray, gx, cv.CV_16S, 1, 0, 3);
      cv.convertScaleAbs(gx, strokes);
      cv.threshold(strokes, strokes, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.dilate(strokes, joined, kernel);
      cv.findContours(joined, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const pts = cnt.rows >= 20 ? approxPoints(cnt) : null;
        cnt.delete();
        if (!pts) continue;
        const axis = fitLine(pts);
        const ux = axis.b.x - axis.a.x;
        const uy = axis.b.y - axis.a.y;
        // Lines run roughly across the image; the guide keeps documents level.
        if (Math.abs(uy) > Math.abs(ux) * 0.45) continue;
        const along = pts.map((p) => (p.x - axis.a.x) * ux + (p.y - axis.a.y) * uy);
        const across = pts.map((p) => (p.x - axis.a.x) * -uy + (p.y - axis.a.y) * ux);
        const length = Math.max(...along) - Math.min(...along);
        const thickness = Math.max(...across) - Math.min(...across);
        if (length < docWidth * 0.5 || length < thickness * 12) continue;
        const sign = ux < 0 ? -1 : 1;
        const t0 = Math.min(...along);
        const t1 = Math.max(...along);
        const start = { x: axis.a.x + ux * t0, y: axis.a.y + uy * t0 };
        const end = { x: axis.a.x + ux * t1, y: axis.a.y + uy * t1 };
        lines.push({ left: sign > 0 ? start : end, right: sign > 0 ? end : start, length, angle: Math.atan2(uy * sign, ux * sign) });
      }
    } finally {
      hierarchy.delete();
      contours.delete();
      kernel.delete();
      joined.delete();
      strokes.delete();
      gx.delete();
      gray.delete();
      src.delete();
    }
    // Neighbouring lines of one zone: parallel, same length and start, and one
    // line pitch apart (6.3mm over 112mm of TD3, 4.2mm over 76mm of TD1).
    const mid = (l) => ({ x: (l.left.x + l.right.x) / 2, y: (l.left.y + l.right.y) / 2 });
    lines.sort((p, q) => mid(p).y - mid(q).y);
    const next = (p, q) => {
      const gap = dist(mid(p), mid(q)) / p.length;
      return Math.abs(p.angle - q.angle) < 0.07 && Math.min(p.length, q.length) > 0.85 * Math.max(p.length, q.length) &&
        dist(p.left, q.left) < 0.12 * p.length + gap * p.length && gap > 0.025 && gap < 0.09;
    };
    let best = null;
    for (let i = 0; i + 1 < lines.length; i++) {
      if (!next(lines[i], lines[i + 1])) continue;
      const zone = i + 2 < lines.length && next(lines[i + 1], lines[i + 2]) ? lines.slice(i, i + 3) : lines.slice(i, i + 2);
      if (!best || zone.length > best.length || (zone.length === best.length && zone[0].length > best[0].length)) best = zone;
    }
    if (!best) return null;
    return { type: best.length === 3 ? "TD1" : "TD3", lines: best };
  }

  // The passport page placed from its zone: in TD3 the lines run from about
  // 5.6mm to 117.8mm across the 125×88mm page, with centres 15.5mm and 9.2mm
  // above its bottom edge (measured on the MIDV-500 passport templates). The page
  // is taken to be upright: the zone below the rest of the page.
  function passportFromMrz(mrz) {
    const [top, bottom] = mrz.lines;
    const left = { x: (top.left.x + bottom.left.x) / 2, y: (top.left.y + bottom.left.y) / 2 };
    const right = { x: (top.right.x + bottom.right.x) / 2, y: (top.right.y + bottom.right.y) / 2 };
    const length = dist(left, right);
    const s = length / 112.2;
    const ux = (right.x - left.x) / length;
    const uy = (right.y - left.y) / length;
    // Down the page, perpendicular to the lines.
    const vx = -uy;
    const vy = ux;
    const at = (u, v) => ({ x: left.x + (ux * (u - 5.6) + vx * (v - (88 - 12.35))) * s, y: left.y + (uy * (u - 5.6) + vy * (v - (88 - 12.35))) * s });
    return [at(0, 0), at(125, 0), at(125, 88), at(0, 88)];
  }

  // Source and edge show the same search area at different resolutions.
  // Measure quality on the detected card, never on the reference guide/background.
  function analyzeScanFrame(cv, edge, source) {
    let found = detectQuad(cv, edge);
    // Downsampling can erase thin outlines or join them to background texture.
    // Retry only uncertain detections, using detail already sent to this worker.
    // Bound the extra work and compare both candidates at the same resolution.
    const scale = Math.min(1, 800 / source.width, 1000 / source.height);
    const retryWidth = Math.round(source.width * scale);
    const retryHeight = Math.round(source.height * scale);
    if ((!found || found.score < WEAK_SCORE) && retryWidth >= edge.width * 1.1) {
      const detail = scale === 1 ? source : warpCard(cv, source, [
        { x: 0, y: 0 }, { x: source.width - 1, y: 0 },
        { x: source.width - 1, y: source.height - 1 }, { x: 0, y: source.height - 1 },
      ], retryWidth, retryHeight);
      const retry = detectQuad(cv, detail);
      // Texture can form a contour around the entire image. It cannot be a
      // complete document and must not displace an existing card candidate.
      if (retry && retry.quad.every(p => p.x > 0.01 && p.y > 0.01 && p.x < 0.99 && p.y < 0.99)) {
        const score = (candidate) => quadScore(
          { cols: source.width, rows: source.height, data: source.data },
          candidate.quad.map(p => ({ x: p.x * source.width, y: p.y * source.height })),
          candidate.aspect,
        );
        if (!found || score(retry) > score(found)) found = retry;
      }
    }
    const pixels = { cols: source.width, rows: source.height, data: source.data };
    const fit = (quad) => ({ quad, score: quadScore(pixels, quad, quadAspect(quad)) });
    // The coarse quad comes from a small image; place it on the sharper source.
    // On a dark card on a dark mat the outline is faint and printing near the edge
    // pulls a side inward; then the coarse quad fits clearly better and stays.
    let corners = null;
    if (found) {
      const coarse = found.quad.map(p => ({ x: p.x * source.width, y: p.y * source.height }));
      const refined = refineQuad(source, coarse);
      corners = fit(refined).score * 1.25 >= fit(coarse).score ? refined : coarse;
    }
    const mrz = findMrz(cv, source, corners ? Math.max(dist(corners[0], corners[1]), dist(corners[3], corners[2])) : source.width * 0.55);
    // A passport zone places the page even where its outline is faint or joins
    // the other page; the better fitting of the two quads wins.
    if (mrz && mrz.type === "TD3") {
      const page = orderPoints(passportFromMrz(mrz));
      const inView = page.every((p) => p.x > -0.02 * source.width && p.y > -0.02 * source.height && p.x < 1.02 * source.width && p.y < 1.02 * source.height);
      if (inView) {
        // The page is placed as if facing the camera. On a tilted page a wide pass
        // first moves its sides onto the edges, but it can also catch the photo
        // edge on an upright one; the better fitting placement counts.
        const narrow = fit(refineQuad(source, page));
        const wide = fit(refineQuad(source, refineQuad(source, page, 0.12, 0.24)));
        const placed = wide.score > narrow.score ? wide : narrow;
        // Below 2 the placed page has no outline under it: on MIDV-500 that was
        // text on paper around a card, while most passport pages scored above 2.5.
        if (placed.score >= 2 && (!corners || placed.score > fit(corners).score)) corners = placed.quad;
      }
    }
    if (!corners) return { sharpness: 0, glareRatio: 0, hotspot: false,
      luma: 0, borderScore: 0, quad: null, aspect: null, glare: null, mrz: null };
    // Text lines on the surface around a card, or a two-line title on the card
    // itself, can look like a zone; only lines across the bottom of the document count.
    const lineDist = (a, b, p) => cross(a, b, p) / dist(a, b);
    const low = (p) => {
      const fromTop = lineDist(corners[0], corners[1], p);
      const fromBottom = lineDist(corners[2], corners[3], p);
      return Math.sign(fromTop) === Math.sign(fromBottom) && fromTop / (fromTop + fromBottom) > 0.6 &&
        Math.sign(lineDist(corners[1], corners[2], p)) === Math.sign(fromTop) && Math.sign(lineDist(corners[3], corners[0], p)) === Math.sign(fromTop);
    };
    const zone = mrz && mrz.lines.every((l) => low({ x: (l.left.x + l.right.x) / 2, y: (l.left.y + l.right.y) / 2 })) ? mrz.type : null;
    const quad = corners.map(p => ({ x: p.x / source.width, y: p.y / source.height }));
    const doc = zone === "TD3" ? DOCS.passport : DOCS.card;
    const width =Math.max(32, Math.min(660, Math.floor(Math.max(dist(corners[0], corners[1]), dist(corners[3], corners[2])))));
    const card = warpCard(cv, source, corners, width, Math.round(width / (doc.w / doc.h)));
    const x = Math.round(card.width * 0.06), y = Math.round(card.height * 0.09);
    const w = card.width - x * 2, h = card.height - y * 2;
    const data = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) {
      const offset = ((row + y) * card.width + x) * 4;
      data.set(card.data.subarray(offset, offset + w * 4), row * w * 4);
    }
    return { ...qualityMetrics(cv, card, {width:w,height:h,data}, {x:0,y:0,width:1,height:1}),
      quad, aspect: quadAspect(corners), glare: glareCells(card), mrz: zone };
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

  const CORNER_R = 3.18;

  // Initial values from synthetic fixtures only. Calibrate with scripts/damage-eval.mts.
  const DAMAGE = {
    outlineMin: 6,
    croppedColour: 25,
    cornerSupport: 0.35,
    cornerGapMm: 3,
    anomaly: 30,
    tapeAnomaly: 12,
    holeMinMm: 4.5,
    holeMaxMm: 12,
    holeRound: 0.8,
    holeFlat: 8,
    holeSurface: 35,
    stepMm: 0.45,
    stepFlatMm: 0.15,
    edgeMin: 8,
    seamGrad: 10,
    seamCover: 0.8,
    seamContrast: 2.5,
    seamMinMm: 40,
  };

  function median(values) {
    if (!values.length) return NaN;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  // Judges a captured card warped with `margin` of real background on each side.
  // Works on edges rather than colour so a card on a same-coloured surface still
  // shows its outline through the shadow of its thickness. A passport page is only
  // checked for its outline: the damage rules assume a card.
  function inspectDamage(cv, captured, margin, kind = "card") {
    const CARD_W = DOCS[kind].w;
    const CARD_H = DOCS[kind].h;
    let img = captured;
    // About 8px per millimetre: enough for a 2mm chip, and fast on a mid-range phone.
    if (img.width > 800) {
      const w = img.width;
      const h = img.height;
      img = warpCard(cv, img, [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], 800, Math.round(h * 800 / w));
    }
    const W = img.width;
    const H = img.height;
    const f = margin / (1 + 2 * margin);
    const guess = { x0: W * f, y0: H * f, x1: W * (1 - f), y1: H * (1 - f) };
    const src = rgbaMat(cv, img);
    const gray = new cv.Mat();
    const blurred = new cv.Mat();
    const edges = new cv.Mat();
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    const shapes = [];
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);
      cv.Canny(blurred, edges, 30, 90);
      cv.dilate(edges, edges, kernel);
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        shapes.push({ area: cv.contourArea(cnt), peri: cv.arcLength(cnt, true), points: approxPoints(cnt) });
        cnt.delete();
      }
    } finally {
      hierarchy.delete();
      contours.delete();
      kernel.delete();
      edges.delete();
      gray.delete();
      src.delete();
    }
    const lum = blurred.data.slice();
    blurred.delete();
    const at = (p) => {
      const x = Math.min(W - 1, Math.max(0, Math.round(p.x)));
      const y = Math.min(H - 1, Math.max(0, Math.round(p.y)));
      return lum[y * W + x];
    };
    const color = (p) => {
      const i = (Math.round(p.y) * W + Math.round(p.x)) * 4;
      return [img.data[i], img.data[i + 1], img.data[i + 2]];
    };
    const inImage = (p) => p.x >= 0 && p.y >= 0 && p.x <= W - 1 && p.y <= H - 1;

    // The capture is framed on the refined card edge, so the card sits within
    // about a millimetre of where the margin puts it; a wider search would catch
    // tape overhanging the edge.
    const framed = [
      { x: guess.x0, y: guess.y0 },
      { x: guess.x1, y: guess.y0 },
      { x: guess.x1, y: guess.y1 },
      { x: guess.x0, y: guess.y1 },
    ];
    // Card millimetres to image pixels for the card at these corners.
    let toPx;
    let mm;
    const placeCard = ([tl, tr, , bl]) => {
      const ex = { x: tr.x - tl.x, y: tr.y - tl.y };
      const ey = { x: bl.x - tl.x, y: bl.y - tl.y };
      toPx = (u, v) => ({ x: tl.x + ex.x * u / CARD_W + ey.x * v / CARD_H, y: tl.y + ex.y * u / CARD_W + ey.y * v / CARD_H });
      mm = dist(tl, tr) / CARD_W;
    };
    placeCard(refineQuad(img, framed, 0.012));
    const colourAt = (p) => color({ x: Math.min(W - 1, Math.max(0, p.x)), y: Math.min(H - 1, Math.max(0, p.y)) });

    // Colour step from card to surface across the expected outline at (u, v),
    // with (nu, nv) pointing out of the card. Brightness and tint both count, so
    // a card on white paper still shows a step; half a millimetre of slack.
    const edgeStep = (u, v, nu, nv) => {
      let best = 0;
      for (let s = -0.5; s <= 0.5; s += 0.25) {
        const d = [0, 0, 0];
        for (let k = 0.3; k <= 1.2; k += 0.3) {
          const inside = colourAt(toPx(u + nu * (s - k), v + nv * (s - k)));
          const outside = colourAt(toPx(u + nu * (s + k), v + nv * (s + k)));
          for (let c = 0; c < 3; c++) d[c] += (inside[c] - outside[c]) / 4;
        }
        const l = (d[0] + d[1] + d[2]) / 3;
        best = Math.max(best, Math.abs(l) + 2 * Math.hypot(d[0] - l, d[1] - l, d[2] - l));
      }
      return best;
    };
    // How strong the card edge is along the middle of each side.
    const sideEdges = () => [[0, -1], [1, 0], [0, 1], [-1, 0]].map(([nu, nv]) => {
      const steps = [];
      const length = nu === 0 ? CARD_W : CARD_H;
      for (let t = length * 0.2; t <= length * 0.8; t += 1) {
        const u = nu === 0 ? t : nu > 0 ? CARD_W : 0;
        const v = nv === 0 ? t : nv > 0 ? CARD_H : 0;
        steps.push(edgeStep(u, v, nu, nv));
      }
      return median(steps);
    });
    const sideEdge = sideEdges();
    let edge = median(sideEdge);
    // A side without its edge: the card is not where the capture framed it (cropped).
    if (Math.min(...sideEdge) < DAMAGE.outlineMin) return { damage: null, outline: false, edge: sideEdge };
    const marginU = margin * CARD_W;
    const marginV = margin * CARD_H;

    // Median colour of a margin patch; a finger or tape changes it, a thin
    // background grid line does not.
    const patch = (u0, u1, v0, v1) => {
      const r = [];
      const g = [];
      const b = [];
      for (let u = u0; u <= u1; u += 0.3) {
        for (let v = v0; v <= v1; v += 0.3) {
          const p = toPx(u, v);
          if (!inImage(p)) continue;
          const c = color(p);
          r.push(c[0]);
          g.push(c[1]);
          b.push(c[2]);
        }
      }
      return r.length ? [median(r), median(g), median(b)] : null;
    };
    const patches = [];
    const addPatch = (side, u, v, box) => {
      const c = patch(...box);
      if (c) patches.push({ side, u, v, c });
    };
    const inU = [0.8 - marginU, -0.8];
    const inV = [0.8 - marginV, -0.8];
    for (let u = 4; u <= CARD_W - 4; u += 4) {
      addPatch(0, u, 0, [u - 4, u + 4, inV[0], inV[1]]);
      addPatch(2, u, CARD_H, [u - 4, u + 4, CARD_H - inV[1], CARD_H - inV[0]]);
    }
    for (let v = 4; v <= CARD_H - 4; v += 4) {
      addPatch(3, v, 0, [inU[0], inU[1], v - 4, v + 4]);
      addPatch(1, v, CARD_W, [CARD_W - inU[1], CARD_W - inU[0], v - 4, v + 4]);
    }
    const cornersMm = [{ u: 0, v: 0 }, { u: CARD_W, v: 0 }, { u: CARD_W, v: CARD_H }, { u: 0, v: CARD_H }];
    cornersMm.forEach((c, i) => {
      const us = c.u === 0 ? inU : [CARD_W - inU[1], CARD_W - inU[0]];
      const vs = c.v === 0 ? inV : [CARD_H - inV[1], CARD_H - inV[0]];
      addPatch(-1 - i, 0, 0, [us[0], us[1], vs[0], vs[1]]);
    });
    const base = [0, 1, 2].map((k) => median(patches.map((p) => p.c[k])));
    const off = (c, ref) => Math.hypot(c[0] - ref[0], c[1] - ref[1], c[2] - ref[2]);
    for (const p of patches) p.anomaly = off(p.c, base);
    // Tape is compared with the rest of its own side, so a smooth lighting
    // gradient across the surface does not look like tape.
    for (let s = 0; s < 4; s++) {
      const own = patches.filter((p) => p.side === s);
      const ref = [0, 1, 2].map((k) => median(own.map((p) => p.c[k])));
      for (const p of own) p.local = off(p.c, ref);
    }
    const patchMm = (p) => (p.side < 0 ? cornersMm[-1 - p.side] : p.side === 0 || p.side === 2 ? { u: p.u, v: p.v } : { u: p.v, v: p.u });

    const cardSamples = [];
    for (let u = 4; u < CARD_W - 4; u += 2) {
      for (let v = 4; v < CARD_H - 4; v += 2) {
        const p = toPx(u, v);
        if (inImage(p)) cardSamples.push(color(p));
      }
    }
    const cardColour = [0, 1, 2].map((k) => median(cardSamples.map((c) => c[k])));
    // The image border is surface on every side of a well framed capture; a side
    // whose border has the card's colour, unlike the other three, cut the card off.
    const strip = Math.max(2, Math.round(W * 0.012));
    const borderColour = [(x, y) => y < strip, (x, y) => x >= W - strip, (x, y) => y >= H - strip, (x, y) => x < strip].map((onBorder) => {
      const samples = [];
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (onBorder(x, y)) samples.push(color({ x, y }));
      return [0, 1, 2].map((k) => median(samples.map((c) => c[k])));
    });
    const cropped = borderColour.some((c, i) => {
      const others = borderColour.filter((_, j) => j !== i);
      const rest = [0, 1, 2].map((k) => median(others.map((o) => o[k])));
      return off(c, cardColour) < DAMAGE.croppedColour && off(c, rest) >= DAMAGE.croppedColour;
    });
    if (cropped) return { damage: null, outline: false, edge, cropped };
    if (kind === "passport") return { damage: null, outline: true, edge };

    // 1. Corners: follow the expected rounded outline 12mm around each corner.
    // Where a piece is missing there is surface on both sides of it, so no step.
    const cornerGaps = () => cornersMm.map((c) => {
      const su = c.u === 0 ? 1 : -1;
      const sv = c.v === 0 ? 1 : -1;
      const path = [];
      for (let t = 12; t >= CORNER_R; t -= 0.25) path.push([c.u + su * t, c.v, 0, -sv]);
      for (let a = 0; a <= Math.PI / 2; a += 0.25 / CORNER_R) {
        const nu = -su * Math.cos(Math.PI / 2 - a);
        const nv = -sv * Math.sin(Math.PI / 2 - a);
        path.push([c.u + su * CORNER_R + nu * CORNER_R, c.v + sv * CORNER_R + nv * CORNER_R, nu, nv]);
      }
      for (let t = CORNER_R; t <= 12; t += 0.25) path.push([c.u, c.v + sv * t, -su, 0]);
      let run = 0;
      let longest = 0;
      for (const [u, v, nu, nv] of path) {
        run = edgeStep(u, v, nu, nv) < edge * DAMAGE.cornerSupport ? run + 0.25 : 0;
        longest = Math.max(longest, run);
      }
      return longest;
    });
    let cornerGap = cornerGaps();
    // A gap may only mean the live quad framed the card off by more than the
    // narrow search (seen: 5mm). Search across the whole margin once; a real break
    // leaves the sides where they are, so its gap stays. Kept narrow otherwise:
    // tape overhang can pull a wide fit.
    if (cornerGap.some((g) => g >= DAMAGE.cornerGapMm)) {
      const narrow = { toPx, mm, edge };
      placeCard(refineQuad(img, framed, 0.09));
      edge = median(sideEdges());
      const wide = cornerGaps();
      if (wide.every((g) => g < DAMAGE.cornerGapMm)) cornerGap = wide;
      else ({ toPx, mm, edge } = narrow);
    }
    const cornerAnomaly = cornersMm.map((c) => Math.max(0, ...patches.filter((p) => {
      const q = patchMm(p);
      return Math.hypot(q.u - c.u, q.v - c.v) < 14;
    }).map((p) => p.anomaly)));

    // 2. Holes: a round closed edge inside the card through which the surface
    // shows. Dark print such as hair in the photo differs from the surface. When
    // the surface is the card's own colour that test says nothing, so the inside
    // must also be plain.
    const surfaceLikeCard = off(cardColour, base) < DAMAGE.anomaly;
    const holes = [];
    const lo = toPx(2, 2);
    const hi = toPx(CARD_W - 2, CARD_H - 2);
    for (const s of shapes) {
      const d = 2 * Math.sqrt(s.area / Math.PI) / mm;
      if (d < DAMAGE.holeMinMm || d > DAMAGE.holeMaxMm) continue;
      if (s.points.some((p) => p.x < lo.x || p.y < lo.y || p.x > hi.x || p.y > hi.y)) continue;
      const round = 4 * Math.PI * s.area / (s.peri * s.peri);
      if (round < DAMAGE.holeRound) continue;
      const cx = s.points.reduce((sum, p) => sum + p.x, 0) / s.points.length;
      const cy = s.points.reduce((sum, p) => sum + p.y, 0) / s.points.length;
      const r = d * mm / 2;
      const inside = [];
      const insideColour = [];
      for (let y = -r * 0.6; y <= r * 0.6; y += 1) {
        for (let x = -r * 0.6; x <= r * 0.6; x += 1) {
          const p = { x: cx + x, y: cy + y };
          if (Math.hypot(x, y) >= r * 0.6 || !inImage(p)) continue;
          inside.push(at(p));
          insideColour.push(color(p));
        }
      }
      const mean = inside.reduce((a, b) => a + b, 0) / inside.length;
      const flat = Math.sqrt(inside.reduce((a, b) => a + (b - mean) ** 2, 0) / inside.length);
      const surface = off([0, 1, 2].map((k) => median(insideColour.map((c) => c[k]))), base);
      holes.push({ d, round, flat, surface });
    }
    const hole = holes.find((h) => h.surface <= DAMAGE.holeSurface && (!surfaceLikeCard || h.flat <= DAMAGE.holeFlat));

    // 3. Split and taped: seam ends on the outline (a step where the halves are
    // misaligned, or tape overhanging into the margin) joined by an edge line
    // across the card. A narrow edge gap is not used: a grid line crossing the
    // card edge looks the same.
    const SIDES = [
      { from: (t) => ({ u: t, v: 0 }), n: { u: 0, v: 1 }, len: CARD_W },
      { from: (t) => ({ u: CARD_W, v: t }), n: { u: -1, v: 0 }, len: CARD_H },
      { from: (t) => ({ u: t, v: CARD_H }), n: { u: 0, v: -1 }, len: CARD_W },
      { from: (t) => ({ u: 0, v: t }), n: { u: 1, v: 0 }, len: CARD_H },
    ];
    const ends = [];
    SIDES.forEach((side, s) => {
      const samples = [];
      for (let t = 6; t <= side.len - 6; t += 0.5) {
        const o = side.from(t);
        let best = { off: 0, mag: -1 };
        for (let off = -1.5; off <= 1.5; off += 1 / mm) {
          const p = toPx(o.u + side.n.u * off, o.v + side.n.v * off);
          const before = toPx(o.u + side.n.u * (off - 1 / mm), o.v + side.n.v * (off - 1 / mm));
          const after = toPx(o.u + side.n.u * (off + 1 / mm), o.v + side.n.v * (off + 1 / mm));
          if (!inImage(p)) continue;
          const mag = Math.abs(at(after) - at(before));
          if (mag > best.mag) best = { off, mag };
        }
        samples.push(best);
      }
      // A real step has a straight run on both sides; a faint edge that wanders
      // between print and noise does not.
      const w = 6;
      const spread = (offs) => {
        const m = median(offs);
        return median(offs.map((o) => Math.abs(o - m)));
      };
      for (let i = w; i < samples.length - w; i++) {
        // Where the outline fades out there is no edge position to compare.
        if (samples.slice(i - w, i + 1 + w).some((p) => p.mag < DAMAGE.edgeMin)) continue;
        const left = samples.slice(i - w, i).map((p) => p.off);
        const right = samples.slice(i + 1, i + 1 + w).map((p) => p.off);
        if (Math.abs(median(left) - median(right)) < DAMAGE.stepMm) continue;
        if (spread(left) > DAMAGE.stepFlatMm || spread(right) > DAMAGE.stepFlatMm) continue;
        ends.push({ side: s, t: 6 + i * 0.5, why: "step" });
      }
    });
    // Tape is wider than one 8mm patch, so a lone odd patch is not tape.
    for (const p of patches) {
      if (p.side < 0 || p.local < DAMAGE.tapeAnomaly) continue;
      const wide = patches.some((q) => q.side === p.side && Math.abs(q.u - p.u) === 4 && q.local >= DAMAGE.tapeAnomaly);
      if (wide) ends.push({ side: p.side, t: p.u, why: "tape" });
    }
    let seam = { cover: 0 };
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        if (ends[i].side === ends[j].side) continue;
        const a = SIDES[ends[i].side].from(ends[i].t);
        const b = SIDES[ends[j].side].from(ends[j].t);
        const length = Math.hypot(b.u - a.u, b.v - a.v);
        // A card split in half has a seam across it, not a short cut over a corner.
        if (length < DAMAGE.seamMinMm) continue;
        const nu = -(b.v - a.v) / length;
        const nv = (b.u - a.u) / length;
        let hits = 0;
        let total = 0;
        for (let k = 2; k <= length - 2; k += 0.5) {
          const u = a.u + (b.u - a.u) * k / length;
          const v = a.v + (b.v - a.v) * k / length;
          const grad = (off) => Math.abs(at(toPx(u + nu * (off + 1 / mm), v + nv * (off + 1 / mm))) - at(toPx(u + nu * (off - 1 / mm), v + nv * (off - 1 / mm))));
          let peak = 0;
          for (let off = -1; off <= 1; off += 1 / mm) peak = Math.max(peak, grad(off));
          // The seam must stand out from the card's fine background print beside it.
          const texture = median([-2.75, -2.25, -1.75, 1.75, 2.25, 2.75].map(grad));
          total += 1;
          if (peak >= DAMAGE.seamGrad && peak >= DAMAGE.seamContrast * texture) hits += 1;
        }
        const cover = total ? hits / total : 0;
        if (cover > seam.cover) seam = { cover, from: ends[i], to: ends[j] };
      }
    }

    const metrics = { outline: true, edge, cornerGap, cornerAnomaly, holes, seam, ends: ends.length };
    const broken = cornerGap.findIndex((m) => m >= DAMAGE.cornerGapMm);
    if (broken >= 0 && cornerAnomaly[broken] >= DAMAGE.anomaly) return { damage: "covered", ...metrics };
    if (broken >= 0) return { damage: "corner", ...metrics };
    if (hole) return { damage: "hole", ...metrics };
    if (seam.cover >= DAMAGE.seamCover) return { damage: "split", ...metrics };
    return { damage: null, ...metrics };
  }

  return { analyzeFrame, analyzeScanFrame, warpCard, detectQuad, refineQuad, inspectDamage, glareCells, fuseGlare, findMrz };
});
