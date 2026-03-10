// Builds a routable graph from PBOT bike infrastructure GeoJSON and provides
// A* pathfinding to guide BRouter through streets with known bike infrastructure.

import { haversine, pointToSegDist, pointToEdgeDist } from './geo';
import { crossesBusyRoad, nearBusyRoad } from './busy-roads';
import type { Waypoint } from './types';

// ========== Types ==========

interface GraphNode {
  lat: number;
  lng: number;
  edges: GraphEdge[];
}

interface GraphEdge {
  target: string;               // node key
  ct: string;                   // ConnectionType (uppercase)
  distance: number;             // actual meters
  coords: [number, number][];   // [lat, lng] points along segment
}

// ========== Per-profile edge weights ==========
// Lower = more preferred when routing

export type GuidanceProfile = 'safest';

// "Bike Paths" — aggressively favor MUPs, will detour significantly to stay
// on paths/greenways and to use safe crossings of busy roads.
const WEIGHTS_SAFEST: Record<string, number> = {
  'MUP_P': 0.15, 'MUP_U': 0.2, 'BL-MUP': 0.15,
  'NG': 0.5, 'BBL': 0.5,
  'BL': 1.8, 'SR_LT': 1.5, 'SC': 1.8, 'BL-SR_LT': 1.6,
  'SR_MT': 12.0, 'BL-SR_MT': 10.0, 'BL_VHT': 15.0,
  'DC': 3.0, 'SR_DC': 3.5, 'BL-DC': 2.5, 'SR_MT-DC': 15.0,
  '_GAP': 2.0,         // gap-bridging edges: unknown residential roads
  '_GAP_BUSY': 40.0,   // gap crossing a secondary/arterial road
  '_GAP_MAJOR': 200.0, // gap crossing a trunk/primary/motorway
};

const PROFILE_WEIGHTS: Record<GuidanceProfile, Record<string, number>> = {
  safest: WEIGHTS_SAFEST,
};

// Minimum edge cost per type (per profile).
// Even a 10m segment on SR_MT incurs this cost, modeling the inherent danger
// of crossing/entering a busy road regardless of distance.
const MIN_COST_SAFEST: Record<string, number> = {
  'SR_MT': 1200, 'BL-SR_MT': 800, 'BL_VHT': 1500, 'SR_MT-DC': 1500,
  '_GAP': 80,
  '_GAP_BUSY': 3000,
  '_GAP_MAJOR': 10000,
};

const PROFILE_MIN_COSTS: Record<GuidanceProfile, Record<string, number>> = {
  safest: MIN_COST_SAFEST,
};

const MIN_WEIGHT = 0.15;       // smallest multiplier across all profiles (keeps A* heuristic admissible)
const MAX_SNAP_DIST = 500;     // max meters from point to nearest PBOT node
const MAX_SAMPLES = 25;        // cap waypoints passed to BRouter
const GAP_BRIDGE_DIST = 250;   // max meters for synthetic gap-bridging edges
const MIN_SPACING = 200;        // meters - minimum distance between consecutive waypoints

// ========== Module state ==========

let nodes: Map<string, GraphNode> | null = null;
let grid: Map<string, string[]> | null = null;

// Spatial index of edges for classification — indexes edges by every grid cell
// their geometry passes through (not just endpoint cells). Solves the problem
// where long edges pass through cells that contain no graph nodes.
interface IndexedEdge {
  ct: string;
  coords: [number, number][];
}
let edgeIndex: Map<string, IndexedEdge[]> | null = null;

// ========== Coordinate helpers ==========

