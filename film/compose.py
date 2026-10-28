# /// script
# dependencies = ["pillow"]
# ///
"""Turns a take into docs/<name>.mp4 and docs/<name>.gif, styled after Apple's product pages.

The handover take (film/take.ts, layout "stage"): a white page with an eyebrow and a large headline
over a light gray stage card holding three midnight-titanium devices, a display showing the Tern
window, a laptop showing the desktop browser and a phone showing the phone browser, all live. A
camera flies between them: it pulls back to frame where the task was and where it goes, then
pushes in. The phone take (film/take-phone.ts, layout "phone"): the phone alone on the right of the
card, its headline on the left. Pointers, taps and dragging fingers are drawn in.

    uv run film/compose.py [WORK]   (default /tmp/tern-awui-film)

Needs ffmpeg. Inter (SIL OFL) is downloaded once into ~/.cache/tern-awui-film.
"""

import io
import json
import math
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from multiprocessing import Pool
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

WORK = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/tern-awui-film")
DOCS = Path(__file__).resolve().parent.parent / "docs"
CACHE = Path.home() / ".cache" / "tern-awui-film"
INTER = "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip"
FPS = 30
SS = 2  # device chrome is drawn this many times larger, then reduced, for smooth edges

WHITE = (255, 255, 255)
INK = (29, 29, 31)
GRAY = (110, 110, 115)
CARD = (245, 245, 247)
BLUE = (0, 113, 227)
CARD_RADIUS = 36
INTRO_MS = 1100
TEXT_IN_MS = 520
TEXT_OUT_MS = 220


def fonts() -> dict[str, Path]:
    """Inter's display and text cuts, fetched once."""
    names = {"display": "InterDisplay-SemiBold.ttf", "display-bold": "InterDisplay-Bold.ttf", "text": "Inter-Medium.ttf", "text-semibold": "Inter-SemiBold.ttf"}
    CACHE.mkdir(parents=True, exist_ok=True)
    if not all((CACHE / n).exists() for n in names.values()):
        with urllib.request.urlopen(INTER, timeout=60) as response:
            archive = zipfile.ZipFile(io.BytesIO(response.read()))
        for n in names.values():
            (CACHE / n).write_bytes(archive.read(f"extras/ttf/{n}"))
    return {k: CACHE / n for k, n in names.items()}


FONT = fonts()


def font(kind: str, size: float) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT[kind]), round(size))


timeline = json.loads((WORK / "timeline.json").read_text())
frames, events = timeline["frames"], timeline["events"]
NAME = timeline.get("name", "handover")
PHONE_ONLY = timeline.get("layout", "stage") == "phone"
tern_crop = timeline.get("ternCrop")
TRANSITION_MS = timeline["transitionMs"]
scenes = [e for e in events if e["kind"] == "scene"]
captions = [e for e in events if e["kind"] == "caption"]
# The phone alone is tall: a squarer canvas gives it more height, and its text sits beside it.
W, H = (1280, 960) if PHONE_ONLY else (1600, 900)
CARD_BOX = (40, 40, 1240, 920) if PHONE_ONLY else (60, 156, 1540, 840)
# GIF width: the phone's text must stay readable, and its mostly still frames compress well.
GIF_WIDTH = 1280 if PHONE_ONLY else 960


def ease(k: float) -> float:
    k = max(0.0, min(1.0, k))
    return 4 * k**3 if k < 0.5 else 1 - (-2 * k + 2) ** 3 / 2


def ease_out(k: float) -> float:
    k = max(0.0, min(1.0, k))
    return 1 - (1 - k) ** 3


def latest(items: list[dict], t: float, test=lambda item: True) -> dict | None:
    found = None
    for item in items:
        if item["t"] > t:
            break
        if test(item):
            found = item
    return found


