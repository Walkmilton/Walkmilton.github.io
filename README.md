# Holyrood 2026 — Live Results Dashboard

> Interactive dashboard for the **7 May 2026 Scottish Parliament election**.
> Watch seat totals, swings, projections and the parliament hemicycle update
> live as the count comes in.

🔴 **Live:** [election.declans.gaff.scot](https://election.declans.gaff.scot)

![election](https://img.shields.io/badge/election-7%20May%202026-blue) ![status](https://img.shields.io/badge/status-live-success) ![hosting](https://img.shields.io/badge/hosted-GitHub%20Pages-181717)

---

## What it does

- **Two interactive maps** — 73 constituencies (geographic or hex-grid) and
  8 regions with per-region list-seat dots.
- **Parliament hemicycle** — every one of the 129 MSPs as a coloured dot,
  ordered left → right by political position, with the majority line at 65.
- **Sky-style two-party swingometer** — semi-circle dial in every seat's
  detail modal showing the swing between 2021 winner and runner-up, with
  the tipping-point line marked.
- **Live polling** — auto-pulls results from a published Google Sheet so a
  small team can update results as they declare and every dashboard reading
  the same sheet refreshes within ~30 seconds.
- **Two projection modes** — `Declared only` shows only what's been called;
  `Projected (BBS)` applies the latest Ballot Box Scotland poll-of-polls
  swing to every undeclared seat and runs d'Hondt on the regional lists.
  Bootstrap confidence intervals on every party's seat total.
- **Path-to-majority tracker** — for each party, the next N seats they'd
  need to flip to reach 65, ranked by required swing.
- **Coalition arithmetic** — every realistic 2- and 3-party combination
  with seat totals and ✓/✗ majority verdict.
- **Story-so-far auto-headline** — a natural-language summary that updates
  as results arrive ("With 23 of 73 declared, Labour have gained 4 seats…").
- **20 most marginal seats** with curated commentary on the contests
  (party leaders, retiring MSPs, Reform pickups).
- **Year-view selector** — switch between live 2026 and any of the previous
  six elections (1999, 2003, 2007, 2011, 2016, 2021).
- **TV / big-screen mode**, **light / dark theme**, **sound alerts** when
  results arrive, **expected declaration schedule**, **smart-paste vote
  entry** that extracts numbers from BBC live-blog text.

---

## Use the live site

You don't need a copy of this repo — just visit
[election.declans.gaff.scot](https://election.declans.gaff.scot) on Friday
8 May 2026 and watch the count come in.

The dashboard is fully client-side, so anything you enter (vote counts,
watchlist seats, light/dark preference) lives only in your browser. Nothing
is sent anywhere.

### Updating results from your own data source

If you want to mirror an active count using your own sheet:

1. Make a Google Sheet using the headers in `live-template.csv`
2. **File → Share → Publish to web → CSV**
3. In the dashboard, click **🔴 Live: off** in the top bar, paste the
   published CSV URL, hit **Test connection** then **Start live mode**

Detailed setup is in the in-app modal.

---

## Run it locally

Clone and serve:

```bash
git clone https://github.com/Walkmilton/Walkmilton.github.io.git
cd Walkmilton.github.io
python3 -m http.server 8765
```

Then visit <http://localhost:8765>. (Opening `index.html` directly via
`file://` won't work — browsers block local-file `fetch()` calls.)

No build step. No `npm install`. The whole dashboard is one HTML file
+ one JS file + a `data/` folder of JSON.

---

## Fork it for a different election

This is set up for Holyrood 2026 with 73 constituencies + 8 regions, but
the structure is straightforward to retarget:

- `data/maps.topo.json` — TopoJSON for both maps (replace with your
  boundaries; mapshaper does the conversion)
- `data/results_2021_*.json` — baseline you compare against (per-seat
  vote shares, regional list votes, national totals)
- `data/predictions_2026.json` — the polling baseline driving Projected
  mode (replace with your favourite forecast)
- `data/notables_2026.json` — your curated commentary on key seats
- `data/declaration_schedule.json` — expected declaration times
- `data/historical/` — historical comparison years
- Constants in `app.js`: `PARTIES`, `PARTY_COLORS`, `PARTY_NAMES`,
  `REGIONS`, `TOTAL_SEATS`, `MAJORITY` etc.

The d'Hondt allocator and UNS projection logic are general — would also
adapt to the Welsh Senedd or any AMS / MMP system with minor tweaks.

---

## Method notes

- Constituency winners use **first-past-the-post** on entered votes.
- Undeclared constituencies under `Projected (BBS)` mode use **uniform
  national swing** computed from BBS poll-of-polls vote shares vs 2021.
- Regional list seats use the **d'Hondt method** with constituency wins
  counted as the initial divisor (the AMS top-up rule).
- Per-seat **two-party swing** uses the standard UK formula:
  `swing from A to B = ((curB% − curA%) − (oldB% − oldA%)) / 2`.
  Tipping point = `(oldA% − oldB%) / 2`.
- Each region returns 7 list MSPs. Total: 73 + 56 = 129. Majority = 65.
- Bootstrap confidence intervals: 200 replicates, ±2pp Gaussian noise on
  BBS shares (representing typical polling MoE).

---

## Data sources

- **Boundaries:** 2011–2026 Scottish Parliamentary Constituencies and
  Regions, Ordnance Survey BoundaryLine via
  [martinjc/UK-GeoJSON](https://github.com/martinjc/UK-GeoJSON), simplified
  with [mapshaper](https://github.com/mbloch/mapshaper) to a compact
  TopoJSON.
- **2021 baseline + historical results:**
  [Wikipedia — Scottish Parliament elections](https://en.wikipedia.org/wiki/Scottish_Parliament_election).
- **2026 polling projections:**
  [Ballot Box Scotland](https://ballotbox.scot/scottish-parliament/sp26-hub/)
  poll-of-polls and Norstat April 2026.
- **Notable contests commentary:** sourced from
  [Scotsman — 16 seats to watch](https://www.scotsman.com/news/politics/2026-scottish-parliament-election-the-16-seats-to-watch-out-for-5120120),
  Wikipedia and BBS individual contest pages.

---

## Caveats

- The 2026 election uses the **Second Periodic Review boundaries** (Order
  2025/285): 73 constituencies, 8 regions, 56 list seats, 129 MSPs total —
  same structure as 2021. **42 of the 73 constituencies have redrawn
  boundaries**, 3 changed in name only, 28 are unchanged. This dashboard
  uses 2011–2026 boundary outlines for the maps so the 2021 comparison is
  direct; constituency names map 1-to-1 in almost all cases.
- Reform was effectively absent in 2021, so any current Reform vote shows
  as pure swing under the projection model.
- Pre-2011 historical years (1999, 2003, 2007) are shown as Scotland-wide
  totals only — different boundaries, not directly comparable to the
  current map.

---

## Tech

- Vanilla HTML/CSS/JS — no framework, no build, no dependencies to install
- D3 v7 + topojson-client (loaded from jsdelivr)
- ~1.1MB total page weight
- Client-side only — no backend, no tracking, no analytics
- CSP headers locked to approved CDNs and Google Sheets only
- Light / dark mode, persists state to `localStorage`

---

## License

Code: MIT. Election data is in the public domain (or under Open Government
Licence, where applicable). Maps © Crown copyright and database right via
Ordnance Survey under the Open Government Licence.

---

## Contributing

This is a personal weekend project, but PRs are welcome — especially:

- Improving the per-seat 2026 boundary mapping for the redrawn seats
- Adding YouGov MRP / Survation per-seat predictions
- Backfilling per-constituency detail for the 2011 and 2016 historical
  files (currently Scotland-totals only)
- Fixing the hex-grid layout for any constituencies that look wrong

Open an issue if anything is broken on the night.

---

*Built for the 7 May 2026 Scottish Parliament election.*
