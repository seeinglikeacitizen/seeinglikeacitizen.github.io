#!/usr/bin/env python3
"""Apply one verified change (from a report or the news sweep) to the data files.

It updates the holder record for the post, adds an event to data/timeline.json,
regenerates the indexes and validates everything. Nothing is written if validation fails.

Input is a JSON object, from a file or stdin:

    {
      "event": "took_office",            # took_office | elected | additional_charge |
                                         # resigned | removed | transferred | died | other
      "office": "district.dm",           # id from data/offices.json
      "jurisdiction": "MH/pune",         # IN, a state code, a district id, or a High Court id
      "person": "Jane Doe",
      "date": "2026-09-20",
      "predecessor": "John Roe",         # optional; filled in automatically when replacing
      "summary": "Jane Doe took charge as Collector and District Magistrate of Pune.",
      "status": "verified",              # verified | unverified | disputed
      "sources": [{"url": "https://...", "title": "...", "publisher": "...", "accessed": "2026-09-21"}],
      "report_issue": 123,               # optional GitHub issue number
      "note": "optional free text"
    }

    python scripts/apply_update.py update.json
    python scripts/apply_update.py - < update.json
    python scripts/apply_update.py update.json --dry-run
"""
import argparse
import copy
import datetime as dt
import json
import subprocess
import sys

from slc_data import (ARRIVING, DATA, DATE_RE, EVENT_TYPES, LEAVING, STATUSES, applies, dump,
                      empty_holder_file, holder_file_for, holder_list, is_district, jurisdictions,
                      load, norm_name, offices, state_of)


