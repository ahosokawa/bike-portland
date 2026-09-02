// Client-side bike routing over a build-time street graph.
//
// The graph is Portland's bikeable OSM network with PBOT bike-infrastructure
// attributes conflated onto edges (see scripts/fetch-street-graph.ts). Routing
// runs entirely in the browser — no network calls, works offline.
//
// Costs are "weighted meters": each edge costs its length times a class
// weight, plus penalties at junctions for sharp turns and for crossing busy
// roads (discounted where the crossing is signalised).

import { haversine, computeDistance, bearing, pointToSegProject } from './geo';

/** Bumped when the encoded format changes; the loader refuses older data. */
export const GRAPH_VERSION = 1;

export interface EncodedGraph {
  v: number;
  built: string;
  bbox: [number, number, number, number];
  names: string[];
  hws: string[];
  cts: string[];
  nodes: number[];   // delta-encoded lat/lng pairs, scaled 1e5
  edges: number[];   // a, b, hw, name, oneway, ct+1, interiorCount, ...deltas
  signals: number[]; // delta-encoded node indices with signals/marked crossings
}

export type RouteProfile = 'safest' | 'balanced';

/** Fetch and decode the graph artifact shipped in public/data. */
export async function fetchStreetGraph(baseUrl = '/'): Promise<StreetGraph> {
  const res = await fetch(`${baseUrl}data/street-graph.json`);
  if (!res.ok) throw new Error(`Street graph unavailable: ${res.status} ${res.statusText}`);
  return new StreetGraph(await res.json() as EncodedGraph);
}

// ========== Cost model ==========

/** Per-meter weight by PBOT ConnectionType (the facility actually present). */
const PBOT_WEIGHTS: Record<RouteProfile, Record<string, number>> = {
  safest: {
    'MUP_P': 0.15, 'MUP_U': 0.2, 'BL-MUP': 0.15,
    'NG': 0.4, 'BBL': 0.5,
    'BL': 1.0, 'SR_LT': 1.2, 'SC': 1.3, 'BL-SR_LT': 1.1,
    'SR_MT': 8.0, 'BL-SR_MT': 5.0, 'BL_VHT': 10.0,
    'DC': 2.5, 'SR_DC': 3.0, 'BL-DC': 2.2, 'SR_MT-DC': 10.0,
  },
  balanced: {
    'MUP_P': 0.7, 'MUP_U': 0.75, 'BL-MUP': 0.7,
    'NG': 0.8, 'BBL': 0.8,
    'BL': 0.9, 'SR_LT': 1.0, 'SC': 1.0, 'BL-SR_LT': 0.9,
    'SR_MT': 2.0, 'BL-SR_MT': 1.5, 'BL_VHT': 2.5,
    'DC': 1.3, 'SR_DC': 1.4, 'BL-DC': 1.2, 'SR_MT-DC': 2.5,
  },
};

/** Fallback per-meter weight by OSM highway class (no PBOT facility). */
const HW_WEIGHTS: Record<RouteProfile, Record<string, number>> = {
  safest: {
    cycleway: 0.2, path: 0.5, track: 1.6, pedestrian: 1.6, footway: 2.6,
    living_street: 1.0, residential: 1.4, unclassified: 1.8,
    tertiary: 4.0, tertiary_link: 4.0,
    secondary: 9.0, secondary_link: 9.0,
    primary: 16.0, primary_link: 16.0,
  },
  balanced: {
    cycleway: 0.75, path: 0.95, track: 1.4, pedestrian: 1.4, footway: 2.0,
    living_street: 0.95, residential: 1.0, unclassified: 1.05,
    tertiary: 1.3, tertiary_link: 1.3,
    secondary: 2.2, secondary_link: 2.2,
    primary: 3.2, primary_link: 3.2,
  },
};

const DEFAULT_WEIGHT = 2.0;

/**
 * PBOT tags that describe a *difficulty* rather than a bike facility.
 *
 * These must never make a road cheaper than its OSM class alone would: PBOT
 * flags NE Lombard as "bike lane, difficult connection" and NW Skyline as
 * "shared road, difficult connection", and taking those tags at face value
 * priced a primary truck route at 2.2x instead of 16x — the warning was making
 * the router *prefer* the road it warns about. Facility tags (a real bike lane,
 * greenway or path) still win, since infrastructure genuinely does improve an
 * arterial.
 */
