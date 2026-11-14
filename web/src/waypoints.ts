// Science destinations from web/public/data/waypoints.csv (built by
// tools/build_waypoints.py from NASA PDS PLACES rover positions).
export interface Waypoint {
  id: string;
  name: string;
  sol: number;
  lat: number;
  lon: number;
  elevationM: number;
  positionSource: string;
  identificationSource: string;
  identificationQuote: string;
  imageFile: string; // relative to data/
  imageCaption: string;
}

// Minimal RFC 4180 CSV reader: commas, double-quoted fields, "" as an escaped quote.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseWaypoints(text: string): Waypoint[] {
  const [header, ...rows] = parseCsv(text);
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`waypoints.csv is missing column ${name}`);
    return i;
  };
  const c = {
    id: col("id"), name: col("name"), sol: col("sol"), lat: col("latitude_planetocentric"), lon: col("longitude_east"),
    elev: col("elevation_m"), pos: col("position_source"), idSrc: col("identification_source"), quote: col("identification_quote"),
    img: col("image_file"), imgCap: col("image_caption"),
  };
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => ({
      id: r[c.id],
      name: r[c.name],
      sol: Number(r[c.sol]),
      lat: Number(r[c.lat]),
      lon: Number(r[c.lon]),
      elevationM: Number(r[c.elev]),
      positionSource: r[c.pos],
      identificationSource: r[c.idSrc],
      identificationQuote: r[c.quote],
      imageFile: r[c.img],
      imageCaption: r[c.imgCap],
    }));
}

export async function loadWaypoints(url = "data/waypoints.csv"): Promise<Waypoint[]> {
  return parseWaypoints(await (await fetch(url)).text());
}
