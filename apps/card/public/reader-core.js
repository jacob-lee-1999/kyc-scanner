// Reads the card number, expiry date and activation number off the camera's view
// of the guide (readFrame); no card outline is found first. The worker calls this;
// tests call it too.
// Fields are told apart by their shape, not by where a design prints them:
// 16 digits, MM/YY, 12 digits.
//
// The glyph steps (otsu, lineInk, components, segment, glyph) have a Python twin in
// training/reader.py that cuts the training glyphs; change both together.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.readerCore = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  const GLYPH = 24;
  // A card filling the frame at this size has digits (about 3-4mm tall) 35-45px
  // tall, inside the 16-46px the model was trained on.
  const CARD_W = 1000;
  const CARD_H = Math.round(CARD_W / (85.6 / 53.98));
  // A card held more slanted than this in the guide is not straightened.
  const MAX_SKEW = (20 * Math.PI) / 180;

  function otsu(gray) {
    const hist = new Float64Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    let sumAll = 0;
    for (let t = 0; t < 256; t++) sumAll += t * hist[t];
    let best = -1, bestT = 0, w0 = 0, sum0 = 0;
    for (let t = 0; t < 256; t++) {
      w0 += hist[t];
      sum0 += t * hist[t];
      const w1 = gray.length - w0;
      if (w0 === 0 || w1 === 0) continue;
      const m0 = sum0 / w0;
      const m1 = (sumAll - sum0) / w1;
      const between = w0 * w1 * (m0 - m1) ** 2;
      if (between > best) {
        best = between;
        bestT = t;
      }
    }
    return bestT;
  }

  // Ink of a line crop in 0..1, text = 1. The text is the smaller of the two Otsu
  // classes, so light print on a dark card works too. Null without contrast.
  function lineInk(gray) {
    const t = otsu(gray);
    let nDark = 0, sumDark = 0, sumLight = 0;
    for (let i = 0; i < gray.length; i++) {
      if (gray[i] <= t) { nDark++; sumDark += gray[i]; } else sumLight += gray[i];
    }
    if (nDark === 0 || nDark === gray.length) return null;
    const darkMean = sumDark / nDark;
    const lightMean = sumLight / (gray.length - nDark);
    const [fg, bg] = nDark * 2 <= gray.length ? [darkMean, lightMean] : [lightMean, darkMean];
    if (Math.abs(bg - fg) < 20) return null;
    const ink = new Float64Array(gray.length);
    for (let i = 0; i < gray.length; i++) ink[i] = Math.min(1, Math.max(0, (bg - gray[i]) / (bg - fg)));
    return ink;
  }

  // 8-connected blobs as [x, y, w, h, area], in order of first pixel (row major).
  // `label` gets each pixel's blob number, from 1.
  function components(mask, w, h, label = new Int32Array(w * h)) {
    const boxes = [];
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || label[start]) continue;
      const n = boxes.length + 1;
      label[start] = n;
      const stack = [start];
      let x0 = start % w, x1 = x0, y0 = (start / w) | 0, y1 = y0, area = 0;
      while (stack.length) {
        const i = stack.pop();
        const x = i % w, y = (i / w) | 0;
        area++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (mask[j] && !label[j]) { label[j] = n; stack.push(j); }
          }
        }
      }
      boxes.push([x0, y0, x1 - x0 + 1, y1 - y0 + 1, area]);
    }
    return boxes;
  }

  // Character boxes [x, y, w, h] left to right, and the character height.
  function segment(ink, w, h) {
    const mask = new Uint8Array(ink.length);
    for (let i = 0; i < ink.length; i++) mask[i] = ink[i] >= 0.5 ? 1 : 0;
    const boxes = components(mask, w, h).filter((b) => b[4] >= 4).map((b) => b.slice(0, 4));
    boxes.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    // Pieces of one character (a broken stroke, the parts of a Hangul syllable)
    // overlap across; join them.
    const merged = [];
    for (const b of boxes) {
      const m = merged[merged.length - 1];
      if (m) {
        const overlap = Math.min(m[0] + m[2], b[0] + b[2]) - Math.max(m[0], b[0]);
        if (overlap >= 0.5 * Math.min(m[2], b[2])) {
          const x0 = Math.min(m[0], b[0]), y0 = Math.min(m[1], b[1]);
          const x1 = Math.max(m[0] + m[2], b[0] + b[2]), y1 = Math.max(m[1] + m[3], b[1] + b[3]);
          merged[merged.length - 1] = [x0, y0, x1 - x0, y1 - y0];
          continue;
        }
      }
      merged.push(b.slice());
    }
    const tall = merged.filter((b) => b[3] >= 0.4 * h).map((b) => b[3]).sort((a, b) => a - b);
    if (!tall.length) return { chars: [], hc: 0 };
    const hc = tall[Math.floor(tall.length / 2)];
    // Touching characters are cut into even parts one digit wide: the median width
    // of the line's single digits (fonts differ, a tipped card squeezes or stretches
    // them), or Arial's 0.72 of the height when the line has too few. A 1 is no
    // digit width, so narrow boxes do not count.
    const singles = merged
      .filter((b) => b[3] >= 0.6 * hc && b[3] <= 1.35 * hc && b[2] >= 0.45 * hc && b[2] <= 1.1 * hc)
      .map((b) => b[2]).sort((a, b) => a - b);
    const pitch = singles.length >= 3 ? Math.min(0.95 * hc, Math.max(0.55 * hc, singles[Math.floor(singles.length / 2)])) : 0.72 * hc;
    const chars = [];
    for (const b of merged) {
      if (b[3] < 0.6 * hc || b[3] > 1.35 * hc) continue;
      if (b[2] > 1.1 * hc) {
        const n = Math.max(2, Math.round(b[2] / pitch));
        for (let i = 0; i < n; i++) chars.push([b[0] + (b[2] * i) / n, b[1], b[2] / n, b[3]]);
      } else chars.push(b);
    }
    return { chars, hc };
  }

  // GLYPH x GLYPH ink of a box, scaled by its longer side, aspect kept. Only ink
  // inside the box counts: in tightly set numbers the neighbours touch.
  // Each output pixel averages 3x3 bilinear samples.
  function glyph(ink, cols, rows, box) {
    const [x, y, w, h] = box;
    const side = Math.max(w, h) * 1.2;
    const cx = x + w / 2, cy = y + h / 2;
    const x0 = Math.max(0, Math.floor(x)), x1 = Math.min(cols - 1, Math.ceil(x + w) - 1);
    const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(rows - 1, Math.ceil(y + h) - 1);
    const at = (px, py) => (px < x0 || px > x1 || py < y0 || py > y1 ? 0 : ink[py * cols + px]);
    const n = GLYPH * 3;
    const offs = new Float64Array(n);
    for (let j = 0; j < GLYPH; j++) for (let a = 0; a < 3; a++) offs[j * 3 + a] = ((j + (a + 0.5) / 3) * side) / GLYPH - side / 2;
    const out = new Float32Array(GLYPH * GLYPH);
    for (let sy = 0; sy < n; sy++) {
      const gy = cy + offs[sy] - 0.5;
      const y0 = Math.floor(gy), fy = gy - y0;
      for (let sx = 0; sx < n; sx++) {
        const gx = cx + offs[sx] - 0.5;
        const x0 = Math.floor(gx), fx = gx - x0;
        const v = at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) +
          at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
        out[((sy / 3) | 0) * GLYPH + ((sx / 3) | 0)] += v / 9;
      }
    }
    return out;
  }

  // int8 weights back to floats, once per model.
  const loaded = new WeakMap();
  function weights(model) {
    let w = loaded.get(model);
    if (w) return w;
    const bytes = typeof atob === "function"
      ? Uint8Array.from(atob(model.data), (c) => c.charCodeAt(0))
      : new Uint8Array(Buffer.from(model.data, "base64"));
    const raw = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
    w = {};
    for (const t of model.tensors) {
      if (t.bias) { w[t.name] = Float32Array.from(t.bias); continue; }
      const size = t.shape.reduce((a, b) => a * b, 1);
      const out = new Float32Array(size);
      for (let i = 0; i < size; i++) out[i] = raw[t.offset + i] * t.scale;
      w[t.name] = out;
    }
    loaded.set(model, w);
    return w;
  }

  // 3x3 convolution, zero padding, ReLU. The input is copied into a padded grid
  // so the inner loops need no edge checks.
  function conv3(input, c, size, weight, bias) {
    const n = bias.length;
    const p = size + 2;
    const padded = new Float32Array(c * p * p);
    for (let i = 0; i < c; i++) {
      for (let y = 0; y < size; y++) padded.set(input.subarray((i * size + y) * size, (i * size + y + 1) * size), (i * p + y + 1) * p + 1);
    }
    const result = new Float32Array(n * size * size);
    for (let o = 0; o < n; o++) {
      const out = result.subarray(o * size * size, (o + 1) * size * size);
      out.fill(bias[o]);
      for (let i = 0; i < c; i++) {
        const k = ((o * c + i) * 3) * 3;
        const w0 = weight[k], w1 = weight[k + 1], w2 = weight[k + 2];
        const w3 = weight[k + 3], w4 = weight[k + 4], w5 = weight[k + 5];
        const w6 = weight[k + 6], w7 = weight[k + 7], w8 = weight[k + 8];
        const base = i * p * p;
        for (let y = 0; y < size; y++) {
          const r0 = base + y * p, r1 = r0 + p, r2 = r1 + p;
          const row = y * size;
          for (let x = 0; x < size; x++) {
            out[row + x] += padded[r0 + x] * w0 + padded[r0 + x + 1] * w1 + padded[r0 + x + 2] * w2 +
              padded[r1 + x] * w3 + padded[r1 + x + 1] * w4 + padded[r1 + x + 2] * w5 +
              padded[r2 + x] * w6 + padded[r2 + x + 1] * w7 + padded[r2 + x + 2] * w8;
          }
        }
      }
      for (let j = 0; j < out.length; j++) if (out[j] < 0) out[j] = 0;
    }
    return result;
  }

  function pool2(input, c, size) {
    const half = size >> 1;
    const out = new Float32Array(c * half * half);
    for (let i = 0; i < c; i++) {
      for (let y = 0; y < half; y++) {
        for (let x = 0; x < half; x++) {
          const at = (dy, dx) => input[(i * size + 2 * y + dy) * size + 2 * x + dx];
          out[(i * half + y) * half + x] = Math.max(at(0, 0), at(0, 1), at(1, 0), at(1, 1));
        }
      }
    }
    return out;
  }

  function linear(input, weight, bias, relu) {
    const n = bias.length;
    const out = new Float32Array(n);
    for (let o = 0; o < n; o++) {
      let s = bias[o];
      for (let i = 0; i < input.length; i++) s += input[i] * weight[o * input.length + i];
      out[o] = relu && s < 0 ? 0 : s;
    }
    return out;
  }

  // The layers of build() in training/train.py; returns class probabilities.
  function runModel(model, input) {
    const w = weights(model);
    let x = pool2(conv3(input, 1, GLYPH, w["0.weight"], w["0.bias"]), 8, GLYPH);
    x = pool2(conv3(x, 8, GLYPH / 2, w["3.weight"], w["3.bias"]), 16, GLYPH / 2);
    x = linear(x, w["7.weight"], w["7.bias"], true);
    const logits = linear(x, w["9.weight"], w["9.bias"], false);
    const max = Math.max(...logits);
    const exp = Array.from(logits, (v) => Math.exp(v - max));
    const total = exp.reduce((a, b) => a + b, 0);
    return exp.map((v) => v / total);
  }

  // Characters of one line crop, left to right, with the model's best guess.
  // A line of fewer than 5 characters holds no field (MM/YY is the shortest), so
  // the model is not run on it.
  function readLine(model, gray, w, h) {
    const ink = lineInk(gray);
    if (!ink) return [];
    const { chars, hc } = segment(ink, w, h);
    if (chars.length < 5) return [];
    return chars.map((box) => {
      const probs = runModel(model, glyph(ink, w, h, box));
      let best = 0;
      for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
      return { box, hc, label: model.classes[best], p: probs[best] };
    });
  }

  // Runs of digits and slashes on a line. Anything else, or a gap wider than
  // one and a half characters, ends a run; spaces inside a number do not.
  // A run set right against a character that is not a digit (closer than a word
  // space) is part of something longer, often a number with one digit misread,
  // so it is dropped: its tail could pass for a shorter field.
  function runsOf(chars) {
    const runs = [];
    let current = null;
    let last = null;
    const touching = (a, b) => b.box[0] - (a.box[0] + a.box[2]) <= 0.35 * b.hc;
    for (const c of chars) {
      if (c.label === "other") {
        if (current && touching(last, c)) current.broken = true;
        current = null;
      } else if (current && c.box[0] - current.end <= 1.5 * c.hc) {
        current.text += c.label;
        current.p = Math.min(current.p, c.p);
      } else {
        current = { text: c.label, p: c.p, broken: last != null && last.label === "other" && touching(last, c) };
        runs.push(current);
      }
      if (current) current.end = c.box[0] + c.box[2];
      last = c;
    }
    return runs.filter((r) => !r.broken).map(({ text, p, end }) => ({ text, p, end }));
  }

  // Card numbers end in a Luhn check digit (payment card numbering); one misread
  // digit breaks it.
  function luhn(digits) {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
    }
    return sum % 10 === 0;
  }

  const FIELDS = {
    card: { test: (text) => /^\d{16}$/.test(text) && luhn(text) },
    expiry: /^(0[1-9]|1[0-2])\/\d{2}$/,
    activation: /^\d{12}$/,
  };

  // The most confident run of each field's shape.
  function fieldsOf(runs) {
    const out = { card: null, expiry: null, activation: null };
    for (const run of runs) {
      for (const [name, shape] of Object.entries(FIELDS)) {
        if (shape.test(run.text) && (!out[name] || run.p > out[name].p)) out[name] = { value: run.text, p: run.p };
      }
    }
    return out;
  }

  // Clears connected pieces of a mask taller than `limit`: the card's own edges,
  // panel borders and background texture, which would join lines of print next to
  // them into one blob.
  function dropTall(mask, w, h, limit) {
    const label = new Int32Array(w * h);
    const tall = components(mask, w, h, label).map((b) => b[3] > limit);
    for (let i = 0; i < mask.length; i++) if (label[i] && tall[label[i] - 1]) mask[i] = 0;
  }

  // Outlines of print: strong horizontal gradients joined across about one
  // character gap, as in the passport zone finder of apps/web. Each is a flat
  // array of x, y points.
  function strokeBlobs(cv, image) {
    const src = new cv.Mat(image.height, image.width, cv.CV_8UC4);
    src.data.set(image.data);
    const gray = new cv.Mat();
    const gx = new cv.Mat();
    const strokes = new cv.Mat();
    const joined = new cv.Mat();
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.round(image.width * 0.02), 1));
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    const blobs = [];
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.Sobel(gray, gx, cv.CV_16S, 1, 0, 3);
      cv.convertScaleAbs(gx, strokes);
      cv.threshold(strokes, strokes, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      dropTall(strokes.data, image.width, image.height, Math.round(image.height * 0.12));
      cv.dilate(strokes, joined, kernel);
      cv.findContours(joined, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        blobs.push(Int32Array.from(cnt.data32S));
        cnt.delete();
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
    return blobs;
  }

  // Slant of the print in radians, from the long axis of line-shaped blobs,
  // weighted by length. 0 when nothing looks like a line.
  function skewOf(cv, image) {
    let sum = 0, weight = 0;
    for (const pts of strokeBlobs(cv, image)) {
      const n = pts.length / 2;
      let mx = 0, my = 0;
      for (let k = 0; k < pts.length; k += 2) { mx += pts[k]; my += pts[k + 1]; }
      mx /= n; my /= n;
      let xx = 0, yy = 0, xy = 0;
      for (let k = 0; k < pts.length; k += 2) {
        const dx = pts[k] - mx, dy = pts[k + 1] - my;
        xx += dx * dx; yy += dy * dy; xy += dx * dy;
      }
      const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
      const spread = Math.sqrt((xx + yy) / n);
      const long = Math.sqrt(Math.max(0, (xx + yy) / 2 + Math.sqrt(((xx - yy) / 2) ** 2 + xy * xy)) / n);
      const short = Math.sqrt(Math.max(0, (xx + yy) / 2 - Math.sqrt(((xx - yy) / 2) ** 2 + xy * xy)) / n);
      if (long < 4 * short || spread < image.width * 0.1 || Math.abs(angle) > MAX_SKEW) continue;
      sum += angle * long;
      weight += long;
    }
    return weight ? sum / weight : 0;
  }

  // Boxes around lines of print.
  function findLines(cv, image) {
    const lines = [];
    for (const pts of strokeBlobs(cv, image)) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < pts.length; k += 2) {
        x0 = Math.min(x0, pts[k]); x1 = Math.max(x1, pts[k]);
        y0 = Math.min(y0, pts[k + 1]); y1 = Math.max(y1, pts[k + 1]);
      }
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      if (h < image.height * 0.025 || h > image.height * 0.12 || w < h * 1.5) continue;
      lines.push({ x0, y0, x1, y1 });
    }
    // One line of print can come out as two boxes, cut through a character;
    // boxes side by side on the same row are one line.
    for (let merged = true; merged;) {
      merged = false;
      for (let i = 0; i < lines.length && !merged; i++) {
        for (let j = i + 1; j < lines.length && !merged; j++) {
          const a = lines[i], b = lines[j];
          const h = Math.min(a.y1 - a.y0, b.y1 - b.y0) + 1;
          const rows = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
          const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
          if (rows >= 0.6 * h && gap <= 0) {
            lines[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
            lines.splice(j, 1);
            merged = true;
          }
        }
      }
    }
    // Room around the print for the ink threshold to see the card too.
    return lines.map(({ x0, y0, x1, y1 }) => {
      const h = y1 - y0 + 1;
      const padY = Math.round(h * 0.25), padX = Math.round(h * 0.5);
      const x = Math.max(0, x0 - padX), y = Math.max(0, y0 - padY);
      return { x, y, width: Math.min(image.width, x1 + 1 + padX) - x, height: Math.min(image.height, y1 + 1 + padY) - y };
    });
  }

  function grayOf(image) {
    const out = new Uint8Array(image.width * image.height);
    for (let i = 0; i < out.length; i++) {
      const d = image.data;
      out[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
    }
    return out;
  }

  // A line crop with its slant taken out. A card tipped toward the camera leans its
  // print, and a leaning 0 reads as the letter O. The shear kept is the one whose
  // ink falls in the sharpest columns (largest sum of squared column totals).
  const SHEARS = [-0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4];
  function upright(gray, w, h) {
    const ink = lineInk(gray);
    if (!ink) return gray;
    const sheared = (values, k) => {
      const out = new Float64Array(w * h);
      for (let y = 0; y < h; y++) {
        const shift = k * (y - h / 2);
        for (let x = 0; x < w; x++) {
          const sx = x + shift, x0 = Math.floor(sx), f = sx - x0;
          const a = x0 >= 0 && x0 < w ? values[y * w + x0] : values[y * w + Math.min(w - 1, Math.max(0, x0))];
          const b = x0 + 1 >= 0 && x0 + 1 < w ? values[y * w + x0 + 1] : a;
          out[y * w + x] = a * (1 - f) + b * f;
        }
      }
      return out;
    };
    let best = 0, bestScore = -1;
    for (const k of SHEARS) {
      const columns = new Float64Array(w);
      const moved = k ? sheared(ink, k) : ink;
      for (let i = 0; i < moved.length; i++) columns[i % w] += moved[i];
      const score = columns.reduce((sum, c) => sum + c * c, 0);
      if (score > bestScore) { bestScore = score; best = k; }
    }
    return best ? Uint8Array.from(sheared(gray, best), Math.round) : gray;
  }

  function readUpright(cv, model, card) {
    const gray = grayOf(card);
    const runs = [];
    for (const line of findLines(cv, card)) {
      const crop = new Uint8Array(line.width * line.height);
      for (let y = 0; y < line.height; y++) {
        const from = (line.y + y) * card.width + line.x;
        crop.set(gray.subarray(from, from + line.width), y * line.width);
      }
      runs.push(...runsOf(readLine(model, upright(crop, line.width, line.height), line.width, line.height)));
    }
    return fieldsOf(runs);
  }

  function rotate180(image) {
    const data = new Uint8Array(image.data.length);
    const n = image.width * image.height;
    for (let i = 0; i < n; i++) data.set(image.data.subarray(i * 4, i * 4 + 4), (n - 1 - i) * 4);
    return { width: image.width, height: image.height, data };
  }

  const found = (fields) => Object.values(fields).filter(Boolean).length;

  // `image` turned by `angle` radians about its centre, same size; the edges
  // repeat outward so no dark border looks like print.
  function rotate(cv, image, angle) {
    const cx = image.width / 2, cy = image.height / 2;
    const c = Math.cos(angle), s = Math.sin(angle);
    const corners = [[0, 0], [image.width, 0], [image.width, image.height], [0, image.height]];
    const turned = corners.flatMap(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
    const src = new cv.Mat(image.height, image.width, cv.CV_8UC4);
    src.data.set(image.data);
    const from = cv.matFromArray(4, 1, cv.CV_32FC2, corners.flat());
    const to = cv.matFromArray(4, 1, cv.CV_32FC2, turned);
    const m = cv.getPerspectiveTransform(from, to);
    const out = new cv.Mat();
    try {
      cv.warpPerspective(src, out, m, new cv.Size(image.width, image.height), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
      return { width: image.width, height: image.height, data: new Uint8Array(out.data) };
    } finally {
      out.delete();
      m.delete();
      to.delete();
      from.delete();
      src.delete();
    }
  }

  // `card` is level print, the card about filling it. A card held upside down
  // reads no field, and is read again turned around.
  function readCard(cv, model, card) {
    const upright = readUpright(cv, model, card);
    if (found(upright) > 0) return upright;
    return readUpright(cv, model, rotate180(card));
  }

  // `image` is the camera's view of the guide, about CARD_W wide, the card roughly
  // in it and maybe slanted; no card outline is needed. The print is turned level first.
  function readFrame(cv, model, image) {
    const angle = skewOf(cv, image);
    return readCard(cv, model, Math.abs(angle) < 0.005 ? image : rotate(cv, image, -angle));
  }

  return { CARD_W, CARD_H, otsu, lineInk, components, segment, glyph, runModel, readLine, runsOf, fieldsOf, upright, readCard, readFrame };
});
