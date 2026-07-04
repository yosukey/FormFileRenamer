"""
Google Workspace Marketplace Store Listing Assets Generator
Generates: app icon (128x128) and application card banner (220x140)
"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.dirname(os.path.abspath(__file__))

# ── Color palette ──────────────────────────────────────────────────
PURPLE      = (103,  58, 183)   # Google Forms purple
PURPLE_DARK = ( 69,  39, 160)
PURPLE_LIGHT= (149, 117, 205)
WHITE       = (255, 255, 255)

def font(size, bold=False):
    """Load a system font, fall back to default."""
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans{}.ttf".format("-Bold" if bold else ""),
        "/usr/share/fonts/truetype/liberation/LiberationSans-{}.ttf".format("Bold" if bold else "Regular"),
        "/usr/share/fonts/truetype/freefont/FreeSans{}.ttf".format("Bold" if bold else ""),
    ]
    for path in candidates:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()

def draw_rounded_rect(draw, xy, radius, fill):
    x0, y0, x1, y1 = xy
    draw.rectangle([x0 + radius, y0, x1 - radius, y1], fill=fill)
    draw.rectangle([x0, y0 + radius, x1, y1 - radius], fill=fill)
    draw.ellipse([x0, y0, x0 + 2*radius, y0 + 2*radius], fill=fill)
    draw.ellipse([x1 - 2*radius, y0, x1, y0 + 2*radius], fill=fill)
    draw.ellipse([x0, y1 - 2*radius, x0 + 2*radius, y1], fill=fill)
    draw.ellipse([x1 - 2*radius, y1 - 2*radius, x1, y1], fill=fill)

# ══════════════════════════════════════════════════════════════════
# 1. APP ICON  128 × 128
# ══════════════════════════════════════════════════════════════════
def draw_file(d, fx, fy, fw, fh, fold, body_fill, line_fill, fold_fill):
    """Draw a document icon with folded corner."""
    d.polygon([
        (fx,        fy + fold),
        (fx + fold, fy),
        (fx + fw,   fy),
        (fx + fw,   fy + fh),
        (fx,        fy + fh),
    ], fill=body_fill)
    d.polygon([
        (fx,        fy + fold),
        (fx + fold, fy),
        (fx + fold, fy + fold),
    ], fill=fold_fill)
    # Three text lines
    lx0, lx1 = fx + 6, fx + fw - 6
    for ly in [fy + int(fh*0.40), fy + int(fh*0.57), fy + int(fh*0.73)]:
        d.rectangle([lx0, ly, lx1, ly + max(2, int(fh*0.06))], fill=line_fill)

def make_icon():
    # Draw at 2× then downscale for clean edges
    S = 256
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded square background
    draw_rounded_rect(d, (0, 0, S-1, S-1), 44, PURPLE)

    # ── Left file (white, "before") ──────────────────────────────
    fw, fh = 72, 90
    fold = 22
    draw_file(d, 18, 83, fw, fh, fold,
              body_fill=WHITE,
              line_fill=PURPLE_LIGHT,
              fold_fill=PURPLE_LIGHT)

    # ── Arrow in the center ──────────────────────────────────────
    ax, ay = 104, S // 2
    shaft_h = 14
    d.rectangle([ax, ay - shaft_h//2, ax + 42, ay + shaft_h//2], fill=WHITE)
    d.polygon([
        (ax + 34, ay - shaft_h - 4),
        (ax + 58, ay),
        (ax + 34, ay + shaft_h + 4),
    ], fill=WHITE)

    # ── Right file (slightly lighter purple bg, white lines = "after") ──
    draw_file(d, 168, 83, fw, fh, fold,
              body_fill=(220, 210, 240),
              line_fill=PURPLE,
              fold_fill=PURPLE_LIGHT)
    # Highlight the top line to suggest "renamed"
    d.rectangle([168 + 6, 83 + int(fh*0.40),
                 168 + fw - 6, 83 + int(fh*0.40) + max(2, int(fh*0.06))],
                fill=WHITE)

    # Downscale to all required sizes
    icon_base = img.resize((128, 128), Image.LANCZOS)
    icon_base.save(os.path.join(OUT, "icon_128.png"))
    print("icon_128.png saved")

    for size in [96, 48, 32]:
        img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f"icon_{size}.png"))
        print(f"icon_{size}.png saved")

# ══════════════════════════════════════════════════════════════════
# 2. APPLICATION CARD BANNER  220 × 140
# ══════════════════════════════════════════════════════════════════
def make_banner():
    BW, BH = 220, 140
    img = Image.new("RGB", (BW, BH), PURPLE_DARK)
    d = ImageDraw.Draw(img)

    # Gradient-ish background: two rectangles
    d.rectangle([0, 0, BW, BH // 2], fill=PURPLE_DARK)
    d.rectangle([0, BH // 2, BW, BH], fill=PURPLE)

    # Decorative circles (top-right)
    d.ellipse([BW-60, -20, BW+20, 60], fill=PURPLE_LIGHT, outline=None)
    d.ellipse([BW-40, -10, BW+10, 40], fill=PURPLE_DARK)

    # Mini file icon (left side)
    fx, fy, fw, fh, fold = 14, 30, 28, 36, 9
    d.polygon([
        (fx, fy+fold), (fx+fold, fy), (fx+fw, fy),
        (fx+fw, fy+fh), (fx, fy+fh),
    ], fill=WHITE)
    d.polygon([(fx, fy+fold), (fx+fold, fy), (fx+fold, fy+fold)], fill=PURPLE_LIGHT)
    for ly in [fy+14, fy+20, fy+27]:
        d.rectangle([fx+5, ly, fx+fw-4, ly+2], fill=PURPLE_LIGHT)

    # Arrow
    ax = 46
    ay = BH // 2 - 4
    d.rectangle([ax, ay-3, ax+16, ay+3], fill=WHITE)
    d.polygon([(ax+13, ay-7), (ax+22, ay), (ax+13, ay+7)], fill=WHITE)

    # App name text
    d.text((14, BH//2 + 10), "Form File", font=font(16, bold=True), fill=WHITE)
    d.text((14, BH//2 + 30), "Renamer", font=font(16, bold=True), fill=WHITE)
    d.text((14, BH//2 + 52), "for Google Forms", font=font(9), fill=PURPLE_LIGHT)

    img.save(os.path.join(OUT, "banner_220x140.png"))
    print("banner_220x140.png saved")

# ══════════════════════════════════════════════════════════════════
# Run all
# ══════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    make_icon()
    make_banner()
    print("\nAll assets saved to:", OUT)
