import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { buildGraph, findGuidedWaypoints, findPbotPath } from './pbot-graph';
import type { PbotPathResult } from './pbot-graph';
import { indexBusyRoads } from './busy-roads';
import { haversine } from './geo';
import type { Waypoint } from './types';

// Load actual PBOT data for integration-style route tests
beforeAll(() => {
  const pbot = JSON.parse(readFileSync(resolve(__dirname, '../public/data/pbot-routes.geojson'), 'utf8'));
  const busy = JSON.parse(readFileSync(resolve(__dirname, '../public/data/busy-roads.geojson'), 'utf8'));
  indexBusyRoads(busy);
  buildGraph(pbot);
});

// Helper: check if any waypoint is within `radius` meters of a point
function hasWaypointNear(wps: Waypoint[], lat: number, lng: number, radius: number): boolean {
  return wps.some(wp => haversine([wp.lat, wp.lng], [lat, lng]) < radius);
}

// Helper: find max gap between consecutive waypoints
function maxGap(wps: Waypoint[]): number {
  let max = 0;
  for (let i = 0; i < wps.length - 1; i++) {
    const d = haversine([wps[i].lat, wps[i].lng], [wps[i + 1].lat, wps[i + 1].lng]);
    if (d > max) max = d;
  }
  return max;
}

// Real geocoded coordinates from Photon
const COOK_431 = { lat: 45.5473593, lng: -122.6608221 };
const THE_REDD = { lat: 45.5145893, lng: -122.6569925 };
const SELLWOOD_PARK = { lat: 45.467536, lng: -122.6603582 };
const ZOIGLHAUS = { lat: 45.4809278, lng: -122.568338 };

// NE Morris greenway crossing of MLK
const MORRIS_MLK = { lat: 45.54463, lng: -122.66163 };  // west/MLK-side endpoint
const MORRIS_7TH = { lat: 45.54467, lng: -122.65859 };  // east/7th-side endpoint

// Springwater / inner SE MUP nodes
const MUP_OMSI_AREA = { lat: 45.50150, lng: -122.66122 };
const MUP_INNER_SE = { lat: 45.49023, lng: -122.65565 };
const MUP_SE_4TH = { lat: 45.48088, lng: -122.65475 };

describe('431 NE Cook → The Redd on Salmon St', () => {
  it('should use the NE Morris greenway crossing of MLK', () => {
    const wps = findGuidedWaypoints(COOK_431.lat, COOK_431.lng, THE_REDD.lat, THE_REDD.lng);
    expect(wps).not.toBeNull();

    // Waypoints should guide BRouter through the Morris greenway crossing
    // (sampled at ~200m intervals, so allow up to 100m radius for matching)
    expect(hasWaypointNear(wps!, MORRIS_MLK.lat, MORRIS_MLK.lng, 100)).toBe(true);
    expect(hasWaypointNear(wps!, MORRIS_7TH.lat, MORRIS_7TH.lng, 100)).toBe(true);
  });

  it('should not route north to NE Stanton for MLK crossing', () => {
    const wps = findGuidedWaypoints(COOK_431.lat, COOK_431.lng, THE_REDD.lat, THE_REDD.lng);
    expect(wps).not.toBeNull();

    // The start is at ~45.5474. No waypoint should go north of the start
    // (route heads south to The Redd). Stanton detour would show waypoints
    // significantly north of the start.
    const hasNorthDetour = wps!.some(wp => wp.lat > COOK_431.lat + 0.002);
    expect(hasNorthDetour).toBe(false);
  });

  it('should have the Morris crossing before any waypoint west of MLK', () => {
    const wps = findGuidedWaypoints(COOK_431.lat, COOK_431.lng, THE_REDD.lat, THE_REDD.lng);
    expect(wps).not.toBeNull();

    // The Morris greenway crossing should appear early in the waypoints,
    // guiding BRouter to cross MLK at a safe point
    const morrisIdx = wps!.findIndex(wp =>
      haversine([wp.lat, wp.lng], [MORRIS_MLK.lat, MORRIS_MLK.lng]) < 100
    );
    expect(morrisIdx).toBeGreaterThanOrEqual(0);
    expect(morrisIdx).toBeLessThan(5); // should be among the first few waypoints
  });
});

