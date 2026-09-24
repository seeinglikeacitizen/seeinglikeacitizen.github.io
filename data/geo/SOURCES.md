# Boundary sources

**Source:** `INDIA/INDIA_DISTRICTS.geojson` from https://github.com/datta07/INDIAN-SHAPEFILES
(district polygons with LGD-style codes). Check that repository's licence before redistributing
modified boundaries; if it doesn't allow it, replace the source in `scripts/build_geo.py`.

**Corrections applied by `scripts/build_geo.py`:**
- Names: the source mangles diacritics (`>` for ā, `|` for ī, `@`/`#` for ū) and truncates most
  Karnataka names. These are restored; Karnataka by LGD district code. Some spellings follow the
  state's usage (Howrah, Darjeeling, Alipurduar, Cooch Behar, Malda). Code 0584 is shown as
  "Ramanagara (Bengaluru South)".
- Rajasthan: nine districts created in 2023 and abolished on 28 Dec 2024 are merged into the district
  each was mostly carved from. Edges are approximate.
- Purba Medinipur appears twice in the source; merged.
- A Delhi "Nazul" land parcel is not a district; moved to the unassigned layer.
- Areas the source leaves without a state are kept in a separate `disputed` layer and drawn hatched,
  not assigned. The site does not take a position on boundary disputes; the outline follows the
  source file.

**Simplification:** mapshaper, weighted Visvalingam, 4% of vertices kept, shapes preserved.

**Hexagons:** one cell per district, laid out by a two-stage assignment (states to compact blocks,
then districts within a state) that keeps each district near its real position. See `build_hex` in
the script.

Districts created after the source was last updated are missing. To update: replace the source or add
to `MERGE_INTO`/name fixes, then `python scripts/build_geo.py` (needs `requirements-geo.txt` and
`npm i -g mapshaper`).

## Electoral boundaries

- **Lok Sabha:** DataMeet's simplified 2019 parliamentary constituencies, 543 features, CC0 1.0:
  https://github.com/datameet/maps/tree/master/parliamentary-constituencies
- **Vidhan Sabha:** DataMeet's Assembly constituency shapefile scraped from the ECI polling-station
  site, CC BY 2.5 India:
  https://github.com/datameet/maps/tree/master/assembly-constituencies. The upstream README warns
  that several states are pre-delimitation and that some names and alignments are imperfect.
- **Rajya Sabha:** the existing state/UT polygons are used because Rajya Sabha members represent a
  state or UT and are elected indirectly; there are no single-member Rajya Sabha boundary polygons.

`scripts/build_constituencies.py` converts and simplifies the source geometry with the Python standard
library and creates one equal-area schematic hex per seat. Then run
`python scripts/build_constituencies.py --hex-only` (needs `requirements-geo.txt`) to lay the hexagons
out with the same algorithm as the district hexagons, so each state is one compact block. Electoral geometry is reference data, not
an official delimitation record. Hermes checks upstream monthly and opens an issue for review before
geometry is replaced.
