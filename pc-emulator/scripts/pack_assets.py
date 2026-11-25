#!/usr/bin/env python3
"""
Processes official downloaded game artwork/logos into pc-emulator/assets/media/
and packs pc-emulator/assets/media/* + pc-emulator/web/* into pc-emulator/src/embedded_assets.h.
"""
import os
import sys
from pathlib import Path
from collections import deque

# Allow using /tmp/py-env if Pillow is installed there
if os.path.isdir("/tmp/py-env") and "/tmp/py-env" not in sys.path:
    sys.path.insert(0, "/tmp/py-env")

from PIL import Image, ImageOps

REPO_ROOT = Path(__file__).resolve().parents[2]
IMG_SRC = REPO_ROOT / "image-search"
MEDIA_OUT = REPO_ROOT / "pc-emulator" / "assets" / "media"
WEB_DIR = REPO_ROOT / "pc-emulator" / "web"
HEADER_OUT = REPO_ROOT / "pc-emulator" / "src" / "embedded_assets.h"


def trim_alpha(im: Image.Image, pad: int = 4) -> Image.Image:
    im = im.convert("RGBA")
    bbox = im.getbbox()
    if not bbox:
        return im
    x0, y0, x1, y1 = bbox
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(im.width, x1 + pad)
    y1 = min(im.height, y1 + pad)
    return im.crop((x0, y0, x1, y1))


def trim_black_bars(im: Image.Image, threshold: int = 16) -> Image.Image:
    rgb = im.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    left, right = 0, w - 1
    while left < right:
        col_max = max(max(px[left, y]) for y in range(0, h, 4))
        if col_max > threshold:
            break
        left += 1
    while right > left:
        col_max = max(max(px[right, y]) for y in range(0, h, 4))
        if col_max > threshold:
            break
        right -= 1
    top, bottom = 0, h - 1
    while top < bottom:
        row_max = max(max(px[x, top]) for x in range(left, right + 1, 4))
        if row_max > threshold:
            break
        top += 1
    while bottom > top:
        row_max = max(max(px[x, bottom]) for x in range(left, right + 1, 4))
        if row_max > threshold:
            break
        bottom -= 1
    return im.crop((left, top, right + 1, bottom + 1))


def flood_remove_white_bg(im: Image.Image, tol: int = 235) -> Image.Image:
    """Flood-fills outer white background to transparent while preserving interior white letters."""
    rgba = im.convert("RGBA")
    w, h = rgba.size
    px = rgba.load()
    visited = [[False] * h for _ in range(w)]
    q = deque()

    def is_bg(r, g, b, a):
        return a < 20 or (r >= tol and g >= tol and b >= tol)

    for x in range(w):
        for y in (0, h - 1):
            if is_bg(*px[x, y]):
                visited[x][y] = True
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not visited[x][y] and is_bg(*px[x, y]):
                visited[x][y] = True
                q.append((x, y))

    while q:
        x, y = q.popleft()
        px[x, y] = (0, 0, 0, 0)
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h and not visited[nx][ny]:
                if is_bg(*px[nx, ny]):
                    visited[nx][ny] = True
                    q.append((nx, ny))

    # Feather 1px anti-aliased white fringes touching transparent pixels
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            r, g, b, a = px[x, y]
            if a > 0 and r > 200 and g > 200 and b > 200:
                if (px[x - 1, y][3] == 0 or px[x + 1, y][3] == 0 or
                        px[x, y - 1][3] == 0 or px[x, y + 1][3] == 0):
                    px[x, y] = (r, g, b, 45)
    return trim_alpha(rgba)


def recolor_dark_ink_logo(im: Image.Image, color=(232, 200, 114)) -> Image.Image:
    """Converts a dark-ink-on-white logo into a crisp colored transparent RGBA logo."""
    gray = im.convert("L")
    w, h = gray.size
    gpx = gray.load()
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    opx = out.load()
    for y in range(h):
        for x in range(w):
            v = gpx[x, y]
            alpha = max(0, min(255, int((242 - v) * 1.15)))
            if alpha > 12:
                opx[x, y] = (color[0], color[1], color[2], alpha)
    return trim_alpha(out)


def invert_alpha_logo_to_white(im: Image.Image) -> Image.Image:
    """Turns a black-ink transparent PNG logo into crisp white-on-transparent PNG."""
    rgba = im.convert("RGBA")
    w, h = rgba.size
    px = rgba.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 0:
                px[x, y] = (248, 250, 255, a)
    return trim_alpha(rgba)


def save_square_thumb(src: Path, out: Path, size: int = 340, quality: int = 80, crop_bars: bool = False):
    im = Image.open(src).convert("RGB")
    if crop_bars:
        im = trim_black_bars(im)
    im = ImageOps.fit(im, (size, size), method=Image.Resampling.LANCZOS, centering=(0.5, 0.35))
    im.save(out, "JPEG", quality=quality, optimize=True)


