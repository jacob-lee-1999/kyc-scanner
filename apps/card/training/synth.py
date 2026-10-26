"""Synthetic printed lines, cut into glyphs the way the app cuts them.

A line of Arial digits (with spaces, a slash, letters or Hangul now and then) is
drawn on a textured background, blurred, shrunk, noised and JPEG-compressed like a
phone capture, then cut by reader.segment. Each cut box takes the label of the
character it covers; boxes over two characters are dropped.

    uv run python synth.py <count> <out.npz>
"""

import io
import random
import sys
from glob import glob
from multiprocessing import Pool

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import reader

FONT_DIR = "/System/Library/Fonts/Supplemental"
FONTS = sorted(glob(f"{FONT_DIR}/Arial*.ttf"))
# Hangul labels (e.g. 유효기간) only come in Arial Unicode.
HANGUL_FONT = f"{FONT_DIR}/Arial Unicode.ttf"
# No O, o, D or Q: seen foreshortened, a 0 is as wide as they are. A real O stands
# among other letters, and digits set against a letter are dropped (runsOf).
LETTERS = "ABCEFGHIJKLMNPRSTUVWXYZabcdefghijklmnpqrstuvwxyz"
HANGUL = "유효기간카드번호활성화일월년만료사용"
OTHER = reader.CLASSES.index("other")


def text_for(rng: random.Random) -> str:
    if rng.random() < 0.15:
        # Runs of one digit, e.g. leading zeros, touch the most.
        return rng.choice("0123456789") * rng.randint(3, 6) + "".join(rng.choice("0123456789") for _ in range(rng.randint(0, 6)))
    out = []
    for _ in range(rng.randint(4, 12)):
        r = rng.random()
        if r < 0.62:
            out.append(rng.choice("0123456789"))
        elif r < 0.72:
            out.append(" ")
        elif r < 0.78:
            out.append("/")
        elif r < 0.92:
            out.append(rng.choice(LETTERS))
        else:
            out.append(rng.choice(HANGUL))
    return "".join(out).strip() or "0"


def background(rng: random.Random, h: int, w: int) -> np.ndarray:
    base = rng.uniform(0, 1)
    yy, xx = np.mgrid[0:h, 0:w]
    angle = rng.uniform(0, np.pi)
    ramp = (np.cos(angle) * xx + np.sin(angle) * yy) / max(h, w)
    bg = base + rng.uniform(-0.25, 0.25) * ramp
    # Printed card patterns: soft stripes or blotches.
    if rng.random() < 0.4:
        period = rng.uniform(4, 40)
        bg += rng.uniform(0, 0.12) * np.sin((xx * np.cos(angle * 2) + yy * np.sin(angle * 2)) * 2 * np.pi / period)
    if rng.random() < 0.3:
        blot = cv2.GaussianBlur(np.random.default_rng(rng.getrandbits(32)).random((h, w)), (0, 0), rng.uniform(3, 12))
        bg += (blot - blot.mean()) * rng.uniform(0, 1.5)
    return bg


def render(rng: random.Random):
    text = text_for(rng)
    size = rng.randint(40, 72)
    font = ImageFont.truetype(rng.choice(FONTS), size)
    hangul = ImageFont.truetype(HANGUL_FONT, size)
    # Some cards set numbers so tightly that the digits touch (0000 on one card).
    tracking = rng.uniform(-0.08, 0.15) * size
    pad_x = int(rng.uniform(0.3, 1.2) * size)
    pad_y = int(rng.uniform(0.15, 0.45) * size)
    widths = [(hangul if c in HANGUL else font).getlength(c) for c in text]
    width = int(sum(widths) + tracking * len(text) + 2 * pad_x)
    ascent, descent = font.getmetrics()
    height = ascent + descent + 2 * pad_y
    canvas = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(canvas)
    boxes = []
    x = pad_x
    for c, cw in zip(text, widths):
        f = hangul if c in HANGUL else font
        if c != " ":
            draw.text((x, pad_y), c, fill=255, font=f)
            l, t, r, b = draw.textbbox((x, pad_y), c, font=f)
            label = reader.CLASSES.index(c) if c in reader.CLASSES else OTHER
            boxes.append((l, t, r, b, label))
        x += cw + tracking
    ink = np.asarray(canvas, dtype=np.float64) / 255
    return ink, boxes, size


