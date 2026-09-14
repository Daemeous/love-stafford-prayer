# Love Stafford Prayer Network

An interactive prayer-walking map for Stafford town. The town is split into
4 quadrants by the River Sow and the A34; each quadrant has a rotating
weekly set of streets to pray for, with an organiser able to override any
given week and add notes to individual streets. Anyone can tap "I prayed
for here" — no sign-in needed — to add to that week's prayer tally.

Live: https://daemeous.github.io/love-stafford-prayer/

---

## How it works

Road geometry comes from the existing Leafletting pipeline (OpenStreetMap,
clipped to Stafford's urban-core wards). Roads are split into 4 quadrants
by the River Sow and the A34 (see `leaflet-pipeline`'s sibling script,
`build_quadrants.py`), then bucketed into weekly rotation groups of ~10
roads per quadrant, chained by geographic proximity.

Data lives in a Google Sheet (`Data`, `Focus`, `PrayerLog`, `Authorised`,
`Changelog` tabs), read by the app as published CSVs. An Apps Script web
app handles writes: an authorised organiser can set/clear a week's focus
override and edit a street's notes/residence count; anyone can log an
"I prayed for here" tap with no authentication.

---

## Repository contents

| File | Purpose |
|------|---------|
| `index.html` | Config block (Sheet ID/gids, Apps Script URL, title, map centre) |
| `core.js` | App logic — data loading, quadrant/week rotation, map rendering, GPS locate, organiser controls |
| `styles.css` | Styles |
| `sw.js` | Service worker (PWA offline shell + map tile cache) |
| `stafford_quadrants.geojson` | The 4 quadrant polygons, used for the GPS "locate me" point-in-polygon check |

---

## License and Attributions

Licensed under the [PolyForm Noncommercial 1.0.0](LICENSE) license — free
for personal, church, and other noncommercial use; commercial use requires
a separate agreement.

Road data © OpenStreetMap contributors, available under the [Open Database
License](https://opendatacommons.org/licenses/odbl/). Ward boundaries from
Ordnance Survey Boundary-Line, © Crown copyright and database right, under
the [Open Government Licence](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
This project's noncommercial restriction applies to its own code only —
the upstream OSM/OS data both explicitly permit commercial use and can't
be relicensed by this project.
