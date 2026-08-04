// Spatial index for major roads (from OSM) used to penalize bike route
// gap-bridge edges that cross busy streets without bike infrastructure.

import { haversine, pointToSegDist, bearing as computeBearing } from './geo';

// ========== Types ==========

interface RoadSegment {
  lat1: number; lng1: number;
  lat2: number; lng2: number;
  highway: string;
}

export type BusyRoadSeverity = 'major' | 'secondary';

interface OnewaySegment {
  lat1: number; lng1: number;
  lat2: number; lng2: number;
  bearing: number;  // precomputed bearing of segment
}

// ========== Module state ==========

let segments: RoadSegment[] | null = null;
let grid: Map<string, number[]> | null = null;
let onewayGrid: Map<string, OnewaySegment[]> | null = null;

const MAJOR_TYPES = new Set([
  'trunk', 'primary', 'motorway',
  'trunk_link', 'primary_link', 'motorway_link',
]);

// ========== Indexing ==========

interface BusyRoadsFeatureCollection {
  features: Array<{
    geometry?: { coordinates: number[][] };
    properties?: { highway?: string; oneway?: string };
  }>;
}

export function indexBusyRoads(geojson: BusyRoadsFeatureCollection): void {
  const _segments: RoadSegment[] = [];
  const _grid = new Map<string, number[]>();

  for (const f of geojson.features) {
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    const highway: string = f.properties?.highway || '';

    for (let i = 0; i < coords.length - 1; i++) {
      const [lng1, lat1] = coords[i];
      const [lng2, lat2] = coords[i + 1];
      const idx = _segments.length;
      _segments.push({ lat1, lng1, lat2, lng2, highway });

      // Add to all grid cells this segment touches
      const minLat = Math.floor(Math.min(lat1, lat2) * 1000);
      const maxLat = Math.floor(Math.max(lat1, lat2) * 1000);
      const minLng = Math.floor(Math.min(lng1, lng2) * 1000);
      const maxLng = Math.floor(Math.max(lng1, lng2) * 1000);

      for (let gLat = minLat; gLat <= maxLat; gLat++) {
        for (let gLng = minLng; gLng <= maxLng; gLng++) {
          const key = `${gLat},${gLng}`;
          const arr = _grid.get(key);
          if (arr) arr.push(idx);
          else _grid.set(key, [idx]);
        }
      }
    }
  }

  segments = _segments;
  grid = _grid;

  // Build separate spatial index for one-way road segments
  const _ow = new Map<string, OnewaySegment[]>();

  for (const f of geojson.features) {
    const oneway = f.properties?.oneway;
    if (oneway !== 'yes' && oneway !== '-1') continue;

    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;

    for (let i = 0; i < coords.length - 1; i++) {
      const [lng1, lat1] = coords[i];
      const [lng2, lat2] = coords[i + 1];
      const seg: OnewaySegment = {
        lat1, lng1, lat2, lng2,
        bearing: computeBearing([lat1, lng1], [lat2, lng2]),
      };

      const gLat = Math.floor((lat1 + lat2) / 2 * 1000);
      const gLng = Math.floor((lng1 + lng2) / 2 * 1000);
      for (let dl = -1; dl <= 1; dl++) {
        for (let dn = -1; dn <= 1; dn++) {
          const key = `${gLat + dl},${gLng + dn}`;
          const arr = _ow.get(key);
          if (arr) arr.push(seg);
          else _ow.set(key, [seg]);
        }
      }
    }
  }

  onewayGrid = _ow;
}

// ========== Line segment intersection ==========

// 2D cross product of vectors (a->b) and (a->c) using flat-earth approx
function cross2d(
  aLat: number, aLng: number,
  bLat: number, bLng: number,
  cLat: number, cLng: number,
  cosLat: number,
): number {
  const abLat = bLat - aLat;
  const abLng = (bLng - aLng) * cosLat;
  const acLat = cLat - aLat;
  const acLng = (cLng - aLng) * cosLat;
  return abLat * acLng - abLng * acLat;
}

