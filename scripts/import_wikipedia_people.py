#!/usr/bin/env python3
"""Fill in elected representatives and other office holders from Wikipedia's current lists.

    Lok Sabha MPs            List of members of the 18th Lok Sabha       -> holders/constituencies/<ST>.json
    Rajya Sabha MPs          List of current members of the Rajya Sabha -> holders/constituencies/<ST>.json
                                                                            (nominated members -> national.json)
    MLAs                     "<State> Legislative Assembly", members table -> holders/constituencies/<ST>.json,
                                                                            and district.mla lists by district
    MPs by district          derived: the Lok Sabha seats that contain the district's Assembly seats
    Union ministers          Union Council of Ministers                  -> holders/national.json
    Supreme Court            List of sitting judges of the Supreme Court -> holders/national.json
    Presiding officers       List of current Indian legislative speakers and chairpersons
    Leaders of Opposition    List of current Indian opposition leaders
    Other Union posts        the incumbent in each office's (or institution's) Wikipedia infobox

Every record is `unverified`, sourced to the Wikipedia revision it came from. Verified records are
never overwritten. Run through import_wikipedia.py, or on its own:

    python scripts/import_wikipedia_people.py [--dry-run]
"""
import argparse
import json
import re
import urllib.parse
import urllib.request
import sys
import time
from collections import defaultdict
from difflib import SequenceMatcher
from html import unescape

from import_wikipedia import API, UA, clean_name, col, fetch, merge, norm, parse_date, tables
from slc_data import DATA, dump, jurisdictions, load

CONST_NOTE = "Imported from Wikipedia by scripts/import_wikipedia_people.py. Check against an official source."
LEFT = re.compile(r"\b(died|death|resigned|disqualified|expelled|removed|vacant|elevated|elected to)\b", re.I)


def pad(t):
    """Data rows of a table, each padded to the header's width."""
    w = max(len(r) for r in t["rows"])
    return [r + [""] * (w - len(r)) for r in t["rows"][1:]]


def pause():
    time.sleep(1.5)   # be polite to the Wikipedia API


def rec(name, source, since=None, **extra):
    r = {"name": name, "since": since, "status": "unverified", "sources": [source], "verified_at": None, "note": CONST_NOTE}
    r.update({k: v for k, v in extra.items() if v})
    return r


def vacant(text, source):
    d = parse_date(text)
    r = {"name": None, "vacant_since": d, "status": "unverified", "sources": [source], "verified_at": None,
         "note": f"Wikipedia: {text}. {CONST_NOTE}"}
    return r


def person(cell):
    """'Ricky A. J. Syngkon (Died on 20 February 2026)' -> (None, note); 'Vacant' -> (None, note)."""
    text = " ".join(cell.split())
    if not text or LEFT.search(text):
        return None, text or "Vacant"
    return clean_name(re.sub(r"\(.*?\)", "", text)), None


def party_of(row, header):
    idx = [i for i, h in enumerate(header) if h.lower().startswith("party") or h.lower() == "political party"]
    vals = [row[i] for i in idx if i < len(row) and row[i].strip()]
    return vals[-1] if vals else None


def seat_key(name):
    return norm(re.sub(r"\((sc|st)\)", "", name, flags=re.I))


# Current seat name -> the name in our (2019) Lok Sabha boundaries, where a seat was renamed when it
# was redrawn (Assam in 2023, Jammu and Kashmir in 2022). The boundary shown is the older one.
RENAMED = {
    ("LS", "AS", "guwahati"): "gauhati", ("LS", "AS", "nagaon"): "nowgong", ("LS", "AS", "sonitpur"): "tezpur",
    ("LS", "AS", "kaziranga"): "kaliabor", ("LS", "AS", "diphu"): "autonomous district",
    ("LS", "AS", "darrang udalguri"): "mangaldoi", ("LS", "JK", "anantnag rajouri"): "anantnag",
}


def find_seat(house, st, index, name, no):
    """Match a seat by name; fall back to its number only if the names are still alike, because
    numbering changed wherever seats were redrawn."""
    ids = index[house].get(st)
    if not ids:
        return None
    key = seat_key(name)
    key = RENAMED.get((house, st, key), key)
    if key in ids["name"]:
        return ids["name"][key]
    sid = ids["no"].get(no)
    if sid and SequenceMatcher(None, key, ids["names_of"][sid]).ratio() >= 0.6:
        return sid
    return None


