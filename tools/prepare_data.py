"""MarsWalk data preparation.

Step 1 of P1: read the raw MOLA raster and check it matches what we verified.
Later steps (NoData, crop, slope, export) are added to this file one at a time.
"""

import io
import json
from pathlib import Path

import numpy as np
from PIL import Image

from coords import METERS_PER_DEGREE, PIXEL_SIZE_M, PIXELS_PER_DEGREE, latlon_to_pixel

# Paths are built from this file's location, so the script works from any
# working directory and on Windows, macOS and Linux.
REPO_ROOT = Path(__file__).resolve().parents[1]
RAW_FILE = REPO_ROOT / "data-raw" / "megt90n000fb.img"

# Facts from the ENVI header, verified by the human before the event.
WIDTH = 11520   # samples (columns)
HEIGHT = 5760   # lines (rows)
DTYPE = ">i2"   # 16-bit signed integer, most-significant byte first


def load_raster(path: Path = RAW_FILE) -> np.ndarray:
    """Return the MOLA elevation grid as a (HEIGHT, WIDTH) int16 array (meters).

    np.fromfile reads raw bytes and reinterprets them with the given dtype.
    reshape then lays the flat list of numbers out as rows and columns.
    """
    if not path.exists():
        raise FileNotFoundError(
            f"Raw file not found: {path}\n"
            "Place megt90n000fb.img (and its .hdr) in data-raw/ first."
        )
    flat = np.fromfile(path, dtype=DTYPE)
    expected = WIDTH * HEIGHT
    if flat.size != expected:
        raise ValueError(f"Expected {expected} values, got {flat.size}")
    return flat.reshape(HEIGHT, WIDTH)


def summarize(grid: np.ndarray) -> None:
    """Print only small facts about the grid, never the grid itself."""
    print(f"numpy   {np.__version__}")
    print(f"shape   {grid.shape}")
    print(f"count   {grid.size}")
    print(f"min     {int(grid.min())}")
    print(f"max     {int(grid.max())}")


# --- Step 4: the Gale Crater crop -----------------------------------------
# Gale Crater values as supplied by the human on 14 Nov, quoted from the USGS
# Gazetteer of Planetary Nomenclature (Mars). PROVISIONAL: the AI could not
# fetch the Gazetteer entry itself, so the human must confirm these against
# https://planetarynames.wr.usgs.gov/ before they are treated as verified.
GALE_LAT = -5.37  # degrees, south negative
GALE_LON = 137.81  # degrees east, 0-360
GALE_BBOX = (-6.67, -4.07, 136.51, 139.12)  # lat_min, lat_max, lon_min, lon_max
GALE_SOURCE = "USGS Gazetteer of Planetary Nomenclature (human-supplied, not AI-verified)"

# 256 pixels at 32 px/deg = 8 degrees = about 470 km, inside the 400-600 km goal.
CROP_SIZE = 256


def crop_window(lat: float = GALE_LAT, lon: float = GALE_LON, size: int = CROP_SIZE):
    """Return (row0, col0): top-left pixel of a size x size window centered on (lat, lon).

    Working in whole pixels keeps the window aligned with the raster, so
    crop bounds in degrees are exact multiples of 1/32.
    """
    row, col = latlon_to_pixel(lat, lon)
    return row - size // 2, col - size // 2


def crop_gale(grid: np.ndarray):
    """Cut the Gale window out of the full raster. Returns (crop, row0, col0)."""
    row0, col0 = crop_window()
    if row0 < 0 or col0 < 0 or row0 + CROP_SIZE > grid.shape[0] or col0 + CROP_SIZE > grid.shape[1]:
        raise ValueError("crop window falls outside the raster")
    # .copy() so the crop owns its memory and the full 133 MB grid can be freed.
    return grid[row0:row0 + CROP_SIZE, col0:col0 + CROP_SIZE].copy(), row0, col0


