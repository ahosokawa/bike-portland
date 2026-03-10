#!/usr/bin/env npx tsx
/**
 * Route testing script — loads PBOT data, computes guided routes via BRouter,
 * classifies segments, and reports grey segments + backtracking.
 *
 * Usage: npx tsx scripts/test-routes.ts
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// ---- Import core modules (they have no DOM/Leaflet dependencies in the
//      functions we need, but we need to handle the imports carefully) ----

// We'll directly import from geo.ts and pbot-graph.ts since they're pure logic.
// For BRouter calls we use fetch (available in Node 18+).

import { haversine, computeDistance } from '../src/geo.js';
import { buildGraph, findGuidedWaypoints, classifyRoute, isGraphReady, debugNearestEdge } from '../src/pbot-graph.js';
import type { InfraTier } from '../src/pbot-graph.js';
import { indexBusyRoads } from '../src/busy-roads.js';

// ---- Load data ----

const dataDir = join(import.meta.dirname, '..', 'public', 'data');

console.log('Loading PBOT routes...');
const pbotGeojson = JSON.parse(readFileSync(join(dataDir, 'pbot-routes.geojson'), 'utf-8'));

console.log('Loading busy roads...');
const busyGeojson = JSON.parse(readFileSync(join(dataDir, 'busy-roads.geojson'), 'utf-8'));

console.log('Indexing busy roads...');
indexBusyRoads(busyGeojson);

console.log('Building graph...');
buildGraph(pbotGeojson);
console.log(`Graph ready: ${isGraphReady()}`);

// ---- BRouter API ----

interface Waypoint { lat: number; lng: number; }

async function brouterRoute(waypoints: Waypoint[], profile = 'fastbike-verylowtraffic'): Promise<{
  coords: [number, number][];
  distance: number;
}> {
  const lonlats = waypoints.map(w => `${w.lng},${w.lat}`).join('|');
  const params = new URLSearchParams({
    lonlats,
    profile,
    alternativeidx: '0',
    format: 'geojson',
  });

  const res = await fetch(`https://brouter.de/brouter?${params}`);
  if (!res.ok) throw new Error(`BRouter error: ${res.status}`);
  const geojson = await res.json();
  const feature = geojson.features[0];
  if (!feature) throw new Error('No route found');

  const coords: [number, number][] = feature.geometry.coordinates.map(
    (c: number[]) => [c[1], c[0]] as [number, number]
  );
  const distance = parseFloat(feature.properties['track-length']) || computeDistance(coords);
  return { coords, distance };
}

// ---- Analysis helpers ----

function analyzeTiers(tiers: InfraTier[]): Record<InfraTier, number> {
  const counts: Record<string, number> = {};
  for (const t of tiers) counts[t] = (counts[t] || 0) + 1;
  return counts as Record<InfraTier, number>;
}

function findGreySegments(coords: [number, number][], tiers: InfraTier[]): { start: number; end: number; length: number }[] {
  const segments: { start: number; end: number; length: number }[] = [];
  let segStart = -1;
  for (let i = 0; i < tiers.length; i++) {
    if (tiers[i] === 'none') {
      if (segStart === -1) segStart = i;
    } else {
      if (segStart !== -1) {
        let length = 0;
        for (let j = segStart; j < i; j++) length += haversine(coords[j], coords[j + 1] || coords[j]);
        segments.push({ start: segStart, end: i - 1, length });
        segStart = -1;
      }
    }
  }
  if (segStart !== -1) {
    let length = 0;
    for (let j = segStart; j < tiers.length - 1; j++) length += haversine(coords[j], coords[j + 1]);
    segments.push({ start: segStart, end: tiers.length - 1, length });
  }
  return segments;
}

function detectBacktracking(coords: [number, number][]): { idx: number; bearing1: number; bearing2: number; diff: number }[] {
  if (coords.length < 3) return [];

  const toRad = (deg: number) => deg * Math.PI / 180;
  function bearing(a: [number, number], b: [number, number]): number {
    const dLng = toRad(b[1] - a[1]);
    const y = Math.sin(dLng) * Math.cos(toRad(b[0]));
    const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0]))
            - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(dLng);
    return Math.atan2(y, x) * 180 / Math.PI;
  }

  const samples: { bearing: number; idx: number }[] = [];
  let accumDist = 0;
  let lastSampleIdx = 0;
  for (let i = 1; i < coords.length; i++) {
    accumDist += haversine(coords[i - 1], coords[i]);
    if (accumDist >= 100 || i === coords.length - 1) {
      samples.push({ bearing: bearing(coords[lastSampleIdx], coords[i]), idx: i });
      accumDist = 0;
      lastSampleIdx = i;
    }
  }

  const reversals: { idx: number; bearing1: number; bearing2: number; diff: number }[] = [];
  for (let i = 1; i < samples.length; i++) {
    let diff = Math.abs(samples[i].bearing - samples[i - 1].bearing);
    if (diff > 180) diff = 360 - diff;
    if (diff > 120) {
      reversals.push({
        idx: samples[i].idx,
        bearing1: samples[i - 1].bearing,
        bearing2: samples[i].bearing,
        diff,
      });
    }
  }
  return reversals;
}

function checkRiverCrossings(coords: [number, number][]): { idx: number; lat: number; lng: number; direction: string }[] {
  // The Willamette River in Portland runs roughly at lng ≈ -122.667
  // Detect when the route crosses this longitude
  const RIVER_LNG = -122.667;
  const crossings: { idx: number; lat: number; lng: number; direction: string }[] = [];

  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1][1]; // lng
    const curr = coords[i][1];
    if ((prev < RIVER_LNG && curr > RIVER_LNG) || (prev > RIVER_LNG && curr < RIVER_LNG)) {
      const direction = curr < prev ? 'westbound' : 'eastbound';
      crossings.push({ idx: i, lat: coords[i][0], lng: coords[i][1], direction });
    }
  }
  return crossings;
}

// ---- Test cases ----

interface TestCase {
  name: string;
  start: Waypoint;
  end: Waypoint;
  expectations?: string[];
}

const TEST_CASES: TestCase[] = [
  {
    name: '431 NE Cook St → Sellwood Park',
    start: { lat: 45.5347, lng: -122.6585 },
    end: { lat: 45.4623, lng: -122.6530 },
    expectations: [
      'Should use Vera Katz Eastbank Esplanade (no unnecessary river crossings)',
      'Should use Springwater Corridor (green, not grey)',
    ],
  },
  {
    name: 'NW 23rd & Lovejoy → Springwater near OMSI',
    start: { lat: 45.5299, lng: -122.6985 },
    end: { lat: 45.5050, lng: -122.6655 },
    expectations: ['Should not backtrack north after heading south'],
  },
  {
    name: 'Springwater Corridor traverse (OMSI → Sellwood)',
    start: { lat: 45.5057, lng: -122.6658 },
    end: { lat: 45.4700, lng: -122.6480 },
    expectations: ['Almost entirely green (MUP path segments)', 'Minimal grey segments'],
  },
];

// ---- Run tests ----

async function runTest(tc: TestCase): Promise<void> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`TEST: ${tc.name}`);
  console.log(`  Start: ${tc.start.lat}, ${tc.start.lng}`);
  console.log(`  End:   ${tc.end.lat}, ${tc.end.lng}`);
  if (tc.expectations) {
    for (const e of tc.expectations) console.log(`  Expected: ${e}`);
  }
  console.log('-'.repeat(70));

  // Step 1: Find guided waypoints
  const guided = findGuidedWaypoints(tc.start.lat, tc.start.lng, tc.end.lat, tc.end.lng, 'safest');
  console.log(`\nGuided waypoints: ${guided ? guided.length : 'null (fallback to direct)'}`);
  if (guided) {
    for (const wp of guided) {
      console.log(`  (${wp.lat.toFixed(5)}, ${wp.lng.toFixed(5)})`);
    }
  }

  // Step 2: Call BRouter
  const waypoints: Waypoint[] = [
    tc.start,
    ...(guided || []),
    tc.end,
  ];

  try {
    const result = await brouterRoute(waypoints);
    console.log(`\nBRouter result: ${result.coords.length} coords, ${(result.distance / 1609.34).toFixed(2)} mi`);

    // Step 3: Classify
    const tiers = classifyRoute(result.coords);
    const tierCounts = analyzeTiers(tiers);
    const total = tiers.length;

    console.log('\nTier distribution:');
    for (const [tier, count] of Object.entries(tierCounts).sort((a, b) => b[1] - a[1])) {
      const pct = ((count / total) * 100).toFixed(1);
      const bar = '#'.repeat(Math.round(count / total * 40));
      console.log(`  ${tier.padEnd(8)} ${String(count).padStart(5)} (${pct.padStart(5)}%) ${bar}`);
    }

    // Step 4: Grey segments with nearest-edge diagnostics
    const greySegs = findGreySegments(result.coords, tiers);
    if (greySegs.length > 0) {
      console.log(`\nGrey segments (${greySegs.length}):`);
      for (const seg of greySegs.filter(s => s.length > 20)) {
        const startCoord = result.coords[seg.start];
        const endCoord = result.coords[seg.end];
        console.log(`  coords[${seg.start}..${seg.end}] ${seg.length.toFixed(0)}m  (${startCoord[0].toFixed(5)},${startCoord[1].toFixed(5)}) → (${endCoord[0].toFixed(5)},${endCoord[1].toFixed(5)})`);
        // Sample a few points in the grey segment to check nearest PBOT edge
        const samplePoints = [seg.start, Math.floor((seg.start + seg.end) / 2), seg.end];
        for (const idx of samplePoints) {
          const coord = result.coords[idx];
          const nearest = debugNearestEdge(coord[0], coord[1]);
          if (nearest) {
            console.log(`    [${idx}] nearest PBOT edge: ${nearest.dist.toFixed(1)}m away, type=${nearest.ct} (${nearest.tier})`);
          } else {
            console.log(`    [${idx}] no PBOT edge found within 550m`);
          }
        }
      }
    } else {
      console.log('\nNo grey segments!');
    }

    // Step 5: Backtracking
    const reversals = detectBacktracking(result.coords);
    if (reversals.length > 0) {
      console.log(`\nBearing reversals (${reversals.length}):`);
      for (const r of reversals) {
        const coord = result.coords[r.idx];
        console.log(`  coord[${r.idx}] ${r.diff.toFixed(0)}° reversal at (${coord[0].toFixed(5)},${coord[1].toFixed(5)})`);
      }
    } else {
      console.log('\nNo bearing reversals detected.');
    }

    // Step 6: River crossings
    const crossings = checkRiverCrossings(result.coords);
    if (crossings.length > 0) {
      console.log(`\nRiver crossings (${crossings.length}):`);
      for (const c of crossings) {
        console.log(`  coord[${c.idx}] ${c.direction} at (${c.lat.toFixed(5)},${c.lng.toFixed(5)})`);
      }
    } else {
      console.log('\nNo river crossings.');
    }

  } catch (err) {
    console.error(`  ERROR: ${err instanceof Error ? err.message : err}`);
  }
}

async function main() {
  console.log('PedalPDX Route Test Suite');
  console.log('========================\n');

  for (const tc of TEST_CASES) {
    await runTest(tc);
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('Done.');
}

main().catch(console.error);
