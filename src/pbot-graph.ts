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
  name: string;                 // street/path name from PBOT StreetName
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
  '_PREF': 3.0,        // user-defined preference edges (override controls actual cost)
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
const SAFE_WEIGHT = 0.5;       // weight for user-preferred edges (= greenway/buffered lane tier)
const MAX_SNAP_DIST = 500;     // max meters from point to nearest PBOT node
const GAP_BRIDGE_DIST = 250;   // max meters for synthetic gap-bridging edges
const LONG_EDGE = 500;         // meters - edges longer than this get a midpoint sample

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
export function nk(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

/** Canonical edge key: lexicographic order of node keys, joined by `|`.
 *  Direction-independent — both directions of a bidirectional edge share one key. */
export function canonicalEdgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
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
    const name = f.properties?.StreetName || '';

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
      _n.get(kA)!.edges.push({ target: kB, ct, distance: dist, coords: pts, name });
      _n.get(kB)!.edges.push({ target: kA, ct, distance: dist, coords: [...pts].reverse(), name });
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

/** Public snap: find nearest graph node to a point. Returns null if too far. */
export function snapToNode(lat: number, lng: number): { key: string; lat: number; lng: number } | null {
  const key = snap(lat, lng);
  if (!key || !nodes) return null;
  const n = nodes.get(key)!;
  return { key, lat: n.lat, lng: n.lng };
}

/** Ensure a node exists in the graph, creating it if needed. */
function ensureNode(key: string, lat: number, lng: number): void {
  if (!nodes || !grid) return;
  if (!nodes.has(key)) {
    nodes.set(key, { lat, lng, edges: [] });
    const g = gk(lat, lng);
    const a = grid.get(g);
    if (a) a.push(key);
    else grid.set(g, [key]);
  }
}

/** Inject a single synthetic edge between two node keys. Creates nodes if needed. */
export function injectEdge(
  keyA: string, keyB: string,
  coords: [number, number][],
  name: string,
): void {
  if (!nodes || !grid) return;
  if (keyA === keyB) return;

  ensureNode(keyA, coords[0][0], coords[0][1]);
  ensureNode(keyB, coords[coords.length - 1][0], coords[coords.length - 1][1]);

  // Check if edge already exists
  const nodeA = nodes.get(keyA)!;
  if (nodeA.edges.some(e => e.target === keyB)) return;

  let dist = 0;
  for (let i = 1; i < coords.length; i++) {
    dist += haversine(coords[i - 1], coords[i]);
  }

  const ct = '_PREF'; // synthetic preference edge
  nodeA.edges.push({ target: keyB, ct, distance: dist, coords, name });
  const nodeB = nodes.get(keyB)!;
  nodeB.edges.push({ target: keyA, ct, distance: dist, coords: [...coords].reverse(), name });
}

/**
 * Inject a polyline as a chain of graph edges with intermediate nodes.
 * Creates nodes at intervals along the polyline so A* can traverse the
 * full path. Returns the canonical edge keys for all created edges.
 */
export function injectPolylineEdges(
  coords: [number, number][],
  name: string,
  maxSegmentLen = 200,
): string[] {
  if (!nodes || !grid || coords.length < 2) return [];

  // Build node keys along the polyline, inserting intermediate nodes
  // wherever the cumulative distance from the last node exceeds maxSegmentLen.
  const nodeKeys: string[] = [];
  const segments: [number, number][][] = []; // coords for each edge

  let currentSegCoords: [number, number][] = [coords[0]];
  let currentKey = nk(coords[0][0], coords[0][1]);
  ensureNode(currentKey, coords[0][0], coords[0][1]);
  nodeKeys.push(currentKey);

  let accumDist = 0;

  for (let i = 1; i < coords.length; i++) {
    const d = haversine(coords[i - 1], coords[i]);
    accumDist += d;
    currentSegCoords.push(coords[i]);

    const isLast = i === coords.length - 1;
    if (accumDist >= maxSegmentLen || isLast) {
      const endKey = nk(coords[i][0], coords[i][1]);
      ensureNode(endKey, coords[i][0], coords[i][1]);

      if (endKey !== currentKey) {
        segments.push(currentSegCoords);
        nodeKeys.push(endKey);
        currentKey = endKey;
      }

      currentSegCoords = [coords[i]];
      accumDist = 0;
    }
  }

  // Create edges and collect canonical keys
  const edgeKeys: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const kA = nodeKeys[i];
    const kB = nodeKeys[i + 1];
    injectEdge(kA, kB, segments[i], name);
    edgeKeys.push(canonicalEdgeKey(kA, kB));
  }

  // Connect polyline endpoints to the nearest existing PBOT graph nodes
  // so A* can actually reach the injected edges.
  connectToGraph(nodeKeys[0], coords[0][0], coords[0][1]);
  connectToGraph(nodeKeys[nodeKeys.length - 1], coords[coords.length - 1][0], coords[coords.length - 1][1]);

  return edgeKeys;
}

