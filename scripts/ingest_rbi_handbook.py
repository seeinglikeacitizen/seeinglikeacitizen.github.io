#!/usr/bin/env python3
"""Build data/economic/indicators.json from the RBI Handbook of Statistics on Indian States.

The Handbook (published each December) is a set of spreadsheets, one per table. Download the tables
listed in TABLES (by number) into a folder, then:

    npm i --no-save puppeteer-core
    node scripts/fetch_rbi_handbook.mjs raw/rbi-handbook $(python3 scripts/ingest_rbi_handbook.py --tables)
    python scripts/ingest_rbi_handbook.py raw/rbi-handbook --edition 2024-25   # standard library only

The RBI's download server blocks plain scripts, so the fetch step drives a browser; you can also save
the spreadsheets by hand from https://www.rbi.org.in (Publications > Annual > Handbook of Statistics on
Indian States). Files are matched by the table number at the start of their name (e.g. 19T_...XLSX).

Each indicator keeps the latest year available for each state, and the year it refers to. Ratios
(shares of GSDP, per-person figures) use the same year for both parts.
"""
import argparse
import datetime as dt
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from slc_data import dump, jurisdictions

M = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
EDITION = "2024-25"   # the Handbook edition the files come from; pass --edition when it changes
PAGE = "https://www.rbi.org.in/Scripts/AnnualPublications.aspx?head=Handbook%20of%20Statistics%20on%20Indian%20States"

# table number -> how to read it. "sheet": a word in the sheet's subtitle picks one series (e.g. the
# 'Overall' of Male/Female/Overall); "scale" converts units; "column": for tables whose columns are
# labelled rather than dated.
TABLES = {
    8: {"key": "unemp_rural", "sheet": "Overall", "scale": 0.1},
    9: {"key": "unemp_urban", "sheet": "Overall", "scale": 0.1},
    10: {"key": "mpi_headcount", "column": r"NFHS-5.*|Headcount", "year": "2019-21"},
    19: {"key": "nsdp_pc"},
    21: {"key": "gsdp", "scale": 0.01},          # ₹ lakh -> ₹ crore
    22: {"key": "gsdp_real", "scale": 0.01},
    23: {"key": "nsdp", "scale": 0.01},
    25: {"key": "gsva", "scale": 0.01},
    29: {"key": "gsva_agri", "scale": 0.01},
    33: {"key": "gsva_mfg", "scale": 0.01},
    49: {"key": "gsva_services", "scale": 0.01},
    57: {"key": "cropping_intensity"},
    106: {"key": "sdg_score"},
    108: {"key": "cpi_general"},
    111: {"key": "cpi_housing"},
    112: {"key": "wage_construction"},
    113: {"key": "wage_agri"},
    116: {"key": "factories", "transposed": True},
    122: {"key": "factory_workers", "transposed": True},
    138: {"key": "power_pc"},
    148: {"key": "td_losses"},
    154: {"key": "cd_ratio", "march_end": True},
    155: {"key": "deposits", "march_end": True},
    156: {"key": "credit", "march_end": True},
    164: {"key": "gfd"},
    168: {"key": "own_tax"},
    170: {"key": "interest"},
    171: {"key": "pension"},
    173: {"key": "capex"},
    181: {"key": "exports"},
}