function segmentsIntersect(
  aLat1: number, aLng1: number, aLat2: number, aLng2: number,
  bLat1: number, bLng1: number, bLat2: number, bLng2: number,
): boolean {
  const cosLat = Math.cos(((aLat1 + aLat2 + bLat1 + bLat2) / 4) * Math.PI / 180);
  const d1 = cross2d(bLat1, bLng1, bLat2, bLng2, aLat1, aLng1, cosLat);
  const d2 = cross2d(bLat1, bLng1, bLat2, bLng2, aLat2, aLng2, cosLat);
  const d3 = cross2d(aLat1, aLng1, aLat2, aLng2, bLat1, bLng1, cosLat);
  const d4 = cross2d(aLat1, aLng1, aLat2, aLng2, bLat2, bLng2, cosLat);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

// ========== Public API ==========

/**
 * Check if a line segment (gap edge) crosses any busy road.
 * Returns the severity of the worst crossing, or null if none.
 */
export function crossesBusyRoad(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): BusyRoadSeverity | null {
  if (!segments || !grid) return null;

  const minLat = Math.floor(Math.min(lat1, lat2) * 1000);
  const maxLat = Math.floor(Math.max(lat1, lat2) * 1000);
  const minLng = Math.floor(Math.min(lng1, lng2) * 1000);
  const maxLng = Math.floor(Math.max(lng1, lng2) * 1000);

  let worstSeverity: BusyRoadSeverity | null = null;
  const checked = new Set<number>();

  for (let gLat = minLat; gLat <= maxLat; gLat++) {
    for (let gLng = minLng; gLng <= maxLng; gLng++) {
      const indices = grid.get(`${gLat},${gLng}`);
      if (!indices) continue;

      for (const idx of indices) {
        if (checked.has(idx)) continue;
        checked.add(idx);

        const seg = segments[idx];
        if (segmentsIntersect(lat1, lng1, lat2, lng2, seg.lat1, seg.lng1, seg.lat2, seg.lng2)) {
          // Skip near-parallel intersections — a gap edge running along a busy
          // road (not across it) shouldn't be penalized as a crossing.  Two
          // slightly-offset parallel lines can produce a shallow-angle
          // intersection that isn't a real perpendicular crossing.
          const cosLat = Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
          const gapDLat = lat2 - lat1;
          const gapDLng = (lng2 - lng1) * cosLat;
          const roadDLat = seg.lat2 - seg.lat1;
          const roadDLng = (seg.lng2 - seg.lng1) * cosLat;
          const dot = gapDLat * roadDLat + gapDLng * roadDLng;
          const gapLen2 = gapDLat * gapDLat + gapDLng * gapDLng;
          const roadLen2 = roadDLat * roadDLat + roadDLng * roadDLng;
          if (gapLen2 > 0 && roadLen2 > 0) {
            const cos2 = (dot * dot) / (gapLen2 * roadLen2);
            if (cos2 > 0.75) continue; // cos²(30°) = 0.75 → nearly parallel, not a real crossing
          }

          if (MAJOR_TYPES.has(seg.highway)) return 'major'; // worst possible, short-circuit
          worstSeverity = 'secondary';
        }
      }
    }
  }

  return worstSeverity;
}

/**
 * Check if a point is near a busy road (within maxDist meters).
 * Returns the severity if near, null otherwise.
 * Used for route classification of non-PBOT segments.
 */
export function nearBusyRoad(lat: number, lng: number, maxDist: number): BusyRoadSeverity | null {
  if (!segments || !grid) return null;

  const bLat = Math.floor(lat * 1000);
  const bLng = Math.floor(lng * 1000);

  let worstSeverity: BusyRoadSeverity | null = null;

  for (let dl = -1; dl <= 1; dl++) {
    for (let dn = -1; dn <= 1; dn++) {
      const indices = grid.get(`${bLat + dl},${bLng + dn}`);
      if (!indices) continue;

      for (const idx of indices) {
        const seg = segments[idx];
        const d = pointToSegDist([lat, lng], [seg.lat1, seg.lng1], [seg.lat2, seg.lng2]);
        if (d <= maxDist) {
          if (MAJOR_TYPES.has(seg.highway)) return 'major';
          worstSeverity = 'secondary';
        }
      }
    }
  }

  return worstSeverity;
}

/**
 * Check if a PBOT edge lies on a one-way street.
 * Returns which direction is allowed:
 *   'forward'  — edge A→B matches traffic flow (suppress B→A)
 *   'reverse'  — edge A→B opposes traffic flow (suppress A→B, keep B→A)
 *   null       — not on a one-way street (keep both directions)
 */
export function onewayDirection(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
  maxDist = 30,
): 'forward' | 'reverse' | null {
  if (!onewayGrid) return null;

  const edgeBearing = computeBearing([lat1, lng1], [lat2, lng2]);

  // Check both endpoints — near highway interchanges, the midpoint can be
  // closer to an I-5 ramp than to the actual street the PBOT edge is on.
  // Only apply one-way if both endpoints agree on the direction.
  const r1 = _closestOneway(lat1, lng1, edgeBearing, maxDist);
  const r2 = _closestOneway(lat2, lng2, edgeBearing, maxDist);

  if (r1 === null || r2 === null) return null;  // at least one endpoint not near a one-way road
  if (r1 !== r2) return null;                   // endpoints disagree (different one-way roads)
  return r1;
}

/** Find the closest parallel one-way segment near a point and return its direction. */
function _closestOneway(
  lat: number, lng: number,
  edgeBearing: number,
  maxDist: number,
): 'forward' | 'reverse' | null {
  if (!onewayGrid) return null;

  const bLat = Math.floor(lat * 1000);
  const bLng = Math.floor(lng * 1000);

  let bestDist = Infinity;
  let bestResult: 'forward' | 'reverse' | null = null;

  for (let dl = -1; dl <= 1; dl++) {
    for (let dn = -1; dn <= 1; dn++) {
      const candidates = onewayGrid.get(`${bLat + dl},${bLng + dn}`);
      if (!candidates) continue;

      for (const seg of candidates) {
        const d = pointToSegDist([lat, lng], [seg.lat1, seg.lng1], [seg.lat2, seg.lng2]);
        if (d > maxDist || d >= bestDist) continue;

        let diff = Math.abs(edgeBearing - seg.bearing);
        if (diff > 180) diff = 360 - diff;
        if (diff < 30 || diff > 150) {
          bestDist = d;
          bestResult = diff < 30 ? 'forward' : 'reverse';
        }
      }
    }
  }

  return bestResult;
}