def save_hero(src: Path, out: Path, w: int = 1024, h: int = 576, quality: int = 76, crop_bars: bool = False):
    im = Image.open(src).convert("RGB")
    if crop_bars:
        im = trim_black_bars(im)
    im = ImageOps.fit(im, (w, h), method=Image.Resampling.LANCZOS, centering=(0.5, 0.35))
    im.save(out, "JPEG", quality=quality, optimize=True)


def save_logo(im: Image.Image, out: Path, max_w: int = 440, max_h: int = 180):
    im = trim_alpha(im)
    im.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
    im.save(out, "PNG", optimize=True)


def process_media():
    MEDIA_OUT.mkdir(parents=True, exist_ok=True)
    if not IMG_SRC.is_dir():
        print("[pack_assets] image-search/ not present, skipping image regeneration.")
        return

    print("[pack_assets] Processing real official game art & logos...")

    # 1. Grand Theft Auto VI
    save_square_thumb(IMG_SRC / "grand-theft-auto-vi-jason-lucia-official-1.webp", MEDIA_OUT / "gta6_thumb.jpg")
    save_hero(IMG_SRC / "grand-theft-auto-vi-jason-lucia-official-1.webp", MEDIA_OUT / "gta6_hero.jpg")
    save_logo(Image.open(IMG_SRC / "grand-theft-auto-vi-official-cover-art-l-1.png"), MEDIA_OUT / "gta6_logo.png")

    # 2. Grand Theft Auto V
    save_square_thumb(IMG_SRC / "grand-theft-auto-v-official-cover-art-th-1.jpg", MEDIA_OUT / "gta5_thumb.jpg", crop_bars=True)
    save_hero(IMG_SRC / "grand-theft-auto-v-los-santos-official-w-2.jpg", MEDIA_OUT / "gta5_hero.jpg")
    save_logo(Image.open(IMG_SRC / "grand-theft-auto-v-official-logo-transpa-2.png"), MEDIA_OUT / "gta5_logo.png")

    # 3. Marvel's Spider-Man 2
    save_square_thumb(IMG_SRC / "marvels-spider-man-2-ps5-game-key-art-bo-2.jpg", MEDIA_OUT / "spiderman2_thumb.jpg")
    save_hero(IMG_SRC / "marvels-spider-man-2-ps5-game-key-art-bo-2.jpg", MEDIA_OUT / "spiderman2_hero.jpg")
    save_logo(Image.open(IMG_SRC / "marvels-spider-man-2-official-game-logo--1.png"), MEDIA_OUT / "spiderman2_logo.png")

    # 4. God of War Ragnarok
    save_square_thumb(IMG_SRC / "god-of-war-ragnarok-official-key-art-kra-1.jpg", MEDIA_OUT / "gow_thumb.jpg")
    save_hero(IMG_SRC / "god-of-war-ragnarok-official-key-art-kra-2.jpg", MEDIA_OUT / "gow_hero.jpg")
    save_logo(Image.open(IMG_SRC / "god-of-war-ragnarok-official-game-logo-p-1.png"), MEDIA_OUT / "gow_logo.png")

    # 5. The Last of Us Part II Remastered
    save_square_thumb(IMG_SRC / "the-last-of-us-part-ii-remastered-offici-1.jpg", MEDIA_OUT / "tlou2_thumb.jpg")
    save_hero(IMG_SRC / "the-last-of-us-part-ii-remastered-offici-1.jpg", MEDIA_OUT / "tlou2_hero.jpg")
    save_logo(invert_alpha_logo_to_white(Image.open(IMG_SRC / "the-last-of-us-part-ii-official-game-log-1.png")), MEDIA_OUT / "tlou2_logo.png")

    # 6. Elden Ring
    save_square_thumb(IMG_SRC / "elden-ring-logo-playstation-store-png-1.jpg", MEDIA_OUT / "eldenring_thumb.jpg")
    save_hero(IMG_SRC / "elden-ring-logo-playstation-store-png-1.jpg", MEDIA_OUT / "eldenring_hero.jpg")
    save_logo(recolor_dark_ink_logo(Image.open(IMG_SRC / "elden-ring-seeklogo-png-1.png"), (236, 206, 122)), MEDIA_OUT / "eldenring_logo.png")

    # 7. Cyberpunk 2077: Phantom Liberty
    save_square_thumb(IMG_SRC / "cyberpunk-2077-phantom-liberty-official--1.jpg", MEDIA_OUT / "cyberpunk_thumb.jpg")
    save_hero(IMG_SRC / "cyberpunk-2077-phantom-liberty-official--1.jpg", MEDIA_OUT / "cyberpunk_hero.jpg")
    save_logo(Image.open(IMG_SRC / "cyberpunk-2077-logo-wikimedia-png-2.png"), MEDIA_OUT / "cyberpunk_logo.png")

    # 8. Red Dead Redemption 2
    save_square_thumb(IMG_SRC / "red-dead-redemption-2-official-cover-art-2.jpg", MEDIA_OUT / "rdr2_thumb.jpg")
    save_hero(IMG_SRC / "red-dead-redemption-2-official-cover-art-1.webp", MEDIA_OUT / "rdr2_hero.jpg")
    save_logo(flood_remove_white_bg(Image.open(IMG_SRC / "red-dead-redemption-2-official-logo-png-1.png")), MEDIA_OUT / "rdr2_logo.png")

    # 9. Halo Infinite (Xbox)
    save_square_thumb(IMG_SRC / "halo-infinite-official-key-art-cover-xbo-1.jpg", MEDIA_OUT / "halo_thumb.jpg", crop_bars=True)
    save_hero(IMG_SRC / "halo-infinite-official-key-art-cover-xbo-1.jpg", MEDIA_OUT / "halo_hero.jpg", crop_bars=True)

    # 10. Forza Horizon 5 (Xbox)
    save_square_thumb(IMG_SRC / "forza-horizon-5-official-cover-art-key-a-1.jpg", MEDIA_OUT / "forza_thumb.jpg")
    save_hero(IMG_SRC / "forza-horizon-5-official-cover-art-key-a-1.jpg", MEDIA_OUT / "forza_hero.jpg")
    save_logo(flood_remove_white_bg(Image.open(IMG_SRC / "forza-horizon-5-logo-png-transparent-1.png")), MEDIA_OUT / "forza_logo.png")

    total = sum(p.stat().st_size for p in MEDIA_OUT.iterdir() if p.is_file())
    print(f"[pack_assets] Processed {len(list(MEDIA_OUT.iterdir()))} media files ({total/1024:.1f} KB total)")


