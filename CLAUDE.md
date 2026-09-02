# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PedalPDX is a mobile-first PWA for bike-friendly routing in Portland, OR. It provides turn-by-turn navigation with color-coded bike infrastructure data from PBOT (Portland Bureau of Transportation). Fully static — no backend, no routing server, deploys to GitHub Pages. Routing runs entirely in the browser over a street graph shipped with the app, so it works offline.

## Commands

```bash
npm run dev          # Vite dev server on http://localhost:5173
npm run build        # Production build → dist/ (does NOT typecheck)
npx tsc --noEmit     # Typecheck — keep this green; vite build won't catch type errors
npm run preview      # Preview production build locally
npm run fetch-data   # Refresh all shipped data (PBOT overlay + routing graph)
npm run fetch-graph  # Rebuild just the routing graph from OSM + PBOT
npm run test         # Run vitest tests (fully offline)
npm run test:watch   # Run vitest in watch mode
```

`fetch-graph` hits the Overpass API and takes a couple of minutes; the raw
response is cached in the OS temp dir for a day. Rerun it when OSM data goes
stale or the graph builder changes, then re-run the tests — they assert against
the committed artifact.

### Dev harness (URL params)

`?from=lat,lng&to=lat,lng&profile=safest|balanced` loads a route on startup; `&sim=1` makes Start Navigation use the fake-GPS ride simulator (`ride-simulator.ts` — speed/pause/veer controls); `&sim=auto` auto-starts navigation; `&debug=1` marks where the endpoints snapped onto the network and dumps route internals to the console. The URL stays in sync with the current route, so repro cases are copy-pasteable links. Use this instead of manual tapping or real GPS whenever validating routing or navigation behavior.

## Architecture

### Module Responsibilities

- **main.ts** — App orchestrator: UI wiring, state management, mode switching (planning ↔ navigation ↔ builder)
- **map.ts** — Leaflet map initialization, markers, route polylines, user position tracking
- **street-graph.ts** — The routing engine: decodes the shipped graph, builds CSR adjacency, snaps points to the nearest edge, and runs A* over weighted meters. Also owns the infrastructure tiers used for colouring
- **route-instructions.ts** — Turns a computed route into named turn-by-turn instructions (leg grouping, noise suppression, turn wording)
- **router.ts** — Thin app-facing API over the engine: profile selection, `RouteResult` shaping, multi-waypoint routes
- **pbot-layer.ts** — GeoJSON overlay with infrastructure color-coding and popup labels (display only — routing reads PBOT attributes off the graph)
- **navigation.ts** — Turn-by-turn engine: snap-to-route, voice announcements (Web Speech API), wake lock, mid-navigation route swap (`updateRoute`) for rerouting. Positions come through an injectable `PositionSource` (real GPS by default). Rerouting policy (8s sustained off-route, 20s cooldown) lives in main.ts `maybeReroute`
- **ride-simulator.ts** — Dev-only fake-GPS `PositionSource` that replays positions along a route (speed multiplier, GPS noise, veer-off-route), plus its floating control panel
- **route-scenarios.ts** — Shared origin/destination scenarios (the golden-route corpus) used across routing tests
- **custom-route-builder.ts** — Multi-waypoint route creation with live preview
- **search.ts** — Address search via Photon API, reverse geocoding, viewport-biased results
- **saved-routes.ts** — IndexedDB persistence for custom routes with offline caching, home address storage
- **geo.ts** — Shared geographic utilities (haversine, bearing, point-to-segment projection, unit conversion constants)
- **icons.ts** — SVG icon generation for turn instructions
- **types.ts** — Shared TypeScript interfaces

### Routing Architecture

All routing is client-side over `public/data/street-graph.json` — Portland's
bikeable OSM network (64k nodes / 78k edges, 3.7MB raw / 1.2MB gzipped) with
PBOT `ConnectionType` conflated onto edges at build time by
`scripts/fetch-street-graph.ts`.

Costs are **weighted meters**: edge length times a per-class weight, plus
junction penalties. A PBOT facility on an edge sets the weight (a bike lane on
an arterial is cheap); otherwise the OSM highway class does. On top of that:
- **crossing penalties** when passing through a junction with a busier road
  than either edge being ridden, heavily discounted where OSM marks a signal or
  marked crossing — this is what replaced the old busy-roads gap-edge machinery
- **turn costs** for direction changes over 60°

Two profiles (`safest` = "Bike Paths", `balanced` = "Direct") differ only in
their weight and penalty tables.

Both endpoints snap to the nearest **edge**, not the nearest node, and the
geometry is trimmed to the projected position — so routes start and end where
the rider actually is. A* is seeded at both ends of the start edge and may
finish at either end of the destination edge, so it naturally picks the
approach that doesn't require doubling back. Snapping only considers edges in
the graph's largest connected component — OSM parking-lot and mall footpaths
form islands that touch no street, and a store's map pin lands nearest one
often enough that snapping there made routing fail.