const HAZARD_TAGS = new Set(['DC', 'SR_DC', 'BL-DC', 'SR_MT-DC', 'SR_MT', 'BL_VHT']);

/** Smallest weight in use — keeps the A* heuristic admissible. */
const MIN_WEIGHT = 0.15;

/** Road classes for crossing danger: 0 minor, 1 tertiary, 2 secondary, 3 primary. */
const HW_CLASS: Record<string, number> = {
  primary: 3, primary_link: 3, trunk: 3, trunk_link: 3,
  secondary: 2, secondary_link: 2,
  tertiary: 1, tertiary_link: 1,
};

/** Cost added for crossing a busy road at a junction, by class and control. */
const CROSSING_PENALTY: Record<RouteProfile, { major: number; majorSignal: number; secondary: number; secondarySignal: number }> = {
  safest:   { major: 900, majorSignal: 60, secondary: 400, secondarySignal: 30 },
  balanced: { major: 180, majorSignal: 20, secondary: 80,  secondarySignal: 10 },
};

/** Cost for a sharp direction change (> 60°) at a junction. */
const TURN_COST: Record<RouteProfile, number> = { safest: 50, balanced: 30 };

// ========== Infrastructure tiers (map colouring) ==========

export type InfraTier = 'path' | 'good' | 'lane' | 'caution' | 'avoid' | 'none';

const TIER_FROM_CT: Record<string, InfraTier> = {
  'MUP_P': 'path', 'MUP_U': 'path', 'BL-MUP': 'path',
  'NG': 'good', 'BBL': 'good',
  'BL': 'lane', 'SR_LT': 'lane', 'SC': 'lane', 'BL-SR_LT': 'lane',
  'SR_MT': 'caution', 'BL-SR_MT': 'caution', 'BL_VHT': 'caution',
  'DC': 'avoid', 'SR_DC': 'avoid', 'BL-DC': 'avoid', 'SR_MT-DC': 'avoid',
};

const TIER_FROM_HW: Record<string, InfraTier> = {
  cycleway: 'path', path: 'path', track: 'none', footway: 'none', pedestrian: 'none',
  living_street: 'good', residential: 'none', unclassified: 'none',
  tertiary: 'caution', tertiary_link: 'caution',
  secondary: 'caution', secondary_link: 'caution',
  primary: 'avoid', primary_link: 'avoid',
};

// ========== Loaded graph ==========

export interface RouteStep {
  edge: number;
  forward: boolean;
  /** Index into `coordinates` where this step's geometry begins. */
  coordIndex: number;
}

export interface StreetRoute {
  coordinates: [number, number][];
  /** Infrastructure tier per coordinate, for colour-coded rendering. */
  tiers: InfraTier[];
  distance: number; // meters
  /** Edges traversed, in order, with direction of travel. */
  steps: RouteStep[];
  /** Street name per step (empty string when the way is unnamed). */
  names: string[];
}

export class StreetGraph {
  readonly built: string;
  readonly nodeCount: number;
  readonly edgeCount: number;

  private lat: Float64Array;
  private lng: Float64Array;
  private ea: Int32Array;        // edge → node a
  private eb: Int32Array;        // edge → node b
  private ehw: Int32Array;       // edge → highway class index
  private ename: Int32Array;     // edge → name index
  private eoneway: Int8Array;
  private ect: Int32Array;       // edge → ct index, -1 when none
  private edist: Float64Array;
  private ecoordStart: Int32Array; // offsets into coordLat/coordLng (len+1)
  private coordLat: Float64Array;
  private coordLng: Float64Array;

  private adjStart: Int32Array;  // CSR offsets into adjEdge/adjTo
  private adjEdge: Int32Array;
  private adjTo: Int32Array;

  private nodeClass: Int8Array;  // highest road class incident to the node
  private nodeSignal: Uint8Array;
  private nodeComp: Int32Array;  // connected-component id per node
  private mainComp = 0;          // the component holding the street network

