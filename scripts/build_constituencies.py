#!/usr/bin/env python3
"""Build lightweight electoral boundary and equal-area hex assets.

The input formats match DataMeet's public constituency datasets:

    python scripts/build_constituencies.py \
      --lok-sabha path/to/india_pc_2019_simplified.geojson \
      --vidhan-sabha path/to/India_AC.shp

The companion DBF must sit beside the Assembly shapefile.  No third-party Python
packages are needed; this matters on the small machine that runs the data sweep.

The hexagons from that run are a quick snap-to-grid. For the proper layout (each state a compact,
contiguous block, as for districts) relay them out with the geo requirements installed:

    python scripts/build_constituencies.py --hex-only     # needs requirements-geo.txt
"""
import argparse
import json
import math
import struct
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "geo" / "constituencies.json"

STATE_NAMES = {
    "andaman and nicobar islands": "AN", "andaman & nicobar": "AN", "andhra pradesh": "AP", "arunachal pradesh": "AR",
    "assam": "AS", "bihar": "BR", "chandigarh": "CH", "chhattisgarh": "CG",
    "dadra and nagar haveli": "DH", "dadra & nagar haveli": "DH", "daman and diu": "DH", "daman & diu": "DH", "delhi": "DL", "goa": "GA",
    "gujarat": "GJ", "haryana": "HR", "himachal pradesh": "HP", "jammu & kashmir": "JK",
    "jammu and kashmir": "JK", "jharkhand": "JH", "karnataka": "KA", "kerala": "KL",
    "ladakh": "LA", "lakshadweep": "LD", "madhya pradesh": "MP", "maharashtra": "MH",
    "manipur": "MN", "meghalaya": "ML", "mizoram": "MZ", "nagaland": "NL",
    "odisha": "OD", "orissa": "OD", "puducherry": "PY", "punjab": "PB",
    "rajasthan": "RJ", "sikkim": "SK", "tamil nadu": "TN", "telangana": "TG",
    "tripura": "TR", "uttar pradesh": "UP", "uttarakhand": "UK", "uttarkhand": "UK",
    "west bengal": "WB",
}


def norm_state(name):
    return STATE_NAMES.get(" ".join(str(name).lower().split()))


def dbf_rows(path):
    with open(path, "rb") as f:
        head = f.read(32)
        count, header_len, row_len = struct.unpack("<IHH", head[4:12])
        descriptors = f.read(header_len - 32)
        fields, offset = [], 1
        for i in range(0, len(descriptors) - 1, 32):
            d = descriptors[i:i + 32]
            if not d or d[0] == 13:
                break
            name = d[:11].split(b"\0")[0].decode("ascii")
            length = d[16]
            fields.append((name, offset, length))
            offset += length
        for _ in range(count):
            raw = f.read(row_len)
            if not raw or raw[:1] == b"*":
                continue
            yield {name: raw[start:start + length].decode("latin1").strip()
                   for name, start, length in fields}


def shp_polygons(path):
    """Yield each Polygon record as a list of rings."""
    with open(path, "rb") as f:
        header = f.read(100)
        if len(header) != 100 or struct.unpack("<i", header[32:36])[0] not in (5, 15, 25):
            raise ValueError("Assembly input must be a polygon shapefile")
        while True:
            rec = f.read(8)
            if not rec:
                return
            size = struct.unpack(">i", rec[4:8])[0] * 2
            body = f.read(size)
            kind = struct.unpack("<i", body[:4])[0]
            if kind == 0:
                yield []
                continue
            parts_n, points_n = struct.unpack("<2i", body[36:44])
            parts = list(struct.unpack(f"<{parts_n}i", body[44:44 + 4 * parts_n]))
            start = 44 + 4 * parts_n
            points = [struct.unpack("<2d", body[start + i * 16:start + (i + 1) * 16])
                      for i in range(points_n)]
            ends = parts[1:] + [points_n]
            yield [points[a:b] for a, b in zip(parts, ends)]