# What the site shows. "from": a table key, or a formula over table keys evaluated for one year.
# "better": which direction is good for citizens, if that is uncontroversial; otherwise None.
INDICATORS = [
    ("income", "nsdp_pc", "Income per person (net state domestic product)", "₹", {"from": "nsdp_pc"}, "higher", 19),
    ("income", "gsdp", "Size of the state economy (GSDP)", "₹ crore", {"from": "gsdp"}, None, 21),
    ("income", "gsdp_growth", "Real GDP growth", "%", {"growth": "gsdp_real"}, "higher", 22),
    ("income", "population", "Population (derived: NSDP ÷ NSDP per person)", "lakh people", {"ratio": ("nsdp", "nsdp_pc"), "k": 1e7 / 1e5}, None, 23),
    ("income", "mpi_headcount", "People in multidimensional poverty", "%", {"from": "mpi_headcount"}, "lower", 10),
    ("structure", "share_agri", "Agriculture's share of the economy", "% of GSVA", {"ratio": ("gsva_agri", "gsva"), "k": 100}, None, 29),
    ("structure", "share_mfg", "Manufacturing's share of the economy", "% of GSVA", {"ratio": ("gsva_mfg", "gsva"), "k": 100}, None, 33),
    ("structure", "share_services", "Services' share of the economy", "% of GSVA", {"ratio": ("gsva_services", "gsva"), "k": 100}, None, 49),
    ("labour", "unemp_urban", "Unemployment rate, urban", "%", {"from": "unemp_urban"}, "lower", 9),
    ("labour", "unemp_rural", "Unemployment rate, rural", "%", {"from": "unemp_rural"}, "lower", 8),
    ("labour", "wage_construction", "Daily wage, rural construction worker (men)", "₹", {"from": "wage_construction"}, None, 112),
    ("labour", "wage_agri", "Daily wage, rural farm labourer (men)", "₹", {"from": "wage_agri"}, None, 113),
    ("prices", "cpi_general", "Consumer price inflation", "%", {"from": "cpi_general"}, "lower", 108),
    ("prices", "cpi_housing", "Housing cost inflation (urban)", "%", {"from": "cpi_housing"}, "lower", 111),
    ("land", "cropping_intensity", "Cropping intensity (gross sown ÷ net sown area)", "%", {"from": "cropping_intensity"}, "higher", 57),
    ("capital", "cd_ratio", "Bank credit-deposit ratio", "%", {"from": "cd_ratio"}, None, 154),
    ("capital", "credit_pc", "Bank credit per person", "₹", {"ratio": ("credit", "population_abs"), "k": 1e7}, None, 156),
    ("capital", "deposits_pc", "Bank deposits per person", "₹", {"ratio": ("deposits", "population_abs"), "k": 1e7}, None, 155),
    ("industry", "factories", "Registered factories", "units", {"from": "factories"}, None, 116),
    ("industry", "factory_workers", "Factory workers", "people", {"from": "factory_workers"}, None, 122),
    ("utilities", "power_pc", "Electricity available per person", "kWh", {"from": "power_pc"}, "higher", 138),
    ("utilities", "td_losses", "Electricity lost in transmission and distribution", "%", {"from": "td_losses"}, "lower", 148),
    ("fiscal", "own_tax_gsdp", "State's own tax revenue", "% of GSDP", {"ratio": ("own_tax", "gsdp"), "k": 100}, None, 168),
    ("fiscal", "gfd_gsdp", "State fiscal deficit", "% of GSDP", {"ratio": ("gfd", "gsdp"), "k": 100}, "lower", 164),
    ("fiscal", "interest_gsdp", "Interest payments", "% of GSDP", {"ratio": ("interest", "gsdp"), "k": 100}, "lower", 170),
    ("fiscal", "pension_gsdp", "Pension payments", "% of GSDP", {"ratio": ("pension", "gsdp"), "k": 100}, None, 171),
    ("fiscal", "capex_gsdp", "Capital expenditure", "% of GSDP", {"ratio": ("capex", "gsdp"), "k": 100}, "higher", 173),
    ("trade", "exports", "Exports", "US$ million", {"from": "exports"}, None, 181),
    ("social", "sdg_score", "SDG India Index score (NITI Aayog)", "score out of 100", {"from": "sdg_score"}, "higher", 106),
]
GROUPS = {"income": "Income and size", "structure": "What the economy makes", "labour": "Work and wages",
          "prices": "Prices", "land": "Land", "capital": "Banking and capital", "industry": "Industry",
          "utilities": "Electricity", "fiscal": "State finances", "trade": "Trade", "social": "Development"}

ALIASES = {"andaman and nicobar islands": "AN", "a and n islands": "AN", "jammu and kashmir": "JK",
           "jammu and kashmir ut": "JK", "delhi": "DL", "nct of delhi": "DL", "orissa": "OD", "pondicherry": "PY",
           "dadra and nagar haveli and daman and diu": "DH", "uttaranchal": "UK", "chattisgarh": "CG",
           "uttarpradesh": "UP", "andaman and nicobar island": "AN",
           # since the 2020 merger the Handbook reports the merged UT on the "Dadra & Nagar Haveli" row
           # ("figures for Dadra and Nagar Haveli include Daman and Diu as well"); older separate rows for
           # Daman & Diu are left out so they cannot overwrite it
           "dadra and nagar haveli": "DH", "daman and diu and dadra and nagar haveli": "DH"}


