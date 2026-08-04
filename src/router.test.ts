// Offline tests for the full safest-mode routing pipeline (PBOT A* + gap
// resolution + first/last-mile stitching) using recorded BRouter fixtures.
// If a test fails with "Missing BRouter fixture", re-record:
//   npx tsx scripts/record-brouter-fixtures.ts

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { LatLng } from 'leaflet';
import { buildGraph, classifyRoute } from './pbot-graph';
import { indexBusyRoads } from './busy-roads';
import {
  computeGuidedRoute,
  setRouteProfile,
  setBRouterFetcher,
  cleanEdgeName,
} from './router';
import type { RouteResult } from './types';
import { haversine, computeDistance } from './geo';
import { SCENARIOS, FIXTURES_PATH, fixtureKey } from './route-scenarios';
import type { RouteScenario } from './route-scenarios';

// Fixture misses inside computeGuidedRoute are swallowed by its internal
// .catch(() => null) fallbacks, so we track them and assert none occurred —
// otherwise a stale fixture set would silently produce degraded routes.
let fixtureMisses: string[] = [];

beforeAll(() => {
  const pbot = JSON.parse(readFileSync(resolve(__dirname, '../public/data/pbot-routes.geojson'), 'utf8'));
  const busy = JSON.parse(readFileSync(resolve(__dirname, '../public/data/busy-roads.geojson'), 'utf8'));
  indexBusyRoads(busy);
  buildGraph(pbot);

  const fixtures = JSON.parse(readFileSync(resolve(__dirname, '..', FIXTURES_PATH), 'utf8'));
  setBRouterFetcher(async (lonlats, profile) => {
    const key = fixtureKey(profile, lonlats);
    const feature = fixtures[key];
    if (!feature) {
      fixtureMisses.push(key);
      throw new Error(`Missing BRouter fixture: ${key} — run: npx tsx scripts/record-brouter-fixtures.ts`);
    }
    return feature;
  });
});

beforeEach(() => {
  fixtureMisses = [];
});

async function computeScenario(scenario: RouteScenario): Promise<RouteResult> {
  setRouteProfile(scenario.profile);
  const route = await computeGuidedRoute(scenario.from as LatLng, scenario.to as LatLng);
  expect(fixtureMisses, 'stale fixtures — re-record with: npx tsx scripts/record-brouter-fixtures.ts').toEqual([]);
  return route;
}

const safestScenarios = SCENARIOS.filter(s => s.profile === 'safest');

describe.each(safestScenarios)('computeGuidedRoute: $name', (scenario) => {
  it('uses the PBOT network (not BRouter fallback)', async () => {
    const route = await computeScenario(scenario);
    expect(route.debug?.source).toBe('pbot+brouter');
  });

  it('starts and ends near the requested points', async () => {
    const route = await computeScenario(scenario);
    const first = route.coordinates[0];
    const last = route.coordinates[route.coordinates.length - 1];
    expect(haversine(first, [scenario.from.lat, scenario.from.lng])).toBeLessThan(150);
    expect(haversine(last, [scenario.to.lat, scenario.to.lng])).toBeLessThan(150);
  });

  it('is continuous where BRouter sections are stitched to the PBOT core', async () => {
    const route = await computeScenario(scenario);
    // Note: consecutive-point spacing elsewhere can legitimately reach ~500m —
    // PBOT geometry is simplified at fetch time, so straight runs are sparse.
    // The stitch boundaries are where disconnects would indicate real bugs.
    // BRouter snaps endpoints to the nearest OSM way, so a hop of tens of
    // meters at a junction is expected; over ~100m (SNAP_THRESHOLD) means a
    // genuinely degraded stitch.
    for (const b of route.debug!.sectionBoundaries) {
      const gap = haversine(route.coordinates[b - 1], route.coordinates[b]);
      expect(gap, `stitch boundary at coord index ${b}`).toBeLessThan(100);
    }
  });

  it('has no catastrophic geometry disconnects', async () => {
    const route = await computeScenario(scenario);
    let maxGap = 0;
    for (let i = 1; i < route.coordinates.length; i++) {
      maxGap = Math.max(maxGap, haversine(route.coordinates[i - 1], route.coordinates[i]));
    }
    // Fetch-time simplification leaves straight trail runs with vertices up
    // to ~800m apart (e.g. Springwater east of Johnson Creek), so this only
    // guards against true disconnects (route jumping across town).
    expect(maxGap).toBeLessThan(1000);
  });

  it('reports distance consistent with its geometry', async () => {
    const route = await computeScenario(scenario);
    const geomDist = computeDistance(route.coordinates);
    expect(Math.abs(route.distance - geomDist) / geomDist).toBeLessThan(0.15);
  });

  it('has one elevation entry per coordinate', async () => {
    const route = await computeScenario(scenario);
    expect(route.elevations.length).toBe(route.coordinates.length);
  });

  it('does not detour absurdly', async () => {
    const route = await computeScenario(scenario);
    const straight = haversine([scenario.from.lat, scenario.from.lng], [scenario.to.lat, scenario.to.lng]);
    // Observed ratios across the corpus: 1.17–2.09 (max = Springwater-heavy
    // Zoiglhaus route, a deliberate bike-path detour)
    expect(route.distance / straight).toBeLessThan(2.3);
    expect(route.distance).toBeGreaterThan(straight * 0.95);
  });

  it('spends most of the ride on real bike infrastructure', async () => {
    const route = await computeScenario(scenario);
    const tiers = classifyRoute(route.coordinates);
    const share = (want: string[]) =>
      tiers.filter(t => want.includes(t)).length / tiers.length;
    // Observed: 80–98% on path/good/lane, ≤10% on caution/avoid
    expect(share(['path', 'good', 'lane'])).toBeGreaterThan(0.7);
    expect(share(['caution', 'avoid'])).toBeLessThan(0.12);
  });

  it('has well-formed instructions', async () => {
    const route = await computeScenario(scenario);
    const inst = route.instructions;
    expect(inst.length).toBeGreaterThanOrEqual(2);
    expect(inst[0].icon).toBe('start');
    expect(inst[inst.length - 1].icon).toBe('arrive');

    // Cumulative distances are monotonically non-decreasing and within the route
    for (let i = 1; i < inst.length; i++) {
      expect(inst[i].distance).toBeGreaterThanOrEqual(inst[i - 1].distance);
    }
    expect(inst[inst.length - 1].distance).toBeLessThanOrEqual(route.distance * 1.05);

    // No freeway/ramp names leak into directions
    for (const step of inst) {
      expect(step.text).not.toMatch(/FWY|RAMP/i);
    }
  });
});