  private names: string[];
  private hws: string[];
  private cts: string[];

  private grid: Map<string, number[]>; // spatial index of edges for snapping

  constructor(data: EncodedGraph) {
    if (data.v !== GRAPH_VERSION) {
      throw new Error(`Street graph version ${data.v} != expected ${GRAPH_VERSION}; re-run npm run fetch-graph`);
    }
    this.built = data.built;
    this.names = data.names;
    this.hws = data.hws;
    this.cts = data.cts;

    // --- nodes ---
    const nodeCount = data.nodes.length / 2;
    this.nodeCount = nodeCount;
    this.lat = new Float64Array(nodeCount);
    this.lng = new Float64Array(nodeCount);
    let alat = 0, alng = 0;
    for (let i = 0; i < nodeCount; i++) {
      alat += data.nodes[i * 2];
      alng += data.nodes[i * 2 + 1];
      this.lat[i] = alat / 1e5;
      this.lng[i] = alng / 1e5;
    }

    // --- edges (two passes: count, then fill) ---
    const raw = data.edges;
    let p = 0;
    let edgeCount = 0;
    let coordTotal = 0;
    while (p < raw.length) {
      const interior = raw[p + 6];
      coordTotal += interior + 2;
      p += 7 + interior * 2;
      edgeCount++;
    }
    this.edgeCount = edgeCount;

    this.ea = new Int32Array(edgeCount);
    this.eb = new Int32Array(edgeCount);
    this.ehw = new Int32Array(edgeCount);
    this.ename = new Int32Array(edgeCount);
    this.eoneway = new Int8Array(edgeCount);
    this.ect = new Int32Array(edgeCount);
    this.edist = new Float64Array(edgeCount);
    this.ecoordStart = new Int32Array(edgeCount + 1);
    this.coordLat = new Float64Array(coordTotal);
    this.coordLng = new Float64Array(coordTotal);

    p = 0;
    let c = 0;
    for (let e = 0; e < edgeCount; e++) {
      const a = raw[p], b = raw[p + 1];
      this.ea[e] = a;
      this.eb[e] = b;
      this.ehw[e] = raw[p + 2];
      this.ename[e] = raw[p + 3];
      this.eoneway[e] = raw[p + 4];
      this.ect[e] = raw[p + 5] - 1;
      const interior = raw[p + 6];
      p += 7;

      this.ecoordStart[e] = c;
      this.coordLat[c] = this.lat[a];
      this.coordLng[c] = this.lng[a];
      c++;
      let cl = Math.round(this.lat[a] * 1e5), cg = Math.round(this.lng[a] * 1e5);
      for (let i = 0; i < interior; i++) {
        cl += raw[p];
        cg += raw[p + 1];
        p += 2;
        this.coordLat[c] = cl / 1e5;
        this.coordLng[c] = cg / 1e5;
        c++;
      }
      this.coordLat[c] = this.lat[b];
      this.coordLng[c] = this.lng[b];
      c++;

      this.edist[e] = computeDistance(this.edgeCoords(e, c));
    }
    this.ecoordStart[edgeCount] = c;

    // --- signals ---
    this.nodeSignal = new Uint8Array(nodeCount);
    let s = 0;
    for (const d of data.signals) {
      s += d;
      if (s < nodeCount) this.nodeSignal[s] = 1;
    }

    // --- adjacency (CSR) + node road class ---
    this.nodeClass = new Int8Array(nodeCount);
    const degree = new Int32Array(nodeCount);
    for (let e = 0; e < edgeCount; e++) {
      const ow = this.eoneway[e];
      if (ow !== -1) degree[this.ea[e]]++;
      if (ow !== 1) degree[this.eb[e]]++;
      const cls = HW_CLASS[this.hws[this.ehw[e]]] ?? 0;
      if (cls > this.nodeClass[this.ea[e]]) this.nodeClass[this.ea[e]] = cls;
      if (cls > this.nodeClass[this.eb[e]]) this.nodeClass[this.eb[e]] = cls;
    }
    this.adjStart = new Int32Array(nodeCount + 1);
    for (let i = 0; i < nodeCount; i++) this.adjStart[i + 1] = this.adjStart[i] + degree[i];
    const fill = this.adjStart.slice(0, nodeCount);
    this.adjEdge = new Int32Array(this.adjStart[nodeCount]);
    this.adjTo = new Int32Array(this.adjStart[nodeCount]);
    for (let e = 0; e < edgeCount; e++) {
      const ow = this.eoneway[e];
      if (ow !== -1) {
        const i = fill[this.ea[e]]++;
        this.adjEdge[i] = e;
        this.adjTo[i] = this.eb[e];
      }
      if (ow !== 1) {
        const i = fill[this.eb[e]]++;
        this.adjEdge[i] = e;
        this.adjTo[i] = this.ea[e];
      }
    }

    // --- connected components ---
    // OSM carries plenty of footpath islands: the walkways inside a shopping
    // centre's parking lot, mall paths, private campus loops. They touch no
    // street (sidewalks and crossings are deliberately not in the graph), so
    // anything that snaps onto one can never be routed. About 17% of nodes sit
    // in such islands, and a supermarket's map pin lands on one often enough
    // that snapping has to know which edges are actually reachable.
    const parent = new Int32Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) parent[i] = i;
    const find = (x: number): number => {
      let root = x;
      while (parent[root] !== root) root = parent[root];
      while (parent[x] !== root) { const next = parent[x]; parent[x] = root; x = next; }
      return root;
    };
    for (let e = 0; e < edgeCount; e++) {
      // Union undirected: a one-way still connects the places it joins.
      const ra = find(this.ea[e]);
      const rb = find(this.eb[e]);
      if (ra !== rb) parent[ra] = rb;
    }
    this.nodeComp = new Int32Array(nodeCount);
    const compSize = new Int32Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) {
      const root = find(i);
      this.nodeComp[i] = root;
      compSize[root]++;
    }
    for (let i = 0; i < nodeCount; i++) {
      if (compSize[i] > compSize[this.mainComp]) this.mainComp = i;
    }

    // --- spatial index for snapping ---
    // Every cell the geometry passes through is indexed, not just the cells
    // holding vertices: a straight block can span several cells with no
    // vertex in between, and points there must still find the edge.
    this.grid = new Map();
    const addCell = (key: string, e: number) => {
      const arr = this.grid.get(key);
      if (arr) { if (arr[arr.length - 1] !== e) arr.push(e); }
      else this.grid.set(key, [e]);
    };
    for (let e = 0; e < edgeCount; e++) {
      const start = this.ecoordStart[e];
      const end = this.ecoordStart[e + 1];
      for (let i = start; i < end - 1; i++) {
        const lat1 = this.coordLat[i], lng1 = this.coordLng[i];
        const lat2 = this.coordLat[i + 1], lng2 = this.coordLng[i + 1];
        const minLat = Math.floor(Math.min(lat1, lat2) * GRID);
        const maxLat = Math.floor(Math.max(lat1, lat2) * GRID);
        const minLng = Math.floor(Math.min(lng1, lng2) * GRID);
        const maxLng = Math.floor(Math.max(lng1, lng2) * GRID);
        for (let gLat = minLat; gLat <= maxLat; gLat++) {
          for (let gLng = minLng; gLng <= maxLng; gLng++) {
            addCell(`${gLat},${gLng}`, e);
          }
        }
      }
    }
  }

  /** Full coordinate list of an edge, in a→b order. */
  edgeCoords(e: number, endOverride?: number): [number, number][] {
    const start = this.ecoordStart[e];
    const end = endOverride ?? this.ecoordStart[e + 1];
    const out: [number, number][] = [];
    for (let i = start; i < end; i++) out.push([this.coordLat[i], this.coordLng[i]]);
    return out;
  }

  edgeName(e: number): string {
    return this.names[this.ename[e]] ?? '';
  }

  /** OSM highway class of an edge (e.g. "residential", "cycleway"). */
  edgeHighway(e: number): string {
    return this.hws[this.ehw[e]] ?? '';
  }

  /** Travel restriction: 0 both ways, 1 a→b only, -1 b→a only. */
  edgeOneway(e: number): number {
    return this.eoneway[e];
  }

  /** PBOT ConnectionType carried by an edge, or null where it has none. */
  edgeConnectionType(e: number): string | null {
    const ct = this.ect[e];
    return ct >= 0 ? this.cts[ct] : null;
  }

  /** Cost multiplier applied per metre of this edge (exposed for tests/debug). */
  edgeWeight(e: number, profile: RouteProfile = 'safest'): number {
    return this.weight(e, profile);
  }

  edgeTier(e: number): InfraTier {
    const ct = this.ect[e];
    if (ct >= 0) {
      const tier = TIER_FROM_CT[this.cts[ct]];
      if (tier) return tier;
    }
    return TIER_FROM_HW[this.hws[this.ehw[e]]] ?? 'none';
  }

  /** Whether an edge is part of the connected street network (see the
   *  component pass in the constructor) rather than an unreachable island. */
  edgeReachable(e: number): boolean {
    return this.nodeComp[this.ea[e]] === this.mainComp;
  }

  private weight(e: number, profile: RouteProfile): number {
    const hwWeight = HW_WEIGHTS[profile][this.hws[this.ehw[e]]] ?? DEFAULT_WEIGHT;
    const ct = this.ect[e];
    if (ct < 0) return hwWeight;

    const tag = this.cts[ct];
    const w = PBOT_WEIGHTS[profile][tag];
    if (w === undefined) return hwWeight;
    // A difficulty flag can only make a road worse, never better
    return HAZARD_TAGS.has(tag) ? Math.max(w, hwWeight) : w;
  }

  /** Cost of passing through `node` from edge `from` onto edge `to`. */
  private junctionCost(node: number, from: number, to: number, profile: RouteProfile): number {
    let cost = 0;

    // Crossing a busier road than either of the two edges we travel on
    const nodeCls = this.nodeClass[node];
    if (nodeCls >= 2) {
      const fromCls = HW_CLASS[this.hws[this.ehw[from]]] ?? 0;
      const toCls = HW_CLASS[this.hws[this.ehw[to]]] ?? 0;
      if (fromCls < nodeCls && toCls < nodeCls) {
        const p = CROSSING_PENALTY[profile];
        const signal = this.nodeSignal[node] === 1;
        cost += nodeCls >= 3
          ? (signal ? p.majorSignal : p.major)
          : (signal ? p.secondarySignal : p.secondary);
      }
    }

    // Sharp turn
    const inB = this.travelBearing(from, node, false);
    const outB = this.travelBearing(to, node, true);
    if (inB !== null && outB !== null) {
      let diff = Math.abs(outB - inB);
      if (diff > 180) diff = 360 - diff;
      if (diff > 60) cost += TURN_COST[profile];
    }
    return cost;
  }

  /** Bearing of travel entering (`leaving=false`) or leaving (`true`) `node` on edge `e`. */
  private travelBearing(e: number, node: number, leaving: boolean): number | null {
    const start = this.ecoordStart[e];
    const end = this.ecoordStart[e + 1] - 1;
    if (end - start < 1) return null;
    const atA = this.ea[e] === node;
    if (leaving) {
      return atA
        ? bearing([this.coordLat[start], this.coordLng[start]], [this.coordLat[start + 1], this.coordLng[start + 1]])
        : bearing([this.coordLat[end], this.coordLng[end]], [this.coordLat[end - 1], this.coordLng[end - 1]]);
    }
    return atA
      ? bearing([this.coordLat[start + 1], this.coordLng[start + 1]], [this.coordLat[start], this.coordLng[start]])
      : bearing([this.coordLat[end - 1], this.coordLng[end - 1]], [this.coordLat[end], this.coordLng[end]]);
  }

  /** Nearest ridable edge to a point, with the projected position along it.
   *  Only edges on the connected network are considered — snapping to an
   *  island (a parking-lot footpath, say) yields a point nothing can reach. */
  snap(lat: number, lng: number, maxDist = 500): SnapPoint | null {
    const bLat = Math.floor(lat * GRID);
    const bLng = Math.floor(lng * GRID);
    let best: SnapPoint | null = null;
    let bestD = maxDist;

    for (let ring = 0; ring <= 5; ring++) {
      for (let dl = -ring; dl <= ring; dl++) {
        for (let dn = -ring; dn <= ring; dn++) {
          // only the outer ring on later passes
          if (ring > 0 && Math.abs(dl) !== ring && Math.abs(dn) !== ring) continue;
          const cell = this.grid.get(`${bLat + dl},${bLng + dn}`);
          if (!cell) continue;
          for (const e of cell) {
            if (!this.edgeReachable(e)) continue;
            const start = this.ecoordStart[e];
            const end = this.ecoordStart[e + 1];
            let along = 0;
            for (let i = start; i < end - 1; i++) {
              const a: [number, number] = [this.coordLat[i], this.coordLng[i]];
              const b: [number, number] = [this.coordLat[i + 1], this.coordLng[i + 1]];
              const segLen = haversine(a, b);
              const r = pointToSegProject([lat, lng], a, b);
              if (r.distance < bestD) {
                bestD = r.distance;
                best = { edge: e, point: r.closest, distFromA: along + r.t * segLen, distance: r.distance };
              }
              along += segLen;
            }
          }
        }
      }
      // Stop expanding once we have a hit comfortably inside the searched ring
      if (best && bestD < (ring + 1) * 110) break;
    }
    return best;
  }

  /**
   * Route between two points. Both ends snap to the nearest edge and the
   * geometry is trimmed to the exact projected positions, so routes start and
   * end where the rider actually is rather than at the nearest intersection.
   */
  route(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
    profile: RouteProfile = 'safest',
  ): StreetRoute | null {
    const s = this.snap(from.lat, from.lng);
    const t = this.snap(to.lat, to.lng);
    if (!s || !t) return null;

    if (s.edge === t.edge) {
      const same = this.sameEdgeRoute(s, t);
      if (same) return same;
    }

    const sLen = this.edist[s.edge];
    const tLen = this.edist[t.edge];

    // Seed both ends of the start edge with the cost of reaching them, and
    // allow finishing at either end of the destination edge.
    const sources: { node: number; cost: number; fromEnd: 'a' | 'b' }[] = [];
    if (this.eoneway[s.edge] !== 1) {
      sources.push({ node: this.ea[s.edge], cost: s.distFromA * this.weight(s.edge, profile), fromEnd: 'a' });
    }
    if (this.eoneway[s.edge] !== -1) {
      sources.push({ node: this.eb[s.edge], cost: (sLen - s.distFromA) * this.weight(s.edge, profile), fromEnd: 'b' });
    }
    const targets: { node: number; cost: number; toEnd: 'a' | 'b' }[] = [];
    if (this.eoneway[t.edge] !== -1) {
      targets.push({ node: this.ea[t.edge], cost: t.distFromA * this.weight(t.edge, profile), toEnd: 'a' });
    }
    if (this.eoneway[t.edge] !== 1) {
      targets.push({ node: this.eb[t.edge], cost: (tLen - t.distFromA) * this.weight(t.edge, profile), toEnd: 'b' });
    }
    if (sources.length === 0 || targets.length === 0) return null;

    const search = this.astar(sources, targets, profile);
    if (!search) return null;

    return this.assemble(s, t, search.path, search.startNode);
  }

  /** A* over the CSR adjacency; returns the edge path to the best target. */
  private astar(
    sources: { node: number; cost: number }[],
    targets: { node: number; cost: number; toEnd: 'a' | 'b' }[],
    profile: RouteProfile,
  ): { path: number[]; startNode: number } | null {
    const g = new Map<number, number>();
    const cameFrom = new Map<number, { node: number; edge: number }>();
    const closed = new Set<number>();
    const heap = new BinaryHeap();

    const targetNodes = targets.map(t => t.node);
    const h = (n: number): number => {
      let best = Infinity;
      for (const tn of targetNodes) {
        const d = haversine([this.lat[n], this.lng[n]], [this.lat[tn], this.lng[tn]]);
        if (d < best) best = d;
      }
      return best * MIN_WEIGHT;
    };

    for (const src of sources) {
      if (src.cost < (g.get(src.node) ?? Infinity)) {
        g.set(src.node, src.cost);
        heap.push(src.cost + h(src.node), src.node);
      }
    }

    let bestTotal = Infinity;
    let bestTarget: typeof targets[number] | null = null;
    const MAX_SETTLED = 300_000;
    let settled = 0;

    while (heap.size > 0) {
      const cur = heap.pop();
      if (closed.has(cur)) continue;
      closed.add(cur);
      if (++settled > MAX_SETTLED) break;

      const gc = g.get(cur)!;
      // Everything still in the frontier costs at least gc, so once the best
      // finished total beats it we cannot improve.
      if (gc >= bestTotal) break;

      for (const t of targets) {
        if (t.node === cur) {
          const total = gc + t.cost;
          if (total < bestTotal) { bestTotal = total; bestTarget = t; }
        }
      }

      const from = this.adjStart[cur];
      const to = this.adjStart[cur + 1];
      const prevEdge = cameFrom.get(cur)?.edge ?? -1;
      for (let i = from; i < to; i++) {
        const e = this.adjEdge[i];
        const nxt = this.adjTo[i];
        if (closed.has(nxt)) continue;
        let cost = this.edist[e] * this.weight(e, profile);
        if (prevEdge >= 0) cost += this.junctionCost(cur, prevEdge, e, profile);
        const ng = gc + cost;
        if (ng >= (g.get(nxt) ?? Infinity)) continue;
        g.set(nxt, ng);
        cameFrom.set(nxt, { node: cur, edge: e });
        heap.push(ng + h(nxt), nxt);
      }
    }

    if (!bestTarget) return null;

    const path: number[] = [];
    let c = bestTarget.node;
    while (cameFrom.has(c)) {
      const step = cameFrom.get(c)!;
      path.push(step.edge);
      c = step.node;
    }
    path.reverse();
    // `c` has walked back to whichever seeded source the path came from
    return { path, startNode: c };
  }

  /** Build the final geometry, trimming the first and last edges to the snaps. */
  private assemble(
    s: SnapPoint,
    t: SnapPoint,
    rawPath: number[],
    startNode: number,
  ): StreetRoute {
    const steps: RouteStep[] = [];
    const coordinates: [number, number][] = [];
    const tiers: InfraTier[] = [];
    const names: string[] = [];

    const path = rawPath.slice();
    let firstNode = startNode;

    // The snapped start/end edges are emitted separately (trimmed to the snap
    // points), so drop them from the path when A* also traversed them —
    // otherwise the route would ride the same block twice.
    if (path.length > 0 && path[0] === s.edge) {
      path.shift();
      firstNode = firstNode === this.ea[s.edge] ? this.eb[s.edge] : this.ea[s.edge];
    }
    if (path.length > 0 && path[path.length - 1] === t.edge) {
      path.pop();
    }

    const startForward = firstNode === this.eb[s.edge];
    const startCoords = trimEdge(this.edgeCoords(s.edge), s.point, startForward ? 'after' : 'before');
    steps.push({ edge: s.edge, forward: startForward, coordIndex: 0 });
    pushRun(coordinates, startForward ? startCoords : startCoords.reverse());
    names.push(this.edgeName(s.edge));
    fillTiers(tiers, coordinates.length, this.edgeTier(s.edge));

    let node = firstNode;
    for (const e of path) {
      const forward = this.ea[e] === node;
      const coords = this.edgeCoords(e);
      steps.push({ edge: e, forward, coordIndex: Math.max(0, coordinates.length - 1) });
      pushRun(coordinates, forward ? coords : coords.slice().reverse());
      names.push(this.edgeName(e));
      fillTiers(tiers, coordinates.length, this.edgeTier(e));
      node = forward ? this.eb[e] : this.ea[e];
    }

    // Final edge: enter at `node`, stop at the destination snap point
    const endForward = node === this.ea[t.edge];
    const endCoords = trimEdge(this.edgeCoords(t.edge), t.point, endForward ? 'before' : 'after');
    steps.push({ edge: t.edge, forward: endForward, coordIndex: Math.max(0, coordinates.length - 1) });
    pushRun(coordinates, endForward ? endCoords : endCoords.slice().reverse());
    names.push(this.edgeName(t.edge));
    fillTiers(tiers, coordinates.length, this.edgeTier(t.edge));

    return { coordinates, tiers, distance: computeDistance(coordinates), steps, names };
  }

  /** Both points on one edge — ride the sub-segment directly. */
  private sameEdgeRoute(s: SnapPoint, t: SnapPoint): StreetRoute | null {
    const forward = t.distFromA >= s.distFromA;
    if (forward && this.eoneway[s.edge] === -1) return null;
    if (!forward && this.eoneway[s.edge] === 1) return null;

    const coords = this.edgeCoords(s.edge);
    const lo = forward ? s.point : t.point;
    const hi = forward ? t.point : s.point;
    let sub = trimEdge(coords, lo, 'after');
    sub = trimEdge(sub, hi, 'before');
    const out = forward ? sub : sub.slice().reverse();
    if (out.length < 2) return null;

    const tier = this.edgeTier(s.edge);
    return {
      coordinates: out,
      tiers: out.map(() => tier),
      distance: computeDistance(out),
      steps: [{ edge: s.edge, forward, coordIndex: 0 }],
      names: [this.edgeName(s.edge)],
    };
  }
}