# ---------------------------------------------------------------- geometry (for MPs by district)
def centre(geom):
    ring = max((p[0] for p in geom["coordinates"]), key=len)
    return sum(x for x, _ in ring) / len(ring), sum(y for _, y in ring) / len(ring)


def inside(x, y, geom):
    def in_ring(ring):
        hit = False
        for i in range(len(ring)):
            (x1, y1), (x2, y2) = ring[i], ring[i - 1]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                hit = not hit
        return hit
    return any(in_ring(p[0]) for p in geom["coordinates"])


# ---------------------------------------------------------------- importers
def state_tables(page, states):
    by_name = {norm(s["name"]): sid for sid, s in states.items()}
    by_name["keralam"] = "KL"
    for t in tables(page):
        st = by_name.get(norm(t["heading"]))
        if st and t["rows"]:
            yield st, t


def lok_sabha(states, seats):
    page = fetch("List of members of the 18th Lok Sabha")
    out, unmatched = {}, []
    for st, t in state_tables(page, states):
        h = t["rows"][0]
        c_no, c_seat, c_name = col(h, "no") if col(h, "no") is not None else 0, col(h, "constituency"), col(h, "name")
        if c_seat is None or c_name is None:
            continue
        for r in pad(t):
            if len(r) <= max(c_seat, c_name) or not r[c_seat]:
                continue
            sid = find_seat("LS", st, seats, r[c_seat], int(r[c_no]) if r[c_no].isdigit() else -1)
            if not sid:
                unmatched.append(f"{st} {r[c_seat]}")
                continue
            name, left = person(r[c_name])
            new = vacant(left, page["source"]) if left else rec(name, page["source"], party=party_of(r, h))
            # a later row for the same seat (a by-election) replaces an earlier one
            if sid not in out or out[sid]["name"] is None or new["name"]:
                out[sid] = new
    return out, unmatched


def rajya_sabha(states):
    page = fetch("List of current members of the Rajya Sabha")
    out, nominated = defaultdict(list), []
    for t in tables(page):
        h = t["rows"][0] if t["rows"] else []
        if col(h, "name") is None or col(h, "term start") is None:
            continue
        st = {norm(s["name"]): sid for sid, s in states.items()}.get(norm(t["heading"]))
        is_nom = "nominat" in t["heading"].lower()
        if not st and not is_nom:
            continue
        for r in pad(t):
            name, left = person(r[col(h, "name")])
            if not name:
                continue
            since = _dmy(r[col(h, "term start")])
            until = _dmy(r[col(h, "term end")]) if col(h, "term end") is not None else None
            x = rec(name, page["source"], since, party=party_of(r, h), until=until,
                    field=r[col(h, "field")] if is_nom and col(h, "field") is not None else None)
            (nominated if is_nom else out[st]).append(x)
    return dict(out), nominated


MON = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def _dmy(s):
    m = re.search(r"(\d{1,2})-([A-Za-z]{3})-(\d{4})", s or "")
    return f"{m.group(3)}-{MON[m.group(2).lower()]:02d}-{int(m.group(1)):02d}" if m and m.group(2).lower() in MON else None


def member_col(h):
    low = [x.lower() for x in h]
    return next((i for i, x in enumerate(low) if x in ("name", "member", "mla", "members", "name of mla", "elected member")
                 or (("member" in x or "mla" in x) and ("name" in x or x.endswith(" member")))), None)


def seat_col(h):
    low = [x.lower() for x in h]
    return next((i for i, x in enumerate(low) if "constituency" in x and not {"no", "no.", "#"} & set(x.split())), None)


def two_row_header(t):
    """Some tables put 'Constituency | Member' over 'No. | Name | Party'; join them into one header row."""
    rows = t["rows"]
    if len(rows) > 2 and any(x in ("No.", "Name", "Party") for x in rows[1]) and not any(x.isdigit() for x in rows[1]):
        return {**t, "rows": [[f"{a} {b}".strip() if a != b else a for a, b in zip(rows[0], rows[1])]] + rows[2:]}
    return t


def members_table(page):
    """The largest table on the page listing an Assembly's members, if there is one."""
    found = [t for t in map(two_row_header, tables(page))
             if t["rows"] and seat_col(t["rows"][0]) is not None and member_col(t["rows"][0]) is not None and len(t["rows"]) >= 10]
    return max(found, key=lambda t: len(t["rows"]), default=None)