def crop_bounds_degrees(row0: int, col0: int, size: int = CROP_SIZE):
    """Edges of the window in degrees: (lat_top, lat_bottom, lon_left, lon_right)."""
    return (
        90.0 - row0 / PIXELS_PER_DEGREE,
        90.0 - (row0 + size) / PIXELS_PER_DEGREE,
        col0 / PIXELS_PER_DEGREE,
        (col0 + size) / PIXELS_PER_DEGREE,
    )


def describe_crop(crop: np.ndarray, row0: int, col0: int) -> None:
    """Print only small facts about the crop."""
    lat_top, lat_bottom, lon_left, lon_right = crop_bounds_degrees(row0, col0, crop.shape[0])
    mid_lat = (lat_top + lat_bottom) / 2.0
    # North-south extent: degrees * metres per degree. East-west shrinks with cos(lat).
    ns_km = (lat_top - lat_bottom) * METERS_PER_DEGREE / 1000.0
    ew_km = (lon_right - lon_left) * METERS_PER_DEGREE * np.cos(np.radians(mid_lat)) / 1000.0
    print(f"crop window  row0={row0} col0={col0} shape={crop.shape}")
    print(f"crop lat     {lat_bottom:.4f} .. {lat_top:.4f}")
    print(f"crop lon     {lon_left:.4f} .. {lon_right:.4f}")
    print(f"crop size    {ns_km:.0f} km north-south x {ew_km:.0f} km east-west")
    print(f"crop min/max {int(crop.min())} / {int(crop.max())} m")
    print(f"crop zeros   {int((crop == 0).sum())} (valid elevation, not masked)")
    print(f"gale source  {GALE_SOURCE}")


# --- Step 5: slope ----------------------------------------------------------
def compute_slope(elevation: np.ndarray, row0: int) -> np.ndarray:
    """Slope in degrees (0 = flat, 90 = vertical) for an elevation window.

    Slope is rise over run. np.gradient gives the elevation change per pixel
    along rows and columns; dividing by the ground distance per pixel gives
    metres of rise per metre of run.
    - North-south ground distance per pixel is constant (PIXEL_SIZE_M).
    - East-west ground distance per pixel SHRINKS with cos(latitude), because
      meridians converge toward the poles. Using one constant for both would
      under-state east-west slopes away from the equator.
    row0 is the window's first row in the full raster, which fixes each row's
    latitude (pixel centers).

    NoData: this file has none (see log.txt, PDS label), so nothing is masked.
    If a grid does contain NaN, it propagates into the cells that touch it
    instead of producing fake slopes from made-up values.
    """
    dz_dx, dz_dy = _gradients(elevation, row0)
    return slope_from_gradients(dz_dx, dz_dy, elevation)


def gradients_for(elevation: np.ndarray, row_lat_deg: np.ndarray, pixel_size_m: float):
    """Return (dz_dx, dz_dy): metres of rise per metre of run along columns
    (east) and rows (south, because row numbers grow downward), for any
    equirectangular grid whose pixel is pixel_size_m at the equator.
    East-west ground distance per pixel shrinks with cos(latitude of the row).
    """
    elev = elevation.astype(np.float64)
    dx = pixel_size_m * np.cos(np.radians(row_lat_deg))  # metres per pixel, one value per row
    dz_dy = np.gradient(elev, axis=0) / pixel_size_m
    dz_dx = np.gradient(elev, axis=1) / dx[:, None]
    return dz_dx, dz_dy


def _gradients(elevation: np.ndarray, row0: int):
    """Gradients for a window of the MOLA grid; row0 fixes each row's latitude (pixel centers)."""
    lat = 90.0 - (row0 + np.arange(elevation.shape[0]) + 0.5) / PIXELS_PER_DEGREE
    return gradients_for(elevation, lat, PIXEL_SIZE_M)


