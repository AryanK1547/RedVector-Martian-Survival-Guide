"""Fast checks for the prepared data. Prints PASS / FAIL per check.

Checks are added step by step through P1. Run from the repo root:
    python tools/validate.py
"""

import json
import math
import random
import sys

import numpy as np

from coords import (
    HEIGHT,
    METERS_PER_DEGREE,
    PIXEL_SIZE_M,
    PIXELS_PER_DEGREE,
    WIDTH,
    latlon_to_pixel,
    pixel_to_latlon,
)
from prepare_data import (
    CROP_SIZE,
    GALE_BBOX,
    OUT_DIR,
    build_assets,
    compute_slope,
    crop_bounds_degrees,
    crop_gale,
    crop_window,
    load_raster,
)


def report(name: str, ok: bool, detail: str = "") -> bool:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))
    return ok


def check_pixel_size() -> bool:
    """Header pixel size must match radius * pi/180 / 32 (cross-check)."""
    computed = METERS_PER_DEGREE / PIXELS_PER_DEGREE
    return report(
        "pixel size matches sphere geometry",
        abs(computed - PIXEL_SIZE_M) < 0.01,
        f"computed {computed:.7f} m, header {PIXEL_SIZE_M} m",
    )


def check_round_trip(n: int = 1000) -> bool:
    """pixel -> lat/lon -> pixel must be exact; lat/lon -> pixel -> lat/lon
    must land within one pixel. Seeded, so the result is deterministic."""
    rng = random.Random(26)
    one_pixel = 1.0 / PIXELS_PER_DEGREE
    worst = 0.0
    ok = True
    for _ in range(n):
        row, col = rng.randrange(HEIGHT), rng.randrange(WIDTH)
        lat, lon = pixel_to_latlon(row, col)
        if latlon_to_pixel(lat, lon) != (row, col):
            ok = False

        lat = rng.uniform(-90.0, 90.0)
        lon = rng.uniform(-180.0, 360.0)  # includes negative longitudes
        lat2, lon2 = pixel_to_latlon(*latlon_to_pixel(lat, lon))
        dlon = abs((lon2 - lon + 180.0) % 360.0 - 180.0)  # wrap-safe difference
        worst = max(worst, abs(lat2 - lat), dlon)
    ok = ok and worst <= one_pixel
    return report("coordinate round trip within one pixel", ok, f"worst {worst:.5f} deg")


def check_edges() -> bool:
    """Corners and wrap must not fall off the grid."""
    ok = (
        latlon_to_pixel(90.0, 0.0) == (0, 0)
        and latlon_to_pixel(-90.0, 359.999) == (HEIGHT - 1, WIDTH - 1)
        and latlon_to_pixel(0.0, -10.0) == latlon_to_pixel(0.0, 350.0)
        and latlon_to_pixel(0.0, 360.0) == latlon_to_pixel(0.0, 0.0)
    )
    return report("edges and longitude wrap", ok)


def check_crop() -> bool:
    """The crop window must lie inside the raster and contain Gale's bounding box."""
    row0, col0 = crop_window()
    inside = row0 >= 0 and col0 >= 0 and row0 + CROP_SIZE <= HEIGHT and col0 + CROP_SIZE <= WIDTH
    lat_top, lat_bottom, lon_left, lon_right = crop_bounds_degrees(row0, col0)
    lat_min, lat_max, lon_min, lon_max = GALE_BBOX
    covers = (
        lat_bottom <= lat_min and lat_max <= lat_top
        and lon_left <= lon_min and lon_max <= lon_right
    )
    return report(
        "crop inside raster and covers Gale bounding box",
        inside and covers,
        f"lat {lat_bottom:.3f}..{lat_top:.3f}, lon {lon_left:.3f}..{lon_right:.3f}",
    )


