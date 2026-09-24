#!/usr/bin/env python3
"""Turn an NCRB district-wise crime table (CSV) into data/crime/<year>-districts.json.

NCRB's "Crime in India" district tables (also mirrored on data.gov.in) change their column
names from year to year, so you tell this script which source column feeds which category:

    python scripts/ingest_ncrb.py crimes_2023.csv --year 2023 \
        --source-url "https://www.ncrb.gov.in/crime-in-india-year-wise.html" \
        --map murder="Murder" --map rape="Rape" --map robbery="Robbery" \
        --map crimes_against_women="Total Crime against Women" \
        --map total_cognizable="Total Cognizable IPC crimes" \
        --population census_projection_2023.csv

Columns for state and district names are detected automatically (anything containing
"state" and "district"); override with --state-col / --district-col.

Matching names to the site's districts is the hard part. Police districts don't always equal
revenue districts (commissionerates, railway police, "CID" rows), and spellings drift. The
script matches exact names first, then data/crime/aliases.json, then a fuzzy match it reports
for you to check. Rows it can't place are listed at the end and skipped, never guessed.
Several police districts that map to one district (e.g. a city commissionerate plus the rural
district) are summed; each district records which source rows fed it in "matched_from".

--population is a CSV with state, district and population columns, used for per-lakh rates.
Without it the map can't compute rates and shows counts in the panel only.
"""
import argparse
import csv
import difflib
import re
import sys

from slc_data import DATA, dump, jurisdictions, load

SKIP = re.compile(r"\b(total|grand|railway|grp|cid|crime branch|stf|eow|cyber cell|special|ats|state|g\.r\.p)\b", re.I)


def slug(s):
    s = s.lower().replace("&", "and")
    s = re.sub(r"\b(district|dist|commissionerate|commr|rural|urban|city|police|east|west|north|south|central)\b", " ", s)
    return re.sub(r"[^a-z]", "", s)


def pick_col(headers, word, override):
    if override:
        return override
    for h in headers:
        if word in h.lower():
            return h
    sys.exit(f"could not find a '{word}' column; pass --{word}-col")


def state_lookup(states):
    by = {}
    for s in states.values():
        by[slug(s["name"])] = s["id"]
        by[s["id"].lower()] = s["id"]
    extra = {"orissa": "OD", "pondicherry": "PY", "jandk": "JK", "jammuandkashmir": "JK",
             "dandnhaveli": "DH", "damananddiu": "DH", "dadraandnagarhaveli": "DH", "delhiut": "DL",
             "nctofdelhi": "DL", "uttaranchal": "UK", "andamanandnicobarislands": "AN", "anislands": "AN"}
    by.update(extra)
    return by


def num(v):
    v = (v or "").replace(",", "").strip()
    if v in ("", "-", "NA", "N.A."):
        return None
    try:
        f = float(v)
        return int(f) if f.is_integer() else f
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv")
    ap.add_argument("--year", required=True, type=int)
    ap.add_argument("--source-url", required=True)
    ap.add_argument("--source", default="NCRB, Crime in India")
    ap.add_argument("--map", action="append", default=[], metavar="CATEGORY=COLUMN")
    ap.add_argument("--state-col")
    ap.add_argument("--district-col")
    ap.add_argument("--population", help="CSV with state, district, population columns")
    ap.add_argument("--cutoff", type=float, default=0.86, help="fuzzy match threshold (0-1)")
    ap.add_argument("--out", help="output file name inside data/crime/ (default <year>-districts.json)")
    a = ap.parse_args()

    states, districts, _ = jurisdictions()
    cats = load("crime/index.json")["categories"]
    mapping = {}
    for m in a.map:
        k, _, col = m.partition("=")
        if k not in cats:
            sys.exit(f"unknown category {k}; choose from {', '.join(cats)}")
        mapping[k] = col
    if not mapping:
        sys.exit("give at least one --map CATEGORY=COLUMN")

    aliases = load("crime/aliases.json", default={"aliases": {}})["aliases"]
    st_by = state_lookup(states)
    by_state = {}
    for d in districts.values():
        by_state.setdefault(d["state"], {})[slug(d["name"])] = d["id"]

    def place(state_name, district_name):
        st = st_by.get(slug(state_name)) or st_by.get(re.sub(r"[^a-z]", "", state_name.lower()))
        if not st:
            return None, f"unknown state {state_name!r}"
        key = f"{st}:{district_name.strip()}"
        if key in aliases:
            return aliases[key], "alias"
        pool = by_state.get(st, {})
        s = slug(district_name)
        if s in pool:
            return pool[s], "exact"
        close = difflib.get_close_matches(s, pool.keys(), n=1, cutoff=a.cutoff)
        if close:
            return pool[close[0]], f"fuzzy ({close[0]})"
        return None, "no match"

    values, fuzzy, unmatched, nonterritorial = {}, [], [], []
    with open(a.csv, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        sys.exit("empty CSV")
    headers = rows[0].keys()
    for col in mapping.values():
        if col not in headers:
            sys.exit(f"column {col!r} not in CSV. Columns are:\n  " + "\n  ".join(headers))
    sc, dc = pick_col(headers, "state", a.state_col), pick_col(headers, "district", a.district_col)

    for r in rows:
        sn, dn = r[sc].strip(), r[dc].strip()
        if not dn:
            continue
        if SKIP.search(dn):
            nonterritorial.append(f"{sn} / {dn}")
            continue
        jid, how = place(sn, dn)
        if not jid:
            unmatched.append(f"{sn} / {dn}: {how}")
            continue
        if how.startswith("fuzzy"):
            fuzzy.append(f"{sn} / {dn} -> {jid} {how}")
        row = values.setdefault(jid, {"matched_from": []})
        row["matched_from"].append(dn)
        for k, col in mapping.items():
            v = num(r.get(col))
            if v is not None:
                row[k] = row.get(k, 0) + v

    if a.population:
        with open(a.population, newline="", encoding="utf-8-sig") as f:
            prow = list(csv.DictReader(f))
        ph = prow[0].keys()
        psc, pdc = pick_col(ph, "state", None), pick_col(ph, "district", None)
        pc = pick_col(ph, "population", None)
        for r in prow:
            jid, _ = place(r[psc], r[pdc])
            if jid in values and num(r[pc]):
                values[jid]["population"] = num(r[pc])

    out = {
        "version": 1, "year": a.year, "level": "district", "source": a.source, "source_url": a.source_url,
        "note": "Cases registered by police. Police districts were mapped to revenue districts; see matched_from.",
        "values": dict(sorted(values.items())),
    }
    name = a.out or f"{a.year}-districts.json"
    dump(f"crime/{name}", out)
    print(f"wrote data/crime/{name}: {len(values)} of {len(districts)} districts")
    if fuzzy:
        print(f"\n{len(fuzzy)} fuzzy matches — check these, and pin any wrong ones in data/crime/aliases.json:")
        print("  " + "\n  ".join(fuzzy))
    if unmatched:
        print(f"\n{len(unmatched)} rows skipped (add to data/crime/aliases.json as \"ST:Name\": \"ST/slug\"):")
        print("  " + "\n  ".join(unmatched))
    if nonterritorial:
        print(f"\n{len(nonterritorial)} totals and non-territorial units skipped (railway police, CID, state totals...)")
    print("\nNow run: python scripts/build_indexes.py && python scripts/validate_data.py")


if __name__ == "__main__":
    main()