def name_key(label):
    """'Andaman & Nicobar Islands*' -> 'andaman and nicobar islands'"""
    s = re.sub(r"\(.*?\)|[*#@$]", "", str(label or "")).lower().replace("&", "and")
    return " ".join(re.sub(r"[^a-z ]", " ", s).split())


# ---------------------------------------------------------------- reading spreadsheets (stdlib)
def sheets(path):
    z = zipfile.ZipFile(path)
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        ss = ["".join(t.text or "" for t in si.iter(M + "t")) for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(M + "si")]
    names = sorted((n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)),
                   key=lambda n: int(re.search(r"(\d+)\.xml", n).group(1)))
    for n in names:
        rows = []
        for r in ET.fromstring(z.read(n)).iter(M + "row"):
            row = {}
            for c in r.iter(M + "c"):
                col, t, v = re.match(r"[A-Z]+", c.get("r")).group(0), c.get("t"), c.find(M + "v")
                if t == "inlineStr":
                    row[col] = "".join(x.text or "" for x in c.iter(M + "t"))
                elif v is not None:
                    row[col] = ss[int(v.text)] if t == "s" else v.text
            rows.append(row)
        yield rows


def num(s):
    s = str(s or "").strip().replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


def year_of(label):
    m = re.match(r"(\d{4})(-\d{2,4})?", str(label).strip())
    return m.group(0) if m else None


def cols(row):
    return sorted(row, key=lambda c: (len(c), c))


def read_table(path, spec, state_id):
    """-> {state: {year: value}}"""
    out = {}
    for rows in sheets(path):
        head = " ".join(r.get("B", "") for r in rows[:4])
        if spec.get("sheet") and spec["sheet"].lower() not in head.lower():
            continue
        if spec.get("transposed"):
            # years down the side, states across; a sheet may hold several blocks, each with its own
            # "Year" header row naming the states it covers
            states = {}
            for r in rows:
                if str(r.get("B", "")).strip().lower() == "year":
                    states = {c: state_id(v) for c, v in r.items() if c != "B"}
                    continue
                y = year_of(r.get("B"))
                if not y:
                    continue
                for c, st in states.items():
                    v = num(r.get(c))
                    if st and v is not None:
                        out.setdefault(st, {})[y] = v * spec.get("scale", 1)
            continue
        if spec.get("column"):
            # labelled columns over two header rows: pick the one matching every part of the pattern
            parts = spec["column"].split("|")
            h1 = next((r for r in rows if "State" in str(r.get("B", ""))), {})
            h2 = rows[rows.index(h1) + 1] if h1 in rows else {}
            top, pick = None, None
            for c in cols({**h1, **h2}):
                if c == "B":
                    continue
                top = h1.get(c, top)
                if all(re.search(p, f"{top} {h2.get(c, '')}", re.I) for p in parts):
                    pick = c
                    break
            for r in rows:
                st = state_id(r.get("B"))
                if st and pick and num(r.get(pick)) is not None:
                    out.setdefault(st, {})[spec["year"]] = num(r[pick]) * spec.get("scale", 1)
            continue
        h = next((r for r in rows if sum(bool(year_of(v)) for k, v in r.items() if k != "B") >= 2), None)
        if not h:
            continue
        years = {c: year_of(v) for c, v in h.items() if c != "B" and year_of(v)}
        if spec.get("march_end"):   # "2025" = end-March 2025 = the close of 2024-25
            years = {c: f"{int(y[:4]) - 1}-{y[2:4]}" if len(y) == 4 else y for c, y in years.items()}
        for r in rows:
            st = state_id(r.get("B"))
            if not st:
                continue
            for c, y in years.items():
                v = num(r.get(c))
                if v is not None:
                    out.setdefault(st, {})[y] = v * spec.get("scale", 1)
    return out


