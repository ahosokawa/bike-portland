// Spatial index for major roads (from OSM) used to penalize bike route
// gap-bridge edges that cross busy streets without bike infrastructure.

import { haversine } from './router';

// ========== Types ==========

interface RoadSegment {
  lat1: number; lng1: number;
  lat2: number; lng2: number;
  highway: string;
}

export type BusyRoadSeverity = 'major' | 'secondary';

// ========== Module state ==========

let segments: RoadSegment[] | null = null;
let grid: Map<string, number[]> | null = null;

const MAJOR_TYPES = new Set([
  'trunk', 'primary', 'motorway',
  'trunk_link', 'primary_link', 'motorway_link',
]);

// ========== Indexing ==========

export function indexBusyRoads(geojson: any): void {
  const _segments: RoadSegment[] = [];
  const _grid = new Map<string, number[]>();

  for (const f of geojson.features) {
    const coords: number[][] = f.geometry?.coordinates;
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

// Point-to-segment distance (flat-earth approx)
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
