# Seeing like a citizen

**Who runs your district, who put them there, and what the law says.**

A map of the Indian state from the citizen's side: every district, the offices that govern it, the
people holding them, and the chain that connects each post back to a ballot, or doesn't.

- **Map.** India by district or state, as a real map or as equal-sized hexagons. Hover a district for
  its District Magistrate, police chief, judge and Zila Parishad head; click for every office from the
  gram panchayat to the Union.
- **Who appoints whom.** 125 offices and bodies with how each is filled: elected, chosen by an elected
  body, appointed, picked by a committee or a collegium, or posted through the service. Select one to
  see its full line of choice and how many steps it sits from a ballot.
- **Changes.** A timeline of appointments, resignations and transfers, each with sources.
- **Lenses.** Political (offices), Economic (land, labour, capital law and taxes, national and state),
  Crime (NCRB registered cases per lakh people).
- **Report a change.** Anyone can file a change as a GitHub issue. An agent checks it against official
  sources before anything is published; what it cannot confirm goes to a person.

It runs on GitHub Pages with no build step: plain HTML, CSS and ES modules, Leaflet and topojson.

## Run it locally

```
python3 -m http.server 8000
# open http://localhost:8000
```
(Opening index.html as a file won't work: browsers block module and data loading from `file://`.)

## Publish

1. Create the GitHub account or organisation `seeinglikeacitizen` and a public repo
   `seeinglikeacitizen.github.io`. (Using another name? Change `REPO` in `assets/js/config.js`.)
2. Push this folder to `main`. Settings → Pages → Deploy from branch → `main` / root.
3. Create labels: `report`, `needs-verification`, `verified`, `rejected`, `needs-human`, `needs-info`,
   `data-update`.

## How the data is organised

| File | What |
|---|---|
| `data/offices.json` | Every office and body, its branch, level, and `selection` (method, `by`, `advice`, `consult`, `confidence`, `members`, legal basis) |
| `data/jurisdictions.json` | States/UTs (type, capital, High Court) and 780 districts |
| `data/holders/…` | Who holds each post: `national.json`, `high_courts.json`, `states/<ST>.json`, `districts/<ST>.json` |
| `data/timeline.json` | Dated events with sources |
| `data/economic/…` | National laws and taxes; per-state files from `states/_template.json` |
| `data/crime/…` | NCRB district datasets, `aliases.json` for police-district names |
| `data/geo/…` | Boundaries (TopoJSON) and the hexagon layout; see `data/geo/SOURCES.md` |
| `data/institutions.json` | Pins for Parliament, courts, secretariats, IITs, AIIMS… |

Every holder and event has a `status` (`verified`, `unverified`, `unverified_seed`, `disputed`) and
`sources`. The site marks anything not verified.

## How a change gets in

1. Someone clicks **Report a change** → a prefilled GitHub issue (`.github/ISSUE_TEMPLATE/report-change.yml`).
2. The maintainer's Hermes agent (kept locally in `hermes/`, not in the repo) picks up issues labelled
   `needs-verification`, looks for an official source or two independent reputable reports, and runs
   `scripts/apply_update.py`, which writes the holder, adds the timeline event, and validates.
3. It opens a pull request; CI (`.github/workflows/validate.yml`) runs `scripts/validate_data.py`.
4. A person merges (or the agent does, for changes backed only by official sources, if enabled).

A daily sweep does the same from the news.

## Scripts

```
python scripts/validate_data.py            # check everything
python scripts/apply_update.py update.json # apply one change (see docstring for format)
python scripts/build_indexes.py            # after adding per-state files
python scripts/import_wikipedia.py         # refresh CMs, Governors/LGs, High Court CJs from Wikipedia (unverified)
python scripts/ingest_ncrb.py …            # load an NCRB district table (see data/crime/README.md)
python scripts/build_geo.py                # rebuild boundaries and hexagons (requirements-geo.txt)
```

## What's missing (honestly)

- **Office holders are mostly empty.** 19 national posts are seeded from general knowledge and marked
  unverified. Chief Ministers, Governors/LGs/Administrators and High Court Chief Justices are imported
  from Wikipedia (`scripts/import_wikipedia.py`) and also marked unverified. Other state and district
  holders arrive through the agent's backfill. Meanwhile every post in the side panel has "Look it up"
  links (Wikipedia lists of current holders, official district sites via igod.gov.in, a gov.in search).
- **State economic data is not compiled yet**; national laws and GST/income-tax basics are.
- **No crime data loaded yet**; the ingest script is ready.
- **Boundaries** come from a community dataset with corrections (see `data/geo/SOURCES.md`). Rajasthan's
  2024 district abolitions are approximated; disputed areas are shown hatched rather than drawn one
  way. Districts created after the source was made are missing.
- `offices.json` describes the general pattern. States differ (mayors directly elected in some states,
  councils in six, no panchayats in parts of the Northeast); notes say where. Corrections welcome.

## Licence

Code: MIT (see `LICENSE`). Data compiled here: CC BY 4.0. Boundary data retains its source's terms.
This site is not an official government source.
