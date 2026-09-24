#!/usr/bin/env python3
"""
Build the map geometry for Seeing Like a Citizen.

Outputs (all in data/geo/):
  india.topo.json   districts + states (dissolved from districts) + disputed slivers
  hex.json          one hexagon per district, laid out as a schematic tile map
And updates data/jurisdictions.json with district ids, names and centroids
(existing hand-written state metadata in that file is preserved).

Requirements: python3, shapely, numpy, scipy, and mapshaper (npm i -g mapshaper)
Source: district boundaries from github.com/datta07/INDIAN-SHAPEFILES (see data/geo/SOURCES.md)

Run:  python3 scripts/build_geo.py
"""
import json, math, os, re, subprocess, sys, urllib.request
from collections import defaultdict

import numpy as np
from scipy.optimize import linear_sum_assignment
from shapely.geometry import shape, Point
from shapely.ops import unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw", "districts_source.geojson")
SRC_URL = "https://raw.githubusercontent.com/datta07/INDIAN-SHAPEFILES/master/INDIA/INDIA_DISTRICTS.geojson"
OUT = os.path.join(ROOT, "data", "geo")
JUR = os.path.join(ROOT, "data", "jurisdictions.json")

# Source state label -> our state code
STATE_CODES = {
    "ANDAMAN AND NICOBAR ISLANDS": "AN", "ANDHRA PRADESH": "AP", "ARUNACHAL PRADESH": "AR",
    "ASSAM": "AS", "BIHAR": "BR", "CHANDIGARH": "CH", "CHHATTISGARH": "CG",
    "DADRA & NAGAR HAVELI & DAMAN & DIU": "DH", "DELHI": "DL", "GOA": "GA", "GUJARAT": "GJ",
    "HARYANA": "HR", "HIMACHAL PRADESH": "HP", "JAMMU AND KASHMIR": "JK", "JHARKHAND": "JH",
    "KARNATAKA": "KA", "KERALA": "KL", "LADAKH": "LA", "LAKSHADWEEP": "LD",
    "MADHYA PRADESH": "MP", "MAHARASHTRA": "MH", "MANIPUR": "MN", "MEGHALAYA": "ML",
    "MIZORAM": "MZ", "NAGALAND": "NL", "ODISHA": "OD", "PUDUCHERRY": "PY", "PUNJAB": "PB",
    "RAJASTHAN": "RJ", "SIKKIM": "SK", "TAMIL NADU": "TN", "TELANGANA": "TG", "TRIPURA": "TR",
    "UTTAR PRADESH": "UP", "UTTARAKHAND": "UK", "WEST BENGAL": "WB",
}
SMALL_WORDS = {"and", "of", "the", "de"}

# Corrections applied on top of the source. Rajasthan abolished nine districts created in
# 2023 (state cabinet decision, 28 Dec 2024); the source still carries them. Each is folded
# into the district it was mostly carved from. This is approximate at the edges: a few
# tehsils went to other neighbours. Fix by editing this table and re-running.
MERGE_INTO = {
    "RJ/dudu": "RJ/jaipur", "RJ/jaipur-gramin": "RJ/jaipur", "RJ/jodhpur-gramin": "RJ/jodhpur",
    "RJ/kekri": "RJ/ajmer", "RJ/shahpura": "RJ/bhilwara", "RJ/neem-ka-thana": "RJ/sikar",
    "RJ/gangapurcity": "RJ/sawai-madhopur", "RJ/anoopgarh": "RJ/ganganagar", "RJ/sanchore": "RJ/jalor",
    # the source splits Purba Medinipur into two features with the same code
    "WB/purba-medinipur-2": "WB/purba-medinipur",
}

# The source file mangles diacritics (a macron a becomes ">", i becomes "|", u becomes "@" or "#")
# and truncates most Karnataka names. Karnataka is fixed by LGD district code.
MANGLED = str.maketrans({">": "a", "|": "i", "@": "u", "#": "u", "\\": "i", "_": "-"})
KARNATAKA_BY_CODE = {
    "0555": "Belagavi", "0556": "Bagalkote", "0558": "Bidar", "0559": "Raichur", "0562": "Dharwad",
    "0564": "Haveri", "0565": "Ballari", "0567": "Davanagere", "0570": "Chikkamagaluru",
    "0571": "Tumakuru", "0572": "Bengaluru Urban", "0574": "Hassan", "0577": "Mysuru",
    "0578": "Chamarajanagar", "0580": "Yadgir", "0581": "Kolar", "0582": "Chikkaballapura",
    "0583": "Bengaluru Rural", "0584": "Ramanagara (Bengaluru South)",
}
# Where the de-mangled spelling differs from the name the state government uses
PREFERRED = {
    "HAORA": "Howrah", "DARJILING": "Darjeeling", "ALIPUR DUAR": "Alipurduar", "KOCH BIHAR": "Cooch Behar",
    "MALDAH": "Malda", "SOUTH 24PARGANAS": "South 24 Parganas",
}