ORD = lambda n: f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def assembly_pages(state_name):
    """The '<State> Legislative Assembly' article, then the latest '<Nth> <State> Assembly' article."""
    names = ["Keralam", "Kerala"] if state_name == "Kerala" else [state_name]
    for nm in names:
        try:
            yield fetch(f"{nm} Legislative Assembly")
            pause()
        except SystemExit:
            pass
    titles = [f"{ORD(n)} {state_name} {kind}" for n in range(25, 0, -1) for kind in ("Assembly", "Legislative Assembly")]
    for i in range(0, len(titles), 50):
        q = urllib.parse.urlencode({"action": "query", "titles": "|".join(titles[i:i + 50]), "format": "json", "formatversion": 2})
        req = urllib.request.Request(f"{API}?{q}", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            exists = {p["title"] for p in json.load(r)["query"]["pages"] if not p.get("missing")}
        for t in titles[i:i + 50]:
            if t in exists:
                yield fetch(t)
                pause()
                return


def assemblies(states, districts, seats):
    """MLAs from each '<State> Legislative Assembly' article. Returns per-seat records, per-district
    lists, the district of each matched seat, and what could not be matched."""
    per_seat, per_district, seat_district, missing, unmatched = {}, defaultdict(list), {}, [], []
    dist_by_name = defaultdict(dict)
    for d in districts.values():
        dist_by_name[d["state"]][norm(d["name"])] = d["id"]
    for st, s in states.items():
        if s.get("legislature") == "none":
            continue
        # the state's Assembly article and its latest "Nth Assembly" article; use the fuller list
        found = [(pg, tb) for pg in assembly_pages(s["name"]) for tb in [members_table(pg)] if tb]
        page, t = max(found, key=lambda x: len(x[1]["rows"]), default=(None, None))
        if not t:
            missing.append(st)
            continue
        h = t["rows"][0]
        c_seat, c_name = seat_col(h), member_col(h)
        c_no = next((i for i, x in enumerate(h) if x.lower() in ("no.", "no", "#", "s.no.", "sr. no.", "ac no.", "constituency no.")), None)
        c_dist = col(h, "district")
        for r in pad(t):
            if not r[c_seat] or r[c_seat] == h[c_seat]:
                continue
            no = int(r[c_no]) if c_no is not None and r[c_no].isdigit() else -1
            sid = find_seat("VS", st, seats, r[c_seat], no)
            name, left = person(r[c_name])
            x = vacant(left, page["source"]) if left else rec(name, page["source"], party=party_of(r, h))
            if sid:
                per_seat[sid] = x
            else:
                unmatched.append(f"{st} {r[c_seat]}")
            did = dist_by_name[st].get(norm(r[c_dist])) if c_dist is not None else None
            if did and name:
                per_district[did].append({**x, "constituency": r[c_seat]})
            if did and sid:
                seat_district[sid] = did
    return per_seat, dict(per_district), seat_district, missing, unmatched


def mps_by_district(seat_district, vs_seats, ls_features, ls_holders, districts):
    """A district's MPs: the Lok Sabha seats containing its Assembly seats (by geometry), plus the seat
    containing the district's own centre."""
    vs_geom = {f["properties"]["id"]: f["geometry"] for f in vs_seats}
    by_state = defaultdict(list)
    for f in ls_features:
        by_state[f["properties"]["st"]].append(f)
    seats_in = defaultdict(list)
    for sid, did in seat_district.items():
        seats_in[did].append(sid)
    out = {}
    for did, d in districts.items():
        st, pts = d["state"], []
        if d.get("centroid"):
            pts.append((d["centroid"][1], d["centroid"][0]))
        pts += [centre(vs_geom[sid]) for sid in seats_in[did] if sid in vs_geom]
        seats = []
        for x, y in pts:
            f = next((f for f in by_state[st] if inside(x, y, f["geometry"])), None)
            if f and f["properties"]["id"] not in seats:
                seats.append(f["properties"]["id"])
        names = {f["properties"]["id"]: f["properties"]["name"] for f in ls_features}
        mps = [{**ls_holders[s], "constituency": names[s]} for s in seats if s in ls_holders and ls_holders[s].get("name")]
        if mps:
            out[did] = mps
    return out


def union_ministers():
    page = fetch("Union Council of Ministers")
    out, all_ministers = {}, []
    wanted = {"in.pm": r"^Prime Minister", "in.home_minister": r"Ministe?ry? of Home Affairs",
              "in.finance_minister": r"Ministe?ry? of Finance", "in.labour_minister": r"Ministe?ry? of Labour",
              "in.health_minister": r"Ministe?ry? of Health", "in.education_minister": r"Ministe?ry? of Education"}
    for t in tables(page):
        h = t["rows"][0] if t["rows"] else []
        if col(h, "minister") is None or col(h, "portfolio") is None:
            continue
        cabinet = "cabinet" in t["heading"].lower()
        for r in pad(t):
            if col(h, "left office") is not None and r[col(h, "left office")].lower() not in ("incumbent", ""):
                continue
            name, _ = person(r[col(h, "minister")])
            if not name:
                continue
            since = parse_date(r[col(h, "took office")]) if col(h, "took office") is not None else None
            x = rec(name, page["source"], since, party=party_of(r, h), portfolio=r[col(h, "portfolio")][:300],
                    rank=("Cabinet Minister" if cabinet else t["heading"].rstrip("s").replace("Ministers", "Minister")))
            if not any(m["name"] == name and m.get("portfolio") == x.get("portfolio") for m in all_ministers):
                all_ministers.append(x)
            if cabinet:
                for oid, pat in wanted.items():
                    if oid not in out and re.search(pat, r[col(h, "portfolio")]):
                        out[oid] = {k: v for k, v in x.items() if k not in ("portfolio", "rank")}
    out["in.union_minister"] = all_ministers
    return out


def supreme_court():
    page = fetch("List of sitting judges of the Supreme Court of India")
    t = next(t for t in tables(page) if t["rows"] and col(t["rows"][0], "date of appointment") is not None)
    h = t["rows"][0]
    judges, cji = [], None
    for r in pad(t):
        raw = r[col(h, "name")]
        name, _ = person(re.sub(r"\(Chief Justice of India\)", "", raw))
        if not name:
            continue
        x = rec(name, page["source"], parse_date(r[col(h, "date of appointment")]))
        judges.append(x)
        if "Chief Justice" in raw:
            m = re.search(r"Appointed as CJI on (\d{1,2} \w+ \d{4})", r[col(h, "date of appointment")])
            cji = rec(name, page["source"], parse_date(m.group(1)) if m else None)
    return {"in.sc_judge": judges, **({"in.cji": cji} if cji else {})}


def presiding(states):
    page = fetch("List of current Indian legislative speakers and chairpersons")
    by_name = {norm(s["name"]): sid for sid, s in states.items()}
    national, per_state = {}, defaultdict(dict)
    for t in tables(page):
        h = t["rows"][0]
        for r in pad(t):
            head, deputy = person(r[1])[0], person(r[4])[0] if len(r) > 4 else None
            if t["heading"] == "Lok Sabha" and head:
                national["in.speaker_ls"] = rec(head, page["source"])
            elif t["heading"] == "Rajya Sabha" and deputy:
                national["in.deputy_chairman_rs"] = rec(deputy, page["source"])
            else:
                st = by_name.get(norm(r[0])) or ("KL" if norm(r[0]) == "keralam" else None)
                if st and head:
                    oid = "state.council_chairman" if "council" in t["heading"].lower() else "state.speaker"
                    per_state[st][oid] = rec(head, page["source"], party=r[2] or None)
    return national, dict(per_state)


def opposition(states):
    page = fetch("List of current Indian opposition leaders")
    by_name = {norm(s["name"]): sid for sid, s in states.items()}
    by_name["keralam"] = "KL"
    national, per_state = {}, defaultdict(dict)
    for t in tables(page):
        h = t["rows"][0]
        c_name = col(h, "name")
        if c_name is None:
            continue
        house = None
        for r in pad(t):
            if len(set(r)) == 1 and r[0]:          # a heading row: "LOK SABHA", "RAJYA SABHA"
                house = r[0].lower()
                continue
            name, _ = person(r[c_name])
            if not name or name.lower() == "name":
                continue
            if t["heading"].startswith("Parliament"):
                oid = {"lok sabha": "in.lop_ls", "rajya sabha": "in.lop_rs"}.get(house)
                if oid and oid not in national:
                    national[oid] = rec(name, page["source"], parse_date(r[3]) if len(r) > 3 else None)
            elif "assembl" in t["heading"].lower():
                st = by_name.get(norm(r[0]))
                if st:
                    per_state[st]["state.lop"] = rec(name, page["source"], party=party_of(r, h))
    return national, dict(per_state)


# Single-holder Union posts: the office's own article names the incumbent in its infobox; an
# institution's article names its head in an "executive" row as "Name, Title".
OFFICE_PAGES = {
    "in.president": "President of India", "in.vice_president": "Vice President of India",
    "in.cec": "Chief Election Commissioner of India", "in.cag": "Comptroller and Auditor General of India",
    "in.attorney_general": "Attorney General for India", "in.cabinet_secretary": "Cabinet Secretary of India",
    "in.rbi_governor": "Governor of the Reserve Bank of India", "in.cbi_director": "Director of the Central Bureau of Investigation",
    "in.ib_director": "Director of the Intelligence Bureau",
}
INSTITUTION_PAGES = {
    "in.sebi_chair": ("Securities and Exchange Board of India", r"chair"), "in.upsc_chair": ("Union Public Service Commission", r"chair"),
    "in.cic": ("Central Information Commission", r""), "in.lokpal_chair": ("Lokpal", r"chair"),
    "in.nhrc_chair": ("National Human Rights Commission of India", r"chair"), "in.nia_dg": ("National Investigation Agency", r"director"),
    "in.ed_director": ("Enforcement Directorate", r"director"), "in.ugc_chair": ("University Grants Commission (India)", r"chair"),
    "in.nmc_chair": ("National Medical Commission", r"chair"),
}


def infobox_rows(html):
    box = re.search(r'<table class="infobox.*?</table>', html, re.S)
    for m in re.finditer(r"<tr>(.*?)</tr>", box.group(0) if box else "", re.S):
        cells = [unescape(re.sub(r"\s+", " ", re.sub(r"<style.*?</style>|<[^>]+>|\[\d+\]", " ", c, flags=re.S))).strip()
                 for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", m.group(1), re.S)]
        if cells:
            yield cells


def strip_honorific(name):
    name = re.sub(r"\[\s*\d+\s*\]|\(.*?\)", "", name)
    return re.sub(r"^(Mr|Mrs|Ms|Dr|Shri|Smt|Justice)\.?\s+", "", " ".join(name.split())).strip()


def office_heads():
    out = {}
    for oid, title in OFFICE_PAGES.items():
        try:
            page = fetch(title)
        except SystemExit:
            continue
        box = re.search(r'<table class="infobox.*?</table>', page["html"], re.S)
        m = re.search(r'Incumbent.{0,600}?<a [^>]*title="([^"]+)"', box.group(0) if box else "", re.S)
        if m:
            name = re.sub(r"\s*\(.*?\)$", "", unescape(m.group(1)))
            out[oid] = rec(name, page["source"])
        pause()
    for oid, (title, role) in INSTITUTION_PAGES.items():
        try:
            page = fetch(title)
        except SystemExit:
            continue
        for cells in infobox_rows(page["html"]):
            if len(cells) == 2 and (re.search(r"executive", cells[0], re.I) or (role and re.search(role, cells[0], re.I))):
                # "Rakesh Aggarwal , IPS , Director General" or "Justice V. Ramasubramanian , Chairman Piyush Goyal, ..."
                people = re.split(r"\s*,\s*", cells[1])
                name = people[0]
                if role and not re.search(role, cells[0] + " " + cells[1], re.I):
                    continue
                acting = "acting" in cells[1].lower()
                out[oid] = rec(strip_honorific(re.sub(r"\s+", " ", name)), page["source"], acting=acting or None)
                break
        pause()
    return out


# ---------------------------------------------------------------- writing
def seat_index():
    geo = load("geo/constituencies.json")
    idx = {"LS": defaultdict(lambda: {"name": {}, "no": {}, "names_of": {}}), "VS": defaultdict(lambda: {"name": {}, "no": {}, "names_of": {}})}
    for kind, key in (("lok_sabha", "LS"), ("vidhan_sabha", "VS")):
        for f in geo[kind]["features"]:
            p = f["properties"]
            idx[key][p["st"]]["name"].setdefault(seat_key(p["name"]), p["id"])
            idx[key][p["st"]]["no"].setdefault(p["no"], p["id"])
            idx[key][p["st"]]["names_of"][p["id"]] = seat_key(p["name"])
    return idx, geo


def put_list(target, oid, records, where, changes):
    old = target.get(oid)
    if isinstance(old, list) and any(r.get("status") == "verified" for r in old):
        return
    # compare who holds what, not the retrieval date or revision, so unchanged lists are not rewritten
    who = lambda rs: [(r.get("name"), r.get("party"), r.get("constituency"), r.get("since"), r.get("portfolio")) for r in rs or []]
    if who(old) == who(records):
        return
    changes.append(f"{where} {oid}: {len(records)} holders")
    target[oid] = records


def run(dry_run=False):
    states, districts, _ = jurisdictions()
    changes, notes = [], []
    seats, geo = seat_index()

    ls, un_ls = lok_sabha(states, seats); pause()
    rs, nominated = rajya_sabha(states); pause()
    vs, mla_by_district, seat_district, no_table, un_vs = assemblies(states, districts, seats)
    ministers = union_ministers(); pause()
    court = supreme_court(); pause()
    pres_nat, pres_state = presiding(states); pause()
    opp_nat, opp_state = opposition(states); pause()
    heads = office_heads()

    mp_by_district = mps_by_district(seat_district, geo["vidhan_sabha"]["features"], geo["lok_sabha"]["features"], ls, districts)

    # constituencies/<ST>.json
    per_state = defaultdict(dict)
    for sid, r in ls.items():
        per_state[sid.split("/")[1]].setdefault(sid, {})["in.lok_sabha_mp"] = r
    for sid, r in vs.items():
        per_state[sid.split("/")[1]].setdefault(sid, {})["state.mla"] = r
    for st, members in rs.items():
        per_state[st].setdefault(f"RS/{st}", {})["in.rajya_sabha_mp"] = members
    for st, cons in sorted(per_state.items()):
        rel = f"holders/constituencies/{st}.json"
        f = load(rel, default={"version": 1, "jurisdiction": st, "constituencies": {}})
        for cid, offs in sorted(cons.items()):
            target = f["constituencies"].setdefault(cid, {})
            for oid, r in offs.items():
                (put_list if isinstance(r, list) else merge)(target, oid, r, cid, changes)
        if not dry_run:
            dump(rel, f)

    # districts/<ST>.json: MLAs and MPs of each district
    by_state = defaultdict(dict)
    for did, mlas in mla_by_district.items():
        by_state[did.split("/")[0]].setdefault(did, {})["district.mla"] = mlas
    for did, mps in mp_by_district.items():
        by_state[did.split("/")[0]].setdefault(did, {})["district.mp"] = mps
    for st, ds in sorted(by_state.items()):
        rel = f"holders/districts/{st}.json"
        f = load(rel, default={"version": 1, "jurisdiction": st, "districts": {}})
        for did, offs in ds.items():
            for oid, lst in offs.items():
                put_list(f["districts"].setdefault(did, {}), oid, lst, did, changes)
        if not dry_run:
            dump(rel, f)

    # states/<ST>.json: speakers, council chairs, leaders of opposition
    for part in (pres_state, opp_state):
        for st, offs in part.items():
            rel = f"holders/states/{st}.json"
            f = load(rel, default={"version": 1, "jurisdiction": st, "holders": {}})
            for oid, r in offs.items():
                if oid == "state.council_chairman" and states[st].get("legislature") != "bicameral":
                    continue
                merge(f["holders"], oid, r, st, changes)
            if not dry_run:
                dump(rel, f)

    # national.json
    nat = load("holders/national.json")
    for oid, r in {**ministers, **court, **pres_nat, **opp_nat}.items():
        (put_list if isinstance(r, list) else merge)(nat["holders"], oid, r, "IN", changes)
    for oid, r in heads.items():
        old = nat["holders"].get(oid)
        # a near-identical spelling is more likely a typo on one side than a new person: keep ours
        if isinstance(old, dict) and old.get("name") and old["name"] != r["name"] \
                and SequenceMatcher(None, old["name"].lower(), r["name"].lower()).ratio() > 0.85:
            notes.append(f"{oid}: kept '{old['name']}', Wikipedia has '{r['name']}'")
            continue
        merge(nat["holders"], oid, r, "IN", changes)
    if nominated:
        put_list(nat["holders"], "in.rajya_sabha_mp", nominated, "IN (nominated)", changes)
    if not dry_run:
        dump("holders/national.json", nat)

    notes.append(f"Lok Sabha: {len(ls)} seats matched" + (f"; unmatched: {', '.join(un_ls)}" if un_ls else ""))
    notes.append(f"Rajya Sabha: {sum(len(v) for v in rs.values())} state members, {len(nominated)} nominated")
    notes.append(f"MLAs: {len(vs)} seats matched, {len(un_vs)} not matched to a boundary; "
                 f"{sum(len(v) for v in mla_by_district.values())} placed in districts"
                 + (f"; no members table for {', '.join(no_table)}" if no_table else ""))
    notes.append(f"MPs by district: {len(mp_by_district)} districts")
    return changes, notes


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    changes, notes = run(args.dry_run)
    print(f"{len(changes)} changes")
    print("\n".join(notes), file=sys.stderr)


if __name__ == "__main__":
    main()
