/**
 * Phase 2 feasibility spike: client-side routing over a build-time graph.
 *
 * Fetches Portland's bikeable street network from OSM (Overpass), builds a
 * routable graph (ways split at intersections), conflates PBOT bike
 * infrastructure onto edges, measures compact-encoded payload size, and
 * prototypes A* against the golden-route corpus.
 *
 * Read-only exploration — writes nothing into public/. Raw Overpass response
 * is cached in the OS temp dir so re-runs don't re-hit the API.
 *
 * Run: npx tsx scripts/spike-osm-graph.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { gzipSync } from 'zlib';
import { haversine, computeDistance, pointToSegDist } from '../src/geo';
import { SCENARIOS } from '../src/route-scenarios';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const BBOX = '45.43,-122.83,45.60,-122.47'; // same as busy-roads fetch
const CACHE = resolve(tmpdir(), 'pedalpdx-spike-osm-raw.json');
const root = resolve(import.meta.dirname, '..');

const QUERY = `
[out:json][bbox:${BBOX}][timeout:300];
(
  way["highway"~"^(primary|secondary|tertiary|unclassified|residential|living_street|cycleway|path|track|pedestrian|primary_link|secondary_link|tertiary_link)$"]["access"!~"^(private|no)$"]["area"!="yes"]["bicycle"!="no"];
  way["highway"="footway"]["footway"!~"^(sidewalk|crossing)$"]["access"!~"^(private|no)$"]["bicycle"!="no"];
);
out geom;
`;

interface OverpassWay {
  type: string;
  id: number;
  tags?: Record<string, string>;
  nodes?: number[];
  geometry?: { lat: number; lon: number }[];
}

interface GraphEdge {
  a: number;             // node index
  b: number;             // node index
  coords: [number, number][];
  dist: number;
  hw: string;
  name: string;
  oneway: number;        // 0 = both, 1 = a→b only, -1 = b→a only
  pbotCt: string | null; // conflated PBOT ConnectionType
}

async function fetchOsm(): Promise<OverpassWay[]> {
  if (existsSync(CACHE)) {
    console.log(`Using cached Overpass response: ${CACHE}`);
    return JSON.parse(readFileSync(CACHE, 'utf8')).elements;
  }
  console.log('Querying Overpass (may take a minute)...');
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: `data=${encodeURIComponent(QUERY)}`,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Overpass returns 406 to Node's default fetch headers
      'Accept': 'application/json',
      'User-Agent': 'PedalPDX-spike/1.0 (github.com/ahosokawa/bike-portland)',
    },
  });
  if (!res.ok) throw new Error(`Overpass error: ${res.status} ${res.statusText}`);
  const text = await res.text();
  writeFileSync(CACHE, text);
  console.log(`Cached raw response (${(Buffer.byteLength(text) / 1e6).toFixed(1)} MB)`);
  return JSON.parse(text).elements;
}

// ========== Graph construction ==========

function buildGraph(ways: OverpassWay[]) {
  const t0 = performance.now();

  // Count node usage to find intersections (nodes shared between ways)
  const nodeUse = new Map<number, number>();
  for (const w of ways) {
    if (w.type !== 'way' || !w.nodes || !w.geometry) continue;
    for (const n of w.nodes) nodeUse.set(n, (nodeUse.get(n) || 0) + 1);
  }

  const nodeIndex = new Map<number, number>(); // osm node id → graph node idx
  const nodeCoords: [number, number][] = [];
  const edges: GraphEdge[] = [];

  function graphNode(osmId: number, lat: number, lng: number): number {
    let idx = nodeIndex.get(osmId);
    if (idx === undefined) {
      idx = nodeCoords.length;
      nodeIndex.set(osmId, idx);
      nodeCoords.push([lat, lng]);
    }
    return idx;
  }

  for (const w of ways) {
    if (w.type !== 'way' || !w.nodes || !w.geometry) continue;
    if (w.nodes.length !== w.geometry.length || w.nodes.length < 2) continue;
    const tags = w.tags || {};
    const oneway =
      tags.oneway === 'yes' || tags.oneway === '1' ? 1 :
      tags.oneway === '-1' ? -1 : 0;
    // Cyclists may legally ride against oneway on streets with contraflow lanes
    const contraflow = /opposite/.test(tags['cycleway'] || '') || /opposite/.test(tags['cycleway:left'] || '');
    const effOneway = oneway !== 0 && contraflow ? 0 : oneway;

    let segStart = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      const isCut = i === w.nodes.length - 1 || (nodeUse.get(w.nodes[i]) || 0) >= 2;
      if (!isCut) continue;

      const coords: [number, number][] = [];
      for (let j = segStart; j <= i; j++) {
        coords.push([w.geometry[j].lat, w.geometry[j].lon]);
      }
      const a = graphNode(w.nodes[segStart], coords[0][0], coords[0][1]);
      const b = graphNode(w.nodes[i], coords[coords.length - 1][0], coords[coords.length - 1][1]);
      if (a !== b) {
        edges.push({
          a, b, coords,
          dist: computeDistance(coords),
          hw: tags.highway || '',
          name: tags.name || '',
          oneway: effOneway,
          pbotCt: null,
        });
      }
      segStart = i;
    }
  }

  const ms = performance.now() - t0;
  return { nodeCoords, edges, buildMs: ms };
}

// ========== PBOT conflation ==========

function conflatePbot(edges: GraphEdge[]) {
  const t0 = performance.now();
  const pbot = JSON.parse(readFileSync(resolve(root, 'public/data/pbot-routes.geojson'), 'utf8'));

  // Grid-index PBOT segments (~110m cells)
  interface Seg { a: [number, number]; b: [number, number]; ct: string }
  const grid = new Map<string, Seg[]>();
  const gk = (lat: number, lng: number) => `${Math.floor(lat * 1000)},${Math.floor(lng * 1000)}`;

  for (const f of pbot.features) {
    const geom = f.geometry;
    if (!geom) continue;
    const ct = (f.properties?.ConnectionType || '').toUpperCase();
    if (!ct) continue;
    const lines: number[][][] =
      geom.type === 'MultiLineString' ? geom.coordinates :
      geom.type === 'LineString' ? [geom.coordinates] : [];
    for (const line of lines) {
      for (let i = 0; i < line.length - 1; i++) {
        const seg: Seg = { a: [line[i][1], line[i][0]], b: [line[i + 1][1], line[i + 1][0]], ct };
        const cells = new Set([
          gk(seg.a[0], seg.a[1]), gk(seg.b[0], seg.b[1]),
          gk((seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2),
        ]);
        for (const c of cells) {
          const arr = grid.get(c);
          if (arr) arr.push(seg); else grid.set(c, [seg]);
        }
      }
    }
  }

  const MATCH_DIST = 12; // meters
  let matched = 0;

  function nearestCt(p: [number, number]): string | null {
    const bLat = Math.floor(p[0] * 1000);
    const bLng = Math.floor(p[1] * 1000);
    let best: string | null = null;
    let bestD = MATCH_DIST;
    for (let dl = -1; dl <= 1; dl++) {
      for (let dn = -1; dn <= 1; dn++) {
        const segs = grid.get(`${bLat + dl},${bLng + dn}`);
        if (!segs) continue;
        for (const s of segs) {
          const d = pointToSegDist(p, s.a, s.b);
          if (d < bestD) { bestD = d; best = s.ct; }
        }
      }
    }
    return best;
  }

  for (const e of edges) {
    // Sample the edge: endpoints, midpoint, and every 3rd vertex
    const samples: [number, number][] = [e.coords[0], e.coords[e.coords.length - 1]];
    const mid = e.coords[Math.floor(e.coords.length / 2)];
    samples.push(mid);
    for (let i = 3; i < e.coords.length - 1; i += 3) samples.push(e.coords[i]);

    const hits: string[] = [];
    for (const s of samples) {
      const ct = nearestCt(s);
      if (ct) hits.push(ct);
    }
    // Majority of samples must match PBOT infrastructure
    if (hits.length * 2 > samples.length) {
      const counts = new Map<string, number>();
      for (const h of hits) counts.set(h, (counts.get(h) || 0) + 1);
      e.pbotCt = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
      matched++;
    }
  }

  return { matched, conflateMs: performance.now() - t0 };
}

// ========== Compact encoding + size measurement ==========

function measureEncoding(nodeCoords: [number, number][], edges: GraphEdge[]) {
  // String tables
  const names: string[] = [];
  const nameIdx = new Map<string, number>();
  const hws: string[] = [];
  const hwIdx = new Map<string, number>();
  const cts: string[] = [];
  const ctIdx = new Map<string, number>();
  const intern = (v: string, table: string[], idx: Map<string, number>) => {
    let i = idx.get(v);
    if (i === undefined) { i = table.length; idx.set(v, i); table.push(v); }
    return i;
  };

  // Nodes: lat/lng * 1e5 as delta-encoded ints
  const nodeArr: number[] = [];
  let plat = 0, plng = 0;
  for (const [lat, lng] of nodeCoords) {
    const il = Math.round(lat * 1e5), ig = Math.round(lng * 1e5);
    nodeArr.push(il - plat, ig - plng);
    plat = il; plng = ig;
  }

  // Edges: [a, b, hwIdx, nameIdx, oneway, ctIdx(+1, 0=none), nCoords, ...deltaCoords]
  // Geometry deltas relative to the edge's first point (which is node a's coord)
  const edgeArr: number[] = [];
  for (const e of edges) {
    edgeArr.push(
      e.a, e.b,
      intern(e.hw, hws, hwIdx),
      intern(e.name, names, nameIdx),
      e.oneway,
      e.pbotCt ? intern(e.pbotCt, cts, ctIdx) + 1 : 0,
      e.coords.length - 2, // interior points only; endpoints come from nodes
    );
    let cl = Math.round(e.coords[0][0] * 1e5), cg = Math.round(e.coords[0][1] * 1e5);
    for (let i = 1; i < e.coords.length - 1; i++) {
      const il = Math.round(e.coords[i][0] * 1e5), ig = Math.round(e.coords[i][1] * 1e5);
      edgeArr.push(il - cl, ig - cg);
      cl = il; cg = ig;
    }
  }

  const payload = JSON.stringify({ v: 1, names, hws, cts, nodes: nodeArr, edges: edgeArr });
  const raw = Buffer.byteLength(payload);
  const gz = gzipSync(Buffer.from(payload), { level: 9 }).length;
  return { rawMB: raw / 1e6, gzMB: gz / 1e6, nameCount: names.length };
}

// ========== A* prototype ==========

const PBOT_WEIGHTS: Record<string, number> = {
  'MUP_P': 0.15, 'MUP_U': 0.2, 'BL-MUP': 0.15,
  'NG': 0.5, 'BBL': 0.5,
  'BL': 1.2, 'SR_LT': 1.5, 'SC': 1.5, 'BL-SR_LT': 1.4,
  'SR_MT': 12.0, 'BL-SR_MT': 10.0, 'BL_VHT': 15.0,
  'DC': 3.0, 'SR_DC': 3.5, 'BL-DC': 2.5, 'SR_MT-DC': 15.0,
};

const HW_WEIGHTS: Record<string, number> = {
  cycleway: 0.15, path: 0.35, footway: 2.5, pedestrian: 1.5, track: 1.5,
  living_street: 1.2, residential: 1.6, unclassified: 2.0, service: 2.5,
  tertiary: 5, tertiary_link: 5, secondary: 10, secondary_link: 10,
  primary: 18, primary_link: 18,
};

const MIN_W = 0.15;

function edgeWeight(e: GraphEdge): number {
  if (e.pbotCt && PBOT_WEIGHTS[e.pbotCt] !== undefined) return PBOT_WEIGHTS[e.pbotCt];
  return HW_WEIGHTS[e.hw] ?? 3.0;
}

function buildAdjacency(nodeCount: number, edges: GraphEdge[]) {
  const adj: { edge: number; to: number; fwd: boolean }[][] = Array.from({ length: nodeCount }, () => []);
  edges.forEach((e, i) => {
    if (e.oneway !== -1) adj[e.a].push({ edge: i, to: e.b, fwd: true });
    if (e.oneway !== 1) adj[e.b].push({ edge: i, to: e.a, fwd: false });
  });
  return adj;
}

function astar(
  nodeCoords: [number, number][],
  edges: GraphEdge[],
  adj: ReturnType<typeof buildAdjacency>,
  start: number,
  goal: number,
): { dist: number; cost: number; edgePath: number[] } | null {
  const g = new Map<number, number>();
  const distAlong = new Map<number, number>();
  const from = new Map<number, { parent: number; edge: number }>();
  const closed = new Set<number>();
  const heap: [number, number][] = [];
  const push = (f: number, n: number) => {
    heap.push([f, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[i][0] >= heap[p][0]) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
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
  };

  const h = (n: number) => haversine(nodeCoords[n], nodeCoords[goal]) * MIN_W;
  g.set(start, 0);
  distAlong.set(start, 0);
  push(h(start), start);

  while (heap.length) {
    const cur = pop();
    if (cur === goal) break;
    if (closed.has(cur)) continue;
    closed.add(cur);
    const gc = g.get(cur)!;
    for (const { edge, to } of adj[cur]) {
      if (closed.has(to)) continue;
      const e = edges[edge];
      const ng = gc + e.dist * edgeWeight(e);
      if (ng >= (g.get(to) ?? Infinity)) continue;
      g.set(to, ng);
      distAlong.set(to, distAlong.get(cur)! + e.dist);
      from.set(to, { parent: cur, edge });
      push(ng + h(to), to);
    }
  }

  if (!from.has(goal)) return null;
  const edgePath: number[] = [];
  let c = goal;
  while (from.has(c)) {
    const { parent, edge } = from.get(c)!;
    edgePath.push(edge);
    c = parent;
  }
  edgePath.reverse();
  return { dist: distAlong.get(goal)!, cost: g.get(goal)!, edgePath };
}

// ========== Main ==========

async function main(): Promise<void> {
  const ways = await fetchOsm();
  console.log(`\nOSM ways fetched: ${ways.length}`);

  const { nodeCoords, edges, buildMs } = buildGraph(ways);
  console.log(`Graph: ${nodeCoords.length} nodes, ${edges.length} edges (built in ${buildMs.toFixed(0)}ms)`);

  const hwCounts = new Map<string, number>();
  for (const e of edges) hwCounts.set(e.hw, (hwCounts.get(e.hw) || 0) + 1);
  console.log('Edge classes:', [...hwCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));

  const { matched, conflateMs } = conflatePbot(edges);
  console.log(`\nPBOT conflation: ${matched}/${edges.length} edges matched (${((matched / edges.length) * 100).toFixed(1)}%) in ${(conflateMs / 1000).toFixed(1)}s`);

  const enc = measureEncoding(nodeCoords, edges);
  console.log(`\nEncoded payload: ${enc.rawMB.toFixed(2)} MB raw, ${enc.gzMB.toFixed(2)} MB gzipped (${enc.nameCount} unique names)`);
  console.log(`(current PBOT+busy-roads payload for comparison: ~7.4 MB raw)`);

  // A* over the corpus
  console.log('\nA* corpus comparison (current safest distances from fixture recording):');
  const CURRENT_MI: Record<string, number> = {
    'cook-to-redd-safest': 3.02,
    'cook-to-sellwood-safest': 7.24,
    'cook-to-zoiglhaus-safest': 13.27,
    'stjohns-to-peninsula-safest': 4.99,
    'kenton-to-mississippi-safest': 2.77,
    'psu-to-hawthorne-safest': 4.03,
    'alberta-to-moda-safest': 2.81,
    'montavilla-to-laurelhurst-safest': 4.82,
  };

  const adj = buildAdjacency(nodeCoords.length, edges);

  // Simple nearest-node snap via linear grid
  const grid = new Map<string, number[]>();
  nodeCoords.forEach(([lat, lng], i) => {
    const k = `${Math.floor(lat * 1000)},${Math.floor(lng * 1000)}`;
    const arr = grid.get(k);
    if (arr) arr.push(i); else grid.set(k, [i]);
  });
  const snap = (lat: number, lng: number): number => {
    let best = -1, bestD = Infinity;
    const bLat = Math.floor(lat * 1000), bLng = Math.floor(lng * 1000);
    for (let dl = -3; dl <= 3; dl++) {
      for (let dn = -3; dn <= 3; dn++) {
        for (const i of grid.get(`${bLat + dl},${bLng + dn}`) || []) {
          const d = haversine([lat, lng], nodeCoords[i]);
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    return best;
  };

  for (const s of SCENARIOS.filter(s => s.profile === 'safest')) {
    const a = snap(s.from.lat, s.from.lng);
    const b = snap(s.to.lat, s.to.lng);
    if (a < 0 || b < 0) { console.log(`  ${s.name}: SNAP FAILED`); continue; }
    const t0 = performance.now();
    const r = astar(nodeCoords, edges, adj, a, b);
    const ms = performance.now() - t0;
    if (!r) { console.log(`  ${s.name}: NO PATH`); continue; }
    const mi = r.dist / 1609.34;
    const infra = r.edgePath.filter(i => edges[i].pbotCt || edges[i].hw === 'cycleway' || edges[i].hw === 'path')
      .reduce((sum, i) => sum + edges[i].dist, 0) / r.dist;
    console.log(
      `  ${s.name}: ${mi.toFixed(2)} mi (current ${CURRENT_MI[s.name]}) ` +
      `query=${ms.toFixed(0)}ms infra=${(infra * 100).toFixed(0)}%`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