def source_name(p):
    if p.get("state") == "KARNATAKA" and p.get("dist_code") in KARNATAKA_BY_CODE:
        return KARNATAKA_BY_CODE[p["dist_code"]]
    n = (p.get("district") or "").translate(MANGLED).strip()
    return PREFERRED.get(n.upper(), n)


DROP = {"DL/nazul": "Nazul (government land) parcel, not a district"}


def title_case(s):
    words = re.split(r"(\s+|-|\(|\))", s.strip().lower())
    out = []
    for i, w in enumerate(words):
        if not w or not w.strip() or w in "-()":
            out.append(w)
        elif w in SMALL_WORDS and i > 0:
            out.append(w)
        else:
            out.append(w[0].upper() + w[1:])
    return "".join(out).replace(" & ", " and ")


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def load_source():
    if not os.path.exists(RAW):
        os.makedirs(os.path.dirname(RAW), exist_ok=True)
        print("downloading", SRC_URL)
        urllib.request.urlretrieve(SRC_URL, RAW)
    return json.load(open(RAW))


def clean(src):
    districts, disputed = [], []
    seen = defaultdict(int)
    for f in src["features"]:
        p = f["properties"]
        st, dn = p.get("state"), p.get("district")
        if st is None or st not in STATE_CODES or not dn or dn == "ISLAND":
            disputed.append({"type": "Feature", "geometry": f["geometry"],
                             "properties": {"note": p.get("remarks") or f"Unassigned in source ({st})"}})
            continue
        code = STATE_CODES[st]
        name = title_case(source_name(p))
        base = f"{code}/{slug(name)}"
        seen[base] += 1
        did = base if seen[base] == 1 else f"{base}-{seen[base]}"
        districts.append({"type": "Feature", "geometry": f["geometry"], "properties": {
            "id": did, "st": code, "name": name, "src_code": p.get("dist_code")}})
    # apply merges
    from shapely.geometry import mapping
    by_id = {f["properties"]["id"]: f for f in districts}
    for child, parent in MERGE_INTO.items():
        if child in by_id and parent in by_id:
            pg = shape(by_id[parent]["geometry"]).buffer(0)
            cg = shape(by_id[child]["geometry"]).buffer(0)
            by_id[parent]["geometry"] = mapping(pg.union(cg).buffer(0.0005).buffer(-0.0005))
            del by_id[child]
        elif child in by_id:
            print("WARN merge target missing", child, parent)
    for did, why in DROP.items():
        if did in by_id:
            disputed.append({"type": "Feature", "geometry": by_id.pop(did)["geometry"],
                             "properties": {"note": why}})
    return list(by_id.values()), disputed