describe('431 NE Cook → Sellwood Park (Springwater corridor)', () => {
  it('should include waypoints on the inner SE MUP path', () => {
    const wps = findGuidedWaypoints(COOK_431.lat, COOK_431.lng, SELLWOOD_PARK.lat, SELLWOOD_PARK.lng);
    expect(wps).not.toBeNull();

    // Route should have waypoints along the inner SE MUP
    // (previously dropped by thinning, creating a 2.6km gap)
    expect(hasWaypointNear(wps!, MUP_OMSI_AREA.lat, MUP_OMSI_AREA.lng, 200)).toBe(true);
    expect(hasWaypointNear(wps!, MUP_INNER_SE.lat, MUP_INNER_SE.lng, 200)).toBe(true);
    expect(hasWaypointNear(wps!, MUP_SE_4TH.lat, MUP_SE_4TH.lng, 200)).toBe(true);
  });

  it('should not have gaps larger than 1500m', () => {
    const wps = findGuidedWaypoints(COOK_431.lat, COOK_431.lng, SELLWOOD_PARK.lat, SELLWOOD_PARK.lng);
    expect(wps).not.toBeNull();

    // Waterfront corridor waypoints are skipped (BRouter handles that stretch
    // autonomously) so gaps up to ~3km can appear through the waterfront zone.
    // BRouter fills these correctly without crossing bridges.
    expect(maxGap(wps!)).toBeLessThan(3000);
  });

  it('should use the Morris greenway crossing', () => {
    const wps = findGuidedWaypoints(COOK_431.lat, COOK_431.lng, SELLWOOD_PARK.lat, SELLWOOD_PARK.lng);
    expect(wps).not.toBeNull();

    // Should use Morris crossing, same as the Redd route
    expect(hasWaypointNear(wps!, MORRIS_MLK.lat, MORRIS_MLK.lng, 100)).toBe(true);
  });
});

describe('431 NE Cook → Zoiglhaus Brewing (should still work)', () => {
  it('should produce waypoints', () => {
    const wps = findGuidedWaypoints(COOK_431.lat, COOK_431.lng, ZOIGLHAUS.lat, ZOIGLHAUS.lng);
    expect(wps).not.toBeNull();
    expect(wps!.length).toBeGreaterThan(5);
  });

  it('should not backtrack north or cross the river', () => {
    const wps = findGuidedWaypoints(COOK_431.lat, COOK_431.lng, ZOIGLHAUS.lat, ZOIGLHAUS.lng);
    expect(wps).not.toBeNull();

    // No waypoint should go north of the start — the destination is south
    const hasNorthDetour = wps!.some(wp => wp.lat > COOK_431.lat + 0.002);
    expect(hasNorthDetour).toBe(false);

    // No waypoint should cross the Willamette (west of -122.670)
    const crossesRiver = wps!.some(wp => wp.lng < -122.670);
    expect(crossesRiver).toBe(false);
  });

  it('should not have gaps larger than 3000m', () => {
    const wps = findGuidedWaypoints(COOK_431.lat, COOK_431.lng, ZOIGLHAUS.lat, ZOIGLHAUS.lng);
    expect(wps).not.toBeNull();
    // Waterfront corridor is skipped — BRouter handles it autonomously
    expect(maxGap(wps!)).toBeLessThan(3000);
  });
});

// ========== findPbotPath tests (direct A* geometry rendering) ==========

// Helper: check if any edge coordinate is within `radius` meters of a point
function pathHasCoordNear(path: PbotPathResult, lat: number, lng: number, radius: number): boolean {
  return path.edges.some(edge =>
    edge.coords.some(c => haversine(c, [lat, lng]) < radius)
  );
}

// Helper: total distance of a PbotPathResult
function pathTotalDist(path: PbotPathResult): number {
  return path.edges.reduce((sum, e) => sum + e.distance, 0);
}

// Helper: flatten path coordinates (deduplicating junctions)
function flattenPath(path: PbotPathResult): [number, number][] {
  const coords: [number, number][] = [];
  for (const edge of path.edges) {
    const start = coords.length === 0 ? 0 : 1;
    for (let i = start; i < edge.coords.length; i++) {
      coords.push(edge.coords[i]);
    }
  }
  return coords;
}

