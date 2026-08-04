// Route planning API used by the app.
//
// Routing runs entirely in the browser over the street graph shipped with the
// app (see street-graph.ts) — no routing server, works offline once loaded.

import type { LatLng } from 'leaflet';
import type { RouteResult, TurnInstruction, Waypoint } from './types';
import { haversine as hav, bearing } from './geo';
import { buildInstructions } from './route-instructions';
import type { StreetGraph, StreetRoute, RouteProfile } from './street-graph';

/** Average cycling speed used for time estimates (~15 km/h). */
const CYCLING_SPEED = 4.2; // m/s

export const ROUTE_PROFILES = {
  'safest': { profile: 'safest', label: 'Bike Paths', description: 'Prioritize multi-use paths and trails' },
  'balanced': { profile: 'balanced', label: 'Direct', description: 'Shorter distance, less bike infrastructure' },
} as const;

export type RouteProfileKey = keyof typeof ROUTE_PROFILES;

let currentProfile: RouteProfileKey = 'safest';
let graph: StreetGraph | null = null;

export function setRouteProfile(key: RouteProfileKey): void {
  currentProfile = key;
}

export function getRouteProfile(): RouteProfileKey {
  return currentProfile;
}

/** Install the loaded street graph. Routing is unavailable until this is called. */
export function setStreetGraph(g: StreetGraph): void {
  graph = g;
}

export function isRouterReady(): boolean {
  return graph !== null;
}

function requireGraph(): StreetGraph {
  if (!graph) {
    throw new Error('Map data is still loading. Try again in a moment.');
  }
  return graph;
}

/** Convert an engine route into the shape the app renders and navigates. */
function toRouteResult(g: StreetGraph, route: StreetRoute, profile: RouteProfileKey): RouteResult {
  const instructions = buildInstructions(g, route);
  return {
    coordinates: route.coordinates,
    tiers: route.tiers,
    distance: route.distance,
    time: Math.round(route.distance / CYCLING_SPEED),
    instructions,
    debug: {
      source: 'street-graph',
      profile,
      steps: route.steps.length,
      snapPoints: [
        { label: `start on ${g.edgeName(route.steps[0].edge) || 'unnamed way'}`, latlng: route.coordinates[0] },
        {
          label: `end on ${g.edgeName(route.steps[route.steps.length - 1].edge) || 'unnamed way'}`,
          latlng: route.coordinates[route.coordinates.length - 1],
        },
      ],
    },
  };
}

/** Plan a route between two points using the current profile. */
export async function computeGuidedRoute(start: LatLng, end: LatLng): Promise<RouteResult> {
  const g = requireGraph();
  const route = g.route(
    { lat: start.lat, lng: start.lng },
    { lat: end.lat, lng: end.lng },
    ROUTE_PROFILES[currentProfile].profile as RouteProfile,
  );
  if (!route) {
    throw new Error('No bike route found between those points');
  }
  return toRouteResult(g, route, currentProfile);
}

/** Plan a route visiting each waypoint in order (custom saved routes). */
export async function computeRouteMulti(
  waypoints: Waypoint[],
  profileOverride?: string,
): Promise<RouteResult> {
  if (waypoints.length < 2) throw new Error('Need at least 2 waypoints');
  const g = requireGraph();
  const profile = (profileOverride === 'balanced' ? 'balanced' : 'safest') as RouteProfile;

  const coordinates: [number, number][] = [];
  const tiers: RouteResult['tiers'] = [];
  const instructions: TurnInstruction[] = [];
  let distance = 0;

  for (let i = 1; i < waypoints.length; i++) {
    const leg = g.route(waypoints[i - 1], waypoints[i], profile);
    if (!leg) throw new Error(`No bike route found to waypoint ${i + 1}`);

    // Renumber this leg's instructions onto the running total, dropping the
    // intermediate "start"/"arrive" pair at each join.
    const legInstructions = buildInstructions(g, leg);
    const isFirst = i === 1;
    const isLast = i === waypoints.length - 1;
    for (const inst of legInstructions) {
      if (inst.icon === 'start' && !isFirst) continue;
      if (inst.icon === 'arrive' && !isLast) continue;
      instructions.push({ ...inst, distance: inst.distance + distance });
    }

    const skip = coordinates.length > 0 && leg.coordinates.length > 0
      && hav(coordinates[coordinates.length - 1], leg.coordinates[0]) < 1 ? 1 : 0;
    for (let j = skip; j < leg.coordinates.length; j++) {
      coordinates.push(leg.coordinates[j]);
      tiers.push(leg.tiers[j]);
    }
    distance += leg.distance;
  }

  return {
    coordinates,
    tiers,
    distance,
    time: Math.round(distance / CYCLING_SPEED),
    instructions,
    debug: { source: 'street-graph', profile: currentProfile, steps: 0, snapPoints: [] },
  };
}

// ========== Backtracking detection (dev diagnostic) ==========

/** Warn in development when a route doubles back on itself. */
export function detectBacktracking(coords: [number, number][]): void {
  if (coords.length < 3) return;

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
    if (diff > 120 && import.meta.env?.DEV) {
      console.warn(
        `[PedalPDX] Possible backtracking at coord index ${samples[i].idx}: ` +
        `bearing changed ${diff.toFixed(0)}° (${samples[i - 1].bearing.toFixed(0)}° → ${samples[i].bearing.toFixed(0)}°)`
      );
    }
  }
}