# ---------------------------------------------------------------- building indicators
def latest(series):
    if not series:
        return None, None
    y = max(series, key=lambda s: s[:4])
    return y, series[y]


def build(raw):
    # population in people, for per-person figures: NSDP (₹ crore) / NSDP per person (₹)
    pop = {}
    for st, s in raw.get("nsdp", {}).items():
        pc = raw.get("nsdp_pc", {}).get(st, {})
        pop[st] = {y: s[y] * 1e7 / pc[y] for y in s if pc.get(y)}
    raw["population_abs"] = pop
    values = {}
    for group, mid, label, unit, how, better, table in INDICATORS:
        vals = {}
        states = set().union(*[raw.get(k, {}).keys() for k in (how.get("ratio") or (how.get("from") or how.get("growth"),))])
        for st in states:
            if "from" in how:
                y, v = latest(raw.get(how["from"], {}).get(st, {}))
            elif "growth" in how:
                s = raw.get(how["growth"], {}).get(st, {})
                ys = sorted(s, key=lambda x: x[:4])
                y, v = (ys[-1], (s[ys[-1]] / s[ys[-2]] - 1) * 100) if len(ys) >= 2 and s[ys[-2]] else (None, None)
            else:
                a, b = (raw.get(k, {}).get(st, {}) for k in how["ratio"])
                common = sorted(set(a) & set(b), key=lambda x: x[:4])
                y = common[-1] if common else None
                v = a[y] / b[y] * how.get("k", 1) if y and b[y] else None
                if mid == "population" and v is not None:
                    v = a[y] * 1e7 / b[y] / 1e5
            if v is not None:
                vals[st] = {"v": round(v, 2 if abs(v) < 100 else 0), "year": y}
        values[mid] = vals
    return values


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("folder", nargs="?", help="folder holding the Handbook spreadsheets")
    ap.add_argument("--tables", action="store_true", help="print the table numbers used, for fetch_rbi_handbook.mjs")
    ap.add_argument("--edition", default=None, help="e.g. 2024-25 (default: taken from the files)")
    args = ap.parse_args()
    if args.tables:
        print(" ".join(str(n) for n in TABLES))
        return
    if not args.folder:
        ap.error("give the folder holding the Handbook spreadsheets")

    states, _, _ = jurisdictions()
    names = {name_key(s["name"]): sid for sid, s in states.items()}

    def state_id(label):
        k = name_key(label)
        return None if k == "daman and diu" else ALIASES.get(k) or names.get(k)

    files = {int(m.group(1)): f for f in Path(args.folder).glob("*.[xX][lL][sS][xX]") if (m := re.match(r"(\d+)T", f.name))}
    missing = sorted(set(TABLES) - set(files))
    if missing:
        print(f"note: tables not found, their indicators are skipped: {missing}", file=sys.stderr)
    raw = {spec["key"]: read_table(files[n], spec, state_id) for n, spec in TABLES.items() if n in files}
    values = build(raw)

    edition = args.edition or EDITION
    today = dt.date.today().isoformat()
    out = {
        "version": 1,
        "note": "State indicators from the RBI Handbook of Statistics on Indian States. Each value is the latest year the Handbook gives for that state; 'year' says which. Built by scripts/ingest_rbi_handbook.py.",
        "source": {"title": f"Handbook of Statistics on Indian States {edition}", "publisher": "Reserve Bank of India", "url": PAGE, "accessed": today,
                   "terms": "RBI publications may be reproduced with acknowledgement of the source."},
        "groups": GROUPS,
        "indicators": [{"id": mid, "group": g, "label": label, "unit": unit, "better": better, "table": table}
                       for g, mid, label, unit, how, better, table in INDICATORS if values.get(mid)],
        "values": {k: v for k, v in values.items() if v},
    }
    dump("economic/indicators.json", out)
    for ind in out["indicators"]:
        vs = out["values"][ind["id"]]
        years = sorted({x["year"] for x in vs.values()})
        print(f"{ind['id']:18s} {len(vs):2d} states  years {years[0]}..{years[-1]}")


if __name__ == "__main__":
    main()
