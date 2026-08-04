# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PedalPDX is a mobile-first PWA for bike-friendly routing in Portland, OR. It provides turn-by-turn navigation with color-coded bike infrastructure data from PBOT (Portland Bureau of Transportation). Fully static — no backend, deploys to GitHub Pages.

## Commands

```bash
npm run dev          # Vite dev server on http://localhost:5173
npm run build        # Production build → dist/ (does NOT typecheck)
npx tsc --noEmit     # Typecheck — keep this green; vite build won't catch type errors
npm run preview      # Preview production build locally
npm run fetch-data   # Fetch PBOT bike network + busy roads → public/data/
npm run test         # Run vitest tests (fully offline; BRouter replayed from fixtures)
npm run test:watch   # Run vitest in watch mode
npx tsx scripts/record-brouter-fixtures.ts  # Re-record BRouter fixtures (live network)
```

### Dev harness (URL params)

`?from=lat,lng&to=lat,lng&profile=safest|balanced` loads a route on startup; `&sim=1` makes Start Navigation use the fake-GPS ride simulator (`ride-simulator.ts` — speed/pause/veer controls); `&sim=auto` auto-starts navigation; `&debug=1` draws gap edges + stitch points and dumps route internals to the console. The URL stays in sync with the current route, so repro cases are copy-pasteable links. Use this instead of manual tapping or real GPS whenever validating routing or navigation behavior.

## Architecture

### Module Responsibilities

- **main.ts** — App orchestrator: UI wiring, state management, mode switching (planning ↔ navigation ↔ builder)
- **map.ts** — Leaflet map initialization, markers, route polylines, user position tracking
- **router.ts** — BRouter API wrapper, PBOT path stitching, instruction parsing, two routing profiles (`safest` = PBOT A* + BRouter first/last mile, `balanced` = pure BRouter)
- **pbot-graph.ts** — A* pathfinding through PBOT bike network with per-profile edge weights, gap-bridging edges, and route classification
- **pbot-layer.ts** — GeoJSON overlay with infrastructure color-coding and popup labels
- **navigation.ts** — Turn-by-turn engine: snap-to-route, voice announcements (Web Speech API), wake lock, mid-navigation route swap (`updateRoute`) for rerouting. Positions come through an injectable `PositionSource` (real GPS by default). Rerouting policy (8s sustained off-route, 20s cooldown) lives in main.ts `maybeReroute`
- **ride-simulator.ts** — Dev-only fake-GPS `PositionSource` that replays positions along a route (speed multiplier, GPS noise, veer-off-route), plus its floating control panel
- **route-scenarios.ts** — Shared origin/destination scenarios used by router tests and the fixture recorder
- **custom-route-builder.ts** — Multi-waypoint route creation with live preview
- **search.ts** — Address search via Photon API, reverse geocoding, viewport-biased results
- **saved-routes.ts** — IndexedDB persistence for custom routes with offline caching, home address storage
- **elevation.ts** — Canvas-based elevation profile visualization
- **geo.ts** — Shared geographic utilities (haversine, bearing, point-to-segment projection, unit conversion constants)
- **busy-roads.ts** — Spatial index of busy roads for crossing detection in gap-bridging
- **icons.ts** — SVG icon generation for turn instructions
- **types.ts** — Shared TypeScript interfaces

### Routing Architecture

Two routing profiles:
- **Bike Paths** (`safest`): Uses PBOT A* pathfinding for the core route (renders edge geometry directly), with BRouter for first-mile and last-mile segments connecting start/end to the PBOT network. Falls back to pure BRouter if PBOT path is unavailable.
- **Direct** (`balanced`): Pure BRouter with `fastbike-lowtraffic` profile.

PBOT data is always used for route classification/highlighting regardless of profile.

### Data Flow

User input (search/tap) → main.ts orchestrates → router.ts either runs PBOT A* path with BRouter first/last mile (safest) or pure BRouter (balanced) → pbot-graph.ts classifies route segments → map.ts renders color-coded route → navigation.ts handles GPS tracking and voice guidance.

