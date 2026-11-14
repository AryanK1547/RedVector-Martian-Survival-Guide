"""THEMIS thermal inertia layer (NASA Mars Odyssey), resampled onto each app region.

Source: ASU THEMIS Gale Crater landing-site products,
  https://static.mars.asu.edu/themis/landingsites/msl42/qualTI/
  Gale_crater_THEMIS_qualTI.tif (8-bit, QUALITATIVE thermal inertia) + .wld + .png.aux.xml
The ASU page gives the colour scale as 90 (low) to 785 (high) J m-2 K-1 s-1/2; the
8-bit values are not a calibrated scale, so this layer is for visual context only
and is NOT used in route costs.

Georeferencing (read from the .wld and .aux.xml on 15 Nov): Mars2000 Equidistant
Cylindrical, central meridian 180, sphere R = 3396190 m, 100 m pixels; the world
file gives the CENTRE of the upper-left pixel.

Run from the repo root:  python tools/prepare_themis.py
(needs the three files in data-raw/themis/)
"""

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC = REPO_ROOT / "data-raw" / "themis" / "Gale_crater_THEMIS_qualTI.tif"
WLD = SRC.with_suffix(".wld")
SOURCE_URL = "https://static.mars.asu.edu/themis/landingsites/msl42/qualTI/Gale_crater_THEMIS_qualTI.tif"
RADIUS_M = 3_396_190.0
CENTRAL_MERIDIAN = 180.0
REGIONS = [REPO_ROOT / "web" / "public" / "data", REPO_ROOT / "web" / "public" / "data" / "local"]

# Low -> high thermal inertia: dark blue, cyan, yellow, red (visual ramp only).
RAMP = np.array([[30, 40, 160], [40, 190, 220], [250, 220, 60], [220, 50, 40]], dtype=np.float64)


def colourize(v: np.ndarray) -> np.ndarray:
    """Map 1..255 to RGB along RAMP."""
    t = (v.astype(np.float64) - 1.0) / 254.0 * (len(RAMP) - 1)
    i = np.clip(np.floor(t).astype(int), 0, len(RAMP) - 2)
    f = (t - i)[..., None]
    return np.rint(RAMP[i] * (1 - f) + RAMP[i + 1] * f).astype(np.uint8)


def main() -> None:
    ti = np.array(Image.open(SRC))
    a, _, _, e, xc, yc = (float(s) for s in WLD.read_text().split())
    px = a
    assert abs(e + px) < 1e-6, "expected square, north-up pixels"
    x_left, y_top = xc - px / 2, yc + px / 2
    h, w = ti.shape
    print(f"THEMIS qualTI {w}x{h}, {px:.1f} m/px, values {ti.min()}..{ti.max()}")

    for region in REGIONS:
        meta = json.loads((region / "meta.json").read_text(encoding="utf-8"))
        c, g = meta["crop"], meta["grid"]
        rows, cols, ppd = c["rows"], c["cols"], g["pixels_per_degree"]
        lat = c["lat_top"] - (np.arange(rows) + 0.5) / ppd  # cell centres
        lon = c["lon_left"] + (np.arange(cols) + 0.5) / ppd
        x = RADIUS_M * np.radians(lon - CENTRAL_MERIDIAN)
        y = RADIUS_M * np.radians(lat)
        tc = np.floor((x - x_left) / px).astype(int)
        tr = np.floor((y_top - y) / px).astype(int)
        ok_r = (tr >= 0) & (tr < h)
        ok_c = (tc >= 0) & (tc < w)
        rgba = np.zeros((rows, cols, 4), dtype=np.uint8)
        rr, cc = np.meshgrid(np.where(ok_r)[0], np.where(ok_c)[0], indexing="ij")
        vals = ti[tr[rr], tc[cc]]  # nearest THEMIS pixel for each cell centre
        rgba[rr, cc, :3] = colourize(vals)
        rgba[rr, cc, 3] = 200
        Image.fromarray(rgba, "RGBA").save(region / "thermal.png", optimize=False)
        covered = 100.0 * ok_r.sum() * ok_c.sum() / (rows * cols)
        info = {
            "kind": "visualization",
            "dataset": "Mars Odyssey THEMIS qualitative thermal inertia, Gale Crater (ASU)",
            "url": SOURCE_URL,
            "scale_note": "qualitative 8-bit; ASU legend 90 (blue, low) to 785 (red, high) J m-2 K-1 s-1/2; not used in route costs",
            "resolution_m": round(px, 1),
            "coverage_percent": round(covered, 1),
            "sampling": "nearest THEMIS pixel at each cell centre",
        }
        # Separate file: meta.json is compared byte-for-byte by validate.py, so it is never edited here.
        (region / "thermal.json").write_text(json.dumps(info, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"{region.relative_to(REPO_ROOT)}: thermal.png {cols}x{rows}, covers {covered:.1f}% of the region")


if __name__ == "__main__":
    main()
