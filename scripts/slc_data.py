"""Shared helpers for the data scripts. Standard library only."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

EVENT_TYPES = {
    "took_office": "Took office or was appointed",
    "resigned": "Resigned",
    "removed": "Was removed or suspended",
    "transferred": "Was transferred",
    "elected": "Was elected",
    "died": "Died in office",
    "term_ended": "Term ended",
    "additional_charge": "Given additional charge",
    "other": "Something else",
}
# Events after which the person no longer holds the post
LEAVING = {"resigned", "removed", "transferred", "died", "term_ended"}
# Events after which the person holds the post
ARRIVING = {"took_office", "elected", "additional_charge"}

STATUSES = {"verified", "unverified_seed", "unverified", "disputed"}
DATE_RE = re.compile(r"^\d{4}(-\d{2}(-\d{2})?)?$")


def load(rel: str | Path, default=None):
    p = DATA / rel
    if not p.exists():
        if default is not None:
            return default
        raise FileNotFoundError(p)
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def dump(rel: str | Path, obj) -> Path:
    """Write JSON the same way everywhere (stable diffs)."""
    p = DATA / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")
    return p


def offices() -> dict:
    return {n["id"]: n for n in load("offices.json")["nodes"]}


def jurisdictions():
    j = load("jurisdictions.json")
    states = {s["id"]: s for s in j["states"]}
    districts = {d["id"]: d for d in j["districts"]}
    return states, districts, j["high_courts"]


# Electoral seats: Lok Sabha LS/<ST>/<NNN>, Vidhan Sabha VS/<ST>/<NNN>, a state's Rajya Sabha seats RS/<ST>.
# Each kind of seat holds one office.
SEAT_OFFICE = {"LS": "in.lok_sabha_mp", "VS": "state.mla", "RS": "in.rajya_sabha_mp"}


def is_constituency(jid: str) -> bool:
    return jid.split("/")[0] in SEAT_OFFICE


def is_district(jid: str) -> bool:
    return "/" in jid and not is_constituency(jid)


def state_of(jid: str) -> str:
    p = jid.split("/")
    return p[1] if p[0] in SEAT_OFFICE else p[0]


def constituency_ids(states: dict) -> set:
    geo = load("geo/constituencies.json", default={})
    ids = {f["properties"]["id"] for k in ("lok_sabha", "vidhan_sabha") for f in geo.get(k, {}).get("features", [])}
    return ids | {f"RS/{st}" for st in states}


def is_hc_office(office_id: str) -> bool:
    return office_id.startswith("state.hc_")


def holder_file_for(office: dict, jurisdiction: str, states: dict) -> tuple[Path, list[str]]:
    """Return (relative file path, key path inside the file) where a holder record lives.

    MP or MLA of a seat       -> holders/constituencies/<ST>.json constituencies.<seat id>.<office>
    national office           -> holders/national.json            holders.<office>
    High Court office         -> holders/high_courts.json         high_courts.<hc>.<office>
    state office              -> holders/states/<ST>.json         holders.<office>
    district / local office   -> holders/districts/<ST>.json      districts.<ST/slug>.<office>
    """
    oid, scope = office["id"], office["scope"]
    if is_constituency(jurisdiction):
        return Path(f"holders/constituencies/{state_of(jurisdiction)}.json"), ["constituencies", jurisdiction, oid]
    if scope == "national":
        return Path("holders/national.json"), ["holders", oid]
    if is_hc_office(oid):
        hc = jurisdiction if jurisdiction in load("jurisdictions.json")["high_courts"] else states[state_of(jurisdiction)]["high_court"]
        return Path("holders/high_courts.json"), ["high_courts", hc, oid]
    st = state_of(jurisdiction)
    if scope == "state":
        return Path(f"holders/states/{st}.json"), ["holders", oid]
    if not is_district(jurisdiction):
        raise ValueError(f"{oid} is a {scope}-level office; give a district id like {st}/<slug>, not {jurisdiction}")
    return Path(f"holders/districts/{st}.json"), ["districts", jurisdiction, oid]


def empty_holder_file(rel: Path, jurisdiction: str) -> dict:
    if rel.parts[1] == "constituencies":
        return {"version": 1, "jurisdiction": state_of(jurisdiction), "constituencies": {}}
    if rel.parts[1] == "districts":
        return {"version": 1, "jurisdiction": state_of(jurisdiction), "districts": {}}
    return {"version": 1, "jurisdiction": state_of(jurisdiction), "holders": {}}


def applies(office: dict, st: str, states: dict) -> bool:
    a = office.get("applies") or {}
    if "states" in a and st not in a["states"]:
        return False
    if st in a.get("exclude", []):
        return False
    if "types" in a and states[st]["type"] not in a["types"]:
        return False
    return True


def holder_list(h) -> list:
    if h is None:
        return []
    if isinstance(h, list):
        return h
    return [h]


def norm_name(s: str) -> str:
    s = re.sub(r"\b(shri|smt|sri|dr|justice|mr|mrs|ms|km)\.?\s+", "", s.lower())
    return re.sub(r"[^a-z]", "", s)
