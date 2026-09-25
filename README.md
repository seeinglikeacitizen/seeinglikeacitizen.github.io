# Seeing like a citizen

**Who runs your district, who put them there, and what the law says.**

A map of the Indian state from the citizen's side: every district, the offices that govern it, the
people holding them, and the chain that connects each post back to a ballot, or doesn't.

- **Map.** India by district, state, Lok Sabha constituency, Rajya Sabha state/UT electoral region,
  or Vidhan Sabha constituency, as a real map or as equal-sized hexagons. Hover a district for
  its District Magistrate, police chief, judge and Zila Parishad head; click for every office from the
  gram panchayat to the Union.
- **Who appoints whom.** 125 offices and bodies with how each is filled: elected, chosen by an elected
  body, appointed, picked by a committee or a collegium, or posted through the service. Select one to
  see its full line of choice and how many steps it sits from a ballot.
- **Who pays whom.** Where public money comes from and where it goes, as flow diagrams: the Union
  budget (2026-27, in rupees, by purpose or by type of spending), all states combined (shares of
  revenue), and panchayats and municipalities (routes only). Every tax and levy, from income tax and GST
  to payroll levies, stamp duty, royalties and borrowing, is listed with who pays it, who bears it, who
  collects it and where it goes, and each flow links to the offices that decide it.
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
| `data/economic/…` | National/state/local laws and taxes plus the abundance and dispersed-knowledge research rubric in `lens.json` |
| `data/crime/…` | NCRB district datasets, `aliases.json` for police-district names |
| `data/geo/…` | Boundaries (TopoJSON) and the hexagon layout; see `data/geo/SOURCES.md` |
| `data/institutions.json` | Pins for Parliament, courts, regulators, investigative bodies, civil-service institutions, utilities, secretariats, IITs, AIIMS… |
| `data/money/flows.json` | "Who pays whom" diagrams: nodes (payers, taxes, governments, spending, recipients) and links in rupees or shares; `null` for routes whose size is not published |
| `data/money/taxes.json` | Every tax, levy and other source of public money, by category, with who pays, who bears, collector, destination and legal basis |
| `data/refresh_manifest.json` | Sources and due dates checked by the Hermes daily data refresh |

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
python scripts/apply_update.py list.json   # apply a list together (validated once; record_only confirms a holder)
python scripts/build_indexes.py            # after adding per-state files
python scripts/import_wikipedia.py         # refresh CMs, Governors/LGs, High Court CJs from Wikipedia (unverified)
python scripts/ingest_ncrb.py …            # load an NCRB district table (see data/crime/README.md)
python scripts/build_geo.py                # rebuild boundaries and hexagons (requirements-geo.txt)
python scripts/build_constituencies.py …   # rebuild Lok/Vidhan Sabha geographic and hex maps
python scripts/build_constituencies.py --hex-only  # then relay out their hexagons (requirements-geo.txt)
```

## Future plans and features

This is the working backlog. Add proposals here (and to an issue when implementation starts) so the
map's ambition remains visible even when the underlying data must be built jurisdiction by
jurisdiction.

- Add frequently refreshed **price feeds** for land and rents, electricity tariffs and realised cost,
  water, transport, construction inputs, wages, credit and other locally important scarcity signals.
  Preserve the source, observation date, unit, tax/subsidy treatment and geographic coverage so
  unlike figures are not silently compared.
- Show a **land-use bar chart** for every selectable geography: housing, commerce, industry,
  agriculture, forest, public facilities, transport, vacant/under-used land and water. Put statutory
  zoning beside observed use where both exist.
- Publish transparent, revisable **district and city GDP/income estimates**, employment, firm births
  and deaths, building completions, floor space, commute time, utility reliability, approval time,
  court/tribunal delay and public-capital formation—with uncertainty intervals where figures are
  modelled rather than observed.
- Make the economic lens computable: track how each local, state and national land/labour/capital
  rule changes entry, supply, administered versus discovered prices, discretion, time cost,
  informality, concentration and the portability of rights. Keep the rule's public purpose,
  externalities and distributional incidence visible alongside any abundance cost.
- Complete constituency-level feeds for MPs and MLAs, election dates, reservation category and
  representative history; replace legacy Assembly geometry state by state as newer official
  delimitation files become available.
- Build a national utility registry for electricity, water, sewerage and waste that names the public
  authority, actual operator, ownership, regulator, tariff order, service standard and—where private
  or PPP—the tender/auction method, bid criterion, award, concession term and replacement process.
- Add machine-readable provenance and freshness badges to every metric, law, office holder,
  institution and boundary, with diffs produced by the Hermes daily refresh before publication.

- Extend **Who pays whom** down to the last rupee: a diagram for each state from its budget documents;
  ministry-level and scheme-level flows from the Union's demands for grants; the salary bill by service
  (IAS, IPS, IFS, state services, teachers, police); named contracts and contractors from the Central
  Public Procurement Portal, GeM and state e-procurement portals; and local-body finances city by city.

## What's missing (honestly)

- **Office holders come mostly from Wikipedia and are unverified.** `scripts/import_wikipedia.py` fills
  in Chief Ministers, Governors/LGs/Administrators, High Court Chief Justices, all Lok Sabha and Rajya
  Sabha MPs, MLAs (every Assembly except Tripura, whose current members Wikipedia does not tabulate),
  each district's MPs and MLAs, Union ministers, Supreme Court judges, speakers, council chairs,
  leaders of opposition and heads of the main Union bodies, each sourced to the Wikipedia revision.
  Some MLAs cannot be placed on the map where seats were redrawn after the boundary data (Assam, Jammu
  and Kashmir). Appointed district officers (DM, SP, judges) still arrive through the agent's backfill. Meanwhile every post in the side panel has "Look it up"
  links (Wikipedia lists of current holders, official district sites via igod.gov.in, a gov.in search).
- **State economic data is not compiled yet**; national laws and GST/income-tax basics are.
- **No crime data loaded yet**; the ingest script is ready.
- **Boundaries** come from a community dataset with corrections (see `data/geo/SOURCES.md`). Rajasthan's
  2024 district abolitions are approximated; disputed areas are shown hatched rather than drawn one
  way. Districts created after the source was made are missing.
- **Assembly constituency boundaries are legacy community data.** The upstream source flags several
  states as pre-delimitation and some names or alignments as imperfect. The map shows that warning and
  the refresh manifest asks Hermes to look for newer official state/ECI geometry; do not treat the
  current layer as an official delimitation record. Rajya Sabha regions are states/UTs, not
  single-member territorial constituencies.
- `offices.json` describes the general pattern. States differ (mayors directly elected in some states,
  councils in six, no panchayats in parts of the Northeast); notes say where. Corrections welcome.

## Licence

Code: MIT (see `LICENSE`). Data compiled here: CC BY 4.0. Boundary data retains its source's terms.
This site is not an official government source.