### Data Flow

User input (search/tap) → main.ts orchestrates → router.ts asks street-graph.ts
for a route → route-instructions.ts derives named turns → map.ts renders the
colour-coded polyline (tiers come back with the route) → navigation.ts handles
GPS tracking, voice guidance, and rerouting.

### External Services (all public, no auth)

Nothing is called at runtime for routing — the graph ships with the app.

- **Photon / Nominatim** — Address geocoding (runtime, only while searching)
- **OpenStreetMap** — Map tiles (runtime, cached by the service worker)
- **Overpass API** — Street network + crossings (build time, `npm run fetch-graph`)
- **PBOT ArcGIS** — Bike infrastructure data (build time, `npm run fetch-data`)

### PBOT Infrastructure Tiers

Routes are classified and color-coded: `path` (green, MUPs) → `good` (greenways, buffered lanes) → `lane` (bike lanes) → `caution` (medium/high traffic) → `avoid` (difficult) → `none` (unknown). Tiers come back with the route from street-graph.ts; per-profile weights there control how aggressively each is favoured or penalised.

### State Management

Simple centralized state in main.ts (`AppState` with mode, start/end locations, route). The loaded `StreetGraph` is held in router.ts (installed by main.ts once fetched — routing throws a friendly error until then). Module-level state in navigation.ts (position source, wakeLock), builder, and saved-routes (IndexedDB via `idb` library). Database: "pedalpdx" v3 with savedRoutes, settings, and a legacy edgePreferences store (unused — kept so existing databases open without a version bump). Home address persisted in the settings store.

### Multi-Page Build

The project is a Vite MPA (`appType: 'mpa'`) with two entry points:
- **`src/index.html`** — The main PWA app
- **`src/info/index.html`** — Informational landing page for prospective users (static HTML + CSS, no JS)

Both are built via `rollupOptions.input` and deployed together. The info page lives at `/pedalpdx/info/`. A dev-only Vite plugin handles trailing-slash redirects for `/info` → `/info/`. The service worker's `navigateFallbackDenylist` prevents the app shell from intercepting `/info/` requests.

### PWA & Offline

Vite PWA plugin generates service worker (Workbox). OSM tiles cached CacheFirst (30-day, 500 max). PBOT GeoJSON (up to 6MB) cached. App works offline.

## Testing

Tests use vitest with real PBOT data (integration-style) and run fully offline:

- **`src/street-graph.test.ts`** — The routing engine against the committed graph artifact, over a golden-route corpus of 8 city-wide scenarios (`route-scenarios.ts`). Per-scenario invariants: endpoints within 150m of the request, continuous geometry, detour ratio < 2.3× straight-line, no doubling back at either end, no riding the wrong way down a one-way, ≥85% of coordinates on path/good/lane infrastructure, ≤8% on caution/avoid, query under 400ms. Plus geography checks (uses the Springwater Corridor, stays east of the Willamette, crosses a bridge when it must).
- **`src/route-instructions.test.ts`** — Instruction generation: monotonic distances, step distances summing to route length, instructions sitting on the geometry, icon/wording agreement, street names on turns, no instructions closer than 12m.
- **`src/navigation.test.ts`** — Nav engine driven by scripted positions: instruction advancement, off-route detection, arrival, mid-navigation route swap.

Tests run against the committed `public/data/street-graph.json`, so rebuilding
the graph can shift measured numbers. When tuning weights, re-run the tests and
update the thresholds **from measurement** rather than nudging them until green
— several bounds carry a comment recording the observed value.

Node-importability: `router.ts`, `navigation.ts`, `street-graph.ts` and
`route-instructions.ts` must stay free of browser-only imports (Leaflet values,
IndexedDB); browser APIs they touch (speechSynthesis, wake lock) are guarded.
Don't add direct imports of `map.ts`/`saved-routes.ts` into them.

Gotcha: PBOT edge geometry is simplified at fetch time, so consecutive route coordinates on straight runs can legitimately be 200–800m apart — consecutive-point spacing is not a continuity signal; check `debug.sectionBoundaries` instead.

## Build & Deploy

- Vite MPA with base path `/pedalpdx/` (GitHub Pages subdirectory)
- Two entry points: `src/index.html` (app) and `src/info/index.html` (landing page)
- TypeScript target: ES2020, strict mode, bundler module resolution
- Push to `main` triggers GitHub Actions → `npm ci && npm run build` → deploys dist/ to GitHub Pages
- Source root is `src/`, public dir is `public/`, output is `dist/`
- Geolocation requires HTTPS or localhost

## Maintenance

After making changes, review and update CLAUDE.md and README.md if any of the following are affected: module responsibilities, architecture, commands, external services, data flow, or build/deploy process. Keep descriptions concise and accurate.