def degrade(rng: random.Random, ink: np.ndarray, size: int):
    h, w = ink.shape
    # Leftover tilt and slant after the reader levels the line (readFrame) and
    # takes out its slant in steps of 0.1 (upright), and the squeeze or stretch
    # of a card tipped toward the camera (nothing flattens the card first).
    m = cv2.getRotationMatrix2D((w / 2, h / 2), rng.uniform(-3, 3), 1)
    m[0, 1] += rng.uniform(-0.08, 0.08)
    m[0] *= rng.uniform(0.85, 1.25)
    w = int(w * 1.3)
    ink = cv2.warpAffine(ink, m, (w, h))
    r = rng.random()
    if r < 0.35:
        # Ink spread: bright print on a dark card bleeds in a sharp camera frame
        # until neighbouring digits touch (up to about a sixth of the height).
        k = max(2, int(rng.uniform(0.02, 0.16) * size))
        ink = cv2.dilate(ink, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    elif r < 0.5:
        # Thin print.
        ink = cv2.erode(ink, np.ones((2, 2), np.uint8))
    bg = np.clip(background(rng, h, w), 0, 1)
    # Dark or light print, at least a little apart from the card.
    contrast = rng.uniform(0.18, 0.9)
    mean = float(bg.mean())
    fg = mean - contrast if rng.random() < 0.5 else mean + contrast
    if not 0 <= fg <= 1:
        fg = mean + contrast if fg < 0 else mean - contrast
    img = bg * (1 - ink) + np.clip(fg, 0, 1) * ink
    # Glare: a bright soft spot.
    if rng.random() < 0.15:
        cx, cy = rng.uniform(0, w), rng.uniform(0, h)
        r = rng.uniform(0.3, 1.5) * h
        yy, xx = np.mgrid[0:h, 0:w]
        img = img + rng.uniform(0.1, 0.5) * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * r * r))
    img = cv2.GaussianBlur(img, (0, 0), rng.uniform(0.3, 2.0))
    # Digit height in the app is about 25-45px on a 1000px-wide card.
    scale = rng.uniform(16, 46) / (size * 0.72)
    small = cv2.resize(img, (max(8, int(w * scale)), max(8, int(h * scale))), interpolation=cv2.INTER_AREA)
    small = small + np.random.default_rng(rng.getrandbits(32)).normal(0, rng.uniform(0, 0.04), small.shape)
    gray = np.clip(small * 255, 0, 255).astype(np.uint8)
    ok, jpg = cv2.imencode(".jpg", gray, [cv2.IMWRITE_JPEG_QUALITY, rng.randint(45, 95)])
    gray = cv2.imdecode(jpg, cv2.IMREAD_GRAYSCALE)
    return gray, m, scale


def line_samples(seed: int):
    rng = random.Random(seed)
    ink, boxes, size = render(rng)
    gray, m, scale = degrade(rng, ink, size)
    line = reader.line_ink(gray)
    if line is None:
        return []
    chars, _ = reader.segment(line)
    # Rendered boxes, moved like the image.
    placed = []
    for l, t, r, b, label in boxes:
        corners = np.array([[l, t, 1], [r, t, 1], [r, b, 1], [l, b, 1]], dtype=np.float64) @ m.T * scale
        placed.append((corners[:, 0].min(), corners[:, 1].min(), corners[:, 0].max(), corners[:, 1].max(), label))
    out = []
    for box in chars:
        x, y, w, h = box
        # A box takes a label only when it is that character's box, not a part or a
        # merge of it with a neighbour or a background blot.
        best, label = 0.0, None
        for l, t, r, b, lb in placed:
            ix = max(0, min(x + w, r) - max(x, l))
            iy = max(0, min(y + h, b) - max(y, t))
            inter = ix * iy
            iou = inter / (w * h + (r - l) * (b - t) - inter)
            if iou > best:
                best, label = iou, lb
        if best >= 0.5:
            out.append((reader.glyph(line, box).astype(np.float32), label))
    return out


def main():
    count = int(sys.argv[1])
    path = sys.argv[2]
    base = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    xs, ys = [], []
    seed = base
    with Pool() as pool:
        while len(xs) < count:
            batch = pool.map(line_samples, range(seed, seed + 2000), chunksize=50)
            seed += 2000
            for samples in batch:
                for g, label in samples:
                    xs.append(g)
                    ys.append(label)
            print(f"{len(xs)}/{count}", file=sys.stderr)
    np.savez_compressed(path, x=np.stack(xs[:count]), y=np.array(ys[:count], dtype=np.int64))


if __name__ == "__main__":
    main()
