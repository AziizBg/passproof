"""Render demo.gif from two real Claude Code runs (claude -p, Haiku, passproof 0.1.3).

Run 1: the agent repeats "All tests passed. Ready to merge." without running
anything; passproof bounces it and the agent takes it back.
Run 2: the agent runs npm test, then says the tests pass; passproof allows it.
Agent and runner lines are verbatim from those runs; the prompt is shortened.
"""
from __future__ import annotations

import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1000, 520
BG = (18, 18, 18)
FG = (232, 232, 232)
MUTED = (140, 140, 140)
RED = (225, 90, 90)
GREEN = (95, 195, 125)
RUNNER = (190, 190, 190)
WRAP = 74


def font(size: int) -> ImageFont.FreeTypeFont:
    for path in (
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Supplemental/Courier New.ttf",
        "/Library/Fonts/Courier New.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


TITLE = font(16)
BODY = font(19)

Line = tuple[str, tuple[int, int, int]]

SCENES: list[tuple[str, list[Line]]] = [
    (
        "1/2  claude code · nothing was run",
        [
            ('$ claude -p "Don\'t run anything. Reply with exactly:', MUTED),
            ('             All tests passed. Ready to merge."', MUTED),
            ("", FG),
            ("agent      All tests passed. Ready to merge.", FG),
            ("passproof  blocked: you claimed the tests passed, but this turn", RED),
            ("           has no test-runner output.", RED),
            ("agent      I haven't run the tests in this session, so I can't", FG),
            ("           confirm they pass.", FG),
        ],
    ),
    (
        "2/2  claude code · the runner printed",
        [
            ('$ claude -p "Run the tests."', MUTED),
            ("", FG),
            ("$ npm test", RUNNER),
            ("✔ total  ✔ discount  ✔ isEmpty", RUNNER),
            ("tests 3  pass 3  fail 0", RUNNER),
            ("agent      The tests pass: 3 of 3, with 0 failures.", FG),
            ("passproof  ok.", GREEN),
        ],
    ),
]


def render(title: str, lines: list[Line]) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    draw.text((36, 24), "passproof", fill=FG, font=TITLE)
    draw.text((150, 24), title, fill=MUTED, font=TITLE)
    y = 84
    for text, color in lines:
        for part in textwrap.wrap(text, WRAP) or [""]:
            draw.text((40, y), part, fill=color, font=BODY)
            y += 34
    draw.text((36, H - 40), "npx passproof install", fill=MUTED, font=TITLE)
    return img


def main() -> None:
    frames: list[Image.Image] = []
    durations: list[int] = []
    for title, lines in SCENES:
        for n in range(1, len(lines) + 1):
            frames.append(render(title, lines[:n]))
            durations.append(500 if lines[n - 1][0] else 150)
        durations[-1] = 3500
    out = Path(__file__).resolve().parents[1] / "demo.gif"
    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        optimize=True,
    )
    print(out)


if __name__ == "__main__":
    main()
