#!/usr/bin/env python3
"""Fill in state-level office holders from Wikipedia's lists of current office holders.

Covers the posts Wikipedia keeps reliably current in one table each:

    state.cm                     Chief minister (India)                      "Officeholder" table
    state.governor               Governor (India)                            states table
    ut.lieutenant_governor       Governor (India)                            union territory tables
    ut.administrator             Governor (India)                            union territory tables
    state.hc_cj                  List of sitting judges of the high courts   the "(CJ)" judge per court

Every record written is marked `unverified` with the Wikipedia revision it came from as the source,
so the site shows it as unchecked until someone confirms it against an official source.
Records already marked `verified` are never touched.

    python scripts/import_wikipedia.py            # write, rebuild indexes, validate
    python scripts/import_wikipedia.py --dry-run  # show what would change

Standard library only.
"""
import argparse
import datetime as dt
import json
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from html.parser import HTMLParser

from slc_data import DATA, dump, jurisdictions, load

API = "https://en.wikipedia.org/w/api.php"
UA = "seeinglikeacitizen-import/1.0 (https://github.com/seeinglikeacitizen/seeinglikeacitizen.github.io)"
TODAY = dt.date.today().isoformat()
MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                      "september", "october", "november", "december"], 1)}
NOTE = "Imported from Wikipedia by scripts/import_wikipedia.py. Check against an official source."

# Wikipedia's spelling -> ours, where they differ
PLACE_ALIASES = {
    "national capital territory of delhi": "delhi",
    "nct of delhi": "delhi",
    "orissa": "odisha",
    "keralam": "kerala",
}


