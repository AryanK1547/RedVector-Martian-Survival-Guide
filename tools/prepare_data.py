"""MarsWalk data preparation.

Step 1 of P1: read the raw MOLA raster and check it matches what we verified.
Later steps (NoData, crop, slope, export) are added to this file one at a time.
"""

from pathlib import Path

import numpy as np

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
    elev = elevation.astype(np.float64)
    lat = 90.0 - (row0 + np.arange(elev.shape[0]) + 0.5) / PIXELS_PER_DEGREE
    dx = PIXEL_SIZE_M * np.cos(np.radians(lat))  # metres per pixel, one value per row
    dy = PIXEL_SIZE_M
    dz_dy = np.gradient(elev, axis=0) / dy
    dz_dx = np.gradient(elev, axis=1) / dx[:, None]
    # arctan turns a rise/run ratio into an angle; hypot combines both directions.
    slope = np.degrees(np.arctan(np.hypot(dz_dx, dz_dy)))
    # np.gradient reads a cell's NEIGHBOURS, never the cell itself, so a NaN
    # cell would otherwise get a made-up slope. Keep masked cells masked.
    slope[np.isnan(elev)] = np.nan
    return slope


def describe_slope(slope: np.ndarray) -> None:
    """Print only summary statistics of the slope grid."""
    print(f"slope min/max  {np.nanmin(slope):.2f} / {np.nanmax(slope):.2f} deg")
    print(f"slope mean     {np.nanmean(slope):.2f} deg")
    print(f"slope p50/p95/p99  {np.nanpercentile(slope, 50):.2f} / "
          f"{np.nanpercentile(slope, 95):.2f} / {np.nanpercentile(slope, 99):.2f} deg")
    print(f"slope NaN count    {int(np.isnan(slope).sum())}")


if __name__ == "__main__":
    full = load_raster()
    summarize(full)
    gale, r0, c0 = crop_gale(full)
    describe_crop(gale, r0, c0)
    describe_slope(compute_slope(gale, r0))