// Node key: 4 decimal places ≈ 11 m precision — coarser to ensure segment
// endpoints at the same intersection merge even if coords differ slightly
function nk(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

// Spatial grid cell: 3 decimal places ≈ 110 m cells
function gk(lat: number, lng: number): string {
  return `${Math.floor(lat * 1000)},${Math.floor(lng * 1000)}`;
}

// ========== Graph construction ==========

export function buildGraph(geojson: any): void {
  const _n = new Map<string, GraphNode>();
  const _g = new Map<string, string[]>();

  function ensure(lat: number, lng: number): string {
    const k = nk(lat, lng);
    if (!_n.has(k)) {
      _n.set(k, { lat, lng, edges: [] });
      const g = gk(lat, lng);
      const a = _g.get(g);
      if (a) a.push(k);
      else _g.set(g, [k]);
    }
    return k;
  }

  for (const f of geojson.features) {
    const geom = f.geometry;
    const ct = (f.properties?.ConnectionType || '').toUpperCase();

    const lines: number[][][] =
      geom.type === 'MultiLineString' ? geom.coordinates :
      geom.type === 'LineString' ? [geom.coordinates] : [];

    for (const line of lines) {
      if (line.length < 2) continue;

      // GeoJSON coordinates are [lng, lat]
      const a = line[0];
      const b = line[line.length - 1];
      const kA = ensure(a[1], a[0]);
      const kB = ensure(b[1], b[0]);
      if (kA === kB) continue;

      // Convert to [lat, lng] for internal use
      const pts: [number, number][] = line.map(c => [c[1], c[0]] as [number, number]);

      let dist = 0;
      for (let i = 1; i < pts.length; i++) {
        dist += haversine(pts[i - 1], pts[i]);
      }

      // Bidirectional edges — weight computed at query time per profile
      _n.get(kA)!.edges.push({ target: kB, ct, distance: dist, coords: pts });
      _n.get(kB)!.edges.push({ target: kA, ct, distance: dist, coords: [...pts].reverse() });
    }
  }

  nodes = _n;
  grid = _g;

  // Build spatial edge index for route classification.
  // Each edge is indexed in every grid cell its geometry passes through,
  // including cells between vertices (long segments can span multiple cells).
  const _ei = new Map<string, IndexedEdge[]>();

  function addToEdgeIndex(cellKey: string, ie: IndexedEdge): void {
    const arr = _ei.get(cellKey);
    if (arr) {
      if (arr[arr.length - 1] !== ie) arr.push(ie);
    } else {
      _ei.set(cellKey, [ie]);
    }
  }

  for (const [, node] of _n) {
    for (const edge of node.edges) {
      const ie: IndexedEdge = { ct: edge.ct, coords: edge.coords };
      for (let i = 0; i < edge.coords.length; i++) {
        addToEdgeIndex(gk(edge.coords[i][0], edge.coords[i][1]), ie);
        // Also index all grid cells between consecutive vertices
        if (i < edge.coords.length - 1) {
          const [lat1, lng1] = edge.coords[i];
          const [lat2, lng2] = edge.coords[i + 1];
          const minLat = Math.floor(Math.min(lat1, lat2) * 1000);
          const maxLat = Math.floor(Math.max(lat1, lat2) * 1000);
          const minLng = Math.floor(Math.min(lng1, lng2) * 1000);
          const maxLng = Math.floor(Math.max(lng1, lng2) * 1000);
          for (let gLat = minLat; gLat <= maxLat; gLat++) {
            for (let gLng = minLng; gLng <= maxLng; gLng++) {
              addToEdgeIndex(`${gLat},${gLng}`, ie);
            }
          }
        }
      }
    }
  }
  edgeIndex = _ei;

  // Add synthetic edges between nearby but unconnected nodes so the pathfinder
  // can bridge gaps in the PBOT network (e.g. reach a MUP across a few blocks
  // of non-bike-infrastructure streets).
  addGapBridges();
}

export function isGraphReady(): boolean {
  return nodes !== null;
}

// ========== Gap-bridging edges ==========

function addGapBridges(): void {
  if (!nodes || !grid) return;

  const radius = Math.ceil(GAP_BRIDGE_DIST / 110); // grid cells to search

  for (const [key, node] of nodes) {
    const connected = new Set(node.edges.map(e => e.target));
    connected.add(key);

    const bLat = Math.floor(node.lat * 1000);
    const bLng = Math.floor(node.lng * 1000);

    for (let dl = -radius; dl <= radius; dl++) {
      for (let dn = -radius; dn <= radius; dn++) {
        const cellKeys = grid.get(`${bLat + dl},${bLng + dn}`);
        if (!cellKeys) continue;
        for (const otherKey of cellKeys) {
          if (connected.has(otherKey)) continue;
          // Only process each pair once (smaller key initiates)
          if (key >= otherKey) continue;

          const other = nodes.get(otherKey)!;
          const d = haversine([node.lat, node.lng], [other.lat, other.lng]);
          if (d > GAP_BRIDGE_DIST) continue;

          const severity = crossesBusyRoad(node.lat, node.lng, other.lat, other.lng);
          const ct = severity === 'major' ? '_GAP_MAJOR' : severity === 'secondary' ? '_GAP_BUSY' : '_GAP';
          const coords: [number, number][] = [[node.lat, node.lng], [other.lat, other.lng]];
          node.edges.push({ target: otherKey, ct, distance: d, coords });
          other.edges.push({ target: key, ct, distance: d, coords: [[other.lat, other.lng], [node.lat, node.lng]] });
          connected.add(otherKey);
        }
      }
    }
  }
}

// ========== Nearest-node lookup ==========

function snap(lat: number, lng: number): string | null {
  if (!nodes || !grid) return null;

  let best: string | null = null;
  let bestD = Infinity;
  let bestSafe: string | null = null;
  let bestSafeD = Infinity;
  const bLat = Math.floor(lat * 1000);
  const bLng = Math.floor(lng * 1000);

  // Search within ±5 grid cells (~550m) to cover MAX_SNAP_DIST
  for (let dl = -5; dl <= 5; dl++) {
    for (let dn = -5; dn <= 5; dn++) {
      const keys = grid.get(`${bLat + dl},${bLng + dn}`);
      if (!keys) continue;
      for (const k of keys) {
        const n = nodes.get(k)!;
        const d = haversine([lat, lng], [n.lat, n.lng]);
        if (d > MAX_SNAP_DIST) continue;
        if (d < bestD) { bestD = d; best = k; }
        // Track closest node reachable without crossing a major road
        if (d < bestSafeD && crossesBusyRoad(lat, lng, n.lat, n.lng) !== 'major') {
          bestSafeD = d;
          bestSafe = k;
        }
      }
    }
  }

  // Prefer a node that doesn't require crossing a major road,
  // as long as it's not drastically farther (within 2x or +200m)
  if (bestSafe && bestSafeD <= Math.max(bestD * 2, bestD + 200)) {
    return bestSafe;
  }
  return best ?? null;
}

// ========== A* pathfinding ==========

// Inline min-heap on [f-cost, nodeKey] tuples

function astar(startKey: string, endKey: string, weights: Record<string, number>, minCosts: Record<string, number>): GraphEdge[] | null {
  if (!nodes) return null;

  const endNode = nodes.get(endKey)!;
  const gCost = new Map<string, number>();
  const from = new Map<string, { parent: string; edge: GraphEdge }>();
  const closed = new Set<string>();

  // Heap entries: [f, key]
  const heap: [number, string][] = [];

  function push(f: number, key: string) {
    heap.push([f, key]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[i][0] >= heap[p][0]) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  }

  function pop(): string {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        let s = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
        if (s === i) break;
        [heap[i], heap[s]] = [heap[s], heap[i]];
        i = s;
      }
    }
    return top[1];
  }

  const sn = nodes.get(startKey)!;
  gCost.set(startKey, 0);
  push(haversine([sn.lat, sn.lng], [endNode.lat, endNode.lng]) * MIN_WEIGHT, startKey);

  while (heap.length > 0) {
    const cur = pop();
    if (cur === endKey) break;
    if (closed.has(cur)) continue;
    closed.add(cur);

    const g = gCost.get(cur)!;
    const node = nodes.get(cur)!;

    for (const edge of node.edges) {
      if (closed.has(edge.target)) continue;
      const edgeCost = Math.max(edge.distance * (weights[edge.ct] ?? 3.0), minCosts[edge.ct] ?? 0);
      const ng = g + edgeCost;
      if (ng >= (gCost.get(edge.target) ?? Infinity)) continue;

      gCost.set(edge.target, ng);
      from.set(edge.target, { parent: cur, edge });

      const t = nodes.get(edge.target)!;
      push(ng + haversine([t.lat, t.lng], [endNode.lat, endNode.lng]) * MIN_WEIGHT, edge.target);
    }
  }

  if (!from.has(endKey)) return null;

  // Reconstruct edge path
  const path: GraphEdge[] = [];
  let c = endKey;
  while (from.has(c)) {
    const { parent, edge } = from.get(c)!;
    path.push(edge);
    c = parent;
  }
  path.reverse();
  return path;
}