export interface SnapPoint {
  edge: number;
  point: [number, number];
  distFromA: number;
  distance: number;
}

// ========== Helpers ==========

const GRID = 1000; // ~110 m cells
function gridKey(lat: number, lng: number): string {
  return `${Math.floor(lat * GRID)},${Math.floor(lng * GRID)}`;
}

/** Keep the part of a polyline before or after the projection of `point`.
 *  The cut point replaces a vertex it coincides with, so the result never
 *  contains a zero-length segment (which would have an undefined bearing). */
function trimEdge(coords: [number, number][], point: [number, number], keep: 'before' | 'after'): [number, number][] {
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const r = pointToSegProject(point, coords[i], coords[i + 1]);
    if (r.distance < bestD) { bestD = r.distance; bestI = i; }
  }
  const COINCIDENT = 0.5; // meters
  if (keep === 'before') {
    const head = coords.slice(0, bestI + 1);
    if (head.length > 0 && haversine(head[head.length - 1], point) < COINCIDENT) {
      head[head.length - 1] = point;
    } else {
      head.push(point);
    }
    return head;
  }
  const tail = coords.slice(bestI + 1);
  if (tail.length > 0 && haversine(tail[0], point) < COINCIDENT) {
    tail[0] = point;
  } else {
    tail.unshift(point);
  }
  return tail;
}

