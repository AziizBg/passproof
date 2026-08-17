"""Render demo.gif — fake claim blocked, then runner output allowed."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 960, 420
BG = (18, 18, 18)
FG = (232, 232, 232)
MUTED = (140, 140, 140)
RED = (220, 80, 80)
GREEN = (90, 190, 120)
ACCENT = (200, 200, 200)


def font(size: int) -> ImageFont.FreeTypeFont:
    for path in (
        "/System/Library/Fonts/Supplemental/Courier New.ttf",
        "/System/Library/Fonts/Menlo.ttc",
        "/Library/Fonts/Courier New.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def frame(lines: list[tuple[str, tuple[int, int, int]]]) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    title = font(18)
    body = font(22)
    draw.text((36, 24), "passproof", fill=MUTED, font=title)
    y = 88
    for text, color in lines:
        draw.text((48, y), text, fill=color, font=body)
        y += 44
    return img


def main() -> None:
    scenes = [
        [
            ("agent", MUTED),
            ("  All tests passed.", FG),
            ("", FG),
            ("passproof", MUTED),
            ("  blocked. no runner output in this turn.", RED),
        ],
        [
            ("$ pytest -q", MUTED),
            ("  3 passed in 0.12s", ACCENT),
            ("agent", MUTED),
            ("  All tests passed.", FG),
            ("passproof", MUTED),
            ("  ok.", GREEN),
        ],
    ]
    frames: list[Image.Image] = []
    for scene in scenes:
        img = frame(scene)
        frames.extend([img] * 24)
    out = Path(__file__).resolve().parents[1] / "demo.gif"
    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=80,
        loop=0,
        optimize=True,
    )
    print(out)


if __name__ == "__main__":
    main()