// ========== Minimum-spacing filter ==========

/** Drop intermediate waypoints that are too close together, preventing
 *  zigzag via-points on parallel one-way streets (e.g. Broadway/Weidler). */
function enforceMinSpacing(waypoints: Waypoint[]): Waypoint[] {
  if (waypoints.length <= 2) return waypoints;
  const result: Waypoint[] = [waypoints[0]];
  for (let i = 1; i < waypoints.length - 1; i++) {
    const last = result[result.length - 1];
    if (haversine([last.lat, last.lng], [waypoints[i].lat, waypoints[i].lng]) >= MIN_SPACING) {
      result.push(waypoints[i]);
    }
  }
  // Always keep the last waypoint (final infrastructure decision point)
  result.push(waypoints[waypoints.length - 1]);
  return result;
}

// ========== Forward-progress filter ==========

/** Remove waypoints that go significantly backward relative to the start→end
 *  direction, preventing BRouter from backtracking. Allows small backward
 *  steps (within 10% of route length) for legitimate detours to reach a MUP. */
function enforceForwardProgress(
  waypoints: Waypoint[],
  startLat: number, startLng: number,
  endLat: number, endLng: number,
): Waypoint[] {
  if (waypoints.length <= 1) return waypoints;

  const cosLat = Math.cos(((startLat + endLat) / 2) * Math.PI / 180);
  const dx = (endLng - startLng) * cosLat;
  const dy = endLat - startLat;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return waypoints;

  function project(wp: Waypoint): number {
    const px = (wp.lng - startLng) * cosLat;
    const py = wp.lat - startLat;
    return (px * dx + py * dy) / lenSq;
  }

  const result: Waypoint[] = [];
  let maxProj = -Infinity;

  for (const wp of waypoints) {
    const proj = project(wp);
    if (proj >= maxProj - 0.10) {
      result.push(wp);
      maxProj = Math.max(maxProj, proj);
    }
  }

  return result;
}

