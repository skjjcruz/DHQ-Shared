# dhq-shared

Canonical source of the **shared browser engine** used by both Dynasty HQ products:

- **War Room** (`C2-Football/WarRoom`) — desktop command center
- **ReconAI / Scout** (`C2-Football/ReconAI`) — mobile PWA

This repo is the single source of truth. Both apps **vendor** these modules into their own
build at deploy time and at local-dev startup, so **neither app depends on the other's repo**.

```
                          ┌──────────────────┐
   edit here ───push───▶  │   dhq-shared      │
                          └────────┬─────────┘
                       vendored at │ build (sync)
                 ┌─────────────────┴─────────────────┐
                 ▼                                     ▼
         WarRoom/reconai-shared/              ReconAI/shared/  (these 30 files)
         (classic <script> tags via           (side-effect `import` in main.js,
          js/shared/shared-loader.js)           bundled by Vite)
```

## How to make a change

1. Edit a module here and push to `main`.
2. Each app picks it up on its **next build / `npm run dev`** (their sync step copies these
   files in). No app reads the other app's repo anymore.

There is intentionally no build/runtime CDN serving from this repo — the apps copy the files
locally, so a change is "live" once each app redeploys.

## Module contract

Every module here is a **classic, global-attaching script** (no ES exports). It runs for
side effects and attaches its API to `window.*`. This is why the *same* file works in both
consumers: War Room loads it via `<script>`, ReconAI imports it for side effects under Vite.
Do not add `export`/`import` statements to these files.

## Modules (30)

Authoritative list also lives in each app's sync script
(`WarRoom/scripts/sync-reconai-shared.cjs`, `ReconAI/scripts/sync-shared.cjs`) and in
[`manifest.json`](manifest.json).

App-specific modules that are **not** shared (Scout-only `data-cache.js`,
`league-memory.js`, …; War Room's own `js/shared/*`) stay in their respective app repos.

## Shared data (`draft-war-room/`)

The rookie/prospect CSVs consumed by `rookie-data.js` also live here (static,
hand-curated data): `draft-war-room/player.csv`, `draft-war-room/player-enrichment.csv`,
`draft-war-room/data/mock_draft_db.csv`. Both apps vendor these alongside the modules
and load them **same-origin** from their own deploy — neither fetches them cross-repo.
War-Room-only draft-tool data (`player-sources.csv`, `prospects_test_2025.csv`,
`players-final.json`) stays in the WarRoom repo.
