#!/usr/bin/env python3
"""Check every data file: references resolve, dates parse, verified records carry sources.

Exit code 1 on any error. Warnings (such as unverified seeds) never fail the build.

    python scripts/validate_data.py            # everything
    python scripts/validate_data.py --strict   # also fail on warnings
"""
import argparse
import sys
from urllib.parse import urlparse

from slc_data import (DATA, DATE_RE, EVENT_TYPES, STATUSES, applies, constituency_ids, holder_list, is_district,
                      is_hc_office, jurisdictions, load, offices, state_of)

errors, warnings = [], []


def err(where, msg):
    errors.append(f"{where}: {msg}")


def warn(where, msg):
    warnings.append(f"{where}: {msg}")


def check_sources(where, rec, required):
    srcs = rec.get("sources")
    if srcs is None:
        err(where, "missing 'sources' (use [] if there are none yet)")
        return
    if not isinstance(srcs, list):
        err(where, "'sources' must be a list")
        return
    for i, s in enumerate(srcs):
        u = urlparse(s.get("url", ""))
        if u.scheme not in ("http", "https") or not u.netloc:
            err(f"{where}.sources[{i}]", f"bad url {s.get('url')!r}")
        if not s.get("publisher") and not s.get("title"):
            err(f"{where}.sources[{i}]", "needs a publisher or title")
        if s.get("accessed") and not DATE_RE.match(s["accessed"]):
            err(f"{where}.sources[{i}]", f"accessed date {s['accessed']!r} is not YYYY-MM-DD")
    if required and not srcs:
        err(where, "status is 'verified' but there are no sources")


def check_record(where, rec):
    status = rec.get("status")
    if status not in STATUSES:
        err(where, f"status {status!r} not one of {sorted(STATUSES)}")
    for k in ("since", "until", "date", "verified_at"):
        v = rec.get(k)
        if v and not DATE_RE.match(str(v)[:10]):
            err(where, f"{k} {v!r} is not a date")
    check_sources(where, rec, status == "verified")
    if status == "unverified_seed":
        warn(where, "unverified seed")


def check_offices(O):
    ids = set(O)
    branches = set(load("offices.json")["branches"])
    methods = set(load("offices.json")["methods"])
    for oid, n in O.items():
        if n["branch"] not in branches:
            err(f"offices.{oid}", f"unknown branch {n['branch']}")
        sel = n.get("selection", {})
        if sel.get("method") not in methods:
            err(f"offices.{oid}", f"unknown method {sel.get('method')}")
        for rel in ("by", "advice", "consult", "confidence", "members"):
            for p in sel.get(rel, []) or []:
                if p not in ids:
                    err(f"offices.{oid}.selection.{rel}", f"unknown office {p}")


def check_holders(O, states, districts, hcs):
    nat = load("holders/national.json")
    for oid, h in nat.get("holders", {}).items():
        if oid not in O or O[oid]["scope"] != "national":
            err(f"holders/national.json:{oid}", "not a national office")
        for i, r in enumerate(holder_list(h)):
            check_record(f"holders/national.json:{oid}[{i}]", r)

    hc = load("holders/high_courts.json")
    for hcid, offs in hc.get("high_courts", {}).items():
        if hcid not in hcs:
            err(f"holders/high_courts.json:{hcid}", "unknown High Court id")
        for oid, h in offs.items():
            if not is_hc_office(oid):
                err(f"holders/high_courts.json:{hcid}.{oid}", "not a High Court office")
            for i, r in enumerate(holder_list(h)):
                check_record(f"holders/high_courts.json:{hcid}.{oid}[{i}]", r)

    for f in sorted((DATA / "holders/states").glob("*.json")) if (DATA / "holders/states").exists() else []:
        st = f.stem
        where = f"holders/states/{f.name}"
        if st not in states:
            err(where, "file name is not a state code")
            continue
        for oid, h in load(f"holders/states/{f.name}").get("holders", {}).items():
            n = O.get(oid)
            if not n or n["scope"] != "state" or is_hc_office(oid):
                err(f"{where}:{oid}", "not a state-level office (High Court posts go in high_courts.json)")
            elif not applies(n, st, states):
                err(f"{where}:{oid}", f"office does not exist in {st}")
            for i, r in enumerate(holder_list(h)):
                check_record(f"{where}:{oid}[{i}]", r)

    for f in sorted((DATA / "holders/districts").glob("*.json")) if (DATA / "holders/districts").exists() else []:
        st = f.stem
        where = f"holders/districts/{f.name}"
        for did, offs in load(f"holders/districts/{f.name}").get("districts", {}).items():
            if did not in districts or state_of(did) != st:
                err(f"{where}:{did}", "unknown district for this state file")
                continue
            for oid, h in offs.items():
                n = O.get(oid)
                if not n or n["scope"] not in ("district", "local"):
                    err(f"{where}:{did}.{oid}", "not a district or local office")
                elif not applies(n, st, states):
                    err(f"{where}:{did}.{oid}", f"office does not exist in {st}")
                for i, r in enumerate(holder_list(h)):
                    check_record(f"{where}:{did}.{oid}[{i}]", r)


