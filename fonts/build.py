"""Builds the fonts for the Stillfield web page.

Fixation Display is a Modified Version (SIL OFL 1.1) of Atkinson Hyperlegible Next ExtraBold:
  * every round dot (i, j, period, colon, semicolon, exclamation, question, combining dot) is redrawn as a ring,
    the shape of a perimetry stimulus and fixation target;
  * spacing is tightened by 24 units per em for display sizes, and hinting is dropped;
  * outlines are converted to CFF (PostScript) and the font is renamed, as the OFL requires of modified versions.
Body and number faces are the unmodified Atkinson Hyperlegible Next and Mono, subset to Latin.

Usage: python3 fonts/build.py   (needs fonttools and brotli)
Writes fonts/dist/*.otf and web/fonts/*.woff2.
"""

import math
import os
import shutil

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.reverseContourPen import ReverseContourPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
DIST = os.path.join(HERE, "dist")
WEB = os.path.join(HERE, "..", "web", "fonts")

FAMILY = "Fixation Display"
PS_NAME = "FixationDisplay-ExtraBold"
TRACK = -24  # units per em, split across both sides
# Every character the page sets in the display face, plus Latin punctuation for future headings.
DISPLAY_TEXT = "".join(chr(c) for c in range(0x20, 0x7F)) + "°×’‘“”·…"
BODY_UNICODES = list(range(0x20, 0x7F)) + list(range(0xA0, 0x100)) + [
    0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x2032, 0x2033, 0x2190, 0x2191, 0x2192,
    0x2193, 0x2212, 0x2264, 0x2265, 0x00D7, 0x00B0, 0x00B1,
]
DOT_GLYPHS = {"period", "uni0307", "uni0307.large", "exclam", "question", "exclamdown", "questiondown"}


def contours(rec):
    """Splits a recording pen's value into contours (lists of (op, args))."""
    out, cur = [], []
    for op, args in rec:
        cur.append((op, args))
        if op in ("closePath", "endPath"):
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def bounds(contour):
    pts = [p for _, args in contour for p in args]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def is_dot(contour, upm):
    x0, y0, x1, y1 = bounds(contour)
    w, h = x1 - x0, y1 - y0
    return 0 < w < 0.32 * upm and 0 < h < 0.32 * upm and 0.75 < w / max(h, 1) < 1.33


def draw_circle(pen, cx, cy, r, clockwise):
    """Four cubic segments; clockwise is the TrueType outer contour direction."""
    k = 0.5522847498 * r
    if clockwise:
        pts = [(cx, cy + r), (cx + r, cy), (cx, cy - r), (cx - r, cy)]
        ctrl = [((cx + k, cy + r), (cx + r, cy + k)), ((cx + r, cy - k), (cx + k, cy - r)),
                ((cx - k, cy - r), (cx - r, cy - k)), ((cx - r, cy + k), (cx - k, cy + r))]
    else:
        pts = [(cx, cy + r), (cx - r, cy), (cx, cy - r), (cx + r, cy)]
        ctrl = [((cx - k, cy + r), (cx - r, cy + k)), ((cx - r, cy - k), (cx - k, cy - r)),
                ((cx + k, cy - r), (cx + r, cy - k)), ((cx + r, cy + k), (cx + k, cy + r))]
    pen.moveTo(pts[0])
    for i in range(4):
        pen.curveTo(ctrl[i][0], ctrl[i][1], pts[(i + 1) % 4])
    pen.closePath()


def replay(pen, contour):
    for op, args in contour:
        getattr(pen, op)(*args)