def check_slope_synthetic() -> bool:
    """Known answers: flat -> 0 deg; a ramp at the equator and at 60 N.

    The ramp rises 100 m per pixel eastward. East-west ground distance per
    pixel is PIXEL_SIZE_M * cos(lat), so the expected angle is
    atan(100 / (PIXEL_SIZE_M * cos(lat))), larger at high latitude.
    """
    flat = np.full((5, 5), 1234.0)
    flat_ok = float(np.nanmax(compute_slope(flat, 2000))) == 0.0

    ramp = np.tile(100.0 * np.arange(5), (3, 1))

    def expected(row0: int) -> float:
        lat = 90.0 - (row0 + 1 + 0.5) / PIXELS_PER_DEGREE  # middle row of 3
        return math.degrees(math.atan(100.0 / (PIXEL_SIZE_M * math.cos(math.radians(lat)))))

    results = []
    for row0 in (2879, 960):  # about 0 deg and about 60 N
        got = float(compute_slope(ramp, row0)[1, 2])
        results.append(abs(got - expected(row0)) < 0.01)
    return report(
        "slope: flat = 0 and ramps match cos(latitude) spacing",
        flat_ok and all(results),
        f"equator {expected(2879):.3f} deg, 60N {expected(960):.3f} deg",
    )


def check_slope_nan_borders() -> bool:
    """A NaN hole must not create spikes: neighbours become NaN, the rest stays flat 0."""
    elev = np.full((7, 7), 500.0)
    elev[3, 3] = np.nan
    slope = compute_slope(elev, 2000)
    finite = slope[np.isfinite(slope)]
    ok = (
        finite.size > 0
        and float(finite.min()) >= 0.0
        and float(finite.max()) == 0.0  # flat everywhere the hole does not reach
        and bool(np.isnan(slope[3, 3]))
        and bool(np.isfinite(slope[0, 0]))
    )
    return report("slope: NaN hole creates no spikes at its borders", ok)


def check_slope_real_crop() -> bool:
    """Real Gale crop: slope inside 0..90 degrees, no NaN."""
    try:
        full = load_raster()
    except FileNotFoundError:
        return report("slope: real crop in range 0-90", False, "raw file missing")
    gale, row0, _ = crop_gale(full)
    slope = compute_slope(gale, row0)
    ok = (
        not bool(np.isnan(slope).any())
        and float(slope.min()) >= 0.0
        and float(slope.max()) <= 90.0
    )
    return report(
        "slope: real crop in range 0-90, no NaN",
        ok,
        f"min {slope.min():.2f}, max {slope.max():.2f} deg",
    )


def check_assets() -> bool:
    """Exported files: present, small, readable, match the raster, repeatable."""
    try:
        full = load_raster()
    except FileNotFoundError:
        return report("assets: exported files are correct", False, "raw file missing")
    expected = build_assets(full)
    built_twice_equal = expected == build_assets(full)  # same input -> same bytes
    on_disk_equal = all(
        (OUT_DIR / name).exists() and (OUT_DIR / name).read_bytes() == data
        for name, data in expected.items()
    )
    total = sum(len(data) for data in expected.values())
    meta = json.loads(expected["meta.json"])
    crop, _, _ = crop_gale(full)
    elevation = np.frombuffer(expected["elevation.bin"], dtype="<i2").reshape(CROP_SIZE, CROP_SIZE)
    elevation_ok = bool((elevation == crop).all())
    shape_ok = meta["files"]["elevation.bin"]["shape"] == [CROP_SIZE, CROP_SIZE]
    ok = (
        built_twice_equal and on_disk_equal and elevation_ok and shape_ok
        and total < 5_000_000
    )
    return report(
        "assets: files match the raster, repeatable, under 5 MB",
        ok,
        f"{len(expected)} files, {total} bytes",
    )


def main() -> int:
    results = [
        check_pixel_size(),
        check_round_trip(),
        check_edges(),
        check_crop(),
        check_slope_synthetic(),
        check_slope_nan_borders(),
        check_slope_real_crop(),
        check_assets(),
    ]
    print(f"{sum(results)}/{len(results)} checks passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