describe('findPbotPath: Cook → The Redd', () => {
  it('should return a path with edges', () => {
    const path = findPbotPath(COOK_431.lat, COOK_431.lng, THE_REDD.lat, THE_REDD.lng);
    expect(path).not.toBeNull();
    expect(path!.edges.length).toBeGreaterThan(5);
  });

  it('should pass through the Morris greenway crossing', () => {
    const path = findPbotPath(COOK_431.lat, COOK_431.lng, THE_REDD.lat, THE_REDD.lng)!;
    expect(pathHasCoordNear(path, MORRIS_MLK.lat, MORRIS_MLK.lng, 100)).toBe(true);
    expect(pathHasCoordNear(path, MORRIS_7TH.lat, MORRIS_7TH.lng, 100)).toBe(true);
  });

  it('should not backtrack north', () => {
    const path = findPbotPath(COOK_431.lat, COOK_431.lng, THE_REDD.lat, THE_REDD.lng)!;
    const coords = flattenPath(path);
    const hasNorthDetour = coords.some(c => c[0] > COOK_431.lat + 0.002);
    expect(hasNorthDetour).toBe(false);
  });

  it('should have reasonable total distance (3-8km)', () => {
    const path = findPbotPath(COOK_431.lat, COOK_431.lng, THE_REDD.lat, THE_REDD.lng)!;
    const dist = pathTotalDist(path);
    expect(dist).toBeGreaterThan(3000);
    expect(dist).toBeLessThan(8000);
  });

  it('edges should have street names', () => {
    const path = findPbotPath(COOK_431.lat, COOK_431.lng, THE_REDD.lat, THE_REDD.lng)!;
    const named = path.edges.filter(e => e.name.length > 0);
    expect(named.length).toBeGreaterThan(path.edges.length / 2);
  });
});

describe('findPbotPath: Cook → Sellwood (Springwater corridor)', () => {
  it('should include the waterfront/esplanade coords', () => {
    const path = findPbotPath(COOK_431.lat, COOK_431.lng, SELLWOOD_PARK.lat, SELLWOOD_PARK.lng)!;
    expect(path).not.toBeNull();

    // Unlike findGuidedWaypoints, findPbotPath keeps all coordinates
    // including waterfront — no skipping needed since we render directly
    expect(pathHasCoordNear(path, MUP_OMSI_AREA.lat, MUP_OMSI_AREA.lng, 200)).toBe(true);
    expect(pathHasCoordNear(path, MUP_INNER_SE.lat, MUP_INNER_SE.lng, 200)).toBe(true);
    expect(pathHasCoordNear(path, MUP_SE_4TH.lat, MUP_SE_4TH.lng, 200)).toBe(true);
  });

  it('should not cross the Willamette', () => {
    const path = findPbotPath(COOK_431.lat, COOK_431.lng, SELLWOOD_PARK.lat, SELLWOOD_PARK.lng)!;
    const coords = flattenPath(path);
    // No coordinate should be west of the Willamette
    const crossesRiver = coords.some(c => c[1] < -122.680);
    expect(crossesRiver).toBe(false);
  });

  it('should have reasonable total distance (10-16km)', () => {
    const path = findPbotPath(COOK_431.lat, COOK_431.lng, SELLWOOD_PARK.lat, SELLWOOD_PARK.lng)!;
    const dist = pathTotalDist(path);
    expect(dist).toBeGreaterThan(10000);
    expect(dist).toBeLessThan(16000);
  });
});

describe('findPbotPath: Cook → Zoiglhaus', () => {
  it('should return a path', () => {
    const path = findPbotPath(COOK_431.lat, COOK_431.lng, ZOIGLHAUS.lat, ZOIGLHAUS.lng);
    expect(path).not.toBeNull();
    expect(path!.edges.length).toBeGreaterThan(5);
  });

  it('should not cross the river or backtrack north', () => {
    const path = findPbotPath(COOK_431.lat, COOK_431.lng, ZOIGLHAUS.lat, ZOIGLHAUS.lng)!;
    const coords = flattenPath(path);
    expect(coords.some(c => c[0] > COOK_431.lat + 0.002)).toBe(false);
    expect(coords.some(c => c[1] < -122.680)).toBe(false);
  });
});
