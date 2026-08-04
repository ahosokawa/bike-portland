# PedalPDX

A mobile-first PWA for bike-friendly routing in Portland, OR. Combines official PBOT bicycle infrastructure data with OpenStreetMap's street network into a routing graph that ships with the app, so routes preferring protected bike lanes, neighborhood greenways, and multi-use paths are computed instantly, on your phone, with no server and no connection required.

**[Learn more](https://ahosokawa.github.io/bike-portland/info/)** · **[Open the app](https://ahosokawa.github.io/bike-portland/)**

## Features

- **Bike-optimized routing, fully offline** — Two profiles: Bike Paths (favours multi-use paths and greenways, and detours to cross busy roads at signals) and Direct (shorter, still avoiding traffic). Routes compute in milliseconds on-device — no routing server.
- **Named turn-by-turn directions** — Every turn references a real street: "Turn right onto Northeast Tillamook Street".
- **Automatic rerouting** — Drift off course and a new route is computed from where you are.
- **PBOT bike network overlay** — 12,800+ route segments from Portland Bureau of Transportation, color-coded by infrastructure quality (green = multi-use path, blue = bike lane, red = difficult connection).
- **Turn-by-turn navigation** — Real-time GPS tracking, voice announcements before turns, off-route warnings with automatic rerouting, and screen wake lock. Designed for phone-on-handlebars use.
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
2. A route calculates automatically. Open **Route Details** for named turn-by-turn directions.
3. Toggle **Bike Routes** (top right) to see Portland's bike network overlay.
4. Switch routing profile (Bike Paths / Direct) above the bottom controls.
5. Tap **Start Navigation** for turn-by-turn mode with voice, GPS tracking, and a glanceable HUD.

## Build & Deploy

```bash
npm run build        # Build to dist/
npm run preview      # Preview production build locally
npm run test         # Run tests (fully offline)
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
| `&debug=1` | Mark where the endpoints snapped onto the network and dump route/instructions to console |

Example — simulate riding Cook St → The Redd with debug overlay:

```
http://localhost:5173/bike-portland/?from=45.54736,-122.66082&to=45.51459,-122.65699&sim=auto&debug=1
```

The URL updates as you plan routes manually, so any route you see can be shared or re-loaded by copying the address bar.

Tests run against the committed routing graph in `public/data/`, so they need
no network at all.

## Refreshing PBOT Data

All map and routing data is fetched at build time and bundled as static files.
To refresh:

```bash
npm run fetch-data    # PBOT overlay + routing graph
npm run fetch-graph   # just the routing graph
```

This queries the PBOT ArcGIS REST API and OpenStreetMap (Overpass), then builds
`public/data/street-graph.json` — Portland's bikeable street network (64k nodes,
78k edges, 5,940 km) with PBOT bike-infrastructure attributes conflated onto its
edges and signalised crossings marked. It is 3.7 MB raw and 1.2 MB gzipped over
the wire.

## Tech Stack

| Component | Choice |
|-----------|--------|
| Build | Vite + TypeScript |
| Map | Leaflet + OpenStreetMap tiles |
| Routing | Client-side A* over an OSM + PBOT street graph (no server) |
| Bike data | PBOT ArcGIS REST API (build-time fetch) |
| Street network | OpenStreetMap Overpass API (build-time fetch) |
| Search | Photon (free, no key needed) |
| PWA | vite-plugin-pwa + Workbox |
| Testing | Vitest |
| Hosting | GitHub Pages |

## Project Structure

```
src/
  main.ts                 App entry, UI wiring, planning/nav mode switching
  map.ts                  Leaflet map, markers, user position
  street-graph.ts         Routing engine: graph decoding, snapping, A*
  route-instructions.ts   Named turn-by-turn instruction generation
  router.ts               App-facing routing API and route profiles
  pbot-layer.ts           PBOT GeoJSON overlay with infrastructure color-coding
  navigation.ts           Turn-by-turn engine: position tracking, snap-to-route, voice
  ride-simulator.ts       Dev fake-GPS position source + on-screen sim controls
  route-scenarios.ts      Golden-route corpus shared across routing tests
  custom-route-builder.ts Multi-waypoint route creation with live preview
  saved-routes.ts         IndexedDB persistence for saved routes
  search.ts               Photon address search, reverse geocoding
  geo.ts                  Shared geographic utilities (haversine, bearing, projection, unit constants)
  icons.ts                SVG icon generation
  geolocation.ts          Device GPS wrapper
  types.ts                Shared TypeScript interfaces
  street-graph.test.ts    Routing engine tests over the golden-route corpus
  route-instructions.test.ts  Instruction generation tests
  navigation.test.ts      Turn-by-turn engine tests via a scripted position source
  style.css               Mobile-first styles, navigation HUD
  index.html              App entry point
  info/
    index.html            Informational landing page (static HTML)
    info.css              Landing page styles
scripts/
  fetch-pbot-data.ts      Build-time PBOT data fetcher
  fetch-street-graph.ts   Build-time routing graph builder (Overpass + PBOT)
  spike-osm-graph.ts      Feasibility spike kept for re-measuring graph size/quality
public/
  data/pbot-routes.geojson  Bike network for the map overlay (~4.5 MB)
  data/street-graph.json    Routing graph (3.7 MB, 1.2 MB gzipped)
  icons/                    PWA icons
```

## License

ISC