// ========== River-crossing filter ==========

// The Willamette River runs north-south through Portland. PBOT data includes
// east-bank waterfront paths whose coordinates sit right at the river's edge
// (~-122.666 to -122.669). BRouter's OSM network doesn't always have matching
// roads there, causing it to cross bridges to reach these waypoints.
// When start and end are both well inland on the same side, we filter out
// waypoints in the waterfront "danger zone" that BRouter can't reliably reach.
// River corridor: the Willamette runs at ~-122.667. PBOT data includes
// east-bank waterfront paths at -122.665 to -122.669 that BRouter can't
// reliably route to without crossing bridges. When start and end are on
// the same side, nudge river-corridor waypoints to the nearest safe node.
const RIVER_CORRIDOR_EAST = -122.665;
const RIVER_CORRIDOR_WEST = -122.672;
const INLAND_THRESHOLD = -122.660;

function fixRiverWaypoints(
  waypoints: Waypoint[],
  startLng: number, endLng: number,
): Waypoint[] {
  if (!nodes || !grid) return waypoints;

  const startEast = startLng > INLAND_THRESHOLD;
  const endEast = endLng > INLAND_THRESHOLD;
  const startWest = startLng < RIVER_CORRIDOR_WEST;
  const endWest = endLng < RIVER_CORRIDOR_WEST;

  if (!((startEast && endEast) || (startWest && endWest))) return waypoints;

  // Determine which side is safe
  const safeSide = startEast ? 'east' : 'west';

  return waypoints.map(wp => {
    const inCorridor = wp.lng <= RIVER_CORRIDOR_EAST && wp.lng >= RIVER_CORRIDOR_WEST;
    if (!inCorridor) return wp;

    // Find the nearest PBOT node that's safely on the correct side
    const bLat = Math.floor(wp.lat * 1000);
    const bLng = Math.floor(wp.lng * 1000);
    let bestKey: string | null = null;
    let bestDist = Infinity;

    for (let dl = -3; dl <= 3; dl++) {
      for (let dn = -3; dn <= 3; dn++) {
        const keys = grid!.get(`${bLat + dl},${bLng + dn}`);
        if (!keys) continue;
        for (const k of keys) {
          const n = nodes!.get(k)!;
          // Must be on the safe side
          if (safeSide === 'east' && n.lng <= RIVER_CORRIDOR_EAST) continue;
          if (safeSide === 'west' && n.lng >= RIVER_CORRIDOR_WEST) continue;
          const d = haversine([wp.lat, wp.lng], [n.lat, n.lng]);
          if (d < bestDist) { bestDist = d; bestKey = k; }
        }
      }
    }

    if (bestKey && bestDist < 500) {
      const n = nodes!.get(bestKey)!;
      return { lat: n.lat, lng: n.lng };
    }
    // Can't find a safe replacement — drop this waypoint
    return null;
  }).filter((wp): wp is Waypoint => wp !== null);
}