def gradient(size: tuple[int, int], stops: list[tuple[float, tuple[int, ...]]], horizontal: bool = False) -> Image.Image:
    """A linear gradient through `stops` (position 0..1, RGB)."""
    length = size[0] if horizontal else size[1]
    line = Image.new("RGB", (length, 1))
    px = line.load()
    for i in range(length):
        p = i / max(1, length - 1)
        for (a, ca), (b, cb) in zip(stops, stops[1:]):
            if a <= p <= b:
                k = (p - a) / (b - a) if b > a else 0
                px[i, 0] = tuple(round(x + (y - x) * k) for x, y in zip(ca, cb))
                break
    if horizontal:
        return line.resize(size)
    return line.transpose(Image.Transpose.ROTATE_90).transpose(Image.Transpose.FLIP_TOP_BOTTOM).resize(size)


def rounded_mask(size: tuple[int, int], radius: float, box=None) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(box or (0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return mask


# Midnight titanium: a dark blue-gray metal with a lit top edge.
METAL = [(0, (92, 102, 128)), (0.06, (58, 66, 86)), (0.5, (40, 46, 62)), (1, (28, 32, 44))]
METAL_SIDE = [(0, (30, 34, 46)), (0.5, (64, 72, 94)), (1, (30, 34, 46))]


def metal(size, radius, stops=METAL, horizontal=False) -> Image.Image:
    image = gradient(size, stops, horizontal).convert("RGBA")
    image.putalpha(rounded_mask(size, radius))
    return image


def edge(draw: ImageDraw.ImageDraw, box, radius, color=(140, 150, 178, 150), width=2):
    draw.rounded_rectangle(box, radius=radius, outline=color, width=width)


class Device:
    """A device drawn at native size, where a screen pixel is a shot pixel (the phone: two per CSS
    pixel). It stands in the shared stage at world x, `height` world units tall; the floor is y = 0."""

    def __init__(self, surface: str, x: float, height: float):
        self.surface = surface
        getattr(self, f"build_{surface}")()
        self.world = height / self.size[1]
        self.origin = (x, -height)  # world position of the native top left
        self.cache: tuple[str, Image.Image] | None = None
        self.shadow = self.make_shadow()

    # Native layouts. `screen` is where the shot goes; `chrome` the device with a transparent screen.

    def build_tern(self):
        bezel, frame = 18, 10
        sw, sh = tern_crop[2] - tern_crop[0], tern_crop[3] - tern_crop[1]
        bw, bh = sw + 2 * (bezel + frame), sh + 2 * (bezel + frame)
        neck_h, foot_h = 150, 20
        self.size = (bw, bh + neck_h + foot_h)
        self.screen = (frame + bezel, frame + bezel, sw, sh)
        self.screen_radius = 4

        def draw(c: Image.Image, s: int):
            d = ImageDraw.Draw(c)
            neck_w, foot_w = 190 * s, 430 * s
            neck = metal((neck_w, (neck_h + 30) * s), 6 * s, METAL_SIDE, horizontal=True)
            c.alpha_composite(neck, ((bw * s - neck_w) // 2, (bh - 30) * s))
            foot = metal((foot_w, foot_h * s), 10 * s, [(0, (120, 130, 156)), (0.25, (62, 70, 92)), (1, (34, 38, 52))])
            c.alpha_composite(foot, ((bw * s - foot_w) // 2, (bh + neck_h) * s))
            c.alpha_composite(metal((bw * s, bh * s), 24 * s), (0, 0))
            edge(d, (1 * s, 1 * s, (bw - 1) * s, (bh - 1) * s), 24 * s)
            d.rounded_rectangle((frame * s, frame * s, (bw - frame) * s, (bh - frame) * s), radius=16 * s, fill=(8, 8, 10, 255))

        self.draw = draw

    def build_web(self):
        bar = 40
        sw, sh = timeline["web"]["width"], timeline["web"]["height"] + bar
        side, top, bottom, frame = 22, 30, 26, 7
        lw, lh = sw + 2 * (side + frame), sh + top + bottom + 2 * frame
        deck_w, deck_h = lw + 150, 30
        self.size = (deck_w, lh + deck_h)
        lx = (deck_w - lw) // 2
        self.screen = (lx + frame + side, frame + top, sw, sh)
        self.screen_radius = 6
        self.bar = bar

        def draw(c: Image.Image, s: int):
            d = ImageDraw.Draw(c)
            lid = metal((lw * s, lh * s), 28 * s)
            c.alpha_composite(lid, (lx * s, 0))
            edge(d, (lx * s + s, s, (lx + lw - 1) * s, (lh - 1) * s), 28 * s)
            d.rounded_rectangle(((lx + frame) * s, frame * s, (lx + lw - frame) * s, (lh - frame) * s), radius=22 * s, fill=(8, 8, 10, 255))
            cx = deck_w * s // 2
            d.rounded_rectangle((cx - 120 * s, frame * s, cx + 120 * s, (frame + 26) * s), radius=10 * s, fill=(8, 8, 10, 255))
            d.ellipse((cx - 5 * s, (frame + 10) * s, cx + 5 * s, (frame + 20) * s), fill=(30, 34, 48, 255))
            d.rectangle(((lx + 40) * s, (lh - 2) * s, (lx + lw - 40) * s, (lh + 4) * s), fill=(18, 20, 28, 255))
            deck = metal((deck_w * s, deck_h * s), 14 * s, [(0, (128, 138, 164)), (0.2, (78, 86, 110)), (0.7, (44, 50, 66)), (1, (24, 27, 38))])
            c.alpha_composite(deck, (0, (lh + 2) * s - 2 * s))
            d.rounded_rectangle((cx - 110 * s, (lh + 2) * s, cx + 110 * s, (lh + 10) * s), radius=5 * s, fill=(40, 46, 62, 255))

        self.draw = draw

    def build_phone(self):
        status = 96
        sw, sh = timeline["phone"]["width"] * 2, timeline["phone"]["height"] * 2 + status
        bezel, frame, button = 22, 16, 8
        pw, ph = sw + 2 * (bezel + frame), sh + 2 * (bezel + frame)
        self.size = (pw + 2 * button, ph)
        self.screen = (button + frame + bezel, frame + bezel, sw, sh)
        self.screen_radius = 96
        self.status = status

        def draw(c: Image.Image, s: int):
            d = ImageDraw.Draw(c)
            side_color = (70, 78, 102, 255)
            for x0, y0, h in [(0, 330, 90), (0, 470, 160), (0, 660, 160), (pw + button, 520, 230)]:
                d.rounded_rectangle((x0 * s, y0 * s, (x0 + button + 6) * s, (y0 + h) * s), radius=4 * s, fill=side_color)
            c.alpha_composite(metal((pw * s, ph * s), 150 * s), (button * s, 0))
            edge(d, ((button + 1) * s, s, (button + pw - 1) * s, (ph - 1) * s), 150 * s, width=3)
            d.rounded_rectangle(((button + frame) * s, frame * s, (button + pw - frame) * s, (ph - frame) * s), radius=134 * s, fill=(6, 6, 8, 255))

        self.draw = draw

    def make_chrome(self) -> Image.Image:
        big = Image.new("RGBA", (self.size[0] * SS, self.size[1] * SS), (0, 0, 0, 0))
        self.draw(big, SS)
        return big.resize(self.size, Image.LANCZOS)

    def make_shadow(self) -> Image.Image:
        """A soft contact shadow on the stage floor, as wide as the device's foot."""
        w = self.size[0]
        foot = {"tern": 0.62, "web": 1.0, "phone": 0.9}[self.surface]
        h = max(40, round(w * 0.09))
        shadow = Image.new("L", (round(w * 1.3), h * 2), 0)
        cx = shadow.width / 2
        ImageDraw.Draw(shadow).ellipse((cx - w * foot / 2, h * 0.75, cx + w * foot / 2, h * 1.25), fill=120)
        return shadow.filter(ImageFilter.GaussianBlur(h / 3))

    def screen_world(self) -> tuple[float, float, float, float]:
        x, y, w, h = self.screen
        return (self.origin[0] + x * self.world, self.origin[1] + y * self.world, w * self.world, h * self.world)

    def body_world(self) -> tuple[float, float, float, float]:
        return (self.origin[0], self.origin[1], self.size[0] * self.world, self.size[1] * self.world)

    # Screen content.

    def content(self, file: str) -> Image.Image:
        _, _, w, h = self.screen
        shot = Image.open(file).convert("RGB")
        if self.surface == "tern":
            return shot.crop(tern_crop)
        if self.surface == "web":
            page = shot.resize((w, h - self.bar), Image.LANCZOS)
            screen = Image.new("RGB", (w, h), (43, 43, 46))
            screen.paste(page, (0, self.bar))
            self.browser_bar(ImageDraw.Draw(screen), w)
            return screen
        page = shot.resize((w, h - self.status), Image.LANCZOS)
        screen = Image.new("RGB", (w, h), page.getpixel((w // 2, 2)))
        screen.paste(page, (0, self.status))
        self.status_bar(ImageDraw.Draw(screen), w, page.getpixel((w // 2, 2)))
        return screen

    def browser_bar(self, d: ImageDraw.ImageDraw, w: int):
        bar = self.bar
        for i, color in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
            x = 22 + i * 22
            d.ellipse((x - 7, bar / 2 - 7, x + 7, bar / 2 + 7), fill=color)
        pill = (w / 2 - 230, 7, w / 2 + 230, bar - 7)
        d.rounded_rectangle(pill, radius=(pill[3] - pill[1]) / 2, fill=(60, 60, 64))
        lock = font("text", 15)
        d.text((w / 2, bar / 2), "desk.tailnet.ts.net", font=lock, fill=(222, 222, 228), anchor="mm")
        d.line((0, bar - 1, w, bar - 1), fill=(24, 24, 26))

    def status_bar(self, d: ImageDraw.ImageDraw, w: int, bg):
        fg = (245, 245, 247)
        y = self.status / 2 + 6
        d.text((96, y), "9:41", font=font("text-semibold", 34), fill=fg, anchor="mm")
        d.rounded_rectangle((w / 2 - 124, 20, w / 2 + 124, 92), radius=36, fill=(0, 0, 0))
        x = w - 220
        for i in range(4):
            h = 10 + i * 6
            d.rounded_rectangle((x + i * 12, y + 14 - h, x + i * 12 + 8, y + 14), radius=2, fill=fg)
        cx, cy = w - 140, y + 12
        for r in (26, 18, 10):
            d.arc((cx - r, cy - r, cx + r, cy + r), 225, 315, fill=fg, width=6)
        d.ellipse((cx - 4, cy - 6, cx + 4, cy + 2), fill=fg)
        bx = w - 104
        d.rounded_rectangle((bx, y - 13, bx + 52, y + 13), radius=8, outline=(150, 150, 156), width=3)
        d.rounded_rectangle((bx + 5, y - 8, bx + 40, y + 8), radius=4, fill=fg)
        d.rounded_rectangle((bx + 55, y - 5, bx + 59, y + 5), radius=2, fill=(150, 150, 156))

    def native(self, t: float) -> Image.Image:
        own = frames[self.surface]
        file = (latest(own, t) or own[0])["file"]
        if self.cache and self.cache[0] == file:
            return self.cache[1]
        if not hasattr(self, "chrome"):
            self.chrome = self.make_chrome()
            x, y, w, h = self.screen
            self.mask = rounded_mask((w, h), self.screen_radius)
            # A faint glass sheen across the upper left of the screen.
            sheen = Image.new("L", (w, h), 0)
            ImageDraw.Draw(sheen).polygon([(0, 0), (w * 0.55, 0), (w * 0.2, h), (0, h)], fill=10)
            self.sheen = sheen.filter(ImageFilter.GaussianBlur(w / 30))
        image = self.chrome.copy()
        x, y, w, h = self.screen
        screen = self.content(file)
        screen.paste((255, 255, 255), (0, 0), self.sheen)
        image.paste(screen, (x, y), self.mask)
        self.cache = (file, image)
        return image


# The stage: the display at the back left, the laptop in the middle, the phone on the right. The
# phone take has the phone alone.
if PHONE_ONLY:
    devices = {"phone": Device("phone", 0, 340)}
else:
    devices = {"tern": Device("tern", 0, 520), "web": Device("web", 730, 370)}
    devices["phone"] = Device("phone", 730 + devices["web"].size[0] * devices["web"].world + 70, 340)

card_w, card_h = CARD_BOX[2] - CARD_BOX[0], CARD_BOX[3] - CARD_BOX[1]


def framing(rect: tuple[float, float, float, float], fill: float, drop: float = 0) -> tuple[float, float, float]:
    """The camera (center x, center y, zoom) that shows world `rect` filling `fill` of the card,
    `drop` card pixels below its middle."""
    x, y, w, h = rect
    zoom = min(card_w * fill / w, card_h * fill / h)
    return (x + w / 2, y + h / 2 - drop / zoom, zoom)


def union(rects):
    x0 = min(r[0] for r in rects)
    y0 = min(r[1] for r in rects)
    x1 = max(r[0] + r[2] for r in rects)
    y1 = max(r[1] + r[3] for r in rects)
    return (x0, y0, x1 - x0, y1 - y0)


def shot_for(scene: str) -> tuple[float, float, float]:
    """A scene is a device, `phone:reply` (the lower half of the phone's screen, close), or `wide`.
    The phone take has one shot: the phone filling the card's height, its middle at 70 % of the width."""
    if PHONE_ONLY:
        cx, cy, zoom = framing(devices["phone"].body_world(), 0.95)
        return (cx - 0.2 * card_w / zoom, cy, zoom)
    if scene == "wide":
        # Lower than the middle, leaving room above for the outro's link and room below for shadows.
        return framing(union([d.body_world() for d in devices.values()]), 0.86, drop=24)
    if scene == "phone:reply":
        x, y, w, h = devices["phone"].screen_world()
        return framing((x, y + h / 2, w, h / 2), 0.96)
    device = devices[scene]
    if scene == "phone":
        return framing(device.body_world(), 0.94)
    return framing(device.screen_world(), 0.86)


def camera(t: float) -> tuple[float, float, float]:
    """Flies from the last shot to the current one: out to frame both, then in."""
    i = max(i for i, s in enumerate(scenes) if s["t"] <= t) if t >= scenes[0]["t"] else 0
    to = shot_for(scenes[i]["scene"])
    if i == 0 or PHONE_ONLY:
        k = ease_out((t - scenes[0]["t"]) / INTRO_MS)
        return (to[0], to[1], to[2] * (0.92 + 0.08 * k))
    a, b = scenes[i - 1]["scene"], scenes[i]["scene"]
    u = ease((t - scenes[i]["t"]) / TRANSITION_MS)
    if u >= 1:
        return to
    fr = shot_for(a)
    on = lambda s: [*devices.values()] if s == "wide" else [devices[s.split(":")[0]]]
    rects = [d.body_world() for s in (a, b) for d in on(s)]
    mid = framing(union(rects), 0.82)
    la, lb, lm = math.log(fr[2]), math.log(to[2]), math.log(mid[2])
    # Moving within one device is a straight push; between devices the camera pulls back first.
    bump = 0.0 if on(a) == on(b) and a != "wide" else max(0.0, (la + lb) / 2 - lm)
    zoom = math.exp(la + (lb - la) * u - bump * math.sin(math.pi * u))
    lift = math.sin(math.pi * u) if bump > 0 else 0
    cx = fr[0] + (to[0] - fr[0]) * u + (mid[0] - (fr[0] + to[0]) / 2) * lift
    cy = fr[1] + (to[1] - fr[1]) * u + (mid[1] - (fr[1] + to[1]) / 2) * lift
    return (cx, cy, zoom)


def to_card(cam, x, y) -> tuple[float, float]:
    cx, cy, z = cam
    return ((x - cx) * z + card_w / 2, (y - cy) * z + card_h / 2)


# A macOS-style pointer, tip at (0, 0).
ARROW = [(0, 0), (0, 21), (5, 16), (9, 24), (12.5, 22.5), (8.5, 15), (15, 15)]


def marks(card: Image.Image, cam, device: Device, t: float):
    draw = ImageDraw.Draw(card, "RGBA")
    mine = lambda kind: lambda e: e["kind"] == kind and e.get("surface") == device.surface

    def at(x, y):
        sx, sy = x, y
        if device.surface == "tern":
            sx, sy = x - tern_crop[0], y - tern_crop[1]
        elif device.surface == "web":
            sy = y + device.bar
        else:
            sx, sy = x * 2, y * 2 + device.status
        wx = device.origin[0] + (device.screen[0] + sx) * device.world
        wy = device.origin[1] + (device.screen[1] + sy) * device.world
        return to_card(cam, wx, wy)

    # Full size in a close-up, smaller as the camera pulls back.
    size = min(1.0, max(0.4, cam[2] / shot_for(device.surface)[2]))
    if device.surface == "phone":
        tap = latest(events, t, mine("tap"))
        if tap and t - tap["t"] < 750:
            px, py = at(tap["x"], tap["y"])
            k = (t - tap["t"]) / 750
            touch = 0.3
            if k < touch + 0.2:
                r = (22 - 6 * ease_out(k / touch)) * size
                fade = 1 if k < touch else 1 - (k - touch) / 0.2
                draw.ellipse((px - r, py - r, px + r, py + r), fill=(255, 255, 255, round(110 * fade)), outline=(255, 255, 255, round(190 * fade)), width=2)
            if k >= touch:
                q = (k - touch) / (1 - touch)
                r = (16 + 26 * ease_out(q)) * size
                draw.ellipse((px - r, py - r, px + r, py + r), outline=(255, 255, 255, round(170 * (1 - q))), width=3)
        # A finger on the glass: a soft dot with a short fading trail while it drags, fading out after it lifts.
        finger = latest(events, t, mine("touch"))
        if finger and (finger["phase"] != "up" or t - finger["t"] < 300):
            fade = 1.0 if finger["phase"] != "up" else 1 - (t - finger["t"]) / 300
            # The trail: the last 220 ms of the drag as dots that shrink and fade with age.
            for e in events:
                if e["kind"] == "touch" and e["phase"] != "up" and t - 220 < e["t"] < t:
                    age = (t - e["t"]) / 220
                    ex, ey = at(e["x"], e["y"])
                    er = (14 - 8 * age) * size
                    draw.ellipse((ex - er, ey - er, ex + er, ey + er), fill=(255, 255, 255, round(70 * (1 - age) * fade)))
            px, py = at(finger["x"], finger["y"])
            r = 18 * size
            draw.ellipse((px - r, py - r, px + r, py + r), fill=(255, 255, 255, round(110 * fade)), outline=(255, 255, 255, round(190 * fade)), width=2)
        return
    move = latest(events, t, mine("move"))
    if not move:
        return
    px, py = at(move["x"], move["y"])
    click = latest(events, t, mine("click"))
    if click and t - click["t"] < 420:
        k = (t - click["t"]) / 420
        r = (6 + 16 * ease_out(k)) * size
        draw.ellipse((px - r, py - r, px + r, py + r), fill=(255, 255, 255, round(70 * (1 - k))), outline=(255, 255, 255, round(200 * (1 - k))), width=2)
    pts = [(px + x * size, py + y * size) for x, y in ARROW]
    draw.polygon(pts, fill=(0, 0, 0, 255), outline=(255, 255, 255, 255), width=2 if size > 0.7 else 1)


def render_card(t: float, cam, alpha: float) -> Image.Image:
    card = Image.new("RGBA", (card_w, card_h), (*CARD, 255))
    cx, cy, z = cam
    for device in devices.values():
        x, y, w, h = device.body_world()
        left, top = to_card(cam, x, y)
        ow, oh = w * z, h * z
        if left > card_w or top > card_h or left + ow < 0 or top + oh < 0:
            continue
        # The contact shadow under the device's foot.
        sw, sh = device.shadow.size
        s_scale = ow / device.size[0]
        shadow = device.shadow.resize((max(1, round(sw * s_scale)), max(1, round(sh * s_scale))), Image.BILINEAR)
        shadow = shadow.point(lambda v: round(v * alpha))
        card.paste((0, 0, 0, 255), (round(left + ow / 2 - shadow.width / 2), round(top + oh - shadow.height / 2)), shadow)
        # Only the part of the device inside the card is scaled.
        native = device.native(t)
        k = device.size[0] / ow
        x0, y0 = max(0, -left), max(0, -top)
        x1, y1 = min(ow, card_w - left), min(oh, card_h - top)
        box = (x0 * k, y0 * k, x1 * k, y1 * k)
        size = (max(1, round(x1 - x0)), max(1, round(y1 - y0)))
        layer = native.resize(size, Image.LANCZOS, box=box, reducing_gap=2.0)
        if alpha < 1:
            layer.putalpha(layer.getchannel("A").point(lambda v: round(v * alpha)))
        card.alpha_composite(layer, (round(left + x0), round(top + y0)))
        marks(card, cam, device, t)
    return card


PAGE = Image.new("RGB", (W, H), WHITE)
CARD_MASK = rounded_mask((card_w, card_h), CARD_RADIUS)
EYEBROW = font("display", 23)
HEADLINE = font("display", 54 if PHONE_ONLY else 66)
PILL_FONT = font("text", 19)


def phone_left() -> float:
    """Where the phone's left edge sits on the page: the side text keeps clear of it."""
    x, y, _, _ = devices["phone"].body_world()
    return CARD_BOX[0] + to_card(shot_for("phone"), x, y)[0]


TEXT_X = CARD_BOX[0] + 72


def wrap(d: ImageDraw.ImageDraw, text: str, width: float) -> list[str]:
    lines = [""]
    for word in text.split():
        line = f"{lines[-1]} {word}".strip()
        if lines[-1] and d.textlength(line, font=HEADLINE) > width:
            lines.append(word)
        else:
            lines[-1] = line
    return lines


def text_layer(image: Image.Image, cap: dict, alpha: float, dy: float, eyebrow_alpha: float):
    d = ImageDraw.Draw(image, "RGBA")
    if PHONE_ONLY:
        # Beside the phone, left-aligned and wrapped, the block's middle a little above the card's.
        lines = wrap(d, cap["headline"], phone_left() - 56 - TEXT_X)
        top = H / 2 - 40 - len(lines) * 64 / 2
        d.text((TEXT_X, top - 34), cap["eyebrow"], font=EYEBROW, fill=(*GRAY, round(255 * eyebrow_alpha)), anchor="ls")
        for n, line in enumerate(lines):
            d.text((TEXT_X, top + 12 + n * 64 + dy), line, font=HEADLINE, fill=(*INK, round(255 * alpha)), anchor="lt")
        return
    d.text((W / 2, 52), cap["eyebrow"], font=EYEBROW, fill=(*INK, round(255 * eyebrow_alpha)), anchor="mm")
    d.text((W / 2, 106 + dy), cap["headline"], font=HEADLINE, fill=(*INK, round(255 * alpha)), anchor="mm")


def headline(image: Image.Image, t: float):
    i = max((i for i, c in enumerate(captions) if c["t"] <= t), default=None)
    if i is None:
        return
    cap = captions[i]
    k = (t - cap["t"]) / TEXT_IN_MS
    prev = captions[i - 1] if i > 0 else None
    same_eyebrow = prev is not None and prev["eyebrow"] == cap["eyebrow"]
    out = (t - cap["t"]) / TEXT_OUT_MS
    if prev and out < 1:
        text_layer(image, prev, 1 - ease_out(out), -10 * ease_out(out), 1 if same_eyebrow else 1 - ease_out(out))
    delay = TEXT_OUT_MS * 0.6 / TEXT_IN_MS if prev else 0
    q = ease_out((k - delay) / (1 - delay)) if k > delay else 0
    if q > 0:
        text_layer(image, cap, q, 22 * (1 - q), 1 if same_eyebrow else q)


def outro_pill(image: Image.Image, t: float):
    last = scenes[-1]
    if last["scene"] not in ("wide", "end") or len(scenes) < 2 or t < last["t"] + TRANSITION_MS * 0.7:
        return
    q = ease_out((t - last["t"] - TRANSITION_MS * 0.7) / 600)
    d = ImageDraw.Draw(image, "RGBA")
    label = "github.com/materemias/tern-awui"
    w = d.textlength(label, font=PILL_FONT) + 56
    # Over the stage's devices; under the phone take's headline.
    cx, cy = (TEXT_X + w / 2, H / 2 + 170 + 10 * (1 - q)) if PHONE_ONLY else (W / 2, CARD_BOX[1] + 46 + 10 * (1 - q))
    d.rounded_rectangle((cx - w / 2, cy - 23, cx + w / 2, cy + 23), radius=23, fill=(*BLUE, round(255 * q)))
    d.text((cx, cy), label, font=PILL_FONT, fill=(255, 255, 255, round(255 * q)), anchor="mm")


START = scenes[0]["t"]
END = max(f["t"] for fs in frames.values() for f in fs) + 400
COUNT = int((END - START) / 1000 * FPS) + 1
OUT = WORK / "composed"


def render(n: int):
    t = START + n * 1000 / FPS
    image = PAGE.copy()
    cam = camera(t)
    alpha = ease_out((t - START) / INTRO_MS)
    card = render_card(t, cam, alpha)
    image.paste(card.convert("RGB"), CARD_BOX[:2], CARD_MASK)
    headline(image, t)
    outro_pill(image, t)
    image.save(OUT / f"{n:05d}.png", compress_level=1)


if __name__ == "__main__":
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir()
    with Pool(max(1, (os.cpu_count() or 2) - 2)) as pool:
        # Neighbouring frames share shots, so each worker takes a run of them.
        pool.map(render, range(COUNT), chunksize=max(1, COUNT // ((os.cpu_count() or 2) * 3)))
    DOCS.mkdir(exist_ok=True)
    frames_in = ["-framerate", str(FPS), "-i", str(OUT / "%05d.png")]
    ffmpeg = ["ffmpeg", "-loglevel", "error", "-y"]
    subprocess.run(
        [*ffmpeg, *frames_in, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "slow", "-movflags", "+faststart", str(DOCS / f"{NAME}.mp4")],
        check=True,
    )
    subprocess.run(
        [
            *ffmpeg,
            *frames_in,
            "-filter_complex",
            f"[0]fps=12,scale={GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
            str(DOCS / f"{NAME}.gif"),
        ],
        check=True,
    )
    # The camera moves change every pixel, so the GIF is large; gifsicle, when installed, trims it.
    if shutil.which("gifsicle"):
        subprocess.run(["gifsicle", "-O3", "--lossy=40", "--batch", str(DOCS / f"{NAME}.gif")], check=True)
    print(f"{COUNT} frames, {COUNT / FPS:.1f} s -> {DOCS / f'{NAME}.gif'}, {DOCS / f'{NAME}.mp4'}")
