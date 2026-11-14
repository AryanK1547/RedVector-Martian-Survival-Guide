"""Coordinate conversion between latitude/longitude and raster row/column.

Grid facts (ENVI header, verified by the human's paste; see log.txt):
- Equirectangular on a sphere of radius 3396 km, 32 pixels per degree,
  central meridian 180, tie point (5761, 2881) = (lat 0, lon 180).

Convention (checked against the PDS4 label megt90n000fb.xml on 14 Nov):
- The label's upper-left corner is x = -pi*R, y = +pi*R/2 (R = 3396 km), i.e.
  the outer EDGE of the grid, so the image spans lon 0..360 (east positive,
  per the label) and lat 90..-90, and the pixel (row, col) covers
  lon [col/32, (col+1)/32) and lat (90 - (row+1)/32, 90 - row/32].
- ASSUMED, not stated in the label: a pixel's value belongs to its CENTER.

Why this is simple: an equirectangular grid is a straight scale + offset in
degrees. No trigonometry is needed here (cos(latitude) matters later, for
ground distance, not for pixel positions).
"""

import math

PIXELS_PER_DEGREE = 32
WIDTH = 11520
HEIGHT = 5760
RADIUS_M = 3_396_000.0
PIXEL_SIZE_M = 1852.2306687  # from the header

# Metres per degree on the sphere: radius * (pi / 180).
METERS_PER_DEGREE = RADIUS_M * math.pi / 180.0


def latlon_to_pixel(lat: float, lon: float) -> tuple[int, int]:
    """Return the (row, col) of the pixel that contains (lat, lon).

    Longitude is wrapped into 0..360 so -10 and 350 mean the same place.
    Latitude 90 / longitude 360 sit on the far edge; they are clamped to the
    last row / column instead of falling off the grid.
    """
    if not -90.0 <= lat <= 90.0:
        raise ValueError(f"latitude out of range: {lat}")
    lon = lon % 360.0
    row = int(math.floor((90.0 - lat) * PIXELS_PER_DEGREE))
    col = int(math.floor(lon * PIXELS_PER_DEGREE))
    return min(row, HEIGHT - 1), min(col, WIDTH - 1)


def pixel_to_latlon(row: int, col: int) -> tuple[float, float]:
    """Return (lat, lon) of the CENTER of pixel (row, col)."""
    if not (0 <= row < HEIGHT and 0 <= col < WIDTH):
        raise ValueError(f"pixel out of range: ({row}, {col})")
    lat = 90.0 - (row + 0.5) / PIXELS_PER_DEGREE
    lon = (col + 0.5) / PIXELS_PER_DEGREE
    return lat, lon