def run_mapshaper(districts, disputed):
    tmp = os.path.join(ROOT, "raw")
    dpath, xpath = os.path.join(tmp, "districts_clean.geojson"), os.path.join(tmp, "disputed.geojson")
    json.dump({"type": "FeatureCollection", "features": districts}, open(dpath, "w"))
    json.dump({"type": "FeatureCollection", "features": disputed}, open(xpath, "w"))
    out = os.path.join(OUT, "india.topo.json")
    cmd = ["mapshaper", "-i", dpath, xpath, "combine-files", "snap",
           "-rename-layers", "districts,disputed",
           "-simplify", "weighted", "4%", "keep-shapes", "target=*",
           "-clean", "target=districts",
           "-dissolve", "st", "target=districts", "+", "name=states",
           "-o", "format=topojson", "quantization=100000", "target=*", out]
    print(" ".join(cmd))
    subprocess.run(cmd, check=True)
    print("wrote", out, os.path.getsize(out) // 1024, "KB")


# ---------------------------------------------------------------- hex layout
SQ3 = math.sqrt(3)


def hex_center(q, r, size):
    # pointy-top axial coordinates
    return size * SQ3 * (q + r / 2), size * 1.5 * r


NEIGH = [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]


def build_hex(districts):
    """Two-stage schematic layout.
    1. Lay a hex grid over India's land with roughly one cell per district.
    2. Give every state a compact block of cells near its real territory, sized to its
       district count (a capacitated assignment: each state is replicated once per district).
    3. Inside each state's block, place districts to preserve their relative positions.
    """
    from shapely.affinity import scale
    kx = math.cos(math.radians(22))
    pts, ids, sts = [], [], []
    geoms_by_state = defaultdict(list)
    for f in districts:
        g = scale(shape(f["geometry"]).buffer(0), xfact=kx, yfact=1, origin=(0, 0))
        c = g.representative_point()
        pts.append((c.x, c.y)); ids.append(f["properties"]["id"]); sts.append(f["properties"]["st"])
        geoms_by_state[sts[-1]].append(g)
    pts = np.array(pts)
    n = len(pts)
    from shapely.prepared import prep
    state_geom = {s: unary_union(gs).simplify(0.02) for s, gs in geoms_by_state.items()}
    land = unary_union(list(state_geom.values())).buffer(0.05).simplify(0.02)

    def grid(size, poly):
        minx, miny, maxx, maxy = poly.bounds
        out, pp = [], prep(poly)
        for r in range(int(miny / (1.5 * size)) - 2, int(maxy / (1.5 * size)) + 3):
            for q in range(int(minx / (SQ3 * size) - r / 2) - 3, int(maxx / (SQ3 * size) - r / 2) + 3):
                x, y = hex_center(q, r, size)
                if pp.contains(Point(x, y)):
                    out.append((q, r))
        return out

    lo, hi = 0.1, 1.5
    for _ in range(25):  # bisect so the land holds ~n cells
        mid = (lo + hi) / 2
        k = len(grid(mid, land))
        if k > n * 1.03: lo = mid
        elif k < n: hi = mid
        else: break
    size = mid
    cells = grid(size, land)
    cellset = set(cells)
    # island / enclave states with too few cells of their own get nearby sea cells
    for s, g in state_geom.items():
        need = sum(1 for x in sts if x == s)
        c = g.centroid
        gb = prep(g.buffer(size * 0.5))
        own = [qr for qr in cells if gb.contains(Point(*hex_center(*qr, size)))]
        if len(own) >= need or s not in ("AN", "LD"):
            continue
        q0 = round((c.x / (SQ3 * size)) - (c.y / (1.5 * size)) / 2); r0 = round(c.y / (1.5 * size))
        ring = sorted(((q0 + dq, r0 + dr) for dq in range(-4, 5) for dr in range(-4, 5)),
                      key=lambda qr: (hex_center(*qr, size)[0] - c.x) ** 2 + (hex_center(*qr, size)[1] - c.y) ** 2)
        added = 0
        for qr in ring:
            if qr not in cellset:
                cells.append(qr); cellset.add(qr); added += 1
            if added >= need:
                break
    C = np.array([hex_center(q, r, size) for q, r in cells])
    print(f"hex: {n} districts, {len(cells)} cells, size={size:.4f}")

    # Stage 1: capacitated state -> cell assignment
    order = sorted(range(n), key=lambda i: sts[i])
    st_cost = {}
    for s, g in state_geom.items():
        cen = np.array([g.centroid.x, g.centroid.y])
        dpoly = np.array([g.distance(Point(x, y)) for x, y in C])
        dcen = np.sqrt(((C - cen) ** 2).sum(1))
        st_cost[s] = dpoly ** 2 * 4 + (dcen ** 2) * 0.15
    cost = np.stack([st_cost[sts[i]] for i in order])
    row, col = linear_sum_assignment(cost)
    cells_of_state = defaultdict(list)
    for rr, cc in zip(row, col):
        cells_of_state[sts[order[rr]]].append(cells[cc])

    # Stage 2: within each state, keep relative geography
    tiles = []
    for s, cl in cells_of_state.items():
        members = [i for i in range(n) if sts[i] == s]
        P = pts[members]; Q = np.array([hex_center(q, r, size) for q, r in cl])
        def norm(A):
            sd = A.std(0); sd[sd == 0] = 1
            return (A - A.mean(0)) / sd
        cst = ((norm(P)[:, None, :] - norm(Q)[None, :, :]) ** 2).sum(-1)
        rr, cc = linear_sum_assignment(cst)
        for a, b in zip(rr, cc):
            tiles.append({"id": ids[members[a]], "st": s, "q": cl[b][0], "r": cl[b][1]})
    tiles.sort(key=lambda t: t["id"])
    return {"size": 1, "orientation": "pointy", "tiles": tiles}, pts, kx


def main():
    src = load_source()
    districts, disputed = clean(src)
    print(len(districts), "districts;", len(disputed), "disputed/unassigned slivers")
    os.makedirs(OUT, exist_ok=True)
    run_mapshaper(districts, disputed)
    hexdata, pts, kx = build_hex(districts)
    json.dump(hexdata, open(os.path.join(OUT, "hex.json"), "w"), separators=(",", ":"))

    jur = json.load(open(JUR)) if os.path.exists(JUR) else {"states": [], "districts": []}
    old = {d["id"]: d for d in jur.get("districts", [])}
    jur["districts"] = []
    for f, (x, y) in zip(districts, pts):
        p = f["properties"]
        d = old.get(p["id"], {})
        d.update({"id": p["id"], "state": p["st"], "name": p["name"],
                  "centroid": [round(y, 4), round(x / kx, 4)], "source_code": p["src_code"]})
        jur["districts"].append(d)
    jur["districts"].sort(key=lambda d: d["id"])
    json.dump(jur, open(JUR, "w"), indent=1, ensure_ascii=False)
    print("updated", JUR)


if __name__ == "__main__":
    main()
