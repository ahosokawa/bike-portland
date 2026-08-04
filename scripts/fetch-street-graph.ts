/**
 * Builds the client-side routing graph shipped with the app.
 *
 * Fetches Portland's bikeable street network from OpenStreetMap (Overpass),
 * splits ways at intersections into routable edges, conflates PBOT bike
 * infrastructure onto them, marks signalized/marked crossings, and writes a
 * compact delta-encoded artifact to public/data/street-graph.json.
 *
 * Run: npm run fetch-graph
 *
 * See src/street-graph.ts for the decoder and the routing engine.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { gzipSync } from 'zlib';
import { computeDistance, pointToSegDist } from '../src/geo';
import { GRAPH_VERSION } from '../src/street-graph';
import type { EncodedGraph } from '../src/street-graph';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/** Portland metro bounding box (matches the PBOT/busy-roads fetches). */
const BBOX: [number, number, number, number] = [45.43, -122.83, 45.60, -122.47];
const BBOX_STR = BBOX.join(',');

/** Ways cyclists may legally and sensibly use. Sidewalks/crossings excluded —
 *  they fragment the graph and aren't ridable routes. */
const WAYS_QUERY = `
[out:json][bbox:${BBOX_STR}][timeout:300];
(
  way["highway"~"^(primary|secondary|tertiary|unclassified|residential|living_street|cycleway|path|track|pedestrian|primary_link|secondary_link|tertiary_link)$"]["access"!~"^(private|no)$"]["area"!="yes"]["bicycle"!="no"];
  way["highway"="footway"]["footway"!~"^(sidewalk|crossing)$"]["access"!~"^(private|no)$"]["bicycle"!="no"];
);
out geom;
`;

/** Signalised junctions and marked crossings — these make arterial crossings safe. */
const NODES_QUERY = `
[out:json][bbox:${BBOX_STR}][timeout:300];
(
  node["highway"="traffic_signals"];
  node["highway"="crossing"]["crossing"!~"^(unmarked|informal)$"];
  node["crossing"="traffic_signals"];
);
out ids;
`;

const CACHE_DIR = tmpdir();
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // re-fetch daily
const root = resolve(import.meta.dirname, '..');

interface OverpassWay {
  type: string;
  id: number;
  tags?: Record<string, string>;
  nodes?: number[];
  geometry?: { lat: number; lon: number }[];
}

interface OverpassNode {
  type: string;
  id: number;
}

