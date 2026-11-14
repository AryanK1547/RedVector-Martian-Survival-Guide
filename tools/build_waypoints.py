"""Build web/public/data/waypoints.csv: science destinations taken from NASA's
MSL PLACES rover localizations, each tied to a NASA blog post that names it.

Input (download once, gitignored):
  data-raw/places/localized_interp_demv2.csv (+ .xml label), from
  https://planetarydata.jpl.nasa.gov/img/data/msl/msl_places/data_localizations/

Only waypoints whose identity is stated by a NASA source are listed below.
Run from the repo root:  python tools/build_waypoints.py
"""

import csv
import math
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PLACES_CSV = REPO_ROOT / "data-raw" / "places" / "localized_interp_demv2.csv"
OUT = REPO_ROOT / "web" / "public" / "data" / "waypoints.csv"
PLACES_URL = "https://planetarydata.jpl.nasa.gov/img/data/msl/msl_places/data_localizations/localized_interp_demv2.csv"
RADIUS_M = 3_396_190.0  # Mars 2000 sphere, as used by the USGS MSL Gale DEM

# (id, name, site, drive, evidence URL, evidence quote). site/drive are the
# rover motion counter that PLACES uses as its key.
WAYPOINTS = [
    (
        "boxwork_ridge_base",
        "Base of the ramp to the main boxwork ridge",
        117, 2166,
        "https://science.nasa.gov/blog/curiosity-blog-sols-4600-4601-up-and-over-the-sand-covered-ramp/",
        "the rover parked near the edge of a smooth, sandy stretch at the base of a ridge that leads to "
        "the most prominent and complex network of boxwork structures seen so far",
    ),
    (
        "boxwork_ridge_top",
        "Top of the ridge, start of the main boxwork region",
        117, 2490,
        "https://science.nasa.gov/blog/curiosity-blog-sols-4602-4603-on-top-of-the-ridge/",
        "we successfully climbed the 11-meter ramp (about 36 feet) and have arrived at the top of the "
        "ridge and the start of the main boxwork region",
    ),
]

FIELDS = [
    "id", "name", "sol", "site", "drive", "latitude_planetocentric", "longitude_east", "elevation_m",
    "position_source", "identification_source", "identification_quote",
]


def last_rover_row(rows, site: int, drive: int) -> dict:
    """PLACES can hold several poses per site/drive; take the last one in file order."""
    match = [r for r in rows if r["frame"] == "ROVER" and int(r["site"]) == site and int(r["drive"]) == drive]
    if not match:
        raise ValueError(f"no ROVER row for site {site} drive {drive}")
    return match[-1]


def ground_distance_m(a: dict, b: dict) -> float:
    lat1, lat2 = math.radians(float(a["planetocentric_latitude"])), math.radians(float(b["planetocentric_latitude"]))
    dlon = math.radians(float(b["longitude"]) - float(a["longitude"]))
    x = dlon * math.cos((lat1 + lat2) / 2)
    return RADIUS_M * math.hypot(x, lat2 - lat1)


def main() -> None:
    with PLACES_CSV.open(encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    out = []
    picked = []
    for wid, name, site, drive, url, quote in WAYPOINTS:
        r = last_rover_row(rows, site, drive)
        picked.append(r)
        out.append({
            "id": wid,
            "name": name,
            "sol": r["sol"],
            "site": site,
            "drive": drive,
            "latitude_planetocentric": r["planetocentric_latitude"],
            "longitude_east": r["longitude"],
            "elevation_m": r["elevation"],
            "position_source": f"NASA PDS MSL PLACES localized_interp_demv2.csv ({PLACES_URL})",
            "identification_source": url,
            "identification_quote": quote,
        })
    with OUT.open("w", encoding="utf-8", newline="\n") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(out)
    for w in out:
        print(f"{w['id']:20s} sol {w['sol']}  lat {w['latitude_planetocentric']}  lon {w['longitude_east']}  elev {w['elevation_m']}")
    print(f"base -> top ground distance {ground_distance_m(picked[0], picked[1]):.1f} m "
          f"(NASA blog: 21 m drive planned), climb {float(picked[1]['elevation']) - float(picked[0]['elevation']):.1f} m")
    print(f"wrote {OUT.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
