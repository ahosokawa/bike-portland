# PedalPDX

A mobile-first PWA for bike-friendly routing in Portland, OR. Uses official PBOT bicycle infrastructure data and BRouter's safety-optimized routing to generate routes that prefer protected bike lanes, neighborhood greenways, and multi-use paths.

## Features

- **Bike-optimized routing** — Two profiles: Bike Paths (PBOT A* pathfinding through Portland's bike network) and Direct (BRouter's low-traffic profile). Routes prefer cycleways, greenways, and low-traffic streets.
- **PBOT bike network overlay** — 12,800+ route segments from Portland Bureau of Transportation, color-coded by infrastructure quality (green = multi-use path, blue = bike lane, red = difficult connection).
- **Turn-by-turn navigation** — Real-time GPS tracking, voice announcements before turns, off-route warnings, and screen wake lock. Designed for phone-on-handlebars use.
- **Elevation profile** — See climbing for any route. Useful for Portland's west hills.
- **Address search** — Geocoding via Photon, bounded to Portland.
- **Custom routes** — Build multi-waypoint routes and save them for offline use.
- **GPS start point** — "Use my location" to set your starting point.
- **Installable PWA** — Add to home screen on iOS/Android. Caches tiles and bike data for faster loads.
- **Fully static** — No backend, no API keys, no accounts. Deploys to GitHub Pages.

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
npm run test         # Run tests
```

Deploys automatically to GitHub Pages on push to `main` via the included GitHub Actions workflow.

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
  navigation.ts           Turn-by-turn engine: GPS tracking, snap-to-route, voice
  custom-route-builder.ts Multi-waypoint route creation with live preview
  saved-routes.ts         IndexedDB persistence for saved routes
  search.ts               Photon address search, reverse geocoding
  elevation.ts            Canvas-based elevation profile chart
  geo.ts                  Shared geographic utilities (haversine, distances)
  busy-roads.ts           Busy road spatial index for crossing detection
  icons.ts                SVG icon generation
  geolocation.ts          Device GPS wrapper
  types.ts                Shared TypeScript interfaces
  pbot-graph.test.ts      Integration tests for A* routing
  style.css               Mobile-first styles, navigation HUD
  index.html              Single page shell
scripts/
  fetch-pbot-data.ts      Build-time PBOT data fetcher
  fetch-busy-roads.ts     Build-time busy roads fetcher (Overpass)
  test-routes.ts          Route testing utility
public/
  data/pbot-routes.geojson  Pre-fetched bike network (~4.5 MB)
  data/busy-roads.geojson   Pre-fetched busy road segments
  icons/                    PWA icons
```

## License

ISC