def fail(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(2)


def check_input(u, O, states, districts, hcs):
    for k in ("event", "office", "jurisdiction", "person", "date", "sources", "status"):
        if k not in u or u[k] in (None, ""):
            if not (k == "sources" and isinstance(u.get(k), list)):
                fail(f"missing '{k}'")
    if u["event"] not in EVENT_TYPES:
        fail(f"event must be one of {list(EVENT_TYPES)}")
    if u["status"] not in STATUSES - {"unverified_seed"}:
        fail("status must be verified, unverified or disputed")
    if u["status"] == "verified" and not u["sources"]:
        fail("a verified update needs at least one source")
    if not DATE_RE.match(u["date"]):
        fail("date must be YYYY-MM-DD (or YYYY-MM / YYYY if that's all the source gives)")
    n = O.get(u["office"])
    if not n:
        fail(f"unknown office {u['office']}")
    if n["kind"] != "office":
        fail(f"{u['office']} is a {n['kind']}, not a post someone holds")
    j = u["jurisdiction"]
    if n["scope"] == "national":
        if j != "IN":
            fail("national offices use jurisdiction IN")
    elif j in hcs:
        if not u["office"].startswith("state.hc_"):
            fail("a High Court id is only valid for High Court posts")
    else:
        st = state_of(j)
        if st not in states:
            fail(f"unknown state {st}")
        if is_district(j) and j not in districts:
            fail(f"unknown district {j}; see data/jurisdictions.json")
        if n["scope"] in ("district", "local") and not is_district(j):
            fail(f"{u['office']} is {n['scope']}-level; jurisdiction must be a district id")
        if not applies(n, st, states):
            fail(f"{u['office']} does not exist in {st}")
    return n


def get_path(obj, keys):
    for k in keys[:-1]:
        obj = obj.setdefault(k, {})
    return obj, keys[-1]


def apply_holder(u, n, rel, keys):
    data = load(rel, default=None) if (DATA / rel).exists() else empty_holder_file(rel, u["jurisdiction"])
    parent, key = get_path(data, keys)
    current = holder_list(parent.get(key))
    today = dt.date.today().isoformat()
    rec = {
        "name": u["person"], "since": u["date"], "status": u["status"], "sources": u["sources"],
        "verified_at": today if u["status"] == "verified" else None,
    }
    if u["event"] == "additional_charge":
        rec["note"] = "Additional charge"
    if u.get("note"):
        rec["note"] = (rec.get("note", "") + "; " if rec.get("note") else "") + u["note"]
    who = norm_name(u["person"])
    others = [h for h in current if h.get("name") and norm_name(h["name"]) != who]
    predecessor = None

    if u["event"] in ARRIVING:
        if n.get("multiple_holders"):
            new = others + [rec]
        else:
            named = [h for h in current if h.get("name") and norm_name(h["name"]) != who]
            predecessor = named[0]["name"] if named else None
            new = [rec]
    elif u["event"] in LEAVING:
        if not any(h.get("name") and norm_name(h["name"]) == who for h in current):
            print(f"note: {u['person']} was not recorded as holding this post; recording the event only",
                  file=sys.stderr)
        if n.get("multiple_holders"):
            new = others
        else:
            new = [{"name": None, "vacant_since": u["date"], "status": u["status"], "sources": u["sources"],
                    "verified_at": rec["verified_at"],
                    "note": f"{u['person']}: {EVENT_TYPES[u['event']].lower()}. Successor not yet recorded."}]
    else:  # "other": timeline only
        return data, None, rel

    if not new:
        parent.pop(key, None)
    else:
        parent[key] = new[0] if len(new) == 1 and not n.get("multiple_holders") else new
    return data, predecessor, rel


def timeline_event(u, predecessor):
    ev = {
        "id": f"{u['date']}-{u['office']}-{u['jurisdiction']}-{norm_name(u['person'])[:24]}".replace("/", "_"),
        "date": u["date"], "office": u["office"], "jurisdiction": u["jurisdiction"], "type": u["event"],
        "person": u["person"],
    }
    if u.get("predecessor") or predecessor:
        ev["predecessor"] = u.get("predecessor") or predecessor
    ev["summary"] = u.get("summary") or f"{u['person']}: {EVENT_TYPES[u['event']].lower()}."
    ev["status"] = u["status"]
    ev["sources"] = u["sources"]
    if u.get("report_issue"):
        ev["report_issue"] = int(u["report_issue"])
    return ev


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="update JSON file, or - for stdin")
    ap.add_argument("--dry-run", action="store_true", help="print what would change and write nothing")
    a = ap.parse_args()
    u = json.load(sys.stdin if a.file == "-" else open(a.file, encoding="utf-8"))

    O = offices()
    states, districts, hcs = jurisdictions()
    n = check_input(u, O, states, districts, hcs)
    rel, keys = holder_file_for(n, u["jurisdiction"], states)
    before = copy.deepcopy(load(rel)) if (DATA / rel).exists() else None
    data, predecessor, rel = apply_holder(u, n, rel, keys)

    tl = load("timeline.json")
    ev = timeline_event(u, predecessor)
    if any(e["id"] == ev["id"] for e in tl["events"]):
        fail(f"timeline already has event {ev['id']}")
    tl["events"].append(ev)
    tl["events"].sort(key=lambda e: e["date"], reverse=True)

    if a.dry_run:
        print(f"would write data/{rel} at {'.'.join(keys)}:")
        parent = data
        for k in keys:
            parent = parent.get(k) if isinstance(parent, dict) else None
        print(json.dumps(parent, ensure_ascii=False, indent=1))
        print("would add timeline event:")
        print(json.dumps(ev, ensure_ascii=False, indent=1))
        return

    tl_before = load("timeline.json")
    dump(rel, data)
    dump("timeline.json", tl)
    scripts = DATA.parent / "scripts"
    subprocess.run([sys.executable, str(scripts / "build_indexes.py")], check=True, capture_output=True)
    v = subprocess.run([sys.executable, str(scripts / "validate_data.py"), "--quiet"], capture_output=True, text=True)
    if v.returncode != 0:
        # roll back
        if before is None:
            (DATA / rel).unlink(missing_ok=True)
        else:
            dump(rel, before)
        dump("timeline.json", tl_before)
        subprocess.run([sys.executable, str(scripts / "build_indexes.py")], capture_output=True)
        print(v.stdout, file=sys.stderr)
        fail("validation failed; nothing was changed")
    print(f"updated data/{rel} ({'.'.join(keys)}) and data/timeline.json [{ev['id']}]")


if __name__ == "__main__":
    main()