// ========== Public API ==========

/**
 * Find intermediate waypoints through the PBOT bike network between two points.
 * The profile controls how aggressively the path favors dedicated bike infrastructure:
 *   - 'safest': strongly prefers MUPs and greenways, penalizes shared roads
 * Returns waypoints (excluding start/end) suitable for passing to BRouter,
 * or null if the points are too far from the network or no path exists.
 */
export function findGuidedWaypoints(
  startLat: number, startLng: number,
  endLat: number, endLng: number,
  profile: GuidanceProfile = 'safest',
): Waypoint[] | null {
  if (!nodes) return null;

  const sk = snap(startLat, startLng);
  const ek = snap(endLat, endLng);
  if (!sk || !ek || sk === ek) return null;

  const weights = PROFILE_WEIGHTS[profile];
  const minCosts = PROFILE_MIN_COSTS[profile];
  const edgePath = astar(sk, ek, weights, minCosts);
  if (!edgePath || edgePath.length === 0) return null;

  if (edgePath.length === 1) {
    // Single edge — sample its midpoint so BRouter follows it
    const coords = edgePath[0].coords;
    const mid = coords[Math.floor(coords.length / 2)];
    return [{ lat: mid[0], lng: mid[1] }];
  }

  // Use junction nodes (graph intersections) as waypoints.
  // These are the critical decision points where the path turns or changes
  // road type — much better than uniform sampling which can miss key turns.
  // Exclude last edge's target (= endKey, added by caller).
  const junctions: Waypoint[] = [];
  for (let i = 0; i < edgePath.length - 1; i++) {
    const node = nodes.get(edgePath[i].target)!;
    junctions.push({ lat: node.lat, lng: node.lng });
  }

  if (junctions.length === 0) {
    const coords = edgePath[0].coords;
    const mid = coords[Math.floor(coords.length / 2)];
    return [{ lat: mid[0], lng: mid[1] }];
  }

  const sampled = junctions.length <= MAX_SAMPLES
    ? junctions
    : thinJunctions(junctions, edgePath);

  const spaced = enforceMinSpacing(sampled);
  const noRiverDetour = fixRiverWaypoints(spaced, startLng, endLng);
  return enforceForwardProgress(noRiverDetour, startLat, startLng, endLat, endLng);
}

// ========== Waypoint thinning ==========

function thinJunctions(junctions: Waypoint[], edgePath: GraphEdge[]): Waypoint[] {
  // Mark junctions where infrastructure type changes — these represent
  // critical routing decisions (e.g. entering a greenway to cross a busy road)
  const isCritical: boolean[] = junctions.map((_, i) =>
    edgePath[i].ct !== edgePath[i + 1].ct
  );

  const criticalIdx: number[] = [];
  const otherIdx: number[] = [];
  isCritical.forEach((c, i) => (c ? criticalIdx : otherIdx).push(i));

  if (criticalIdx.length >= MAX_SAMPLES) {
    // Even critical junctions exceed max — evenly sample from them
    const step = criticalIdx.length / MAX_SAMPLES;
    return Array.from({ length: MAX_SAMPLES }, (_, i) =>
      junctions[criticalIdx[Math.min(Math.floor(i * step), criticalIdx.length - 1)]]
    );
  }

  // Include all critical junctions, fill remaining slots evenly from non-critical
  const selected = new Set(criticalIdx);
  const remaining = MAX_SAMPLES - selected.size;

  if (remaining > 0 && otherIdx.length > 0) {
    const step = otherIdx.length / remaining;
    for (let i = 0; i < remaining; i++) {
      selected.add(otherIdx[Math.min(Math.floor(i * step), otherIdx.length - 1)]);
    }
  }

  return Array.from(selected).sort((a, b) => a - b).map(i => junctions[i]);
}

