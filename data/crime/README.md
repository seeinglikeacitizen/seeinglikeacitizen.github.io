# Crime data

District-wise figures from the National Crime Records Bureau, *Crime in India* (annual). The tables
are on ncrb.gov.in and mirrored as CSV on data.gov.in.

Load a year:
```
python scripts/ingest_ncrb.py table.csv --year 2023 --source-url <page you downloaded from> \
  --map murder="<column>" --map robbery="<column>" --map total_cognizable="<column>" \
  --population district_population.csv
python scripts/build_indexes.py && python scripts/validate_data.py
```
Categories are listed in `index.json`. Column names change every year, so check the CSV headers.

**Matching.** NCRB reports by police district: city commissionerates, rural police, railway police
and CID units don't line up with revenue districts. The script sums police districts into revenue
districts, skips railway/CID/total rows, and never guesses: unmatched names are listed so you can add
them to `aliases.json` (`"ST:Name as in NCRB": "ST/district-id"`). Check every fuzzy match it reports.

**Reading it.** These are cases registered, not crimes committed. Places where people trust the police
more, or where registration is enforced, can show higher numbers. NCRB counts only the most serious
offence per case. Per-lakh rates need a population figure; census 2011 is old, so say which
projection you used in the dataset's `note`.