### External Services (all public, no auth)

- **BRouter** (brouter.de) — Routing engine (used for first/last mile in safest mode, full route in balanced mode)
- **Photon** (photon.komoot.io) — Address geocoding
- **OpenStreetMap** — Map tiles
- **PBOT ArcGIS** — Bike infrastructure data (fetched at build time via `npm run fetch-data`)

### PBOT Infrastructure Tiers

Routes are classified and color-coded: `path` (green, MUPs) → `good` (greenways, buffered lanes) → `lane` (bike lanes) → `caution` (medium/high traffic) → `avoid` (difficult) → `none` (unknown). Per-profile weights in pbot-graph.ts control how aggressively each tier is favored/penalized.

### State Management

Simple centralized state in main.ts (`AppState` with mode, start/end locations, route). Module-level state in navigation.ts (position source, wakeLock), builder, and saved-routes (IndexedDB via `idb` library). Database: "pedalpdx" v3 with savedRoutes, settings, and a legacy edgePreferences store (unused — kept so existing databases open without a version bump). Home address persisted in the settings store.

### Multi-Page Build

The project is a Vite MPA (`appType: 'mpa'`) with two entry points:
- **`src/index.html`** — The main PWA app
- **`src/info/index.html`** — Informational landing page for prospective users (static HTML + CSS, no JS)

Both are built via `rollupOptions.input` and deployed together. The info page lives at `/bike-portland/info/`. A dev-only Vite plugin handles trailing-slash redirects for `/info` → `/info/`. The service worker's `navigateFallbackDenylist` prevents the app shell from intercepting `/info/` requests.

### PWA & Offline

Vite PWA plugin generates service worker (Workbox). OSM tiles cached CacheFirst (30-day, 500 max). PBOT GeoJSON (up to 6MB) cached. App works offline.

## Testing

Tests use vitest with real PBOT data (integration-style) and run fully offline:

- **`src/pbot-graph.test.ts`** — A* pathfinding for specific Portland routes (Morris greenway crossing, Springwater corridor, no river crossings, no backtracking, one-way handling).
- **`src/router.test.ts`** — Full safest-mode pipeline (A* + gap resolution + first/last-mile stitching) with BRouter responses replayed from `src/__fixtures__/brouter-fixtures.json`. Asserts stitch-boundary continuity, distance/geometry consistency, and instruction well-formedness.

Fixtures are recorded via `npx tsx scripts/record-brouter-fixtures.ts` (hits live brouter.de). If routing changes alter which BRouter requests get made, tests fail with a "missing fixture" message — re-record. Scenarios live in `src/route-scenarios.ts`.

Node-importability: `router.ts` and `navigation.ts` must stay free of browser-only imports (Leaflet values, IndexedDB); browser APIs they touch (speechSynthesis, wake lock) are guarded. BRouter is injected via `setBRouterFetcher()`. Don't add direct imports of `map.ts`/`saved-routes.ts` into router/pbot-graph/navigation/geo/busy-roads.

Gotcha: PBOT edge geometry is simplified at fetch time, so consecutive route coordinates on straight runs can legitimately be 200–800m apart — consecutive-point spacing is not a continuity signal; check `debug.sectionBoundaries` instead.

## Build & Deploy

- Vite MPA with base path `/bike-portland/` (GitHub Pages subdirectory)
- Two entry points: `src/index.html` (app) and `src/info/index.html` (landing page)
- TypeScript target: ES2020, strict mode, bundler module resolution
- Push to `main` triggers GitHub Actions → `npm ci && npm run build` → deploys dist/ to GitHub Pages
- Source root is `src/`, public dir is `public/`, output is `dist/`
- Geolocation requires HTTPS or localhost

## Maintenance

After making changes, review and update CLAUDE.md and README.md if any of the following are affected: module responsibilities, architecture, commands, external services, data flow, or build/deploy process. Keep descriptions concise and accurate.