/** Bridge an injected node to the nearest existing PBOT graph nodes. */
function connectToGraph(injectedKey: string, lat: number, lng: number): void {
  if (!nodes || !grid) return;
  const bLat = Math.floor(lat * 1000);
  const bLng = Math.floor(lng * 1000);
  const radius = 3; // ~330m search radius

  for (let dl = -radius; dl <= radius; dl++) {
    for (let dn = -radius; dn <= radius; dn++) {
      const keys = grid.get(`${bLat + dl},${bLng + dn}`);
      if (!keys) continue;
      for (const k of keys) {
        if (k === injectedKey) continue;
        const n = nodes.get(k)!;
        const d = haversine([lat, lng], [n.lat, n.lng]);
        if (d > GAP_BRIDGE_DIST) continue;
        // Don't duplicate existing edges
        const injected = nodes.get(injectedKey)!;
        if (injected.edges.some(e => e.target === k)) continue;
        const coords: [number, number][] = [[lat, lng], [n.lat, n.lng]];
        injected.edges.push({ target: k, ct: '_GAP', distance: d, coords, name: '' });
        n.edges.push({ target: injectedKey, ct: '_GAP', distance: d, coords: [[n.lat, n.lng], [lat, lng]], name: '' });
      }
    }
  }
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
          node.edges.push({ target: otherKey, ct, distance: d, coords, name: '' });
          other.edges.push({ target: key, ct, distance: d, coords: [[other.lat, other.lng], [node.lat, node.lng]], name: '' });
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

function astar(startKey: string, endKey: string, weights: Record<string, number>, minCosts: Record<string, number>, edgeOverrides?: Map<string, 'preferred' | 'nogo'>): GraphEdge[] | null {
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

  const MAX_ITERATIONS = 50_000;
  let iterations = 0;

  while (heap.length > 0) {
    if (++iterations > MAX_ITERATIONS) return null;
    const cur = pop();
    if (cur === endKey) break;
    if (closed.has(cur)) continue;
    closed.add(cur);

    const g = gCost.get(cur)!;
    const node = nodes.get(cur)!;

    for (const edge of node.edges) {
      if (closed.has(edge.target)) continue;

      // Check edge overrides (preferred / nogo)
      if (edgeOverrides) {
        const ek = canonicalEdgeKey(cur, edge.target);
        const override = edgeOverrides.get(ek);
        if (override === 'nogo') continue;
        if (override === 'preferred') {
          const ng = g + edge.distance * SAFE_WEIGHT;
          if (ng >= (gCost.get(edge.target) ?? Infinity)) continue;
          gCost.set(edge.target, ng);
          from.set(edge.target, { parent: cur, edge });
          const t = nodes.get(edge.target)!;
          push(ng + haversine([t.lat, t.lng], [endNode.lat, endNode.lng]) * MIN_WEIGHT, edge.target);
          continue;
        }
      }

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

// ========== Public types ==========

export interface PbotEdge {
  ct: string;                   // ConnectionType (uppercase)
  distance: number;             // actual meters
  coords: [number, number][];   // [lat, lng] points along segment
  name: string;                 // street/path name from PBOT StreetName
}

export interface PbotPathResult {
  edges: PbotEdge[];
  startSnapDist: number;  // meters from start point to first PBOT node
  endSnapDist: number;    // meters from last PBOT node to end point
  startNode: { lat: number; lng: number };
  endNode: { lat: number; lng: number };
}

// ========== Public API ==========

/**
 * Find the A* path through the PBOT bike network between two points.
 * Returns the raw edge path with full geometry — caller renders the
 * coordinates directly instead of feeding them as waypoints to BRouter.
 */
export function findPbotPath(
  startLat: number, startLng: number,
  endLat: number, endLng: number,
  profile: GuidanceProfile = 'safest',
  edgeOverrides?: Map<string, 'preferred' | 'nogo'>,
): PbotPathResult | null {
  if (!nodes) return null;

  // Skip A* for very long routes — BRouter handles these better
  if (haversine([startLat, startLng], [endLat, endLng]) > 20_000) return null;

  const sk = snap(startLat, startLng);
  const ek = snap(endLat, endLng);
  if (!sk || !ek || sk === ek) return null;

  const weights = PROFILE_WEIGHTS[profile];
  const minCosts = PROFILE_MIN_COSTS[profile];
  const edgePath = astar(sk, ek, weights, minCosts, edgeOverrides);
  if (!edgePath || edgePath.length === 0) return null;

  const startNode = nodes.get(sk)!;
  const endNode = nodes.get(ek)!;

  return {
    edges: edgePath.map(e => ({ ct: e.ct, distance: e.distance, coords: e.coords, name: e.name })),
    startSnapDist: haversine([startLat, startLng], [startNode.lat, startNode.lng]),
    endSnapDist: haversine([endLat, endLng], [endNode.lat, endNode.lng]),
    startNode: { lat: startNode.lat, lng: startNode.lng },
    endNode: { lat: endNode.lat, lng: endNode.lng },
  };
}

/**
 * Find intermediate waypoints through the PBOT bike network between two points.
 * @deprecated Use findPbotPath instead — this was used to guide BRouter but
 * the new approach renders PBOT geometry directly.
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

  const waypoints: Waypoint[] = [];

  for (let i = 0; i < edgePath.length; i++) {
    const edge = edgePath[i];

    if (edge.distance > LONG_EDGE && edge.coords.length > 2) {
      const midIdx = Math.floor(edge.coords.length / 2);
      const pt = edge.coords[midIdx];
      waypoints.push({ lat: pt[0], lng: pt[1] });
    }

    if (i < edgePath.length - 1) {
      const node = nodes.get(edge.target)!;
      waypoints.push({ lat: node.lat, lng: node.lng });
    }
  }

  return waypoints.length > 0 ? waypoints : null;
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
 *
 * If preferredCoords/nogoCoords are provided, route points near those
 * polylines are classified as 'good' (green) or 'avoid' (red) respectively,
 * overriding the PBOT data. Nogo takes priority over preferred.
 */
export function classifyRoute(
  coords: [number, number][],
  overrides?: { preferred?: [number, number][][]; nogo?: [number, number][][] },
): InfraTier[] {
  if (!edgeIndex) return coords.map(() => 'none');
  const preferredCoords = overrides?.preferred;
  const nogoCoords = overrides?.nogo;

  return coords.map(([lat, lng]) => {
    // Nogo edges take highest priority — show red
    if (nogoCoords) {
      for (const poly of nogoCoords) {
        if (pointToEdgeDist([lat, lng], poly) < CLASSIFY_SNAP) return 'avoid';
      }
    }

    // Check preferred edges — show green
    if (preferredCoords) {
      for (const poly of preferredCoords) {
        if (pointToEdgeDist([lat, lng], poly) < CLASSIFY_SNAP) return 'good';
      }
    }

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