def point_line_distance(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    if dx == dy == 0:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def simplify(points, tolerance=0.018):
    if len(points) <= 5:
        return [[round(x, 4), round(y, 4)] for x, y in points]
    closed = points[0] == points[-1]
    work = points[:-1] if closed else points

    def dp(seq):
        if len(seq) <= 2:
            return seq
        distances = [point_line_distance(p, seq[0], seq[-1]) for p in seq[1:-1]]
        best = max(distances, default=0)
        if best <= tolerance:
            return [seq[0], seq[-1]]
        at = distances.index(best) + 1
        return dp(seq[:at + 1])[:-1] + dp(seq[at:])

    # Split a closed ring at its farthest point so Douglas-Peucker has a real baseline.
    if closed:
        anchor = max(range(1, len(work)), key=lambda i: (work[i][0] - work[0][0]) ** 2 + (work[i][1] - work[0][1]) ** 2)
        out = dp(work[:anchor + 1])[:-1] + dp(work[anchor:] + [work[0]])
    else:
        out = dp(work)
    if len(out) < 4:
        out = list(work[:3]) + [work[0]]
    elif out[0] != out[-1]:
        out.append(out[0])
    return [[round(x, 4), round(y, 4)] for x, y in out]


def centre(geometry):
    pts = []
    for poly in geometry["coordinates"]:
        for ring in poly:
            pts.extend(ring[:-1])
    if not pts:
        return [0, 0]
    xs, ys = zip(*pts)
    return [sum(ys) / len(ys), sum(xs) / len(xs)]


def feature(identifier, state, number, name, category, geometry):
    return {"type": "Feature", "properties": {"id": identifier, "st": state, "no": number,
            "name": name, "category": category or "GEN"}, "geometry": geometry}


def lok_sabha(path):
    raw = json.load(open(path, encoding="utf-8"))
    out, seen = [], defaultdict(int)
    for f in raw["features"]:
        p = f["properties"]
        st = "LA" if str(p.get("pc_name", "")).lower() == "ladakh" else norm_state(p.get("st_name"))
        if not st:
            raise ValueError(f"Unknown Lok Sabha state {p.get('st_name')!r}")
        no = int(p["pc_no"])
        seen[(st, no)] += 1
        suffix = f"-{seen[(st, no)]}" if seen[(st, no)] > 1 else ""
        ident = f"LS/{st}/{no:03d}{suffix}"
        g = f["geometry"]
        if g["type"] == "Polygon":
            g = {"type": "MultiPolygon", "coordinates": [g["coordinates"]]}
        out.append(feature(ident, st, no, p["pc_name"], p.get("pc_category"), g))
    return out


TELANGANA_DISTRICTS = {
    "ADILABAD", "HYDERABAD", "KARIMNAGAR", "KHAMMAM", "MAHBUBNAGAR", "MEDAK",
    "NALGONDA", "NIZAMABAD", "RANGAREDDY", "WARANGAL",
}


def vidhan_sabha(path):
    rows = list(dbf_rows(Path(path).with_suffix(".dbf")))
    shapes = list(shp_polygons(path))
    if len(rows) != len(shapes):
        raise ValueError(f"DBF has {len(rows)} rows but shapefile has {len(shapes)} records")
    out, seen = [], defaultdict(int)
    for p, rings in zip(rows, shapes):
        st = norm_state(p["ST_NAME"])
        if st == "AP" and p.get("DIST_NAME", "").upper() in TELANGANA_DISTRICTS:
            st = "TG"
        if not st or not rings:
            continue
        no = int(p["AC_NO"] or 0)
        seen[(st, no)] += 1
        suffix = f"-{seen[(st, no)]}" if seen[(st, no)] > 1 else ""
        ident = f"VS/{st}/{no:03d}{suffix}"
        # Treat each shapefile part as one polygon exterior.  The source has very few
        # holes; this deliberately favours valid, fast web geometry over preserving a
        # malformed ring hierarchy from the legacy shapefile.
        geom = {"type": "MultiPolygon", "coordinates": [[simplify(ring)] for ring in rings]}
        name = p["AC_NAME"].title() or f"Assembly constituency {no}"
        cat = "SC" if "(SC)" in p["AC_NAME"].upper() else "ST" if "(ST)" in p["AC_NAME"].upper() else "GEN"
        out.append(feature(ident, st, no, name, cat, geom))
    return out


NEIGHBOURS = ((1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1))


def axial_round(q, r):
    x, z, y = q, r, -q - r
    rx, ry, rz = round(x), round(y), round(z)
    xd, yd, zd = abs(rx - x), abs(ry - y), abs(rz - z)
    if xd > yd and xd > zd:
        rx = -ry - rz
    elif yd > zd:
        ry = -rx - rz
    else:
        rz = -rx - ry
    return rx, rz


def hexes(features):
    """Snap feature centres to a pointy hex grid, resolving collisions outward."""
    n = len(features)
    size = math.sqrt(540 / max(n, 1)) * 0.43
    occupied, tiles = set(), []
    ordered = sorted(features, key=lambda f: (f["properties"]["st"], f["properties"]["no"], f["properties"]["id"]))
    for f in ordered:
        lat, lng = centre(f["geometry"])
        x, y = lng * math.cos(math.radians(22)), lat
        r0 = y / (1.5 * size)
        q0 = x / (math.sqrt(3) * size) - r0 / 2
        origin = axial_round(q0, r0)
        choice = origin
        if choice in occupied:
            frontier, visited = [origin], {origin}
            while frontier:
                q, r = frontier.pop(0)
                candidates = [(q + dq, r + dr) for dq, dr in NEIGHBOURS]
                candidates.sort(key=lambda qr: (qr[0] - q0) ** 2 + (qr[1] - r0) ** 2)
                for candidate in candidates:
                    if candidate in visited:
                        continue
                    if candidate not in occupied:
                        choice, frontier = candidate, []
                        break
                    visited.add(candidate)
                    frontier.append(candidate)
        occupied.add(choice)
        tiles.append({"id": f["properties"]["id"], "st": f["properties"]["st"], "q": choice[0], "r": choice[1]})
    return {"size": 1, "orientation": "pointy", "tiles": tiles}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lok-sabha")
    ap.add_argument("--vidhan-sabha")
    ap.add_argument("--hex-only", action="store_true",
                    help="relay out the hexagons of the existing output with the district algorithm")
    ap.add_argument("--output", default=str(OUT))
    args = ap.parse_args()
    if args.hex_only:
        return relayout(Path(args.output))
    if not (args.lok_sabha and args.vidhan_sabha):
        ap.error("--lok-sabha and --vidhan-sabha are required unless --hex-only")
    ls, vs = lok_sabha(args.lok_sabha), vidhan_sabha(args.vidhan_sabha)
    data = {
        "version": 1,
        "sources": {
            "lok_sabha": {"label": "DataMeet 2019 parliamentary constituencies (simplified)", "url": "https://github.com/datameet/maps/tree/master/parliamentary-constituencies", "license": "CC0 1.0"},
            "vidhan_sabha": {"label": "DataMeet / ECI polling-station Assembly boundaries", "url": "https://github.com/datameet/maps/tree/master/assembly-constituencies", "license": "CC BY 2.5 India", "warning": "The source flags several states as pre-delimitation and some names or alignments as imperfect."},
        },
        "lok_sabha": {"type": "FeatureCollection", "features": ls},
        "vidhan_sabha": {"type": "FeatureCollection", "features": vs},
        "hex": {"lok_sabha": hexes(ls), "vidhan_sabha": hexes(vs)},
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
    print(f"wrote {out}: {len(ls)} Lok Sabha and {len(vs)} Vidhan Sabha constituencies")


def relayout(out):
    """Same two-stage layout as the district hexagons in build_geo.py: every state gets a compact
    block of cells near its real territory, and seats keep their relative positions inside it."""
    from build_geo import build_hex   # needs shapely, numpy, scipy
    with open(out, encoding="utf-8") as f:
        data = json.load(f)
    for kind in ("lok_sabha", "vidhan_sabha"):
        data["hex"][kind], _, _ = build_hex(data[kind]["features"])
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
    print(f"relaid out hexagons in {out}")


if __name__ == "__main__":
    main()