# ---------------------------------------------------------------- fetching and table parsing
def fetch(page):
    q = urllib.parse.urlencode({"action": "parse", "page": page, "prop": "text|revid", "format": "json",
                                "formatversion": 2, "redirects": 1})
    req = urllib.request.Request(f"{API}?{q}", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
    if "error" in d:
        raise SystemExit(f"Wikipedia: {page}: {d['error'].get('info')}")
    p = d["parse"]
    title = p["title"]
    return {
        "html": p["text"], "title": title,
        "source": {
            "url": f"https://en.wikipedia.org/w/index.php?title={urllib.parse.quote(title.replace(' ', '_'))}&oldid={p['revid']}",
            "title": title, "publisher": "Wikipedia", "accessed": TODAY,
        },
    }


class Tables(HTMLParser):
    """Collects every wikitable as rows of cells, with the section heading it sits under."""

    def __init__(self):
        super().__init__()
        self.tables, self.stack, self.cell, self.skip = [], [], None, 0
        self.heading, self.in_heading = "", False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("h2", "h3"):
            self.in_heading, self.heading = True, ""
        elif tag == "table":
            self.stack.append({"cls": a.get("class") or "", "rows": [], "heading": self.heading})
        elif not self.stack:
            return
        elif tag == "tr":
            self.stack[-1]["rows"].append([])
        elif tag in ("td", "th"):
            span = lambda k: int(re.sub(r"\D", "", a.get(k) or "1") or 1)
            self.cell = {"text": "", "rowspan": span("rowspan"), "colspan": span("colspan")}
            if self.stack[-1]["rows"]:
                self.stack[-1]["rows"][-1].append(self.cell)
        elif tag in ("sup", "style"):
            self.skip += 1
        elif tag == "br" and self.cell is not None:
            self.cell["text"] += " "

    def handle_endtag(self, tag):
        if tag in ("h2", "h3"):
            self.in_heading = False
        elif tag == "table" and self.stack:
            t = self.stack.pop()
            if "wikitable" in t["cls"]:
                self.tables.append({"heading": t["heading"].strip(), "rows": grid(t["rows"])})
        elif tag in ("sup", "style") and self.skip:
            self.skip -= 1
        elif tag in ("td", "th"):
            self.cell = None

    def handle_data(self, data):
        if self.in_heading:
            self.heading += data
        elif self.cell is not None and not self.skip:
            self.cell["text"] += data


def grid(rows):
    """Expand rowspan/colspan so every row has one string per column."""
    out, carry = [], {}
    for r in rows:
        row, col, k = [], 0, 0
        while k < len(r) or col in carry:
            if col in carry:
                txt, left = carry[col]
                row.append(txt)
                if left > 1:
                    carry[col] = (txt, left - 1)
                else:
                    del carry[col]
                col += 1
                continue
            c = r[k]
            k += 1
            txt = " ".join(c["text"].split())
            for _ in range(c["colspan"]):
                if c["rowspan"] > 1:
                    carry[col] = (txt, c["rowspan"] - 1)
                row.append(txt)
                col += 1
        out.append(row)
    return out


def tables(page):
    p = Tables()
    p.feed(page["html"])
    return p.tables


# ---------------------------------------------------------------- matching
def norm(s):
    s = re.sub(r"\(.*?\)|\[.*?\]", "", s.lower()).replace("&", "and")
    s = re.sub(r"[^a-z ]", " ", s)
    s = " ".join(s.split())
    return PLACE_ALIASES.get(s, s)


def parse_date(s):
    m = re.search(r"(\d{1,2}) ([A-Za-z]+),? (\d{4})", s or "")
    if m and m.group(2).lower() in MONTHS:
        return f"{m.group(3)}-{MONTHS[m.group(2).lower()]:02d}-{int(m.group(1)):02d}"
    m = re.search(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", s or "")   # 05.02.2024 (day.month.year)
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    return None


def clean_name(s):
    s = re.sub(r"\((a?cj|acting.*?|additional charge.*?)\)", "", s, flags=re.I)
    return " ".join(s.split()).strip(" ,")


def looks_vacant(name):
    return not name or re.search(r"vacant|president'?s rule|none|^[-–—]+$", name, re.I)


def col(header, *words):
    for i, h in enumerate(header):
        if all(w in h.lower() for w in words):
            return i
    return None


def officeholder_rows(tbls, first_col_words):
    """Rows of every table whose header has an 'Officeholder' column and whose first column matches."""
    for t in tbls:
        if not t["rows"]:
            continue
        h = t["rows"][0]
        who = col(h, "officeholder")
        if who is None or not any(w in h[0].lower() for w in first_col_words):
            continue
        since = next((i for i, x in enumerate(h) if i != who and re.search(r"(took|assumed) office", x, re.I)), None)
        for r in t["rows"][1:]:
            if len(r) > max(who, since or 0):
                yield r[0], r[who], (r[since] if since is not None else "")


# ---------------------------------------------------------------- importers
def import_cms(states, by_name):
    page = fetch("List of current Indian chief ministers")
    out = {}
    for place, name, since in officeholder_rows(tables(page), ("state",)):
        st = by_name.get(norm(place))
        if not st or st in out or states[st]["legislature"] == "none":
            continue
        if looks_vacant(name):
            continue
        out[st] = record(clean_name(name), parse_date(since), page["source"])
    return {st: {"state.cm": r} for st, r in out.items()}


def import_heads(states, by_name):
    page = fetch("List of current Indian governors")
    office = {"Governor": "state.governor", "Lieutenant Governor": "ut.lieutenant_governor",
              "Administrator": "ut.administrator"}
    out = {}
    for place, name, since in officeholder_rows(tables(page), ("state", "union territory")):
        st = by_name.get(norm(place))
        if not st or st in out or looks_vacant(name):
            continue
        out[st] = {office[states[st]["head"]]: record(clean_name(name), parse_date(since), page["source"])}
    return out


def import_hc_cjs(hcs):
    page = fetch("List of sitting judges of the high courts of India")
    by_name = {}
    for hid, h in hcs.items():
        key = norm(h["name"]).replace("high court", "").replace("for the state of", "").replace("of ", " ")
        by_name[" ".join(key.split())] = hid
    out = {}
    for t in tables(page):
        key = " ".join(norm(t["heading"]).replace("high court", "").split())
        key = {"andhra pradesh": "andhra", "orissa": "orissa"}.get(key, key)
        hid = by_name.get(key) or next((v for k, v in by_name.items() if k.startswith(key) or key.startswith(k)), None)
        if not hid or hid in out or not t["rows"] or "name of the judge" not in t["rows"][0][0].lower():
            continue
        h = t["rows"][0]
        remarks = col(h, "remarks")
        for r in t["rows"][1:]:
            m = re.search(r"\((A?CJ)\)", r[0])
            if not m:
                continue
            since = parse_date(re.search(r"w\.?e\.?f\.?\s*([\d.]+)", r[remarks]).group(1)) \
                if remarks is not None and re.search(r"w\.?e\.?f", r[remarks] or "") else None
            rec = record(clean_name(r[0]), since, page["source"])
            if m.group(1) == "ACJ":
                rec["note"] = "Acting Chief Justice. " + NOTE
            out[hid] = {"state.hc_cj": rec}
            break
    return out


def record(name, since, source):
    return {"name": name, "since": since, "status": "unverified", "sources": [source], "verified_at": None,
            "note": NOTE}


# ---------------------------------------------------------------- writing
def merge(target, office_id, rec, where, changes):
    old = target.get(office_id)
    if isinstance(old, dict) and old.get("status") == "verified":
        return   # never overwrite a checked record
    if isinstance(old, dict) and old.get("name") == rec["name"] and old.get("since") == rec["since"]:
        return
    changes.append(f"{where} {office_id}: {old.get('name') if isinstance(old, dict) else '—'} -> {rec['name']}"
                   f"{' (since ' + rec['since'] + ')' if rec['since'] else ''}")
    target[office_id] = rec


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    states, _, hcs = jurisdictions()
    by_name = {norm(s["name"]): sid for sid, s in states.items()}
    changes = []

    per_state = {}
    for part in (import_cms(states, by_name), import_heads(states, by_name)):
        for st, recs in part.items():
            per_state.setdefault(st, {}).update(recs)
    missing = sorted(set(states) - set(per_state))
    for st, recs in sorted(per_state.items()):
        rel = f"holders/states/{st}.json"
        f = load(rel, default={"version": 1, "jurisdiction": st, "holders": {}})
        for oid, rec in recs.items():
            merge(f["holders"], oid, rec, st, changes)
        if not args.dry_run:
            dump(rel, f)

    hcf = load("holders/high_courts.json")
    cjs = import_hc_cjs(hcs)
    for hid, recs in sorted(cjs.items()):
        for oid, rec in recs.items():
            merge(hcf["high_courts"].setdefault(hid, {}), oid, rec, hid, changes)
    if not args.dry_run:
        dump("holders/high_courts.json", hcf)

    print("\n".join(changes) or "No changes.")
    if missing:
        print(f"note: nothing found for {', '.join(missing)}", file=sys.stderr)
    if set(hcs) - set(cjs):
        print(f"note: no Chief Justice found for {', '.join(sorted(set(hcs) - set(cjs)))}", file=sys.stderr)
    if not args.dry_run:
        here = DATA.parent / "scripts"
        subprocess.run([sys.executable, here / "build_indexes.py"], check=True)
        subprocess.run([sys.executable, here / "validate_data.py"], check=True)


if __name__ == "__main__":
    main()
