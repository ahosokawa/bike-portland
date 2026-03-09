import type { LatLng } from 'leaflet';
import type { RouteResult, TurnInstruction, Waypoint } from './types';

const BROUTER_URL = 'https://brouter.de/brouter';

// Profiles ordered from safest to fastest
export const ROUTE_PROFILES = {
  'safest': { profile: 'fastbike-verylowtraffic', label: 'Bike Paths', description: 'Dedicated bike paths and trails' },
  'safe': { profile: 'trekking', label: 'Low Traffic', description: 'Prefer quiet streets and bike lanes' },
  'balanced': { profile: 'fastbike-lowtraffic', label: 'Direct', description: 'Shortest reasonable route' },
} as const;

export type RouteProfileKey = keyof typeof ROUTE_PROFILES;

let currentProfile: RouteProfileKey = 'safe';

export function setRouteProfile(key: RouteProfileKey): void {
  currentProfile = key;
}

export function getRouteProfile(): RouteProfileKey {
  return currentProfile;
}

// ========== Shared fetch + parse ==========

async function fetchRoute(lonlats: string, profileOverride?: string): Promise<any> {
  const profile = profileOverride || ROUTE_PROFILES[currentProfile].profile;
  const params = new URLSearchParams({
    lonlats,
    profile,
    alternativeidx: '0',
    format: 'geojson',
  });

  const res = await fetch(`${BROUTER_URL}?${params}`);
  if (!res.ok) {
    throw new Error(`Routing failed: ${res.status} ${res.statusText}`);
  }

  const geojson = await res.json();
  const feature = geojson.features[0];
  if (!feature) {
    throw new Error('No route found');
  }
  return feature;
}

function parseRouteFeature(feature: any): RouteResult {
  const coords: [number, number][] = feature.geometry.coordinates.map(
    (c: number[]) => [c[1], c[0]] as [number, number]
  );

  const elevations: number[] = feature.geometry.coordinates.map(
    (c: number[]) => c[2] ?? 0
  );

  const props = feature.properties;
  const distance = parseFloat(props['track-length']) || computeDistance(coords);
  const time = parseFloat(props['total-time']) || Math.round(distance / 4.2);
  const ascend = parseFloat(props['filtered ascend']) || 0;
  const descend = parseFloat(props['filtered descend']) || 0;

  const instructions = parseInstructions(feature);

  return { coordinates: coords, distance, time, elevations, ascend, descend, instructions };
}

// ========== Public API ==========

export async function computeRoute(start: LatLng, end: LatLng): Promise<RouteResult> {
  const lonlats = `${start.lng},${start.lat}|${end.lng},${end.lat}`;
  const feature = await fetchRoute(lonlats);
  return parseRouteFeature(feature);
}

export async function computeRouteMulti(waypoints: Waypoint[], profileOverride?: string): Promise<RouteResult> {
  if (waypoints.length < 2) throw new Error('Need at least 2 waypoints');
  const lonlats = waypoints.map(w => `${w.lng},${w.lat}`).join('|');
  const feature = await fetchRoute(lonlats, profileOverride);
  return parseRouteFeature(feature);
}

// ========== Instructions parsing ==========

function parseInstructions(feature: any): TurnInstruction[] {
  const instructions: TurnInstruction[] = [];
  const messages: any[] = feature.properties?.messages;

  if (!messages || messages.length < 2) {
    return generateBasicInstructions(feature);
  }

  const headers: string[] = messages[0];
  const lonIdx = headers.indexOf('Longitude');
  const latIdx = headers.indexOf('Latitude');
  const dirIdx = headers.indexOf('Direction');
  const msgIdx = headers.indexOf('Message');
  const distIdx = headers.indexOf('Distance');

  let cumulativeDist = 0;

  for (let i = 1; i < messages.length; i++) {
    const row = messages[i];
    const direction = dirIdx >= 0 ? row[dirIdx] : '';
    const message = msgIdx >= 0 ? row[msgIdx] : '';
    const stepDist = distIdx >= 0 ? parseFloat(row[distIdx]) : 0;
    const lon = lonIdx >= 0 ? parseFloat(row[lonIdx]) / 1e6 : 0;
    const lat = latIdx >= 0 ? parseFloat(row[latIdx]) / 1e6 : 0;

    cumulativeDist += stepDist;

    if (!message && i > 1) continue;

    instructions.push({
      text: message || 'Start',
      distance: cumulativeDist,
      stepDistance: stepDist,
      icon: i === 1 ? 'start' : directionIcon(direction),
      latlng: [lat, lon],
    });
  }

  if (instructions.length > 0) {
    const last = instructions[instructions.length - 1];
    if (!last.text.toLowerCase().includes('arrive') && !last.text.toLowerCase().includes('destination')) {
      const endCoord = feature.geometry.coordinates[feature.geometry.coordinates.length - 1];
      instructions.push({
        text: 'Arrive at destination',
        distance: parseFloat(feature.properties?.['track-length']) || cumulativeDist,
        stepDistance: 0,
        icon: 'arrive',
        latlng: [endCoord[1], endCoord[0]],
      });
    }
  }

  return instructions;
}

function generateBasicInstructions(feature: any): TurnInstruction[] {
  const coords = feature.geometry.coordinates;
  if (!coords || coords.length < 2) return [];

  const totalDist = parseFloat(feature.properties?.['track-length']) || 0;
  const start = coords[0];
  const end = coords[coords.length - 1];
  return [
    { text: 'Start your ride', distance: 0, stepDistance: 0, icon: 'start', latlng: [start[1], start[0]] },
    { text: 'Follow the route', distance: totalDist, stepDistance: totalDist, icon: 'continue', latlng: [end[1], end[0]] },
    { text: 'Arrive at destination', distance: totalDist, stepDistance: 0, icon: 'arrive', latlng: [end[1], end[0]] },
  ];
}

function directionIcon(direction: string): string {
  const d = direction?.toUpperCase() || '';
  if (d.includes('LEFT') || d === 'TL') return 'turn-left';
  if (d.includes('RIGHT') || d === 'TR') return 'turn-right';
  if (d.includes('STRAIGHT') || d === 'C') return 'straight';
  if (d.includes('U-TURN') || d === 'TU') return 'u-turn';
  return 'continue';
}

export function computeDistance(coords: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversine(coords[i - 1], coords[i]);
  }
  return total;
}

export function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dlat = toRad(b[0] - a[0]);
  const dlon = toRad(b[1] - a[1]);
  const sinLat = Math.sin(dlat / 2);
  const sinLon = Math.sin(dlon / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * sinLon * sinLon;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
