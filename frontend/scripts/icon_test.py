"""Checks that app icons, splash and native colours follow the Nebula Amber design.

    cd backend && uv run --no-project --with pillow python ../frontend/scripts/icon_test.py ../frontend
"""
import sys
from pathlib import Path

from PIL import Image

root = Path(sys.argv[1])
NAVY = (0x0E, 0x10, 0x16)
AMBER = (0xF2, 0xB1, 0x3C)


def near(a, b, tol=6):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def has_amber(img):
    return any(near(p[:3], AMBER, 40) for p in img.convert("RGB").getdata())


checks = 0
for rel in ["public/icons/icon-192.png", "public/icons/icon-512.png", "public/icons/maskable-512.png",
            "public/icons/apple-touch-icon.png", "assets/icon-only.png", "assets/splash.png", "assets/splash-dark.png"]:
    img = Image.open(root / rel).convert("RGB")
    assert near(img.getpixel((1, 1)), NAVY), f"{rel}: corner {img.getpixel((1, 1))} is not navy #0e1016"
    assert has_amber(img), f"{rel}: no amber mark"
    checks += 1
    print(f"ok {rel}")

fg = Image.open(root / "assets/icon-foreground.png").convert("RGBA")
assert fg.getpixel((1, 1))[3] == 0, "icon-foreground must be transparent around the mark"
assert has_amber(fg), "icon-foreground: no amber mark"
bg = Image.open(root / "assets/icon-background.png").convert("RGB")
assert near(bg.getpixel((10, 10)), NAVY), "icon-background must be navy"
checks += 2
print("ok assets/icon-foreground.png, assets/icon-background.png")

cap = (root / "capacitor.config.ts").read_text(encoding="utf-8")
assert 'backgroundColor: "#0e1016"' in cap, "capacitor SplashScreen.backgroundColor must be #0e1016"
wf = (root.parent / ".github/workflows/android.yml").read_text(encoding="utf-8")
for flag in ["--iconBackgroundColor '#0e1016'", "--iconBackgroundColorDark '#0e1016'",
             "--splashBackgroundColor '#0e1016'", "--splashBackgroundColorDark '#0e1016'"]:
    assert flag in wf, f"android.yml missing {flag}"
checks += 2
print("ok native colours")
print(f"\nALL {checks} ICON CHECKS PASSED")
