// Builds a routable graph from PBOT bike infrastructure GeoJSON and provides
// A* pathfinding to guide BRouter through streets with known bike infrastructure.

import { haversine } from './router';
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

export type GuidanceProfile = 'safest' | 'safe';

// "Bike Paths" — aggressively favor MUPs, will detour significantly to stay
// on paths/greenways and to use safe crossings of busy roads.
const WEIGHTS_SAFEST: Record<string, number> = {
  'MUP_P': 0.15, 'MUP_U': 0.2, 'BL-MUP': 0.15,
  'NG': 0.5, 'BBL': 0.5,
  'BL': 1.8, 'SR_LT': 1.5, 'SC': 1.8, 'BL-SR_LT': 1.6,
  'SR_MT': 12.0, 'BL-SR_MT': 10.0, 'BL_VHT': 15.0,
  'DC': 3.0, 'SR_DC': 3.5, 'BL-DC': 2.5, 'SR_MT-DC': 15.0,
  '_GAP': 8.0,  // gap-bridging edges: very costly — unknown roads could be dangerous
};

// "Mixed" — accepts bike lanes and quiet streets freely
const WEIGHTS_SAFE: Record<string, number> = {
  'MUP_P': 0.6, 'MUP_U': 0.7, 'BL-MUP': 0.6,
  'NG': 0.7, 'BBL': 0.7,
  'BL': 0.9, 'SR_LT': 0.9, 'SC': 1.0, 'BL-SR_LT': 0.9,
  'SR_MT': 2.5, 'BL-SR_MT': 2.0, 'BL_VHT': 3.0,
  'DC': 2.5, 'SR_DC': 2.5, 'BL-DC': 2.0, 'SR_MT-DC': 3.5,
  '_GAP': 2.0,
};

const PROFILE_WEIGHTS: Record<GuidanceProfile, Record<string, number>> = {
  safest: WEIGHTS_SAFEST,
  safe: WEIGHTS_SAFE,
};

// Minimum edge cost per type (per profile).
// Even a 10m segment on SR_MT incurs this cost, modeling the inherent danger
// of crossing/entering a busy road regardless of distance.
const MIN_COST_SAFEST: Record<string, number> = {
  'SR_MT': 1200, 'BL-SR_MT': 800, 'BL_VHT': 1500, 'SR_MT-DC': 1500,
  '_GAP': 500,
};

const MIN_COST_SAFE: Record<string, number> = {
  'BL_VHT': 300,
  'SR_MT-DC': 300,
};

const PROFILE_MIN_COSTS: Record<GuidanceProfile, Record<string, number>> = {
  safest: MIN_COST_SAFEST,
  safe: MIN_COST_SAFE,
};

const MIN_WEIGHT = 0.15;       // smallest multiplier across all profiles (keeps A* heuristic admissible)
const MAX_SNAP_DIST = 500;     // max meters from point to nearest PBOT node
const MAX_SAMPLES = 25;        // cap waypoints passed to BRouter
const GAP_BRIDGE_DIST = 150;   // max meters for synthetic gap-bridging edges

// ========== Module state ==========

let nodes: Map<string, GraphNode> | null = null;
let grid: Map<string, string[]> | null = null;

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

          const coords: [number, number][] = [[node.lat, node.lng], [other.lat, other.lng]];
          node.edges.push({ target: otherKey, ct: '_GAP', distance: d, coords });
          other.edges.push({ target: key, ct: '_GAP', distance: d, coords: [[other.lat, other.lng], [node.lat, node.lng]] });
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
        if (d < bestD) { bestD = d; best = k; }
      }
    }
  }

  return bestD <= MAX_SNAP_DIST ? best : null;
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

// ========== Public API ==========

/**
 * Find intermediate waypoints through the PBOT bike network between two points.
 * The profile controls how aggressively the path favors dedicated bike infrastructure:
 *   - 'safest': strongly prefers MUPs and greenways, penalizes shared roads
 *   - 'safe': accepts bike lanes and low-traffic streets freely
 * Returns waypoints (excluding start/end) suitable for passing to BRouter,
 * or null if the points are too far from the network or no path exists.
 */
export function findGuidedWaypoints(
  startLat: number, startLng: number,
  endLat: number, endLng: number,
  profile: GuidanceProfile = 'safe',
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

  if (junctions.length <= MAX_SAMPLES) {
    return junctions;
  }

  // Too many junctions — thin while preserving critical turn/type-change points
  return thinJunctions(junctions, edgePath);
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
};

const CLASSIFY_SNAP = 25; // meters — max distance to match a route point to PBOT edge

/**
 * For each coordinate on a computed route, classify what type of bike
 * infrastructure it's on by matching against the nearest PBOT edge segment.
 * Returns a parallel array of InfraTier values (one per coordinate).
 */
export function classifyRoute(coords: [number, number][]): InfraTier[] {
  if (!nodes || !grid) return coords.map(() => 'none');

  return coords.map(([lat, lng]) => {
    const bLat = Math.floor(lat * 1000);
    const bLng = Math.floor(lng * 1000);

    let bestTier: InfraTier = 'none';
    let bestDist = CLASSIFY_SNAP;
    const visited = new Set<string>();

    for (let dl = -1; dl <= 1; dl++) {
      for (let dn = -1; dn <= 1; dn++) {
        const keys = grid!.get(`${bLat + dl},${bLng + dn}`);
        if (!keys) continue;
        for (const k of keys) {
          const n = nodes!.get(k)!;
          for (const edge of n.edges) {
            // Deduplicate: each edge exists in both directions
            const ek = k < edge.target ? `${k}|${edge.target}` : `${edge.target}|${k}`;
            if (visited.has(ek)) continue;
            visited.add(ek);

            const tier = TIER_FROM_CT[edge.ct];
            if (!tier) continue; // skip _GAP and unknown types

            // Distance from route point to closest point on the edge geometry
            const d = pointToEdgeDist([lat, lng], edge.coords);
            if (d < bestDist) {
              bestDist = d;
              bestTier = tier;
            }
          }
        }
      }
    }
    return bestTier;
  });
}

/** Minimum distance from point p to any segment of a polyline. */
function pointToEdgeDist(p: [number, number], coords: [number, number][]): number {
  if (coords.length === 0) return Infinity;
  if (coords.length === 1) return haversine(p, coords[0]);
  let min = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = pointToSegDist(p, coords[i], coords[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

/** Distance from point p to the closest point on segment a–b (flat-earth approx). */
function pointToSegDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const cosLat = Math.cos(p[0] * Math.PI / 180);
  const px = (p[1] - a[1]) * cosLat;
  const py = p[0] - a[0];
  const dx = (b[1] - a[1]) * cosLat;
  const dy = b[0] - a[0];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return haversine(p, a);
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
  return haversine(p, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
}