async function overpass(query: string, cacheName: string): Promise<unknown[]> {
  const cache = resolve(CACHE_DIR, `pedalpdx-${cacheName}.json`);
  if (existsSync(cache) && Date.now() - statSync(cache).mtimeMs < CACHE_MAX_AGE_MS) {
    console.log(`  using cached ${cacheName} (${(statSync(cache).size / 1e6).toFixed(1)} MB)`);
    return JSON.parse(readFileSync(cache, 'utf8')).elements;
  }
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Overpass rejects Node's default fetch headers with 406
      'Accept': 'application/json',
      'User-Agent': 'PedalPDX/1.0 (github.com/ahosokawa/bike-portland)',
    },
  });
  if (!res.ok) throw new Error(`Overpass ${cacheName} failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  writeFileSync(cache, text);
  console.log(`  fetched ${cacheName} (${(Buffer.byteLength(text) / 1e6).toFixed(1)} MB)`);
  return JSON.parse(text).elements;
}

// ========== Graph construction ==========

interface BuiltEdge {
  a: number;
  b: number;
  coords: [number, number][];
  hw: string;
  name: string;
  oneway: number; // 0 both, 1 a→b, -1 b→a
  ct: string | null;
}

function buildGraph(ways: OverpassWay[], signalNodeIds: Set<number>) {
  // A node shared by 2+ ways is an intersection; ways are split there.
  const nodeUse = new Map<number, number>();
  for (const w of ways) {
    if (w.type !== 'way' || !w.nodes || !w.geometry) continue;
    for (const n of w.nodes) nodeUse.set(n, (nodeUse.get(n) || 0) + 1);
  }

  const nodeIndex = new Map<number, number>();
  const nodeCoords: [number, number][] = [];
  const signalNodes = new Set<number>(); // graph indices
  const edges: BuiltEdge[] = [];

  function graphNode(osmId: number, lat: number, lng: number): number {
    let idx = nodeIndex.get(osmId);
    if (idx === undefined) {
      idx = nodeCoords.length;
      nodeIndex.set(osmId, idx);
      nodeCoords.push([lat, lng]);
      if (signalNodeIds.has(osmId)) signalNodes.add(idx);
    }
    return idx;
  }

  for (const w of ways) {
    if (w.type !== 'way' || !w.nodes || !w.geometry) continue;
    if (w.nodes.length !== w.geometry.length || w.nodes.length < 2) continue;

    const tags = w.tags || {};
    let oneway =
      tags.oneway === 'yes' || tags.oneway === '1' ? 1 :
      tags.oneway === '-1' ? -1 : 0;
    // Contraflow bike lanes and oneway:bicycle=no let cyclists ride both ways
    const contraflow =
      tags['oneway:bicycle'] === 'no' ||
      /opposite/.test(tags['cycleway'] || '') ||
      /opposite/.test(tags['cycleway:left'] || '') ||
      /opposite/.test(tags['cycleway:right'] || '');
    if (contraflow) oneway = 0;

    let segStart = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      const isCut = i === w.nodes.length - 1 || (nodeUse.get(w.nodes[i]) || 0) >= 2;
      if (!isCut) continue;

      const coords: [number, number][] = [];
      for (let j = segStart; j <= i; j++) coords.push([w.geometry[j].lat, w.geometry[j].lon]);

      const a = graphNode(w.nodes[segStart], coords[0][0], coords[0][1]);
      const b = graphNode(w.nodes[i], coords[coords.length - 1][0], coords[coords.length - 1][1]);
      if (a !== b) {
        edges.push({ a, b, coords, hw: tags.highway || '', name: tags.name || '', oneway, ct: null });
      }
      segStart = i;
    }
  }

  return { nodeCoords, edges, signalNodes };
}

// ========== PBOT conflation ==========

/** Tag each edge with the PBOT ConnectionType of the bike facility it carries. */
function conflatePbot(edges: BuiltEdge[]): number {
  const pbot = JSON.parse(readFileSync(resolve(root, 'public/data/pbot-routes.geojson'), 'utf8'));

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
          gk(seg.a[0], seg.a[1]),
          gk(seg.b[0], seg.b[1]),
          gk((seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2),
        ]);
        for (const c of cells) {
          const arr = grid.get(c);
          if (arr) arr.push(seg); else grid.set(c, [seg]);
        }
      }
    }
  }

  const MATCH_DIST = 12; // meters — PBOT centerlines vs OSM centerlines

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

  let matched = 0;
  for (const e of edges) {
    const samples: [number, number][] = [
      e.coords[0],
      e.coords[e.coords.length - 1],
      e.coords[Math.floor(e.coords.length / 2)],
    ];
    for (let i = 3; i < e.coords.length - 1; i += 3) samples.push(e.coords[i]);

    const hits: string[] = [];
    for (const s of samples) {
      const ct = nearestCt(s);
      if (ct) hits.push(ct);
    }
    // Require a majority of samples to sit on the facility, so an edge that
    // merely crosses or touches a bike route isn't tagged as carrying it.
    if (hits.length * 2 > samples.length) {
      const counts = new Map<string, number>();
      for (const h of hits) counts.set(h, (counts.get(h) || 0) + 1);
      e.ct = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
      matched++;
    }
  }
  return matched;
}

// ========== Encoding ==========

function encode(
  nodeCoords: [number, number][],
  edges: BuiltEdge[],
  signalNodes: Set<number>,
): EncodedGraph {
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

  // Nodes: lat/lng scaled to 1e5 (~1m) and delta-encoded
  const nodes: number[] = [];
  let plat = 0, plng = 0;
  for (const [lat, lng] of nodeCoords) {
    const il = Math.round(lat * 1e5), ig = Math.round(lng * 1e5);
    nodes.push(il - plat, ig - plng);
    plat = il; plng = ig;
  }

  // Edges: a, b, hw, name, oneway, ct+1 (0 = none), interiorCount, ...deltas.
  // Endpoint coordinates are recovered from the node table.
  const edgeArr: number[] = [];
  for (const e of edges) {
    edgeArr.push(
      e.a, e.b,
      intern(e.hw, hws, hwIdx),
      intern(e.name, names, nameIdx),
      e.oneway,
      e.ct ? intern(e.ct, cts, ctIdx) + 1 : 0,
      e.coords.length - 2,
    );
    let cl = Math.round(e.coords[0][0] * 1e5), cg = Math.round(e.coords[0][1] * 1e5);
    for (let i = 1; i < e.coords.length - 1; i++) {
      const il = Math.round(e.coords[i][0] * 1e5), ig = Math.round(e.coords[i][1] * 1e5);
      edgeArr.push(il - cl, ig - cg);
      cl = il; cg = ig;
    }
  }

  // Signalised nodes as a sorted, delta-encoded index list
  const signals: number[] = [];
  let prev = 0;
  for (const idx of [...signalNodes].sort((a, b) => a - b)) {
    signals.push(idx - prev);
    prev = idx;
  }

  return {
    v: GRAPH_VERSION,
    built: new Date().toISOString().slice(0, 10),
    bbox: BBOX,
    names, hws, cts,
    nodes,
    edges: edgeArr,
    signals,
  };
}

// ========== Main ==========

async function main(): Promise<void> {
  console.log('Fetching OpenStreetMap data...');
  const ways = await overpass(WAYS_QUERY, 'osm-ways') as OverpassWay[];
  const signalEls = await overpass(NODES_QUERY, 'osm-signals') as OverpassNode[];
  const signalIds = new Set(signalEls.filter(n => n.type === 'node').map(n => n.id));
  console.log(`  ${ways.length} ways, ${signalIds.size} signalised/marked crossing nodes`);

  console.log('Building routable graph...');
  const { nodeCoords, edges, signalNodes } = buildGraph(ways, signalIds);
  const totalKm = edges.reduce((s, e) => s + computeDistance(e.coords), 0) / 1000;
  console.log(`  ${nodeCoords.length} nodes, ${edges.length} edges, ${totalKm.toFixed(0)} km of ridable way`);
  console.log(`  ${signalNodes.size} graph nodes are signalised/marked crossings`);

  console.log('Conflating PBOT bike infrastructure...');
  const matched = conflatePbot(edges);
  console.log(`  ${matched} edges carry a PBOT facility (${((matched / edges.length) * 100).toFixed(1)}%)`);

  const graph = encode(nodeCoords, edges, signalNodes);
  const json = JSON.stringify(graph);
  const outPath = resolve(root, 'public/data/street-graph.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, json);

  const raw = Buffer.byteLength(json);
  const gz = gzipSync(Buffer.from(json), { level: 9 }).length;
  console.log(
    `\nWrote ${outPath}\n` +
    `  ${(raw / 1e6).toFixed(2)} MB raw, ${(gz / 1e6).toFixed(2)} MB gzipped over the wire`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
