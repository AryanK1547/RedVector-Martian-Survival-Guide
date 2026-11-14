"""Global Mars overview image from the full MOLA MEGDR grid (NASA MGS).

MapLibre stretches an image linearly in Web Mercator. Over a few degrees that
is harmless, but for the whole planet an equirectangular image would be badly
misplaced away from the equator, so each output row is resampled from the
latitude that Web Mercator puts there. Web Mercator stops at +-85.0511 deg.

Output: web/public/data/mars/mars.jpg (visualization only: colour = elevation,
shading = hillshade) and mars.json (bounds, source, sites).
Run from the repo root:  python tools/prepare_mars.py
"""

import io
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

from coords import PIXEL_SIZE_M, PIXELS_PER_DEGREE
from prepare_data import gradients_for, load_raster, shade_from_gradients

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = REPO_ROOT / "web" / "public" / "data" / "mars"
BLOCK = 8  # 32 px/deg -> 4 px/deg (about 15 km per pixel), block mean
SIZE = 1440  # output is SIZE x SIZE in Web Mercator
MERC_MAX_LAT = 85.0511287798
EXAGGERATION = 20.0  # visualization only: relief is tiny at 15 km per pixel

# Elevation colour stops (metres -> RGB), visual choice.
STOPS = [(-8000, (20, 40, 110)), (-4000, (60, 110, 170)), (-1000, (150, 120, 90)), (2000, (200, 150, 100)), (8000, (240, 220, 200)), (21000, (255, 255, 255))]

SITES = [
    {
        "id": "boxwork",
        "name": "Mount Sharp boxwork, Gale Crater (Curiosity)",
        "lat": -4.804603677,
        "lon": 137.379357484,
        "region": "boxwork",
        "source": "NASA PDS MSL PLACES (verified waypoint boxwork_ridge_top)",
    },
    {
        "id": "jezero",
        "name": "Jezero Crater (Perseverance) - approximate",
        "lat": 18.0,
        "lon": 77.0,
        "region": None,
        "source": "NASA JPL Mars 2020 press kit: landing site at roughly 18 N, 77 E (rounded; no local data in MarsWalk yet)",
    },
]


def colour(elev: np.ndarray) -> np.ndarray:
    xs = np.array([s[0] for s in STOPS], dtype=np.float64)
    out = np.empty(elev.shape + (3,), dtype=np.float64)
    for ch in range(3):
        out[..., ch] = np.interp(elev, xs, [s[1][ch] for s in STOPS])
    return out


def main() -> None:
    full = load_raster().astype(np.float32)
    h, w = full.shape
    small = full.reshape(h // BLOCK, BLOCK, w // BLOCK, BLOCK).mean(axis=(1, 3))
    del full
    ppd = PIXELS_PER_DEGREE / BLOCK
    row_lat = 90.0 - (np.arange(small.shape[0]) + 0.5) / ppd
    dz_dx, dz_dy = gradients_for(small, row_lat, PIXEL_SIZE_M * BLOCK)
    shade = shade_from_gradients(dz_dx, dz_dy, EXAGGERATION)
    rgb = colour(small) * (0.35 + 0.65 * shade[..., None])

    # Web Mercator rows -> latitude; columns -> longitude -180..180 (source is 0..360 east).
    y = (np.arange(SIZE) + 0.5) / SIZE
    lat = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * y))))
    lon = -180.0 + (np.arange(SIZE) + 0.5) * 360.0 / SIZE
    src_r = np.clip(np.floor((90.0 - lat) * ppd).astype(int), 0, small.shape[0] - 1)
    src_c = np.clip(np.floor((lon % 360.0) * ppd).astype(int), 0, small.shape[1] - 1)
    merc = np.rint(np.clip(rgb[src_r][:, src_c], 0, 255)).astype(np.uint8)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    Image.fromarray(merc, "RGB").save(buf, format="JPEG", quality=85, optimize=False)
    (OUT_DIR / "mars.jpg").write_bytes(buf.getvalue())
    meta = {
        "image": "mars.jpg",
        "bounds": {"lon_left": -180.0, "lon_right": 180.0, "lat_top": MERC_MAX_LAT, "lat_bottom": -MERC_MAX_LAT},
        "projection": "Web Mercator (resampled from MOLA equirectangular, nearest neighbour)",
        "source": "NASA MGS MOLA MEGDR megt90n000fb, PDS Geosciences Node, block-mean to 4 px/deg (about 15 km)",
        "visualization": f"colour = elevation, shading = hillshade with {EXAGGERATION}x vertical exaggeration; not data",
        "sites": SITES,
    }
    (OUT_DIR / "mars.json").write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"downsampled {small.shape[1]}x{small.shape[0]} ({ppd:.0f} px/deg), elevation {small.min():.0f}..{small.max():.0f} m")
    print(f"wrote mars/mars.jpg {SIZE}x{SIZE}, {len(buf.getvalue())} bytes; mars.json with {len(SITES)} sites")


if __name__ == "__main__":
    main()