/** Append coords, dropping a duplicated junction point. */
function pushRun(out: [number, number][], run: [number, number][]): void {
  let start = 0;
  if (out.length > 0 && run.length > 0) {
    const last = out[out.length - 1];
    if (haversine(last, run[0]) < 1) start = 1;
  }
  for (let i = start; i < run.length; i++) out.push(run[i]);
}

function fillTiers(tiers: InfraTier[], upto: number, tier: InfraTier): void {
  while (tiers.length < upto) tiers.push(tier);
}

/** Min-heap over (priority, value) pairs. */
class BinaryHeap {
  private pri: number[] = [];
  private val: number[] = [];

  get size(): number { return this.pri.length; }

  push(priority: number, value: number): void {
    this.pri.push(priority);
    this.val.push(value);
    let i = this.pri.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.pri[i] >= this.pri[p]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.val[0];
    const lastPri = this.pri.pop()!;
    const lastVal = this.val.pop()!;
    if (this.pri.length > 0) {
      this.pri[0] = lastPri;
      this.val[0] = lastVal;
      let i = 0;
      for (;;) {
        let s = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < this.pri.length && this.pri[l] < this.pri[s]) s = l;
        if (r < this.pri.length && this.pri[r] < this.pri[s]) s = r;
        if (s === i) break;
        this.swap(i, s);
        i = s;
      }
    }
    return top;
  }

  private swap(i: number, j: number): void {
    const p = this.pri[i]; this.pri[i] = this.pri[j]; this.pri[j] = p;
    const v = this.val[i]; this.val[i] = this.val[j]; this.val[j] = v;
  }
}