def guess_mime(name: str) -> str:
    ext = Path(name).suffix.lower()
    return {
        ".html": "text/html; charset=utf-8",
        ".js":   "application/javascript; charset=utf-8",
        ".css":  "text/css; charset=utf-8",
        ".svg":  "image/svg+xml",
        ".png":  "image/png",
        ".jpg":  "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".json": "application/json; charset=utf-8",
    }.get(ext, "application/octet-stream")


def pack_header():
    entries = []
    # Web assets
    if WEB_DIR.is_dir():
        for p in sorted(WEB_DIR.iterdir()):
            if p.is_file():
                url_path = "/vbx/" + p.name
                entries.append((url_path, guess_mime(p.name), p.read_bytes()))
    # Media assets
    if MEDIA_OUT.is_dir():
        for p in sorted(MEDIA_OUT.iterdir()):
            if p.is_file():
                url_path = "/vbx/img/" + p.name
                entries.append((url_path, guess_mime(p.name), p.read_bytes()))

    lines = [
        "#pragma once",
        "// Auto-generated by pc-emulator/scripts/pack_assets.py — DO NOT EDIT MANUALLY",
        "#include <cstddef>",
        "#include <cstring>",
        "",
        "namespace vicebox {",
        "",
        "struct EmbeddedAsset {",
        "    const char* path;",
        "    const char* mime;",
        "    const unsigned char* data;",
        "    std::size_t size;",
        "};",
        "",
    ]

    for idx, (url_path, mime, blob) in enumerate(entries):
        lines.append(f"// {url_path} ({len(blob)} bytes)")
        lines.append(f"static const unsigned char kAssetData_{idx}[] = {{")
        # Emit 20 bytes per line cleanly
        for i in range(0, len(blob), 20):
            chunk = blob[i:i + 20]
            lines.append("    " + ",".join(str(b) for b in chunk) + ",")
        if len(blob) == 0:
            lines.append("    0")
        lines.append("};")
        lines.append("")

    lines.append("static const EmbeddedAsset kEmbeddedAssets[] = {")
    for idx, (url_path, mime, blob) in enumerate(entries):
        lines.append(f'    {{ "{url_path}", "{mime}", kAssetData_{idx}, {len(blob)} }},')
    lines.append("};")
    lines.append("")
    lines.append("inline const EmbeddedAsset* FindEmbeddedAsset(const char* path) {")
    lines.append("    if (!path) return nullptr;")
    lines.append("    for (const auto& a : kEmbeddedAssets) {")
    lines.append("        if (std::strcmp(a.path, path) == 0) return &a;")
    lines.append("    }")
    lines.append("    return nullptr;")
    lines.append("}")
    lines.append("")
    lines.append("} // namespace vicebox")
    lines.append("")

    HEADER_OUT.write_text("\n".join(lines), encoding="utf-8")
    total_bytes = sum(len(b) for _, _, b in entries)
    print(f"[pack_assets] Wrote {HEADER_OUT} ({len(entries)} assets, {total_bytes/1024:.1f} KB raw)")


if __name__ == "__main__":
    if "--pack-only" not in sys.argv:
        process_media()
    pack_header()