describe('computeGuidedRoute: balanced profile (pure BRouter)', () => {
  const scenario = SCENARIOS.find(s => s.name === 'cook-to-redd-balanced')!;

  it('parses the BRouter response into a complete route', async () => {
    const route = await computeScenario(scenario);
    expect(route.debug?.source).toBe('brouter');
    expect(route.distance).toBeGreaterThan(3000);
    expect(route.time).toBeGreaterThan(0);
    expect(route.hasElevation).toBe(true);
    expect(route.elevations.length).toBe(route.coordinates.length);
    expect(route.coordinates.length).toBeGreaterThan(50);
  });

  it('produces real turn-by-turn instructions from voicehints', async () => {
    const route = await computeScenario(scenario);
    // Regression guard: without timode=2 voicehints, a 2.6mi urban route
    // yielded only start + arrive — useless for riding
    expect(route.instructions.length).toBeGreaterThan(8);
    const turns = route.instructions.filter(i => i.icon === 'turn-left' || i.icon === 'turn-right');
    expect(turns.length).toBeGreaterThan(4);
    // Monotonic cumulative distances within route bounds
    for (let i = 1; i < route.instructions.length; i++) {
      expect(route.instructions[i].distance).toBeGreaterThanOrEqual(route.instructions[i - 1].distance);
    }
    expect(route.instructions[0].icon).toBe('start');
    expect(route.instructions.at(-1)!.icon).toBe('arrive');
  });
});

// cleanEdgeName is exercised against live paths in pbot-graph.test.ts; these
// are pure unit cases (previously duplicated there — now imported directly).
describe('cleanEdgeName', () => {
  it('filters freeway and ramp names', () => {
    expect(cleanEdgeName('I5 FWY SB')).toBe('');
    expect(cleanEdgeName('N I5 FWY-MARINE DR RAMP')).toBe('');
    expect(cleanEdgeName('SE HAWTHORNE BRG-HAWTHORNE BLVD RAMP')).toBe('');
  });

  it('simplifies MUP and corridor names', () => {
    expect(cleanEdgeName('SE I205 MULTIUSE PATH')).toBe('I-205 Path');
    expect(cleanEdgeName('SE SPRINGWATER CORRIDOR MULTIUSE TRAIL')).toBe('Springwater Corridor');
  });

  it('title-cases street names, keeping directional prefixes uppercase', () => {
    expect(cleanEdgeName('NE KLICKITAT ST')).toBe('NE Klickitat ST');
    expect(cleanEdgeName('SE WHEELER AVE')).toMatch(/^SE /);
  });
});
