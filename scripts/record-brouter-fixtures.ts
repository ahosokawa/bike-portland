/**
 * Records real BRouter responses for the shared route scenarios into
 * src/__fixtures__/brouter-fixtures.json so router tests run offline.
 *
 * Re-run whenever routing code or PBOT data changes in a way that alters
 * which BRouter requests are made (tests will tell you — they fail with a
 * "missing fixture" message).
 *
 * Run: npx tsx scripts/record-brouter-fixtures.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import type { LatLng } from 'leaflet';
import { buildGraph } from '../src/pbot-graph';
import { indexBusyRoads } from '../src/busy-roads';
import {
  computeGuidedRoute,
  setRouteProfile,
  setBRouterFetcher,
  httpBRouterFetcher,
} from '../src/router';
import type { BRouterFeature } from '../src/types';
import { SCENARIOS, FIXTURES_PATH, fixtureKey } from '../src/route-scenarios';

const root = resolve(import.meta.dirname, '..');

async function main(): Promise<void> {
  console.log('Loading PBOT data and building graph...');
  const pbot = JSON.parse(readFileSync(resolve(root, 'public/data/pbot-routes.geojson'), 'utf8'));
  const busy = JSON.parse(readFileSync(resolve(root, 'public/data/busy-roads.geojson'), 'utf8'));
  indexBusyRoads(busy);
  buildGraph(pbot);

  const recordings: Record<string, BRouterFeature> = {};

  // Wrap the real fetcher: record every request/response, throttled to be
  // polite to brouter.de.
  let lastRequest = 0;
  setBRouterFetcher(async (lonlats, profile) => {
    const wait = Math.max(0, lastRequest + 500 - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequest = Date.now();

    const key = fixtureKey(profile, lonlats);
    console.log(`  BRouter: ${key}`);
    const feature = await httpBRouterFetcher(lonlats, profile);
    recordings[key] = feature;
    return feature;
  });

  for (const scenario of SCENARIOS) {
    console.log(`\nRecording scenario: ${scenario.name}`);
    setRouteProfile(scenario.profile);
    const route = await computeGuidedRoute(scenario.from as LatLng, scenario.to as LatLng);
    console.log(`  → ${(route.distance / 1609.34).toFixed(2)} mi, ${route.coordinates.length} coords, ${route.instructions.length} instructions, source=${route.debug?.source}`);
  }

  const outPath = resolve(root, FIXTURES_PATH);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(recordings));
  const kb = Math.round(Buffer.byteLength(JSON.stringify(recordings)) / 1024);
  console.log(`\nWrote ${Object.keys(recordings).length} fixtures (${kb} KB) → ${FIXTURES_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
