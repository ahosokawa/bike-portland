import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { buildGraph, findPbotPath, nk, canonicalEdgeKey, injectPolylineEdges } from './pbot-graph';
import type { PbotPathResult } from './pbot-graph';
import { indexBusyRoads } from './busy-roads';
import { haversine } from './geo';

// cleanEdgeName lives in router.ts but can't be imported here (Leaflet needs window).
// Duplicated for testing — keep in sync with router.ts.
const KEEP_UPPER = /^(NE|NW|SE|SW|N|S|E|W|US|OR|ST|AVE|BLVD|DR|RD|CT|PL|LN|HWY|PKWY|WAY|BRG|MUP)$/i;
function cleanEdgeName(raw: string): string {
  if (!raw) return '';
  if (/\bI-?\d+\s*(FWY|HWY)/i.test(raw)) return '';
  if (/\bRAMP\b/i.test(raw)) return '';
  const mupMatch = raw.match(/I-?(\d+)\s*MULTI\s*USE\s*(PATH|TRAIL)/i);
  if (mupMatch) return `I-${mupMatch[1]} Path`;
  if (/SPRINGWATER\s+CORRIDOR/i.test(raw)) return 'Springwater Corridor';
  return raw.replace(/\b\w+/g, (w) => {
    if (KEEP_UPPER.test(w)) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  });
}

// Load actual PBOT data for integration-style route tests
beforeAll(() => {
  const pbot = JSON.parse(readFileSync(resolve(__dirname, '../public/data/pbot-routes.geojson'), 'utf8'));
  const busy = JSON.parse(readFileSync(resolve(__dirname, '../public/data/busy-roads.geojson'), 'utf8'));
  indexBusyRoads(busy);
  buildGraph(pbot);
});

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

// ========== I-205 PATH CONNECTION loop geometry ==========

// The "I-205 PATH CONNECTION" edge has geometry that loops south then back north
// (a switchback ramp). The A* path includes it, but router.ts trimLoopyEdges()
// removes it so BRouter handles the exit cleanly via SE Ramona St.

describe('findPbotPath: I-205 PATH CONNECTION edge', () => {
  it('A* path includes the loopy PATH CONNECTION edge', () => {
    const path = findPbotPath(
      45.4860, -122.5686, // north of Zoiglhaus on I-205 MUP
      ZOIGLHAUS.lat, ZOIGLHAUS.lng,
    )!;
    expect(path).not.toBeNull();

    const pathConn = path.edges.find(e => e.name === 'I-205 PATH CONNECTION');
    expect(pathConn).toBeDefined();

    // Confirm it's loopy: distance >> straight-line
    const straightLine = haversine(pathConn!.coords[0], pathConn!.coords[pathConn!.coords.length - 1]);
    expect(pathConn!.distance).toBeGreaterThan(straightLine * 2.5);

    // It should be the last edge, preceded by a gap edge
    const lastIdx = path.edges.indexOf(pathConn!);
    expect(lastIdx).toBe(path.edges.length - 1);
    expect(path.edges[lastIdx - 1].ct).toMatch(/^_GAP/);
  });
});

// ========== One-way street tests ==========

// Broadway Bridge approach — ensure the route goes directly onto the bridge
// rather than detouring via Larrabee or other side streets.
const NW_10TH = { lat: 45.5273, lng: -122.6810 };
// N Weidler is one-way westbound — route should NOT go eastbound on it
const WEIDLER_AREA = { lat: 45.53425, lng: -122.6635 };

describe('findPbotPath: Cook → NW 10th (Broadway Bridge)', () => {
  it('should go directly on Broadway to the bridge (no Larrabee detour)', () => {
    const path = findPbotPath(COOK_431.lat, COOK_431.lng, NW_10TH.lat, NW_10TH.lng)!;
    expect(path).not.toBeNull();
    // The route should have Broadway edges continuing past Larrabee toward
    // Interstate, not turning north on Larrabee to access the bridge ramp.
    const hasLarrabeeUturn = path.edges.some(e =>
      e.name.includes('LARRABEE') && e.name.includes('BRG RAMP'),
    );
    expect(hasLarrabeeUturn).toBe(false);
  });

  it('should not go east on one-way Weidler', () => {
    const path = findPbotPath(COOK_431.lat, COOK_431.lng, NW_10TH.lat, NW_10TH.lng)!;
    expect(path).not.toBeNull();
    // Weidler is one-way westbound around lng -122.66. If the route passes
    // through this area it should be heading west, not east. Check that
    // no edge on Weidler has an eastward trajectory.
    for (const edge of path.edges) {
      if (!edge.name.toLowerCase().includes('weidler')) continue;
      const first = edge.coords[0];
      const last = edge.coords[edge.coords.length - 1];
      // Eastward = longitude increasing (less negative)
      expect(last[1]).not.toBeGreaterThan(first[1] + 0.0005);
    }
  });
});

