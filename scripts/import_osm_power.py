#!/usr/bin/env python3
"""Build data/power_plants.json from OpenStreetMap: every power plant in India with its name, operator,
fuel, capacity and location.

    python scripts/import_osm_power.py

Queries the Overpass API (trying mirrors if one is busy). OpenStreetMap data is © OpenStreetMap
contributors under the Open Database Licence (ODbL): data/power_plants.json stays under the ODbL and
the site credits OpenStreetMap wherever the plants are shown. Standard library only.

Plants are kept if they have a name or at least MIN_MW of capacity; tiny unnamed rooftop and village
solar installations are left out. Where OpenStreetMap has no operator but links the plant to Wikidata,
the operator (or owner) is taken from Wikidata (CC0). Ownership is classified from the operator
(central, state, private); anything unrecognised is 'unknown'.
"""
import datetime as dt
import json
import re
import sys
import time
import urllib.parse
import urllib.request

from slc_data import dump

MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
           "https://overpass.private.coffee/api/interpreter"]
QUERY = '[out:json][timeout:240];area["ISO3166-1"="IN"][admin_level=2]->.in;(nwr["power"="plant"](area.in););out center tags;'
UA = "seeinglikeacitizen-import/1.0 (https://github.com/seeinglikeacitizen/seeinglikeacitizen.github.io)"
MIN_MW = 5

# Operator patterns -> owner type. Central public-sector companies first, then state bodies.
CENTRAL = r"\b(NTPC|NHPC|NPCIL|Nuclear Power Corporation|Damodar Valley|DVC|SJVN|NEEPCO|North Eastern Electric|THDC|NLC|Neyveli|BHAVINI|Solar Energy Corporation of India|SECI|ONGC|GAIL|Indian Oil|BPCL|HPCL|Coal India|NSPCL|NTECL|Aravali Power|Meja Urja|Kanti Bijlee|Nabinagar|Patratu Vidyut|Ratnagiri Gas)\b"
STATE = (r"\b(State|Genco|GENCO|Generation Corporation|Utpadan|Vidyut Utpadan|Power Generation|Power Development Corporation|"
         r"KPCL|Karnataka Power|MAHAGENCO|MSPGCL|GSECL|Gujarat State|RRVUNL|Rajasthan Rajya|UPRVUNL|UPJVNL|Uttar Pradesh Rajya|"
         r"APGENCO|TSGENCO|TGGENCO|Telangana|TANGEDCO|TNPGCL|Tamil Nadu|KSEB|Kerala State|PSPCL|Punjab State|HPGCL|Haryana Power|"
         r"CSPGCL|Chhattisgarh State|MPPGCL|Madhya Pradesh Power|OHPC|OPGCL|Odisha|WBPDCL|West Bengal|APGCL|Assam Power|"
         r"HPSEB|Himachal Pradesh|UJVN|Uttarakhand Jal|JKSPDC|Jammu|Kashmir|IPGCL|Indraprastha|Pragati Power|MePGCL|Meghalaya|"
         r"TPGL|Tripura|Sikkim|Mizoram|Manipur|Nagaland|Arunachal|Goa|Bihar State|JUUNL|Jharkhand|TVNL|Tenughat)\b")


def fetch():
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    for url in MIRRORS:
        for attempt in range(2):
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=300) as r:
                    raw = r.read()
                if raw.lstrip().startswith(b"{"):
                    return json.loads(raw), url
            except Exception as e:  # busy mirror, timeout
                print(f"note: {url}: {e}", file=sys.stderr)
            time.sleep(10)
    raise SystemExit("error: every Overpass mirror failed; try again later")


def megawatts(s):
    m = re.match(r"\s*([\d.,]+)\s*(GW|MW|kW|W)?", s or "", re.I)
    if not m:
        return None
    v = float(m.group(1).replace(",", ""))
    unit = (m.group(2) or "MW").upper()
    return round({"GW": v * 1000, "MW": v, "KW": v / 1000, "W": v / 1e6}[unit], 1)


