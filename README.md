# PedalPDX

A mobile-first PWA for bike-friendly routing in Portland, OR. Uses official PBOT bicycle infrastructure data and BRouter's safety-optimized routing to generate routes that prefer protected bike lanes, neighborhood greenways, and multi-use paths.

**[Learn more](https://ahosokawa.github.io/bike-portland/info/)** · **[Open the app](https://ahosokawa.github.io/bike-portland/)**

## Features

- **Bike-optimized routing** — Two profiles: Bike Paths (PBOT A* pathfinding through Portland's bike network) and Direct (BRouter's low-traffic profile). Routes prefer cycleways, greenways, and low-traffic streets.
- **PBOT bike network overlay** — 12,800+ route segments from Portland Bureau of Transportation, color-coded by infrastructure quality (green = multi-use path, blue = bike lane, red = difficult connection).
- **Turn-by-turn navigation** — Real-time GPS tracking, voice announcements before turns, off-route warnings with automatic rerouting, and screen wake lock. Designed for phone-on-handlebars use.
- **Elevation profile** — See climbing for any route. Useful for Portland's west hills.
- **Address search** — Geocoding via Photon, bounded to Portland.
- **Custom routes** — Build multi-waypoint routes and save them for offline use.
- **GPS start point** — "Use my location" to set your starting point.
- **Installable PWA** — Add to home screen on iOS/Android. Caches tiles and bike data for faster loads.
- **Fully static** — No backend, no API keys, no accounts. Deploys to GitHub Pages.
- **Info page** — Landing page at `/info/` with install instructions, feature overview, and infrastructure legend.

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:5173 on your phone (or use your browser's mobile emulation).

## Usage

1. Tap the map to place a start point (A), then tap again for the destination (B). Or use the search bar / GPS button.
2. A route calculates automatically. Swipe the route panel to see elevation and turn-by-turn directions.
3. Toggle **Bike Routes** (top right) to see Portland's bike network overlay.
4. Switch routing profile (Bike Paths / Direct) above the bottom controls.
5. Tap **Start Navigation** for turn-by-turn mode with voice, GPS tracking, and a glanceable HUD.

## Build & Deploy

```bash
npm run build        # Build to dist/
npm run preview      # Preview production build locally
npm run test         # Run tests (offline — BRouter calls replay from recorded fixtures)
npx tsc --noEmit     # Typecheck (vite build does not typecheck)
```

Deploys automatically to GitHub Pages on push to `main` via the included GitHub Actions workflow.

## Dev Tools

URL parameters for fast testing without tapping through the UI or riding a bike:

| Param | Effect |
|-------|--------|
| `?from=lat,lng&to=lat,lng` | Load and compute a route on startup |
| `&profile=safest\|balanced` | Select the routing profile |
| `&sim=1` | Start Navigation uses a fake-GPS ride simulator (speed, pause, veer-off-route controls) |
| `&sim=auto` | Same, and navigation auto-starts once the URL route loads |
| `&debug=1` | Draw route internals (gap edges, stitch points) and dump route/instructions to console |

Example — simulate riding Cook St → The Redd with debug overlay:

```
http://localhost:5173/bike-portland/?from=45.54736,-122.66082&to=45.51459,-122.65699&sim=auto&debug=1
```

The URL updates as you plan routes manually, so any route you see can be shared or re-loaded by copying the address bar.

To re-record the BRouter test fixtures (needed when routing changes alter which BRouter requests are made — tests fail with a "missing fixture" message):

```bash
npx tsx scripts/record-brouter-fixtures.ts
```

## Refreshing PBOT Data

The PBOT bicycle route data and busy road data are fetched at build time and bundled as static GeoJSON files. To update:

```bash
npm run fetch-data
```

This queries the PBOT ArcGIS REST API and OpenStreetMap (Overpass), handles pagination, simplifies coordinates, and writes `public/data/pbot-routes.geojson` and `public/data/busy-roads.geojson`.

## Tech Stack

| Component | Choice |
|-----------|--------|
| Build | Vite + TypeScript |
| Map | Leaflet + OpenStreetMap tiles |
| Routing | BRouter (public API) + PBOT A* pathfinding |
| Bike data | PBOT ArcGIS REST API (build-time fetch) |
| Busy roads | OpenStreetMap Overpass API (build-time fetch) |
| Search | Photon (free, no key needed) |
| PWA | vite-plugin-pwa + Workbox |
| Testing | Vitest |
| Hosting | GitHub Pages |

## Project Structure

```
src/
  main.ts                 App entry, UI wiring, planning/nav mode switching
  map.ts                  Leaflet map, markers, user position
  router.ts               BRouter API, PBOT path stitching, route profiles
  pbot-graph.ts           A* pathfinding through PBOT bike network, route classification
  pbot-layer.ts           PBOT GeoJSON overlay with infrastructure color-coding
  navigation.ts           Turn-by-turn engine: position tracking, snap-to-route, voice
  ride-simulator.ts       Dev fake-GPS position source + on-screen sim controls
  route-scenarios.ts      Shared OD pairs for tests and fixture recording
  custom-route-builder.ts Multi-waypoint route creation with live preview
  saved-routes.ts         IndexedDB persistence for saved routes
  search.ts               Photon address search, reverse geocoding
  elevation.ts            Canvas-based elevation profile chart
  geo.ts                  Shared geographic utilities (haversine, bearing, projection, unit constants)
  busy-roads.ts           Busy road spatial index for crossing detection
  icons.ts                SVG icon generation
  geolocation.ts          Device GPS wrapper
  types.ts                Shared TypeScript interfaces
  pbot-graph.test.ts      Integration tests for A* routing
  router.test.ts          Offline pipeline tests (stitching, instructions) via BRouter fixtures
  __fixtures__/           Recorded BRouter responses for offline tests
  style.css               Mobile-first styles, navigation HUD
  index.html              App entry point
  info/
    index.html            Informational landing page (static HTML)
    info.css              Landing page styles
scripts/
  fetch-pbot-data.ts      Build-time PBOT data fetcher
  fetch-busy-roads.ts     Build-time busy roads fetcher (Overpass)
  record-brouter-fixtures.ts  Records live BRouter responses into src/__fixtures__/
public/
  data/pbot-routes.geojson  Pre-fetched bike network (~4.5 MB)
  data/busy-roads.geojson   Pre-fetched busy road segments
  icons/                    PWA icons
```

## License

ISC