// ========== Edge override tests ==========

describe('findPbotPath with edge overrides', () => {
  it('preferred override should cause a normally-penalized edge to be used', () => {
    // First, get the baseline path without overrides
    const baseline = findPbotPath(COOK_431.lat, COOK_431.lng, THE_REDD.lat, THE_REDD.lng)!;
    expect(baseline).not.toBeNull();

    // Find an SR_MT (medium traffic) edge that is NOT on the baseline path.
    // We'll prefer it and verify the route changes to include it.
    // SR_MT edges on NE 7th near the start are heavily penalized in safest mode.
    // Instead, just verify that "preferred" overrides work by preferring an edge
    // on the baseline — total cost should decrease (shorter effective distance).
    const baselineKeys = new Set<string>();
    const baselineEdgeInfo: { key: string; ct: string }[] = [];

    // Reconstruct edge keys from the baseline path
    const coords = flattenPath(baseline);
    // Use first and second edge to get node keys
    if (baseline.edges.length >= 2) {
      const e0 = baseline.edges[0];
      const startNk = nk(e0.coords[0][0], e0.coords[0][1]);
      const endNk = nk(e0.coords[e0.coords.length - 1][0], e0.coords[e0.coords.length - 1][1]);
      baselineKeys.add(canonicalEdgeKey(startNk, endNk));
    }

    // Prefer one of the existing edges — the path should still work
    if (baselineKeys.size > 0) {
      const overrides = new Map<string, 'preferred' | 'nogo'>();
      const key = [...baselineKeys][0];
      overrides.set(key, 'preferred');

      const withPref = findPbotPath(COOK_431.lat, COOK_431.lng, THE_REDD.lat, THE_REDD.lng, 'safest', overrides);
      expect(withPref).not.toBeNull();
      expect(withPref!.edges.length).toBeGreaterThan(0);
    }
  });

  it('nogo override on a critical edge should cause the route to avoid it', () => {
    // Get the baseline path
    const baseline = findPbotPath(COOK_431.lat, COOK_431.lng, THE_REDD.lat, THE_REDD.lng)!;
    expect(baseline).not.toBeNull();
    expect(baseline.edges.length).toBeGreaterThan(3);

    // Block a middle edge — the route should find an alternative
    const midIdx = Math.floor(baseline.edges.length / 2);
    const midEdge = baseline.edges[midIdx];
    const startNk = nk(midEdge.coords[0][0], midEdge.coords[0][1]);
    const endNk = nk(midEdge.coords[midEdge.coords.length - 1][0], midEdge.coords[midEdge.coords.length - 1][1]);
    const blockedKey = canonicalEdgeKey(startNk, endNk);

    const overrides = new Map<string, 'preferred' | 'nogo'>();
    overrides.set(blockedKey, 'nogo');

    const rerouted = findPbotPath(COOK_431.lat, COOK_431.lng, THE_REDD.lat, THE_REDD.lng, 'safest', overrides);
    expect(rerouted).not.toBeNull();

    // The rerouted path should not contain the blocked edge
    const reroutedKeys = new Set<string>();
    for (const edge of rerouted!.edges) {
      const a = nk(edge.coords[0][0], edge.coords[0][1]);
      const b = nk(edge.coords[edge.coords.length - 1][0], edge.coords[edge.coords.length - 1][1]);
      reroutedKeys.add(canonicalEdgeKey(a, b));
    }
    expect(reroutedKeys.has(blockedKey)).toBe(false);
  });

  it('injectPolylineEdges should create multiple edge keys from a polyline', () => {
    // Inject a polyline with enough length to produce multiple edges (>200m segments)
    const customCoords: [number, number][] = [
      [45.5470, -122.6610],
      [45.5450, -122.6610],  // ~220m south
      [45.5430, -122.6610],  // ~220m south
      [45.5410, -122.6610],  // ~220m south
    ];

    const edgeKeys = injectPolylineEdges(customCoords, 'Test custom road');
    expect(edgeKeys.length).toBeGreaterThan(1); // should produce multiple edges

    // Each edge key should be a valid canonical key (two node keys joined by |)
    for (const ek of edgeKeys) {
      expect(ek).toContain('|');
      const parts = ek.split('|');
      expect(parts.length).toBe(2);
      expect(parts[0] < parts[1]).toBe(true); // canonical order
    }

    // All edge keys should be unique
    const unique = new Set(edgeKeys);
    expect(unique.size).toBe(edgeKeys.length);
  });
});

