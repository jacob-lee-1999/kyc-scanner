"""Python twin of the glyph steps in public/reader-core.js.

Training glyphs must be cut and scaled exactly as the app cuts them, so these
functions follow the JS line for line. tests/reader.test.mts checks the two
agree on fixtures written by fixtures.py.
"""

import numpy as np

GLYPH = 24
# Classes the model tells apart: digits, the slash of an expiry date, anything else.
CLASSES = list("0123456789/") + ["other"]


def otsu(gray: np.ndarray) -> int:
    """Threshold that best splits the histogram in two; pixels <= t are dark."""
    hist = np.bincount(gray.ravel(), minlength=256).astype(np.float64)
    total = gray.size
    sum_all = float(np.dot(np.arange(256), hist))
    best, best_t = -1.0, 0
    w0 = 0.0
    sum0 = 0.0
    for t in range(256):
        w0 += hist[t]
        sum0 += t * hist[t]
        w1 = total - w0
        if w0 == 0 or w1 == 0:
            continue
        m0 = sum0 / w0
        m1 = (sum_all - sum0) / w1
        between = w0 * w1 * (m0 - m1) ** 2
        if between > best:
            best, best_t = between, t
    return best_t


def line_ink(gray: np.ndarray):
    """Ink of a line crop in 0..1, text = 1. The text is the smaller of the two
    Otsu classes, so light print on a dark card works too. None without contrast."""
    t = otsu(gray)
    dark = gray <= t
    n_dark = int(dark.sum())
    if n_dark == 0 or n_dark == gray.size:
        return None
    dark_mean = float(gray[dark].sum()) / n_dark
    light_mean = float(gray[~dark].sum()) / (gray.size - n_dark)
    if n_dark * 2 <= gray.size:
        fg, bg = dark_mean, light_mean
    else:
        fg, bg = light_mean, dark_mean
    if abs(bg - fg) < 20:
        return None
    return np.clip((bg - gray.astype(np.float64)) / (bg - fg), 0, 1)


def components(mask: np.ndarray):
    """8-connected blobs as [x, y, w, h, area], in order of first pixel (row major)."""
    h, w = mask.shape
    label = np.zeros((h, w), dtype=np.int32)
    boxes = []
    ys, xs = np.nonzero(mask)
    for sy, sx in zip(ys.tolist(), xs.tolist()):
        if label[sy, sx]:
            continue
        n = len(boxes) + 1
        label[sy, sx] = n
        stack = [(sy, sx)]
        x0 = x1 = sx
        y0 = y1 = sy
        area = 0
        while stack:
            y, x = stack.pop()
            area += 1
            x0, x1, y0, y1 = min(x0, x), max(x1, x), min(y0, y), max(y1, y)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not label[ny, nx]:
                        label[ny, nx] = n
                        stack.append((ny, nx))
        boxes.append([x0, y0, x1 - x0 + 1, y1 - y0 + 1, area])
    return boxes


def segment(ink: np.ndarray):
    """Character boxes [x, y, w, h] left to right, and the character height."""
    boxes = [b[:4] for b in components(ink >= 0.5) if b[4] >= 4]
    boxes.sort(key=lambda b: (b[0], b[1]))
    # Pieces of one character (a broken stroke, the parts of a Hangul syllable)
    # overlap across; join them.
    merged = []
    for b in boxes:
        if merged:
            m = merged[-1]
            overlap = min(m[0] + m[2], b[0] + b[2]) - max(m[0], b[0])
            if overlap >= 0.5 * min(m[2], b[2]):
                x0, y0 = min(m[0], b[0]), min(m[1], b[1])
                x1, y1 = max(m[0] + m[2], b[0] + b[2]), max(m[1] + m[3], b[1] + b[3])
                merged[-1] = [x0, y0, x1 - x0, y1 - y0]
                continue
        merged.append(list(b))
    rows = ink.shape[0]
    tall = sorted(b[3] for b in merged if b[3] >= 0.4 * rows)
    if not tall:
        return [], 0
    hc = tall[len(tall) // 2]
    # Touching characters are cut into even parts one digit wide: the median width
    # of the line's single digits (fonts differ, a tipped card squeezes or stretches
    # them), or Arial's 0.72 of the height when the line has too few. A 1 is no
    # digit width, so narrow boxes do not count.
    singles = sorted(b[2] for b in merged if 0.6 * hc <= b[3] <= 1.35 * hc and 0.45 * hc <= b[2] <= 1.1 * hc)
    pitch = min(0.95 * hc, max(0.55 * hc, singles[len(singles) // 2])) if len(singles) >= 3 else 0.72 * hc
    chars = []
    for b in merged:
        if not (0.6 * hc <= b[3] <= 1.35 * hc):
            continue
        if b[2] > 1.1 * hc:
            # floor(x + 0.5): JS Math.round, not Python's round-half-to-even.
            n = max(2, int(np.floor(b[2] / pitch + 0.5)))
            for i in range(n):
                x0 = b[0] + b[2] * i / n
                chars.append([x0, b[1], b[2] / n, b[3]])
        else:
            chars.append(b)
    return chars, hc


def glyph(ink: np.ndarray, box) -> np.ndarray:
    """GLYPH x GLYPH ink of a box, scaled by its longer side, aspect kept. Only ink
    inside the box counts: in tightly set numbers the neighbours touch.
    Each output pixel averages 3x3 bilinear samples."""
    x, y, w, h = box
    side = max(w, h) * 1.2
    cx, cy = x + w / 2, y + h / 2
    rows, cols = ink.shape
    x0, x1 = max(0, int(np.floor(x))), min(cols - 1, int(np.ceil(x + w)) - 1)
    y0, y1 = max(0, int(np.floor(y))), min(rows - 1, int(np.ceil(y + h)) - 1)
    padded = np.zeros((rows + 2, cols + 2))
    padded[y0 + 1:y1 + 2, x0 + 1:x1 + 2] = ink[y0:y1 + 1, x0:x1 + 1]
    sub = (np.arange(3) + 0.5) / 3
    offs = (np.arange(GLYPH)[:, None] + sub[None, :]).ravel() * side / GLYPH - side / 2
    # Pixel centres sit at +0.5.
    sx = cx + offs - 0.5
    sy = cy + offs - 0.5
    gx, gy = np.meshgrid(sx, sy)

    def at(px, py):
        px = np.clip(px + 1, 0, cols + 1)
        py = np.clip(py + 1, 0, rows + 1)
        return padded[py, px]

    x0 = np.floor(gx).astype(int)
    y0 = np.floor(gy).astype(int)
    fx = gx - x0
    fy = gy - y0
    v = (at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy)
         + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy)
    return v.reshape(GLYPH, 3, GLYPH, 3).mean(axis=(1, 3))
