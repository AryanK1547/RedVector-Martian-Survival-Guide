"""CTX optical imagery (NASA MRO Context Camera) from NASA Mars Trek, for each app region.

Layer: Gale_CTX_BlockAdj_dd ("Gale Crater Mosaic"), Mars Trek WMTS:
  https://trek.nasa.gov/tiles/Mars/EQ/Gale_CTX_BlockAdj_dd/1.0.0/WMTSCapabilities.xml
Read from the capabilities on 15 Nov: extent 135.1842593..139.2413012 E,
-6.5732988..-2.8077809; geographic tile grid (EPSG::104905, top-left -180, 90),
256 px tiles, level z has 2^(z+1) x 2^z tiles, so one pixel = 180 / (256 * 2^z) deg.

MapLibre raster tiles must be Web Mercator, so instead of streaming these tiles
we fetch the few that cover each region once, cache them in data-raw/ctx/tiles,
and cut out an image aligned to the region's bounds (both grids are plain
latitude/longitude, so this is a crop plus nearest-neighbour resampling).
Run from the repo root:  python tools/prepare_ctx.py
"""

import io
import json
import math
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[1]
CACHE = REPO_ROOT / "data-raw" / "ctx" / "tiles"
LAYER = "Gale_CTX_BlockAdj_dd"
TILE_URL = "https://trek.nasa.gov/tiles/Mars/EQ/Gale_CTX_BlockAdj_dd/1.0.0/default/default028mm/{z}/{row}/{col}.png"
CAPS_URL = "https://trek.nasa.gov/tiles/Mars/EQ/Gale_CTX_BlockAdj_dd/1.0.0/WMTSCapabilities.xml"
EXTENT = (135.1842593, 139.2413012, -6.5732988, -2.8077809)  # lon_min, lon_max, lat_min, lat_max
HEADERS = {"User-Agent": "Mozilla/5.0 (data preparation script)"}

# region folder -> zoom level (finest the region needs; 12 is the deepest level offered)
REGIONS = {
    REPO_ROOT / "web" / "public" / "data" / "local": 12,
    REPO_ROOT / "web" / "public" / "data": 7,
}


def tile(z: int, row: int, col: int) -> Image.Image | None:
    path = CACHE / str(z) / str(row) / f"{col}.png"
    if not path.exists():
        req = urllib.request.Request(TILE_URL.format(z=z, row=row, col=col), headers=HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None  # outside the mosaic
            raise
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return Image.open(path).convert("L")


def build(region: Path, z: int) -> dict:
    c = json.loads((region / "meta.json").read_text(encoding="utf-8"))["crop"]
    deg = 180.0 / (256 * 2**z)  # degrees per pixel at this level
    # Global pixel range covering the region bounds.
    x0 = math.floor((c["lon_left"] + 180.0) / deg)
    x1 = math.ceil((c["lon_right"] + 180.0) / deg)
    y0 = math.floor((90.0 - c["lat_top"]) / deg)
    y1 = math.ceil((90.0 - c["lat_bottom"]) / deg)
    mosaic = np.zeros((y1 - y0, x1 - x0), dtype=np.uint8)
    have = np.zeros_like(mosaic, dtype=bool)
    fetched = 0
    for row in range(y0 // 256, (y1 - 1) // 256 + 1):
        for col in range(x0 // 256, (x1 - 1) // 256 + 1):
            img = tile(z, row, col)
            if img is None:
                continue
            fetched += 1
            t = np.array(img)
            # Overlap of this tile with the mosaic window, in global pixels.
            gx0, gy0 = col * 256, row * 256
            ax0, ay0 = max(gx0, x0), max(gy0, y0)
            ax1, ay1 = min(gx0 + 256, x1), min(gy0 + 256, y1)
            mosaic[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = t[ay0 - gy0:ay1 - gy0, ax0 - gx0:ax1 - gx0]
            have[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = True
    # Output at the mosaic's own resolution, cut exactly to the region bounds.
    w = round((c["lon_right"] - c["lon_left"]) / deg)
    h = round((c["lat_top"] - c["lat_bottom"]) / deg)
    lon = c["lon_left"] + (np.arange(w) + 0.5) * (c["lon_right"] - c["lon_left"]) / w
    lat = c["lat_top"] - (np.arange(h) + 0.5) * (c["lat_top"] - c["lat_bottom"]) / h
    cx = np.clip(np.floor((lon + 180.0) / deg).astype(int) - x0, 0, mosaic.shape[1] - 1)
    cy = np.clip(np.floor((90.0 - lat) / deg).astype(int) - y0, 0, mosaic.shape[0] - 1)
    gray = mosaic[cy][:, cx]
    inside = (
        have[cy][:, cx]
        & (lon[None, :] >= EXTENT[0]) & (lon[None, :] <= EXTENT[1])
        & (lat[:, None] >= EXTENT[2]) & (lat[:, None] <= EXTENT[3])
    )
    rgba = np.dstack([gray, gray, gray, np.where(inside, 255, 0).astype(np.uint8)])
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=True)
    (region / "ctx.png").write_bytes(buf.getvalue())
    info = {
        "kind": "visualization",
        "dataset": "MRO CTX Gale Crater mosaic (Gale_CTX_BlockAdj_dd), NASA Mars Trek",
        "capabilities": CAPS_URL,
        "zoom_level": z,
        "metres_per_pixel_approx": round(deg * math.pi / 180 * 3396190, 1),
        "coverage_percent": round(100.0 * inside.mean(), 1),
        "note": "optical image only; elevation and slope come from the DEM, not from this image",
    }
    (region / "ctx.json").write_text(json.dumps(info, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{region.relative_to(REPO_ROOT)}: z{z} ({info['metres_per_pixel_approx']} m/px), {fetched} tiles, "
          f"ctx.png {w}x{h} {len(buf.getvalue())} bytes, covers {info['coverage_percent']}%")
    return info


def main() -> None:
    for region, z in REGIONS.items():
        build(region, z)


if __name__ == "__main__":
    main()