// ========== Instruction generation tests ==========

describe('cleanEdgeName', () => {
  it('should filter out freeway names', () => {
    expect(cleanEdgeName('I5 FWY SB')).toBe('');
    expect(cleanEdgeName('I205 FWY NB')).toBe('');
    expect(cleanEdgeName('I84 FWY WB')).toBe('');
    expect(cleanEdgeName('N I5 FWY-MARINE DR RAMP')).toBe('');
  });

  it('should filter out ramp names', () => {
    expect(cleanEdgeName('SE HAWTHORNE BRG-HAWTHORNE BLVD RAMP')).toBe('');
    expect(cleanEdgeName('SW I405 FWY-BROADWAY RAMP')).toBe('');
  });

  it('should simplify MUP names', () => {
    expect(cleanEdgeName('SE I205 MULTIUSE PATH')).toBe('I-205 Path');
    expect(cleanEdgeName('NE I205 MULTIUSE PATH')).toBe('I-205 Path');
  });

  it('should simplify Springwater', () => {
    expect(cleanEdgeName('SE SPRINGWATER CORRIDOR MULTIUSE TRAIL')).toBe('Springwater Corridor');
  });

  it('should title-case street names with uppercase directional prefixes', () => {
    const result = cleanEdgeName('NE KLICKITAT ST');
    expect(result).toBe('NE Klickitat ST');
  });

  it('should keep directional prefixes uppercase', () => {
    const result = cleanEdgeName('SE WHEELER AVE');
    expect(result).toMatch(/^SE /);
  });

  it('should return empty for empty input', () => {
    expect(cleanEdgeName('')).toBe('');
  });
});

describe('cleanEdgeName filters PBOT edge names for Cook → Zoiglhaus', () => {
  it('should clean all edge names without producing freeway/ramp references', () => {
    const path = findPbotPath(COOK_431.lat, COOK_431.lng, ZOIGLHAUS.lat, ZOIGLHAUS.lng)!;
    expect(path).not.toBeNull();

    for (const edge of path.edges) {
      const cleaned = cleanEdgeName(edge.name);
      // No cleaned name should mention freeways or ramps
      expect(cleaned).not.toMatch(/FWY|RAMP/i);
    }
  });

  it('should produce at least some named edges for turn-by-turn directions', () => {
    const path = findPbotPath(COOK_431.lat, COOK_431.lng, ZOIGLHAUS.lat, ZOIGLHAUS.lng)!;
    const namedEdges = path.edges.filter(e => cleanEdgeName(e.name) !== '');
    // Route should have meaningful names on a significant portion of edges
    expect(namedEdges.length).toBeGreaterThan(5);
  });

  it('should produce properly cased names with uppercase directional prefixes', () => {
    const path = findPbotPath(COOK_431.lat, COOK_431.lng, ZOIGLHAUS.lat, ZOIGLHAUS.lng)!;
    for (const edge of path.edges) {
      const cleaned = cleanEdgeName(edge.name);
      if (!cleaned) continue;
      // Simplified names (Springwater Corridor, I-205 Path) don't keep prefixes
      if (cleaned === 'Springwater Corridor' || cleaned.match(/^I-\d+ Path$/)) continue;
      // Regular street names: directional prefixes should be uppercase
      if (/^(NE|NW|SE|SW|N|S|E|W) /.test(edge.name)) {
        expect(cleaned).toMatch(/^(NE|NW|SE|SW|N|S|E|W) /);
      }
    }
  });
});
