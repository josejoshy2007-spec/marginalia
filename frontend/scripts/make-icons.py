"""Generate the app icon, PWA icons and splash screens (navy #0e1016, amber "m").

    cd backend && uv run --no-project --with pillow python ../frontend/scripts/make-icons.py ../frontend
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

root = Path(sys.argv[1])
NAVY = (0x0E, 0x10, 0x16)
AMBER = (0xF2, 0xB1, 0x3C)
INK = (0xE7, 0xE9, 0xF2)


def font(size, bold=True):
    for name in (["seguisb.ttf", "segoeuib.ttf"] if bold else ["segoeui.ttf"]) + ["arial.ttf"]:
        try:
            return ImageFont.truetype(f"C:/Windows/Fonts/{name}", size)
        except OSError:
            continue
    return ImageFont.load_default()


def mark(size, scale=0.6, transparent=False):
    """A lowercase amber "m" with a short amber rule under it, centred on navy (or transparent)."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0) if transparent else NAVY + (255,))
    d = ImageDraw.Draw(img)
    f = font(int(size * scale))
    l, t, r, b = d.textbbox((0, 0), "m", font=f)
    w, h = r - l, b - t
    x, y = (size - w) / 2 - l, (size - h) / 2 - t - size * 0.05
    d.text((x, y), "m", font=f, fill=AMBER + (255,))
    rule_w, rule_y = w * 0.62, y + b + size * 0.07
    d.rectangle([(size - rule_w) / 2, rule_y, (size + rule_w) / 2, rule_y + max(2, size * 0.035)], fill=AMBER + (255,))
    return img


icons = root / "public/icons"
icons.mkdir(parents=True, exist_ok=True)
for s in [48, 72, 96, 128, 144, 152, 192, 256, 384, 512]:
    mark(s).save(icons / f"icon-{s}.png")
for s in [192, 512]:
    mark(s, scale=0.44).save(icons / f"maskable-{s}.png")
mark(180).convert("RGB").save(icons / "apple-touch-icon.png")

assets = root / "assets"
assets.mkdir(exist_ok=True)
mark(1024).save(assets / "icon-only.png")
mark(1024, scale=0.4, transparent=True).save(assets / "icon-foreground.png")
Image.new("RGBA", (1024, 1024), NAVY + (255,)).save(assets / "icon-background.png")

for name in ["splash.png", "splash-dark.png"]:
    sp = Image.new("RGB", (2732, 2732), NAVY)
    logo = mark(520)
    sp.paste(logo, ((2732 - 520) // 2, (2732 - 520) // 2 - 160), logo)
    d = ImageDraw.Draw(sp)
    f = font(120, bold=False)
    l, t, r, b = d.textbbox((0, 0), "Marginalia", font=f)
    d.text(((2732 - (r - l)) / 2 - l, 2732 / 2 + 180), "Marginalia", font=f, fill=INK)
    sp.save(assets / name)
print("icons written")
