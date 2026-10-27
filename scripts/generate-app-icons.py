#!/usr/bin/env python3
"""Derive launcher assets from the approved artwork. Requires Pillow and macOS iconutil."""

from math import hypot
from pathlib import Path
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets/branding/remote-mac-approved.png"
PHONE = ROOT / "transmitter/assets"
MAC = ROOT / "receiver/Resources"
SIZE = 1024
LANCZOS = Image.Resampling.LANCZOS


def main():
    source = Image.open(SOURCE).convert("RGB")
    if source.width != source.height:
        raise ValueError("The approved artwork must be square")
    PHONE.mkdir(parents=True, exist_ok=True)
    MAC.mkdir(parents=True, exist_ok=True)

    # iOS applies its own corner mask; keep the submitted image square and opaque.
    icon = source.resize((SIZE, SIZE), LANCZOS)
    icon.save(PHONE / "icon.png", optimize=True)
    icon.resize((64, 64), LANCZOS).save(PHONE / "favicon.png", optimize=True)

    # Separate the dark mark from the light lime backdrop, preserving its outline.
    # The approved image has a large gap between foreground/background green values.
    alpha = source.getchannel("G").point(
        lambda green: round(255 * max(0, min(1, (200 - green) / 140)))
    )
    mark = Image.new("RGBA", source.size, (19, 29, 33, 0))
    mark.putalpha(alpha)

    # Keep all visible pixels inside Android's central 66/108 safe circle, with
    # extra room for resampling. Retain the approved artwork's relative placement.
    center = source.width / 2
    pixels = alpha.load()
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError("No foreground found in the approved artwork")
    left, top, right, bottom = bounds
    radius = max(
        hypot(x - center, y - center)
        for y in range(top, bottom)
        for x in range(left, right)
        if pixels[x, y] > 0
    )
    scale = (SIZE * 33 / 108 - 12) / radius
    edge = round(source.width * scale)
    foreground = Image.new("RGBA", (SIZE, SIZE))
    foreground.alpha_composite(mark.resize((edge, edge), LANCZOS),
                               ((SIZE - edge) // 2, (SIZE - edge) // 2))
    foreground.save(PHONE / "adaptive-icon.png", optimize=True)
    monochrome = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    monochrome.putalpha(foreground.getchannel("A"))
    monochrome.save(PHONE / "monochrome-icon.png", optimize=True)

    # macOS ICNS artwork includes its rounded tile and transparent outer padding.
    tile_mask = Image.new("L", (SIZE, SIZE))
    ImageDraw.Draw(tile_mask).rounded_rectangle((64, 64, 959, 959), 200, fill=255)
    shadow_mask = Image.new("L", (SIZE, SIZE))
    ImageDraw.Draw(shadow_mask).rounded_rectangle((64, 78, 959, 973), 200, fill=40)
    mac = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    mac.putalpha(shadow_mask.filter(ImageFilter.GaussianBlur(14)))
    tile = Image.new("RGBA", (SIZE, SIZE))
    tile.paste(icon.resize((896, 896), LANCZOS), (64, 64))
    tile.putalpha(tile_mask)
    mac = Image.alpha_composite(mac, tile)

    with tempfile.TemporaryDirectory(prefix="remote-mac-icon-") as temporary:
        iconset = Path(temporary) / "AppIcon.iconset"
        iconset.mkdir()
        for points in (16, 32, 128, 256, 512):
            for density in (1, 2):
                suffix = "@2x" if density == 2 else ""
                filename = f"icon_{points}x{points}{suffix}.png"
                edge = points * density
                mac.resize((edge, edge), LANCZOS).save(iconset / filename)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o",
                        str(MAC / "AppIcon.icns")], check=True)

    print("Generated phone icons, favicon, and macOS AppIcon.icns")


if __name__ == "__main__":
    main()
