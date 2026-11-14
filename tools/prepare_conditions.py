"""Measured surface conditions for the waypoint sols, from Curiosity instruments.

- REMS weather, MODRDR product ("best estimation of the real data", per its
  label), PDS Atmospheres Node. Each sol's table is downloaded once into
  data-raw/rems/ (about 14 MB).
- RAD radiation, RDR product, PDS PPI Node. The daily file is about 70 MB, but
  its label gives the byte offset of every observation's total-dose values, so
  only those bytes are fetched with HTTP range requests.

These are measurements at Curiosity's position on that sol. They are shown as
historical context, never as a forecast or as conditions elsewhere.
Run from the repo root:  python tools/prepare_conditions.py
"""

import csv
import io
import json
import re
import ssl
import statistics
import urllib.request
from pathlib import Path

import certifi

REPO_ROOT = Path(__file__).resolve().parents[1]
RAW = REPO_ROOT / "data-raw"
OUT = REPO_ROOT / "web" / "public" / "data" / "conditions.json"

REMS_BASE = "https://atmos.nmsu.edu/PDS/data/PDS4/msl_rems_bundle/data_calibrated/SOL_04489_04612"
RAD_BASE = "https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0/DATA/SOL_04489_04612"

# Waypoint sols -> archive file names (taken from the directory listings on 15 Nov).
SOLS = {
    4598: {"rems": "SOL04598/RME_805631193RMD45980000000_______P1", "rad": "RAD_RDR_2025_193_23_42_4598_V00"},
    4602: {"rems": "SOL04602/RME_805986290RMD46020000000_______P1", "rad": "RAD_RDR_2025_198_02_14_4602_V00"},
}

# Column positions (0-based) from the MODRDR PDS4 label field_number - 1.
COL = {"lmst": 1, "ambient_temp": 15, "ambient_conf": 16, "uv_abc": 20, "uv_conf": 29, "pressure": 37}
MISSING = -999.0
HEADERS = {"User-Agent": "Mozilla/5.0 (data preparation script)"}
# Full certificate verification against the current Mozilla CA bundle: the local
# Windows Python store chained the PDS PPI certificate to an expired root.
TLS = ssl.create_default_context(cafile=certifi.where())


def http(url: str, start: int | None = None, length: int | None = None) -> bytes:
    headers = dict(HEADERS)
    if start is not None:
        headers["Range"] = f"bytes={start}-{start + length - 1}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120, context=TLS) as r:
        return r.read()


def cached(url: str, path: Path) -> bytes:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(http(url))
    return path.read_bytes()


def flag(value: str, byte: int) -> str:
    """Confidence strings are right-aligned with leading spaces; byte 0 is the left end."""
    s = value.strip()
    return s[byte] if byte < len(s) else "X"


def rems_summary(sol: int, name: str) -> dict:
    text = cached(f"{REMS_BASE}/{name}.TAB", RAW / "rems" / f"{Path(name).name}.TAB").decode("ascii")
    temps, pressures, uv = [], [], []
    rows = 0
    for row in csv.reader(io.StringIO(text)):
        rows += 1
        t, p, u = float(row[COL["ambient_temp"]]), float(row[COL["pressure"]]), float(row[COL["uv_abc"]])
        # Ambient temperature: byte 8 = "observation reliability", 1 = reliable.
        if t != MISSING and flag(row[COL["ambient_conf"]], 8) == "1":
            temps.append(t)
        if p != MISSING:
            pressures.append(p)
        # UV: byte 3 = shadow, 1 = no shadow on the sensor.
        if u != MISSING and flag(row[COL["uv_conf"]], 3) == "1":
            uv.append(u)
    k = lambda v: round(v - 273.15, 1)
    return {
        "rows": rows,
        "ambient_temp_reliable_samples": len(temps),
        "ambient_temp_min_c": k(min(temps)) if temps else None,
        "ambient_temp_max_c": k(max(temps)) if temps else None,
        "pressure_samples": len(pressures),
        "pressure_mean_pa": round(statistics.fmean(pressures), 1) if pressures else None,
        "uv_abc_unshadowed_samples": len(uv),
        "uv_abc_max_w_m2": round(max(uv), 2) if uv else None,
        "source": f"{REMS_BASE}/{name}.TAB",
    }


def rad_summary(name: str) -> dict:
    label = cached(f"{RAD_BASE}/{name}.LBL", RAW / "rad" / f"{name}.LBL").decode("latin-1")
    url = f"{RAD_BASE}/{name}.TXT"
    rates = {"B": [], "E": []}
    for det in rates:
        # e.g. ^OBS012_TOT_DOSE_B_ELEMENT = ("RAD_RDR_...TXT",18892 <BYTES>), value is 7 bytes, microGray/hour
        for offset in re.findall(rf"\^OBS\d+_TOT_DOSE_{det}_ELEMENT\s*=\s*\(\s*\"[^\"]+\"\s*,\s*(\d+)\s*<BYTES>\)", label):
            raw = http(url, int(offset) - 1, 7).decode("ascii").strip()  # PDS byte offsets start at 1
            value = float(raw)
            if value >= 0:  # negative values are fill
                rates[det].append(value)
    day = lambda v: round(statistics.fmean(v) * 24, 1) if v else None
    return {
        "observations_b": len(rates["B"]),
        "observations_e": len(rates["E"]),
        "dose_rate_b_silicon_ugy_per_day": day(rates["B"]),
        "dose_rate_e_plastic_ugy_per_day": day(rates["E"]),
        "method": "mean of per-observation total dose rates (microGray/hour, RAD RDR) x 24",
        "source": url,
    }


def main() -> None:
    out = {
        "note": "Measured by Curiosity at its own position on that sol. Historical context only, not a forecast.",
        "rems_product": "MSL-M-REMS-5-MODRDR-V1.0, PDS Atmospheres Node",
        "rad_product": "MSL-M-RAD-3-RDR-V1.0, PDS PPI Node; detector B = silicon, E = plastic scintillator (RAD RDR SIS)",
        "sols": {},
    }
    for sol, files in SOLS.items():
        print(f"sol {sol}: REMS...")
        rems = rems_summary(sol, files["rems"])
        print(f"sol {sol}: RAD (range requests)...")
        rad = rad_summary(files["rad"])
        out["sols"][str(sol)] = {"rems": rems, "rad": rad}
        print(f"  temp {rems['ambient_temp_min_c']}..{rems['ambient_temp_max_c']} C ({rems['ambient_temp_reliable_samples']} reliable of {rems['rows']}), "
              f"pressure {rems['pressure_mean_pa']} Pa ({rems['pressure_samples']}), UV-ABC max {rems['uv_abc_max_w_m2']} W/m2 ({rems['uv_abc_unshadowed_samples']})")
        print(f"  RAD dose rate B {rad['dose_rate_b_silicon_ugy_per_day']} uGy/day ({rad['observations_b']} obs), "
              f"E {rad['dose_rate_e_plastic_ugy_per_day']} uGy/day ({rad['observations_e']} obs)")
    OUT.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