def build_display():
    src = TTFont(os.path.join(SRC, "AtkinsonHyperlegibleNext-ExtraBold.ttf"))
    upm = src["head"].unitsPerEm
    gs = src.getGlyphSet()
    order = src.getGlyphOrder()
    charstrings, metrics = {}, {}
    rings = 0
    for name in order:
        adv, lsb = src["hmtx"][name]
        rec = DecomposingRecordingPen(gs)
        gs[name].draw(rec)
        new_adv = max(0, adv + TRACK) if adv else 0
        t2 = T2CharStringPen(new_adv, gs)
        # CFF wants counter clockwise outer contours: reverse everything drawn in TrueType order
        pen = TransformPen(ReverseContourPen(t2), (1, 0, 0, 1, TRACK / 2 if adv else 0, 0))
        dot_ok = name in DOT_GLYPHS or name in ("i", "j", "colon", "semicolon", "ellipsis", "periodcentered", "uni00B7")
        for c in contours(rec.value):
            if dot_ok and is_dot(c, upm):
                x0, y0, x1, y1 = bounds(c)
                w = max(x1 - x0, y1 - y0)
                cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
                draw_circle(pen, cx, cy, 0.57 * w, True)
                draw_circle(pen, cx, cy, 0.23 * w, False)
                rings += 1
            else:
                replay(pen, c)
        charstrings[name] = t2.getCharString()
        metrics[name] = (new_adv, 0)
    fb = FontBuilder(upm, isTTF=False)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(src.getBestCmap())
    fb.setupCFF(PS_NAME, {"FullName": f"{FAMILY} ExtraBold", "FamilyName": FAMILY, "Weight": "ExtraBold"}, charstrings, {})
    # left side bearings from the new outlines
    hmtx = {}
    for name in order:
        b = charstrings[name].calcBounds(None)
        hmtx[name] = (metrics[name][0], int(round(b[0])) if b else 0)
    fb.setupHorizontalMetrics(hmtx)
    hh = src["hhea"]
    fb.setupHorizontalHeader(ascent=hh.ascent, descent=hh.descent)
    os2 = src["OS/2"]
    fb.setupOS2(
        sTypoAscender=os2.sTypoAscender, sTypoDescender=os2.sTypoDescender, sTypoLineGap=os2.sTypoLineGap,
        usWinAscent=os2.usWinAscent, usWinDescent=os2.usWinDescent, sxHeight=os2.sxHeight,
        sCapHeight=os2.sCapHeight, usWeightClass=800, achVendID="NONE", fsType=0,
    )
    fb.setupNameTable({
        "copyright": "Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors "
                     "(https://github.com/googlefonts/atkinson-hyperlegible-next). Copyright 2026 The Stillfield authors "
                     "(modifications).",
        "familyName": FAMILY,
        "styleName": "Regular",
        "uniqueFontIdentifier": f"0.100;NONE;{PS_NAME}",
        "fullName": f"{FAMILY} ExtraBold",
        "psName": PS_NAME,
        "version": "Version 0.100",
        "typographicFamily": FAMILY,
        "typographicSubfamily": "ExtraBold",
        "description": "Fixation Display is a Modified Version of Atkinson Hyperlegible Next ExtraBold: round dots "
                       "redrawn as rings, display spacing, CFF outlines.",
        "licenseDescription": "This Font Software is licensed under the SIL Open Font License, Version 1.1. This "
                              "license is available with a FAQ at: https://openfontlicense.org",
        "licenseInfoURL": "https://openfontlicense.org",
    })
    fb.setupPost()
    # keep OpenType layout (kerning, ligatures) from the source
    for tag in ("GDEF", "GPOS", "GSUB"):
        if tag in src:
            fb.font[tag] = src[tag]
    os.makedirs(DIST, exist_ok=True)
    full = os.path.join(DIST, "FixationDisplay-ExtraBold-full.otf")
    fb.save(full)
    print(f"{FAMILY}: {rings} dots redrawn as rings")
    return full


def subset(path, out, unicodes=None, text=None, flavor=None):
    f = TTFont(path)
    opts = Options()
    opts.flavor = flavor
    opts.layout_features = ["kern", "liga", "calt", "case", "tnum", "lnum", "pnum", "ss01", "ss02", "zero"]
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.hinting = False
    s = Subsetter(opts)
    s.populate(unicodes=unicodes or [], text=text or "")
    s.subset(f)
    f.flavor = flavor
    f.save(out)
    print(f"  {os.path.relpath(out, HERE)}: {os.path.getsize(out):,} bytes")


def main():
    os.makedirs(WEB, exist_ok=True)
    full = build_display()
    otf = os.path.join(DIST, "FixationDisplay-ExtraBold.otf")
    subset(full, otf, text=DISPLAY_TEXT)
    os.remove(full)
    subset(otf, os.path.join(WEB, "FixationDisplay-ExtraBold.woff2"), text=DISPLAY_TEXT, flavor="woff2")
    for name in ("AtkinsonHyperlegibleNext-Regular", "AtkinsonHyperlegibleNext-SemiBold",
                 "AtkinsonHyperlegibleMono-Regular", "AtkinsonHyperlegibleMono-Medium"):
        subset(os.path.join(SRC, name + ".ttf"), os.path.join(WEB, name + ".woff2"), unicodes=BODY_UNICODES, flavor="woff2")
    # licence files travel with the fonts
    lic = open(os.path.join(SRC, "OFL-AtkinsonHyperlegibleNext.txt"), encoding="utf8").read()
    head = ("Copyright 2026 The Stillfield authors (Fixation Display modifications).\n"
            "Fixation Display is a Modified Version of Atkinson Hyperlegible Next ExtraBold.\n")
    for d in (DIST, WEB):
        with open(os.path.join(d, "OFL-FixationDisplay.txt"), "w", encoding="utf8") as fh:
            fh.write(head + lic)
    shutil.copy(os.path.join(SRC, "OFL-AtkinsonHyperlegibleNext.txt"), WEB)
    shutil.copy(os.path.join(SRC, "OFL-AtkinsonHyperlegibleMono.txt"), WEB)


if __name__ == "__main__":
    main()
