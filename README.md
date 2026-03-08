# PedalPDX

A mobile-first PWA for bike-friendly routing in Portland, OR. Uses official PBOT bicycle infrastructure data and BRouter's safety-optimized routing to generate routes that prefer protected bike lanes, neighborhood greenways, and multi-use paths.

## Features

- **Bike-optimized routing** — Three profiles: Safest, Safe, and Balanced. Routes prefer cycleways, greenways, and low-traffic streets via BRouter.
- **PBOT bike network overlay** — 12,800+ route segments from Portland Bureau of Transportation, color-coded by infrastructure quality (green = multi-use path, blue = bike lane, red = difficult connection).
- **Turn-by-turn navigation** — Real-time GPS tracking, voice announcements before turns, off-route warnings, and screen wake lock. Designed for phone-on-handlebars use.
- **Elevation profile** — See climbing for any route. Useful for Portland's west hills.
- **Address search** — Geocoding via Nominatim, bounded to Portland.
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
4. Switch routing profile (Safest / Safe / Balanced) above the bottom controls.
5. Tap **Start Navigation** for turn-by-turn mode with voice, GPS tracking, and a glanceable HUD.

## Build & Deploy

```bash
npm run build        # Build to dist/
npm run preview      # Preview production build locally
```

Deploys automatically to GitHub Pages on push to `main` via the included GitHub Actions workflow.

## Refreshing PBOT Data

The PBOT bicycle route data is fetched at build time and bundled as a static GeoJSON file. To update it:

```bash
npm run fetch-data
```

This queries the PBOT ArcGIS REST API, handles pagination, simplifies coordinates, and writes `public/data/pbot-routes.geojson`.

## Tech Stack

| Component | Choice |
|-----------|--------|
| Build | Vite + TypeScript |
| Map | Leaflet + OpenStreetMap tiles |
| Routing | BRouter (public API, no key needed) |
| Bike data | PBOT ArcGIS REST API (build-time fetch) |
| Search | Nominatim (free, no key needed) |
| PWA | vite-plugin-pwa + Workbox |
| Hosting | GitHub Pages |

## Project Structure

```
src/
  main.ts           App entry, UI wiring, planning/nav mode switching
  map.ts            Leaflet map, markers, user position
  router.ts         BRouter API, route profiles, instruction parsing
  navigation.ts     Turn-by-turn engine: GPS tracking, snap-to-route, voice
  search.ts         Nominatim address search
  pbot-layer.ts     PBOT GeoJSON overlay with infrastructure classification
  elevation.ts      Canvas-based elevation profile chart
  geolocation.ts    Device GPS wrapper
  types.ts          Shared TypeScript interfaces
  style.css         Mobile-first styles, navigation HUD
  index.html        Single page shell
scripts/
  fetch-pbot-data.ts  Build-time PBOT data fetcher
public/
  data/pbot-routes.geojson  Pre-fetched bike network (~4.5 MB)
  icons/                    PWA icons
```

## License

ISC