def slope_from_gradients(dz_dx: np.ndarray, dz_dy: np.ndarray, elevation: np.ndarray) -> np.ndarray:
    # arctan turns a rise/run ratio into an angle; hypot combines both directions.
    slope = np.degrees(np.arctan(np.hypot(dz_dx, dz_dy)))
    # np.gradient reads a cell's NEIGHBOURS, never the cell itself, so a NaN
    # cell would otherwise get a made-up slope. Keep masked cells masked.
    slope[np.isnan(elevation)] = np.nan
    return slope


def describe_slope(slope: np.ndarray) -> None:
    """Print only summary statistics of the slope grid."""
    print(f"slope min/max  {np.nanmin(slope):.2f} / {np.nanmax(slope):.2f} deg")
    print(f"slope mean     {np.nanmean(slope):.2f} deg")
    print(f"slope p50/p95/p99  {np.nanpercentile(slope, 50):.2f} / "
          f"{np.nanpercentile(slope, 95):.2f} / {np.nanpercentile(slope, 99):.2f} deg")
    print(f"slope NaN count    {int(np.isnan(slope).sum())}")


# --- Step 6: export small assets for the web app ------------------------------
OUT_DIR = REPO_ROOT / "web" / "public" / "data"
DATA_VERSION = 1

# Visualization settings, NOT data. Recorded in meta.json so the app can say so.
HILLSHADE_AZIMUTH_DEG = 315.0  # light from the north-west (map convention)
HILLSHADE_ALTITUDE_DEG = 45.0
HILLSHADE_EXAGGERATION = 3.0  # terrain is nearly flat at 1.85 km/pixel; this adds contrast
SLOPE_PNG_MAX_DEG = 45.0  # slope.png: 0..45 deg mapped to 0..255, steeper is clipped
SLOPE_STEP_DEG = 0.5  # slope.bin: one uint8 step = 0.5 deg (90 deg = 180, fits in uint8)


def hillshade(elevation: np.ndarray, row0: int) -> np.ndarray:
    """Return shading in 0..1 (1 = fully lit) for the given sun position.

    Idea: a surface facing the sun looks bright. Take the surface normal
    n = (-dz/dx, -dz/dy, 1), a unit vector toward the sun L, and use n.L
    (a dot product) as brightness, clipped at 0 for faces turned away.
    x points east and y north; row numbers grow southward, so dz/dy(north)
    is minus the row gradient.
    """
    return shade_from_gradients(*_gradients(elevation, row0), HILLSHADE_EXAGGERATION)


def shade_from_gradients(dz_dx: np.ndarray, dz_dy_row: np.ndarray, exaggeration: float) -> np.ndarray:
    """Hillshade 0..1 from gradients (see hillshade for the idea)."""
    nx = -dz_dx * exaggeration
    ny = dz_dy_row * exaggeration  # = -(dz/dy_north)
    az = np.radians(HILLSHADE_AZIMUTH_DEG)
    alt = np.radians(HILLSHADE_ALTITUDE_DEG)
    lx, ly, lz = np.sin(az) * np.cos(alt), np.cos(az) * np.cos(alt), np.sin(alt)
    shade = (nx * lx + ny * ly + lz) / np.sqrt(nx * nx + ny * ny + 1.0)
    return np.clip(np.nan_to_num(shade, nan=0.0), 0.0, 1.0)


def _png_bytes(gray: np.ndarray) -> bytes:
    """Encode a uint8 2-D array as a grayscale PNG (no timestamps, so repeatable)."""
    buffer = io.BytesIO()
    Image.fromarray(gray).save(buffer, format="PNG", optimize=False)
    return buffer.getvalue()


