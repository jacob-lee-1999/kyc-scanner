"""Writes tests/fixtures/reader.json: synthetic line crops with what reader.py and
the trained model make of them, so tests/reader.test.mts can check that
public/reader-core.js and public/digit-model.js do the same. Also writes
card.json next to it: a whole made-up card filling the image, for reading end to end.

    uv run python fixtures.py ../tests/fixtures/reader.json
"""

import base64
import json
import os
import random
import sys
import zlib

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

import reader
import synth
import train


def main():
    model = train.build()
    model.load_state_dict(torch.load("data/model.pt"))
    model.eval()
    lines = []
    seed = 0
    while len(lines) < 3:
        rng = random.Random(20261026 + seed)
        seed += 1
        ink, _, size = synth.render(rng)
        gray, _, _ = synth.degrade(rng, ink, size)
        line = reader.line_ink(gray)
        if line is None:
            continue
        chars, hc = reader.segment(line)
        if not chars:
            continue
        glyphs = np.stack([reader.glyph(line, b) for b in chars]).astype(np.float32)
        with torch.no_grad():
            probs = torch.softmax(model(torch.from_numpy(glyphs).unsqueeze(1)), 1).numpy()
        h, w = gray.shape
        lines.append({
            "width": w, "height": h,
            "gray": base64.b64encode(gray.tobytes()).decode(),
            "otsu": reader.otsu(gray),
            "inkSum": float(line.sum()),
            "hc": hc,
            "chars": [[float(v) for v in b] for b in chars],
            # Two glyphs a line are enough to check the sampling; probs cover the rest.
            "glyphs": [[round(float(v), 5) for v in g.ravel()] for g in glyphs[:2]],
            "probs": [[round(float(v), 6) for v in p] for p in probs],
        })
    with open(sys.argv[1], "w") as f:
        json.dump(lines, f)
    with open(os.path.join(os.path.dirname(sys.argv[1]), "card.json"), "w") as f:
        json.dump(card(), f)


# Made-up numbers; not a real card.
CARD = {"card": "9410 2385 7716 0451", "expiry": "08/29", "activation": "3307 1946 5821"}


def card():
    """A 1000px card: tinted gradient, a logo block, Hangul and Latin labels, and
    the three numbers in different Arial weights."""
    w, h = 1000, 631
    yy, xx = np.mgrid[0:h, 0:w]
    base = np.stack([0.85 - 0.25 * xx / w, 0.88 - 0.1 * yy / h, 0.95 - 0.2 * (xx + yy) / (w + h)], -1)
    img = Image.fromarray((base * 255).astype(np.uint8))
    draw = ImageDraw.Draw(img)
    font = lambda name, size: ImageFont.truetype(f"{synth.FONT_DIR}/{name}", size)
    draw.rectangle((60, 60, 220, 160), fill=(30, 60, 140))
    draw.text((250, 80), "SAMPLE CARD", fill=(30, 60, 140), font=font("Arial Bold.ttf", 52))
    draw.text((60, 300), CARD["card"], fill=(25, 25, 30), font=font("Arial Bold.ttf", 54))
    draw.text((60, 400), "VALID THRU", fill=(60, 60, 70), font=font("Arial.ttf", 22))
    draw.text((210, 392), CARD["expiry"], fill=(25, 25, 30), font=font("Arial.ttf", 40))
    draw.text((60, 480), "활성화 번호", fill=(60, 60, 70), font=font("Arial Unicode.ttf", 26))
    draw.text((230, 474), CARD["activation"], fill=(25, 25, 30), font=font("Arial Narrow.ttf", 44))
    rgba = np.asarray(img.convert("RGBA"))
    return {
        "width": w, "height": h,
        "data": base64.b64encode(zlib.compress(rgba.tobytes(), 9)).decode(),
        "truth": {k: v.replace(" ", "").replace("/", "") for k, v in CARD.items()},
    }


if __name__ == "__main__":
    main()