def wikidata_operators(qids):
    """{qid: operator label} from Wikidata's operator (P137) or owned-by (P127) statements."""
    out, qids = {}, sorted(set(qids))
    for i in range(0, len(qids), 50):
        q = urllib.parse.urlencode({"action": "wbgetentities", "ids": "|".join(qids[i:i + 50]), "props": "claims", "format": "json"})
        try:
            with urllib.request.urlopen(urllib.request.Request(f"https://www.wikidata.org/w/api.php?{q}", headers={"User-Agent": UA}), timeout=60) as r:
                ents = json.load(r).get("entities", {})
        except Exception as e:
            print(f"note: Wikidata: {e}", file=sys.stderr)
            continue
        refs = {}
        for qid, ent in ents.items():
            for prop in ("P137", "P127"):
                claim = next((c for c in ent.get("claims", {}).get(prop, []) if c["mainsnak"].get("datavalue")), None)
                if claim:
                    refs[qid] = claim["mainsnak"]["datavalue"]["value"]["id"]
                    break
        if refs:
            q2 = urllib.parse.urlencode({"action": "wbgetentities", "ids": "|".join(sorted(set(refs.values()))), "props": "labels", "languages": "en", "format": "json"})
            with urllib.request.urlopen(urllib.request.Request(f"https://www.wikidata.org/w/api.php?{q2}", headers={"User-Agent": UA}), timeout=60) as r:
                labels = {k: v.get("labels", {}).get("en", {}).get("value") for k, v in json.load(r).get("entities", {}).items()}
            out.update({qid: labels.get(ref) for qid, ref in refs.items() if labels.get(ref)})
        time.sleep(1)
    return out


def owner_type(op):
    if not op:
        return "unknown"
    if re.search(CENTRAL, op, re.I):
        return "central"
    if re.search(STATE, op, re.I):
        return "state"
    return "private"


def main():
    data, url = fetch()
    plants = []
    for e in data["elements"]:
        t = e.get("tags", {})
        lat, lon = (e["lat"], e["lon"]) if "lat" in e else (e.get("center", {}).get("lat"), e.get("center", {}).get("lon"))
        if lat is None:
            continue
        mw = megawatts(t.get("plant:output:electricity"))
        name = t.get("name:en") or t.get("name")
        if not name and (mw or 0) < MIN_MW:
            continue
        op = t.get("operator") or t.get("owner")
        plants.append({
            "id": f"osm-{e['type'][0]}{e['id']}", "name": name, "operator": op, "owner_type": owner_type(op),
            "fuel": t.get("plant:source") or "unknown", "mw": mw, "latlng": [round(lat, 5), round(lon, 5)],
            **({"wikidata": t["wikidata"]} if t.get("wikidata") else {}),
        })
    ops = wikidata_operators([p["wikidata"] for p in plants if not p["operator"] and p.get("wikidata")])
    for p in plants:
        if not p["operator"] and ops.get(p.get("wikidata")):
            p["operator"], p["operator_source"] = ops[p["wikidata"]], "wikidata"
            p["owner_type"] = owner_type(p["operator"])
    plants.sort(key=lambda p: -(p["mw"] or 0))
    out = {
        "version": 1,
        "note": "Power plants in India from OpenStreetMap, built by scripts/import_osm_power.py. Capacity, operator and fuel are as tagged by OpenStreetMap contributors and may be missing or out of date; owner_type is inferred from the operator.",
        "licence": "Open Database Licence (ODbL) 1.0. © OpenStreetMap contributors.",
        "source": {"title": "OpenStreetMap (power=plant)", "publisher": "OpenStreetMap contributors", "url": "https://www.openstreetmap.org/copyright",
                   "accessed": dt.date.today().isoformat(), "via": url},
        "plants": plants,
    }
    dump("power_plants.json", out)
    by = {}
    for p in plants:
        by[p["owner_type"]] = by.get(p["owner_type"], 0) + 1
    print(f"{len(plants)} plants, {round(sum(p['mw'] or 0 for p in plants)):,} MW tagged; by owner: {by}")


if __name__ == "__main__":
    main()