def build_assets(full: np.ndarray) -> dict:
    """Return {file name: bytes} for every exported file. Pure function: same
    input gives byte-identical output, which validate.py relies on."""
    crop, row0, col0 = crop_gale(full)
    slope = compute_slope(crop, row0)
    shade = hillshade(crop, row0)
    lat_top, lat_bottom, lon_left, lon_right = crop_bounds_degrees(row0, col0)

    slope_steps = np.rint(slope / SLOPE_STEP_DEG).astype(np.uint8)
    slope_gray = np.rint(np.clip(slope, 0.0, SLOPE_PNG_MAX_DEG) * 255.0 / SLOPE_PNG_MAX_DEG)
    shade_gray = np.rint(shade * 255.0)

    meta = {
        "version": DATA_VERSION,
        "source": {
            "dataset": "MGS MOLA MEGDR topography, megt90n000fb (PDS Geosciences Node)",
            "url": "https://pds-geosciences.wustl.edu/missions/mgs/megdr.html",
            "elevation_meaning": "planetary radius minus areoid (GMM3), meters",
            "latitude_type": "planetocentric",
            "longitude": "degrees east, 0-360",
        },
        "crop": {
            "name": "Gale Crater region",
            "row0": row0,
            "col0": col0,
            "rows": CROP_SIZE,
            "cols": CROP_SIZE,
            "lat_top": lat_top,
            "lat_bottom": lat_bottom,
            "lon_left": lon_left,
            "lon_right": lon_right,
            "center_lat": GALE_LAT,
            "center_lon": GALE_LON,
            "center_source": GALE_SOURCE,
            "center_verified_by_ai": False,
        },
        "grid": {
            "pixels_per_degree": PIXELS_PER_DEGREE,
            "pixel_size_m": PIXEL_SIZE_M,
            "row_spacing_m": PIXEL_SIZE_M,
            "col_spacing_method": "pixel_size_m * cos(latitude of the row), latitude from the row's pixel center",
            "pixel_convention": "grid edge at the upper-left corner; value assumed at pixel center",
            "nodata": None,
            "nodata_note": "PDS label defines no missing-value constant; 0 m is valid elevation",
        },
        "files": {
            "elevation.bin": {
                "dtype": "<i2",
                "shape": [CROP_SIZE, CROP_SIZE],
                "order": "row-major, north row first",
                "units": "meters",
            },
            "slope.bin": {
                "dtype": "uint8",
                "shape": [CROP_SIZE, CROP_SIZE],
                "degrees_per_step": SLOPE_STEP_DEG,
                "note": "slope in degrees = value * degrees_per_step; computed at 1.85 km per pixel, so steep local terrain is under-stated",
            },
            "slope.png": {
                "kind": "visualization",
                "grayscale_max_degrees": SLOPE_PNG_MAX_DEG,
            },
            "hillshade.png": {
                "kind": "visualization",
                "azimuth_deg": HILLSHADE_AZIMUTH_DEG,
                "altitude_deg": HILLSHADE_ALTITUDE_DEG,
                "vertical_exaggeration": HILLSHADE_EXAGGERATION,
                "note": "exaggeration is for contrast only; it is not applied to any data file",
            },
        },
    }
    return {
        "elevation.bin": crop.astype("<i2").tobytes(),
        "slope.bin": slope_steps.tobytes(),
        "slope.png": _png_bytes(slope_gray.astype(np.uint8)),
        "hillshade.png": _png_bytes(shade_gray.astype(np.uint8)),
        "meta.json": (json.dumps(meta, indent=2, sort_keys=True) + "\n").encode("utf-8"),
    }


def write_assets(full: np.ndarray, out_dir: Path = OUT_DIR) -> dict:
    """Write every asset into out_dir and return {file name: size in bytes}."""
    out_dir.mkdir(parents=True, exist_ok=True)
    sizes = {}
    for name, data in build_assets(full).items():
        (out_dir / name).write_bytes(data)
        sizes[name] = len(data)
    return sizes


if __name__ == "__main__":
    full = load_raster()
    summarize(full)
    gale, r0, c0 = crop_gale(full)
    describe_crop(gale, r0, c0)
    describe_slope(compute_slope(gale, r0))
    sizes = write_assets(full)
    for file_name, size in sizes.items():
        print(f"wrote {file_name:14s} {size:8d} bytes")
    print(f"total          {sum(sizes.values()):8d} bytes -> {OUT_DIR.relative_to(REPO_ROOT)}")