def check_constituency_holders(O):
    d = DATA / "holders/constituencies"
    if not d.exists():
        return
    geo = load("geo/constituencies.json")
    ids = {f["properties"]["id"] for k in ("lok_sabha", "vidhan_sabha") for f in geo[k]["features"]}
    office_for = {"LS": "in.lok_sabha_mp", "VS": "state.mla", "RS": "in.rajya_sabha_mp"}
    for f in sorted(d.glob("*.json")):
        where = f"holders/constituencies/{f.name}"
        for cid, offs in load(f"holders/constituencies/{f.name}").get("constituencies", {}).items():
            kind, st = cid.split("/")[:2]
            if st != f.stem or (kind != "RS" and cid not in ids):
                err(f"{where}:{cid}", "unknown constituency for this state file")
            for oid, h in offs.items():
                if oid != office_for.get(kind):
                    err(f"{where}:{cid}.{oid}", f"a {kind} seat holds {office_for.get(kind)}, not {oid}")
                for i, r in enumerate(holder_list(h)):
                    check_record(f"{where}:{cid}.{oid}[{i}]", r)


def check_timeline(O, states, districts, hcs):
    seen = set()
    seats = constituency_ids(states)
    for i, e in enumerate(load("timeline.json").get("events", [])):
        where = f"timeline.json[{i}:{e.get('id')}]"
        if e.get("id") in seen:
            err(where, "duplicate id")
        seen.add(e.get("id"))
        if e.get("office") not in O:
            err(where, f"unknown office {e.get('office')}")
        j = e.get("jurisdiction")
        if not (j == "IN" or j in states or j in districts or j in hcs or j in seats):
            err(where, f"unknown jurisdiction {j}")
        if e.get("type") not in EVENT_TYPES:
            err(where, f"unknown type {e.get('type')}")
        if not e.get("date") or not DATE_RE.match(e["date"]):
            err(where, "needs a YYYY-MM-DD date")
        if not e.get("person"):
            err(where, "needs a person")
        check_record(where, e)


def check_economy(states):
    econ_dir = DATA / "economic/states"
    for f in sorted(econ_dir.glob("*.json")) if econ_dir.exists() else []:
        if f.stem.startswith("_"):
            continue
        where = f"economic/states/{f.name}"
        if f.stem not in states:
            err(where, "file name is not a state code")
        d = load(f"economic/states/{f.name}")
        for i, law in enumerate(d.get("laws", [])):
            if law.get("domain") not in ("land", "labour", "capital", "tax"):
                err(f"{where}.laws[{i}]", f"domain {law.get('domain')!r}")
            check_record(f"{where}.laws[{i}]", law)
        for k, t in (d.get("taxes") or {}).items():
            if t.get("value") is not None:
                check_sources(f"{where}.taxes.{k}", t, True)


def check_constituencies(states):
    path = DATA / "geo/constituencies.json"
    if not path.exists():
        return
    data = load("geo/constituencies.json")
    for kind, prefix in (("lok_sabha", "LS/"), ("vidhan_sabha", "VS/")):
        features = data.get(kind, {}).get("features", [])
        ids = []
        for i, f in enumerate(features):
            p = f.get("properties", {})
            where = f"geo/constituencies.json.{kind}[{i}]"
            ids.append(p.get("id"))
            if not str(p.get("id", "")).startswith(prefix):
                err(where, f"id must start with {prefix}")
            if p.get("st") not in states:
                err(where, f"unknown state {p.get('st')!r}")
            if f.get("geometry", {}).get("type") not in ("Polygon", "MultiPolygon"):
                err(where, "needs polygon geometry")
        if len(ids) != len(set(ids)):
            err(f"geo/constituencies.json.{kind}", "duplicate constituency ids")
        tiles = data.get("hex", {}).get(kind, {}).get("tiles", [])
        if {t.get("id") for t in tiles} != set(ids):
            err(f"geo/constituencies.json.hex.{kind}", "hex ids do not match boundary ids")
    if len(data.get("lok_sabha", {}).get("features", [])) != 543:
        warn("geo/constituencies.json.lok_sabha", "expected 543 elected constituencies")


def check_institutions(branches):
    seen = set()
    for i, p in enumerate(load("institutions.json").get("pins", [])):
        where = f"institutions.json.pins[{i}]"
        if p.get("id") in seen:
            err(where, f"duplicate id {p.get('id')!r}")
        seen.add(p.get("id"))
        if p.get("branch") not in branches:
            err(where, f"unknown branch {p.get('branch')!r}")
        at = p.get("latlng")
        if not isinstance(at, list) or len(at) != 2 or not all(isinstance(x, (int, float)) for x in at):
            err(where, "latlng must contain two numbers")


