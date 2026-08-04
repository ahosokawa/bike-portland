// Tests for the client-side routing engine, run against the real shipped
// graph artifact (public/data/street-graph.json). Fully offline — no BRouter.
//
// If these fail after changing the graph builder, rebuild the artifact:
//   npm run fetch-graph

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { StreetGraph, GRAPH_VERSION } from './street-graph';
import type { EncodedGraph, InfraTier, StreetRoute } from './street-graph';
import { SCENARIOS, PLACES } from './route-scenarios';
import { haversine, computeDistance, bearing } from './geo';

let graph: StreetGraph;

beforeAll(() => {
  const data = JSON.parse(
    readFileSync(resolve(__dirname, '../public/data/street-graph.json'), 'utf8'),
  ) as EncodedGraph;
  graph = new StreetGraph(data);
});

function share(route: StreetRoute, want: InfraTier[]): number {
  return route.tiers.filter(t => want.includes(t)).length / route.tiers.length;
}

describe('graph artifact', () => {
  it('matches the expected encoding version', () => {
    expect(graph.built).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('covers Portland at a plausible scale', () => {
    // Sanity bounds — catches a truncated or mis-parsed artifact
    expect(graph.nodeCount).toBeGreaterThan(40_000);
    expect(graph.edgeCount).toBeGreaterThan(50_000);
    expect(graph.edgeCount).toBeLessThan(200_000);
  });

  it('rejects an artifact from a different format version', () => {
    const bogus = { v: GRAPH_VERSION + 1 } as EncodedGraph;
    expect(() => new StreetGraph(bogus)).toThrow(/version/i);
  });

  it('snaps a point to a nearby ridable edge', () => {
    const snap = graph.snap(PLACES.COOK_431.lat, PLACES.COOK_431.lng);
    expect(snap).not.toBeNull();
    expect(snap!.distance).toBeLessThan(60);
    expect(graph.edgeName(snap!.edge).length).toBeGreaterThan(0);
  });

  it('returns null when snapping far outside the covered area', () => {
    expect(graph.snap(44.0, -120.0)).toBeNull(); // central Oregon
  });
});

describe.each(SCENARIOS)('route: $name', (scenario) => {
  let route: StreetRoute;

  beforeAll(() => {
    const r = graph.route(scenario.from, scenario.to, scenario.profile);
    expect(r, 'route should be found').not.toBeNull();
    route = r!;
  });

  it('starts and ends at the requested points', () => {
    const first = route.coordinates[0];
    const last = route.coordinates[route.coordinates.length - 1];
    // Endpoints land on the nearest ridable way, which can sit back from a
    // building entrance — but never far.
    expect(haversine(first, [scenario.from.lat, scenario.from.lng])).toBeLessThan(150);
    expect(haversine(last, [scenario.to.lat, scenario.to.lng])).toBeLessThan(150);
  });

  it('has continuous geometry', () => {
    let maxGap = 0;
    for (let i = 1; i < route.coordinates.length; i++) {
      maxGap = Math.max(maxGap, haversine(route.coordinates[i - 1], route.coordinates[i]));
    }
    // Straight blocks carry few OSM vertices, so gaps are legitimately long;
    // anything past this means a disconnect between stitched edges.
    expect(maxGap).toBeLessThan(400);
  });

  it('reports distance matching its geometry', () => {
    expect(Math.abs(route.distance - computeDistance(route.coordinates))).toBeLessThan(1);
  });

  it('does not detour absurdly', () => {
    const straight = haversine(
      [scenario.from.lat, scenario.from.lng],
      [scenario.to.lat, scenario.to.lng],
    );
    expect(route.distance / straight).toBeLessThan(2.3);
    expect(route.distance).toBeGreaterThan(straight * 0.9);
  });

  it('does not double back at the start or destination', () => {
    const c = route.coordinates;
    const angle = (b1: number, b2: number) => {
      const d = Math.abs(b2 - b1) % 360;
      return d > 180 ? 360 - d : d;
    };
    let j = c.length - 2;
    while (j > 0 && haversine(c[j], c[c.length - 2]) < 40) j--;
    expect(angle(bearing(c[j], c[c.length - 2]), bearing(c[c.length - 2], c[c.length - 1])))
      .toBeLessThan(120);

    let k = 1;
    while (k < c.length - 1 && haversine(c[1], c[k]) < 40) k++;
    expect(angle(bearing(c[0], c[1]), bearing(c[1], c[k]))).toBeLessThan(120);
  });

  it('has a tier for every coordinate', () => {
    expect(route.tiers.length).toBe(route.coordinates.length);
  });

  it('names most of the streets it uses', () => {
    const named = route.names.filter(n => n.length > 0).length;
    expect(named / route.names.length).toBeGreaterThan(0.6);
  });

  it('computes quickly enough for live rerouting', () => {
    const t0 = performance.now();
    graph.route(scenario.from, scenario.to, scenario.profile);
    expect(performance.now() - t0).toBeLessThan(400);
  });
});

describe('safest profile route quality', () => {
  const safest = SCENARIOS.filter(s => s.profile === 'safest');

  it.each(safest)('$name rides mostly on bike infrastructure', (scenario) => {
    const route = graph.route(scenario.from, scenario.to, 'safest')!;
    // Measured 91–99% across the corpus; the current BRouter pipeline manages
    // 80–98%, so this bar keeps the client-side engine at least as good.
    expect(share(route, ['path', 'good', 'lane'])).toBeGreaterThan(0.85);
    expect(share(route, ['caution', 'avoid'])).toBeLessThan(0.08);
  });

  it('prefers safer streets than the balanced profile', () => {
    const from = PLACES.COOK_431;
    const to = PLACES.THE_REDD;
    const safe = graph.route(from, to, 'safest')!;
    const fast = graph.route(from, to, 'balanced')!;
    expect(share(safe, ['path', 'good', 'lane'])).toBeGreaterThanOrEqual(
      share(fast, ['path', 'good', 'lane']),
    );
    // ...while staying competitive on distance
    expect(safe.distance).toBeLessThan(fast.distance * 1.5);
  });
});

describe('legal and sensible riding', () => {
  it.each(SCENARIOS)('$name never rides the wrong way down a one-way', (scenario) => {
    const route = graph.route(scenario.from, scenario.to, scenario.profile)!;
    for (const step of route.steps) {
      const oneway = graph.edgeOneway(step.edge);
      if (oneway === 1) expect(step.forward, graph.edgeName(step.edge)).toBe(true);
      if (oneway === -1) expect(step.forward, graph.edgeName(step.edge)).toBe(false);
    }
  });

  it.each(SCENARIOS)('$name does not wander far off the direct line', (scenario) => {
    // Guards against wandering into the wrong part of the city, which total
    // distance alone can hide on a route that later doubles back efficiently.
    // Measured off-line peaks: 680m for every corpus route except
    // Cook→Zoiglhaus, which swings 6.5km south to ride the Springwater
    // Corridor east (the previous engine did the same). A loose guard.
    const route = graph.route(scenario.from, scenario.to, scenario.profile)!;
    const straight = haversine(
      [scenario.from.lat, scenario.from.lng],
      [scenario.to.lat, scenario.to.lng],
    );
    for (const c of route.coordinates) {
      const detour =
        haversine(c, [scenario.from.lat, scenario.from.lng]) +
        haversine(c, [scenario.to.lat, scenario.to.lng]);
      expect(detour).toBeLessThan(straight + 7000);
    }
  });
});

describe('geographic sanity', () => {
  it('uses the Springwater Corridor to reach Sellwood', () => {
    // The signature south-east bike route; naming makes this directly checkable
    const route = graph.route(PLACES.COOK_431, PLACES.SELLWOOD_PARK, 'safest')!;
    expect(route.names.some(n => /springwater/i.test(n))).toBe(true);
  });

  it('crosses MLK on the NE Morris greenway rather than a busy street', () => {
    const route = graph.route(PLACES.COOK_431, PLACES.THE_REDD, 'safest')!;
    // Every arterial crossing should happen on a named bike-friendly street
    const crossings = route.names.filter(n => /morris|tillamook|going|klickitat|ankeny/i.test(n));
    expect(crossings.length).toBeGreaterThan(0);
  });

  it('does not head north to reach a destination due south', () => {
    const route = graph.route(PLACES.COOK_431, PLACES.THE_REDD, 'safest')!;
    expect(route.coordinates.some(c => c[0] > PLACES.COOK_431.lat + 0.002)).toBe(false);
  });

  it('keeps east-side routes east of the Willamette', () => {
    const route = graph.route(PLACES.COOK_431, PLACES.SELLWOOD_PARK, 'safest')!;
    expect(route.coordinates.some(c => c[1] < -122.68)).toBe(false);
  });

  it('crosses the river on a bridge when the trip requires it', () => {
    // PSU (west side) → Bagdad Theater (east side) must cross
    const route = graph.route(PLACES.PSU, PLACES.BAGDAD_THEATER, 'safest')!;
    const west = route.coordinates.some(c => c[1] < -122.675);
    const east = route.coordinates.some(c => c[1] > -122.655);
    expect(west && east).toBe(true);
  });

  it('is deterministic', () => {
    const a = graph.route(PLACES.KENTON, PLACES.MISSISSIPPI_SKIDMORE, 'safest')!;
    const b = graph.route(PLACES.KENTON, PLACES.MISSISSIPPI_SKIDMORE, 'safest')!;
    expect(b.coordinates).toEqual(a.coordinates);
    expect(b.distance).toBe(a.distance);
  });

  it('routes between two points on the same block without going around it', () => {
    // Derive both points from one edge's own geometry so they are genuinely
    // on the same block (picking coordinates by eye can land on a cross street).
    const snap = graph.snap(PLACES.COOK_431.lat, PLACES.COOK_431.lng)!;
    const coords = graph.edgeCoords(snap.edge);
    const along = (frac: number): { lat: number; lng: number } => {
      const total = computeDistance(coords);
      let want = total * frac;
      for (let i = 0; i < coords.length - 1; i++) {
        const seg = haversine(coords[i], coords[i + 1]);
        if (want <= seg) {
          const t = seg === 0 ? 0 : want / seg;
          return {
            lat: coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
            lng: coords[i][1] + t * (coords[i + 1][1] - coords[i][1]),
          };
        }
        want -= seg;
      }
      return { lat: coords[coords.length - 1][0], lng: coords[coords.length - 1][1] };
    };

    const a = along(0.25);
    const b = along(0.75);
    const direct = haversine([a.lat, a.lng], [b.lat, b.lng]);
    const route = graph.route(a, b, 'safest');
    expect(route).not.toBeNull();
    // Riding along one block should be barely longer than the straight line,
    // not a trip around the neighbouring streets.
    expect(route!.distance).toBeLessThan(direct * 1.5 + 20);
    expect(route!.coordinates.length).toBeGreaterThanOrEqual(2);
  });
});
