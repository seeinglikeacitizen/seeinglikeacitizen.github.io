# Contributing

## Report a change to who holds a post
Use **Report a change** on the site (it fills in the post and place ids for you), or open the
"Report a change" issue form. A link to a government order, gazette or news report speeds things up.

## Fix how a post is filled, or add an office
Edit `data/offices.json` and open a PR. Give the legal basis (article, act, section) in
`selection.basis`, and cite something in the PR. Run `python scripts/validate_data.py`.

## Add holders or state economic data directly
Please use `scripts/apply_update.py` for holders so timeline events and predecessors stay consistent.
For economic data copy `data/economic/states/_template.json`. Every value needs a source; leave `null`
rather than estimate.

## Standards
- Verified means an official source, or two independent reputable outlets.
- Public offices only. No private individuals' details.
- Plain English in descriptions: say what the post does and who chooses it.

## Code
No build step. Vanilla ES modules in `assets/js/`. Test with `python3 -m http.server`.