def check_money(O):
    path = DATA / "money/flows.json"
    if not path.exists():
        return
    flows, taxes = load("money/flows.json"), load("money/taxes.json")
    tax_ids = {t["id"] for t in taxes["taxes"]}
    for t in taxes["taxes"]:
        if t.get("category") not in taxes["categories"]:
            err(f"money/taxes.json:{t['id']}", f"unknown category {t.get('category')!r}")
    node_refs = set()
    for did, d in flows["diagrams"].items():
        views = list((d.get("views") or {"": {"nodes": [], "links": []}}).items())
        for s in d.get("sources", []):
            check_sources(f"money/flows.json:{did}", {"sources": [s]}, False)
        for vk, v in views:
            where = f"money/flows.json:{did}{'/' + vk if vk else ''}"
            nodes = {n["id"]: n for n in d["nodes"] + v["nodes"]}
            node_refs |= {f"{did}:{n}" for n in nodes}
            for n in nodes.values():
                if n.get("group") not in flows["groups"]:
                    err(f"{where}:{n['id']}", f"unknown group {n.get('group')!r}")
                for o in n.get("offices", []):
                    if o not in O:
                        err(f"{where}:{n['id']}", f"unknown office {o}")
                for t in n.get("taxes", []):
                    if t not in tax_ids:
                        err(f"{where}:{n['id']}", f"unknown tax {t}")
                if n.get("link", {}).get("diagram", did) not in flows["diagrams"]:
                    err(f"{where}:{n['id']}", "links to an unknown diagram")
            links = d["links"] + v["links"]
            for l in links:
                if l["from"] not in nodes or l["to"] not in nodes:
                    err(where, f"link {l['from']} -> {l['to']} names an unknown node")
                elif nodes[l["from"]]["col"] >= nodes[l["to"]]["col"]:
                    err(where, f"link {l['from']} -> {l['to']} must go to a later column")
                if l["value"] is not None and not (isinstance(l["value"], (int, float)) and l["value"] > 0):
                    err(where, f"link {l['from']} -> {l['to']} value must be positive or null")
            # money is conserved through every government node, within rounding
            for nid, n in nodes.items():
                if n["group"] != "gov" or n["col"] != 2:
                    continue
                i = sum(l["value"] or 0 for l in links if l["to"] == nid)
                o = sum(l["value"] or 0 for l in links if l["from"] == nid)
                if i and o and abs(i - o) > max(i, o) * 0.0001:
                    err(f"{where}:{nid}", f"money in ({i}) and out ({o}) differ")
    for t in taxes["taxes"]:
        if t.get("node") and t["node"] not in node_refs:
            err(f"money/taxes.json:{t['id']}", f"node {t['node']} not found in flows.json")


def check_crime(districts, states):
    for f in sorted((DATA / "crime").glob("*.json")):
        if f.name in ("index.json", "aliases.json"):
            continue
        where = f"crime/{f.name}"
        d = load(f"crime/{f.name}")
        if not d.get("year") or not d.get("source_url"):
            err(where, "needs year and source_url")
        cats = set(load("crime/index.json")["categories"]) | {"population", "matched_from"}
        for jid, row in d.get("values", {}).items():
            if not (jid in districts or jid in states):
                err(f"{where}:{jid}", "unknown jurisdiction")
            for k, v in row.items():
                if k not in cats:
                    err(f"{where}:{jid}", f"unknown category {k}")
                elif k != "matched_from" and not (isinstance(v, (int, float)) and v >= 0):
                    err(f"{where}:{jid}.{k}", f"bad value {v!r}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--strict", action="store_true")
    ap.add_argument("--quiet", action="store_true", help="don't list warnings")
    a = ap.parse_args()
    O = offices()
    states, districts, hcs = jurisdictions()
    check_offices(O)
    check_holders(O, states, districts, hcs)
    check_constituency_holders(O)
    check_timeline(O, states, districts, hcs)
    check_economy(states)
    check_constituencies(states)
    check_institutions(set(load("offices.json")["branches"]))
    check_money(O)
    check_crime(districts, states)
    for s in states.values():
        if s.get("high_court") not in hcs:
            err(f"jurisdictions.states.{s['id']}", f"unknown high_court {s.get('high_court')}")
    for d in districts.values():
        if d["state"] not in states:
            err(f"jurisdictions.districts.{d['id']}", "unknown state")

    if warnings and not a.quiet:
        print(f"{len(warnings)} warning(s); first few:")
        for w in warnings[:8]:
            print("  warn ", w)
    for e in errors:
        print("  ERROR", e)
    ok = not errors and not (a.strict and warnings)
    print("OK" if ok else f"{len(errors)} error(s)")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
