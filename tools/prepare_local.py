"""Local high-resolution map of the Mount Sharp boxwork area.

Source: USGS "MSL Gale Merged DEM 1m" v3 (Calef and Parker 2016, PDS Annex),
a 3.87 GB GeoTIFF built from HiRISE stereo (NASA MRO). Instead of downloading
it, we read only the rows we need with HTTP range requests: the file stores
each row as its own LZW-compressed strip, so one row = one small request.

Window: WINDOW_M x WINDOW_M metres centred on the boxwork_ridge_top waypoint
(web/public/data/waypoints.csv), sampled every STEP_M metres (point sampling:
one 1 m pixel per output cell, no averaging). Downloaded rows are cached in
data-raw/local/ so reruns are offline.

Run from the repo root:  python tools/prepare_local.py
"""

import csv
import json
import math
import struct
import time
import urllib.error
import urllib.request
from pathlib import Path

import imagecodecs
import numpy as np

from prepare_data import (
    HILLSHADE_ALTITUDE_DEG,
    HILLSHADE_AZIMUTH_DEG,
    SLOPE_PNG_MAX_DEG,
    SLOPE_STEP_DEG,
    _png_bytes,
    describe_slope,
    gradients_for,
    shade_from_gradients,
    slope_from_gradients,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
DEM_URL = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif"
DEM_PAGE = "https://astrogeology.usgs.gov/search/map/mars_msl_gale_merged_dem_1m"
CACHE = REPO_ROOT / "data-raw" / "local" / "dem_window.npz"
OUT_DIR = REPO_ROOT / "web" / "public" / "data" / "local"
WAYPOINTS = REPO_ROOT / "web" / "public" / "data" / "waypoints.csv"

# Read from the file header on 14 Nov (see log.txt); checked again at run time.
RADIUS_M = 3_396_190.0  # Mars 2000 sphere
X0, Y0 = 8127993.992786024, -244781.575189438  # upper-left corner of pixel (0, 0), metres
PIXEL_M = 1.0
WIDTH, HEIGHT = 32980, 57440
NODATA = -32767.0

WINDOW_M = 4000
STEP_M = 10
N = WINDOW_M // STEP_M  # output cells per side
CENTER_ID = "boxwork_ridge_top"
HILLSHADE_EXAGGERATION_LOCAL = 1.0  # 10 m cells already show relief; no exaggeration


def fetch(start: int, length: int) -> bytes:
    req = urllib.request.Request(DEM_URL, headers={"Range": f"bytes={start}-{start + length - 1}"})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            # S3 answers 503 "slow down" under load, and long reads can time out;
            # wait and retry. Other HTTP errors (403, 404) are real and re-raised.
            if isinstance(e, urllib.error.HTTPError) and e.code < 500 or attempt == 5:
                raise
            print(f"  retry {attempt + 1} after {type(e).__name__}")
            time.sleep(2**attempt)
    raise RuntimeError("unreachable")


def read_header() -> dict:
    """Return {tag: (type, count, value-or-offset)} of the first image (IFD)."""
    assert fetch(0, 4) == b"II*\x00", "expected a little-endian classic TIFF"
    ifd = struct.unpack("<I", fetch(4, 4))[0]
    buf = fetch(ifd, 2 + 12 * 32)
    n = struct.unpack("<H", buf[:2])[0]
    tags = {}
    for i in range(n):
        tag, typ, count, val = struct.unpack("<HHII", buf[2 + 12 * i: 14 + 12 * i])
        tags[tag] = (typ, count, val)
    return tags


# Registration correction, measured on 15 Nov (see log.txt). With the file's own
# georeferencing, the DEM content sits about 840 m east and 60 m north of where
# MOLA, the Mars Trek CTX mosaic and the PLACES rover positions put it:
# - phase correlation of the DEM hillshade against Mars Trek CTX: 84 cells x 6 cells of 10 m;
# - CTX itself agrees with MOLA at Gale scale (zero shift);
# - at the shifted cells the DEM matches PLACES rover elevations within 9 m and 1.2 m,
#   instead of about 55 m off.
# So every lookup is moved by this many 1 m pixels.
REG_ROWS = -60  # north
REG_COLS = 840  # east


def latlon_to_dem(lat: float, lon: float):
    """(row, col) of the 1 m DEM pixel for (lat, lon) in the MOLA / PLACES frame.
    Equirectangular, centre longitude 0, plus the registration correction above."""
    x = RADIUS_M * math.radians(lon)
    y = RADIUS_M * math.radians(lat)
    return int((Y0 - y) // PIXEL_M) + REG_ROWS, int((x - X0) // PIXEL_M) + REG_COLS


def load_waypoints() -> list[dict]:
    with WAYPOINTS.open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


def window_origin() -> tuple[int, int]:
    """Top-left 1 m pixel (row0, col0) of the window centred on CENTER_ID."""
    wp = next(w for w in load_waypoints() if w["id"] == CENTER_ID)
    row, col = latlon_to_dem(float(wp["latitude_planetocentric"]), float(wp["longitude_east"]))
    return row - WINDOW_M // 2, col - WINDOW_M // 2


def download_window(row0: int, col0: int) -> np.ndarray:
    """Return the N x N sampled window as float64 metres, NaN where the DEM has no data."""
    tags = read_header()
    assert (tags[256][2], tags[257][2]) == (WIDTH, HEIGHT), "DEM size changed"
    assert tags[259][2] == 5 and tags[278][2] == 1, "expected LZW, one row per strip"
    assert 0 <= row0 and row0 + WINDOW_M <= HEIGHT and 0 <= col0 and col0 + WINDOW_M <= WIDTH, "window outside DEM"
    rows = [row0 + STEP_M * i + STEP_M // 2 for i in range(N)]
    cols = np.array([col0 + STEP_M * j + STEP_M // 2 for j in range(N)])
    # The strip offset and byte-count tables hold one 4-byte entry per row; read only our slice.
    span = rows[-1] - rows[0] + 1
    offsets = struct.unpack(f"<{span}I", fetch(tags[273][2] + 4 * rows[0], 4 * span))
    counts = struct.unpack(f"<{span}I", fetch(tags[279][2] + 4 * rows[0], 4 * span))
    out = np.empty((N, N), dtype=np.float64)
    downloaded = 0
    for i, r in enumerate(rows):
        k = r - rows[0]
        raw = imagecodecs.lzw_decode(fetch(offsets[k], counts[k]))
        line = np.frombuffer(raw, dtype="<f4", count=WIDTH)
        out[i] = line[cols]
        downloaded += counts[k]
        if (i + 1) % 50 == 0:
            print(f"  rows {i + 1}/{N}, {downloaded / 1e6:.1f} MB downloaded")
    out[out == NODATA] = np.nan
    return out


def load_window(row0: int, col0: int) -> np.ndarray:
    params = np.array([row0, col0, WINDOW_M, STEP_M])
    if CACHE.exists():
        cached = np.load(CACHE)
        if np.array_equal(cached["params"], params):
            print(f"using cache {CACHE.relative_to(REPO_ROOT)}")
            return cached["elevation"]
    print(f"downloading {N} rows of the USGS MSL Gale 1 m DEM (range requests)...")
    elev = download_window(row0, col0)
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(CACHE, params=params, elevation=elev)
    return elev


def bounds(row0: int, col0: int) -> dict:
    """Edges of the window in degrees (pixel corners, PixelIsArea), in the corrected
    MOLA / PLACES frame: the registration offset is removed before converting."""
    deg = lambda m: math.degrees(m / RADIUS_M)
    r0, c0 = row0 - REG_ROWS, col0 - REG_COLS
    return {
        "lat_top": deg(Y0 - r0 * PIXEL_M),
        "lat_bottom": deg(Y0 - (r0 + WINDOW_M) * PIXEL_M),
        "lon_left": deg(X0 + c0 * PIXEL_M),
        "lon_right": deg(X0 + (c0 + WINDOW_M) * PIXEL_M),
    }


def build_assets(elev: np.ndarray, row0: int, col0: int) -> dict:
    b = bounds(row0, col0)
    cell_deg = math.degrees(STEP_M / RADIUS_M)
    row_lat = b["lat_top"] - (np.arange(N) + 0.5) * cell_deg
    dz_dx, dz_dy = gradients_for(elev, row_lat, float(STEP_M))
    slope = slope_from_gradients(dz_dx, dz_dy, elev)
    shade = shade_from_gradients(dz_dx, dz_dy, HILLSHADE_EXAGGERATION_LOCAL)
    if np.isnan(elev).any():
        raise ValueError("window contains DEM NoData; move or shrink it")

    meta = {
        "version": 1,
        "source": {
            "dataset": "USGS MSL Gale Merged DEM 1m v3 (Calef and Parker 2016, PDS Annex), from NASA MRO HiRISE stereo",
            "url": DEM_PAGE,
            "file": DEM_URL,
            "elevation_meaning": "DEM value as stored in the file, meters; window registered to the MOLA / PLACES frame by a measured offset of 840 m east and 60 m north (see REG_ROWS / REG_COLS)",
            "latitude_type": "planetocentric (sphere R = 3396190 m)",
            "longitude": "degrees east",
        },
        "crop": {
            "name": "Mount Sharp boxwork area (local)",
            "center_waypoint": CENTER_ID,
            "dem_row0": row0,
            "dem_col0": col0,
            "row0": 0,
            "rows": N,
            "cols": N,
            **b,
        },
        "grid": {
            "pixels_per_degree": 1.0 / cell_deg,
            "pixel_size_m": float(STEP_M),
            "row_spacing_m": float(STEP_M),
            "col_spacing_method": "pixel_size_m * cos(latitude of the row)",
            "sampling": f"point sample of one 1 m DEM pixel per {STEP_M} m cell (pixel {STEP_M // 2} of the block), no averaging",
            "nodata": None,
        },
        "files": {
            "elevation.bin": {"dtype": "<f4", "shape": [N, N], "order": "row-major, north row first", "units": "meters"},
            "slope.bin": {"dtype": "uint8", "shape": [N, N], "degrees_per_step": SLOPE_STEP_DEG,
                          "note": f"slope in degrees = value * degrees_per_step; computed at {STEP_M} m per cell"},
            "slope.png": {"kind": "visualization", "grayscale_max_degrees": SLOPE_PNG_MAX_DEG},
            "hillshade.png": {"kind": "visualization", "azimuth_deg": HILLSHADE_AZIMUTH_DEG,
                              "altitude_deg": HILLSHADE_ALTITUDE_DEG, "vertical_exaggeration": HILLSHADE_EXAGGERATION_LOCAL},
        },
    }
    return {
        "elevation.bin": elev.astype("<f4").tobytes(),
        "slope.bin": np.rint(slope / SLOPE_STEP_DEG).astype(np.uint8).tobytes(),
        "slope.png": _png_bytes(np.rint(np.clip(slope, 0, SLOPE_PNG_MAX_DEG) * 255 / SLOPE_PNG_MAX_DEG).astype(np.uint8)),
        "hillshade.png": _png_bytes(np.rint(shade * 255).astype(np.uint8)),
        "meta.json": (json.dumps(meta, indent=2, sort_keys=True) + "\n").encode("utf-8"),
    }, slope


def main() -> None:
    row0, col0 = window_origin()
    elev = load_window(row0, col0)
    print(f"window  dem row0={row0} col0={col0}, {N}x{N} cells of {STEP_M} m ({WINDOW_M / 1000:.0f} km square)")
    print(f"bounds  {bounds(row0, col0)}")
    print(f"elev    min {np.nanmin(elev):.1f}  max {np.nanmax(elev):.1f} m, NoData cells {int(np.isnan(elev).sum())}")
    assets, slope = build_assets(elev, row0, col0)
    describe_slope(slope)
    for w in load_waypoints():
        r, c = latlon_to_dem(float(w["latitude_planetocentric"]), float(w["longitude_east"]))
        i, j = (r - row0) // STEP_M, (c - col0) // STEP_M
        print(f"waypoint {w['id']:20s} cell ({i}, {j})  DEM {elev[i, j]:.1f} m  PLACES {float(w['elevation_m']):.1f} m")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    total = 0
    for name, data in assets.items():
        (OUT_DIR / name).write_bytes(data)
        total += len(data)
        print(f"wrote local/{name:14s} {len(data):8d} bytes")
    print(f"total {total} bytes")


if __name__ == "__main__":
    main()