// ========== Route classification ==========

export type InfraTier = 'path' | 'good' | 'lane' | 'caution' | 'avoid' | 'none';

const TIER_FROM_CT: Record<string, InfraTier> = {
  'MUP_P': 'path', 'MUP_U': 'path', 'BL-MUP': 'path',
  'NG': 'good', 'BBL': 'good',
  'BL': 'lane', 'SR_LT': 'lane', 'SC': 'lane', 'BL-SR_LT': 'lane',
  'SR_MT': 'caution', 'BL-SR_MT': 'caution', 'BL_VHT': 'caution',
  'DC': 'avoid', 'SR_DC': 'avoid', 'BL-DC': 'avoid', 'SR_MT-DC': 'avoid',
  '_GAP': 'none', '_GAP_BUSY': 'caution', '_GAP_MAJOR': 'avoid',
};

const CLASSIFY_SNAP = 50; // meters — max distance to match a route point to PBOT edge

/**
 * For each coordinate on a computed route, classify what type of bike
 * infrastructure it's on by matching against the nearest PBOT edge segment.
 * Returns a parallel array of InfraTier values (one per coordinate).
 */
export function classifyRoute(coords: [number, number][]): InfraTier[] {
  if (!edgeIndex) return coords.map(() => 'none');

  return coords.map(([lat, lng]) => {
    const bLat = Math.floor(lat * 1000);
    const bLng = Math.floor(lng * 1000);

    // Track real PBOT edges and synthetic gap edges separately —
    // prefer real edges so gap edges don't mask actual infrastructure.
    let bestRealTier: InfraTier = 'none';
    let bestRealDist = CLASSIFY_SNAP;
    let bestGapTier: InfraTier = 'none';
    let bestGapDist = CLASSIFY_SNAP;
    const visited = new Set<IndexedEdge>();

    for (let dl = -1; dl <= 1; dl++) {
      for (let dn = -1; dn <= 1; dn++) {
        const edges = edgeIndex!.get(`${bLat + dl},${bLng + dn}`);
        if (!edges) continue;
        for (const edge of edges) {
          if (visited.has(edge)) continue;
          visited.add(edge);

          const tier = TIER_FROM_CT[edge.ct];
          if (!tier) continue;

          const d = pointToEdgeDist([lat, lng], edge.coords);
          const isGap = edge.ct[0] === '_';
          if (isGap) {
            if (d < bestGapDist) { bestGapDist = d; bestGapTier = tier; }
          } else {
            if (d < bestRealDist) { bestRealDist = d; bestRealTier = tier; }
          }
        }
      }
    }

    // Prefer real PBOT edge; fall back to gap edge; then busy-road check
    let bestTier = bestRealTier;
    if (bestTier === 'none' && bestGapTier !== 'none') {
      bestTier = bestGapTier;
    }
    if (bestTier === 'none') {
      const severity = nearBusyRoad(lat, lng, CLASSIFY_SNAP);
      if (severity === 'major') bestTier = 'avoid';
      else if (severity === 'secondary') bestTier = 'caution';
    }

    return bestTier;
  });
}

/** Debug: find nearest PBOT edge to a point, regardless of snap distance.
 *  Returns distance in meters, edge type, and tier. */
export function debugNearestEdge(lat: number, lng: number): { dist: number; ct: string; tier: string } | null {
  if (!edgeIndex) return null;

  const bLat = Math.floor(lat * 1000);
  const bLng = Math.floor(lng * 1000);
  let bestDist = Infinity;
  let bestCt = '';
  const visited = new Set<IndexedEdge>();

  for (let dl = -5; dl <= 5; dl++) {
    for (let dn = -5; dn <= 5; dn++) {
      const edges = edgeIndex.get(`${bLat + dl},${bLng + dn}`);
      if (!edges) continue;
      for (const edge of edges) {
        if (edge.ct[0] === '_') continue;
        if (visited.has(edge)) continue;
        visited.add(edge);
        const d = pointToEdgeDist([lat, lng], edge.coords);
        if (d < bestDist) { bestDist = d; bestCt = edge.ct; }
      }
    }
  }

  if (!bestCt) return null;
  return { dist: bestDist, ct: bestCt, tier: TIER_FROM_CT[bestCt] || 'none' };
}

