import type { LatLng } from 'leaflet';
import type { RouteResult, TurnInstruction, Waypoint } from './types';
import { findGuidedWaypoints, isGraphReady } from './pbot-graph';
import type { GuidanceProfile } from './pbot-graph';
import { haversine as hav } from './geo';

const BROUTER_URL = 'https://brouter.de/brouter';

// Profiles ordered from safest to fastest
export const ROUTE_PROFILES = {
  'safest': { profile: 'fastbike-verylowtraffic', label: 'Bike Paths', description: 'Prioritize multi-use paths and trails' },
  'balanced': { profile: 'fastbike-lowtraffic', label: 'Direct', description: 'Shorter distance, less bike infrastructure' },
} as const;

export type RouteProfileKey = keyof typeof ROUTE_PROFILES;

let currentProfile: RouteProfileKey = 'safest';

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

/**
 * PBOT-guided routing: pathfinds through Portland's bike network to find
 * intermediate waypoints, then routes through them with BRouter.
 * Falls back to standard BRouter if the graph isn't ready or points are
 * too far from the bike network.
 * Skipped for the "balanced" (Direct) profile.
 */
export async function computeGuidedRoute(start: LatLng, end: LatLng): Promise<RouteResult> {
  if (currentProfile !== 'balanced' && isGraphReady()) {
    const guided = findGuidedWaypoints(start.lat, start.lng, end.lat, end.lng, currentProfile as GuidanceProfile);
    if (guided && guided.length > 0) {
      const waypoints: Waypoint[] = [
        { lat: start.lat, lng: start.lng },
        ...guided,
        { lat: end.lat, lng: end.lng },
      ];
      return computeRouteMulti(waypoints);
    }
  }
  return computeRoute(start, end);
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

export { haversine, computeDistance } from './geo';

// ========== Backtracking detection (diagnostic) ==========

/** Detect bearing reversals in a route for debugging.
 *  Logs warnings for segments where the route doubles back. */
export function detectBacktracking(coords: [number, number][]): void {
  if (coords.length < 3) return;

  const toRad = (deg: number) => deg * Math.PI / 180;
  function bearing(a: [number, number], b: [number, number]): number {
    const dLng = toRad(b[1] - a[1]);
    const y = Math.sin(dLng) * Math.cos(toRad(b[0]));
    const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0]))
            - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(dLng);
    return Math.atan2(y, x) * 180 / Math.PI;
  }

  // Sample bearings at ~100m intervals to avoid noise from small wiggles
  const samples: { bearing: number; idx: number }[] = [];
  let accumDist = 0;
  let lastSampleIdx = 0;
  for (let i = 1; i < coords.length; i++) {
    accumDist += hav(coords[i - 1], coords[i]);
    if (accumDist >= 100 || i === coords.length - 1) {
      samples.push({ bearing: bearing(coords[lastSampleIdx], coords[i]), idx: i });
      accumDist = 0;
      lastSampleIdx = i;
    }
  }

  for (let i = 1; i < samples.length; i++) {
    let diff = Math.abs(samples[i].bearing - samples[i - 1].bearing);
    if (diff > 180) diff = 360 - diff;
    if (diff > 120) {
      console.warn(
        `[PedalPDX] Possible backtracking at coord index ${samples[i].idx}: ` +
        `bearing changed ${diff.toFixed(0)}° (${samples[i - 1].bearing.toFixed(0)}° → ${samples[i].bearing.toFixed(0)}°)`
      );
    }
  }
}
