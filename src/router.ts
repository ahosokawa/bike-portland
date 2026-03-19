import type { LatLng } from 'leaflet';
import type { RouteResult, TurnInstruction, Waypoint, BRouterFeature } from './types';
import { haversine as hav, computeDistance, bearing } from './geo';
import { findPbotPath } from './pbot-graph';
import { getOverridesMap } from './edge-preferences';
import type { PbotEdge, PbotPathResult } from './pbot-graph';

const BROUTER_URL = 'https://brouter.de/brouter';

// Skip BRouter first/last mile if the snap distance is under this threshold —
// the user is close enough to the PBOT network that a straight walk is fine.
const SNAP_THRESHOLD = 100; // meters

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

async function fetchRoute(lonlats: string, profileOverride?: string): Promise<BRouterFeature> {
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

  const geojson = await res.json() as { features: BRouterFeature[] };
  const feature = geojson.features[0];
  if (!feature) {
    throw new Error('No route found');
  }
  return feature;
}

function parseRouteFeature(feature: BRouterFeature): RouteResult {
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

  return { coordinates: coords, distance, time, elevations, ascend, descend, hasElevation: true, instructions };
}

// ========== Public API ==========

export async function computeRoute(start: LatLng, end: LatLng): Promise<RouteResult> {
  const lonlats = `${start.lng},${start.lat}|${end.lng},${end.lat}`;
  const feature = await fetchRoute(lonlats);
  return parseRouteFeature(feature);
}

/** Fetch raw road geometry between two points using BRouter (shortest profile).
 *  Returns [lat, lng][] coordinates following real roads. */
export async function fetchRoadGeometry(
  startLat: number, startLng: number,
  endLat: number, endLng: number,
): Promise<[number, number][]> {
  const lonlats = `${startLng},${startLat}|${endLng},${endLat}`;
  const feature = await fetchRoute(lonlats, 'shortest');
  return feature.geometry.coordinates.map(c => [c[1], c[0]] as [number, number]);
}

/**
 * Route using PBOT bike network A* path for the core (safest profile),
 * with BRouter for first/last mile. "balanced" profile uses pure BRouter.
 */
export async function computeGuidedRoute(start: LatLng, end: LatLng): Promise<RouteResult> {
  // "Direct" mode — pure BRouter, no PBOT guidance
  if (currentProfile !== 'safest') {
    return computeRoute(start, end);
  }

  const overrides = getOverridesMap();
  const pbotPath = findPbotPath(start.lat, start.lng, end.lat, end.lng, 'safest', overrides);
  if (!pbotPath) {
    return computeRoute(start, end);
  }

  // Replace straight-line gap edges with real road geometry from BRouter
  await resolveGapEdges(pbotPath.edges);

  const pbotRoute = buildRouteFromPbotPath(pbotPath);

  // Fetch first-mile and last-mile BRouter segments in parallel
  const needFirstMile = pbotPath.startSnapDist > SNAP_THRESHOLD;
  const needLastMile = pbotPath.endSnapDist > SNAP_THRESHOLD;

  const [firstMile, lastMile] = await Promise.all([
    needFirstMile
      ? computeRoute(start, { lat: pbotPath.startNode.lat, lng: pbotPath.startNode.lng } as LatLng)
          .catch(() => null)
      : null,
    needLastMile
      ? computeRoute({ lat: pbotPath.endNode.lat, lng: pbotPath.endNode.lng } as LatLng, end)
          .catch(() => null)
      : null,
  ]);

  return stitchRoutes(start, end, firstMile, pbotRoute, lastMile);
}

/** Replace straight-line gap-bridge edge coords with real road geometry. */
async function resolveGapEdges(edges: PbotEdge[]): Promise<void> {
  const gapIndices = edges
    .map((e, i) => e.ct.startsWith('_GAP') || e.ct === '_PREF' ? i : -1)
    .filter(i => i >= 0);

  if (gapIndices.length === 0) return;

  const results = await Promise.all(
    gapIndices.map(i => {
      const e = edges[i];
      const start = e.coords[0];
      const end = e.coords[e.coords.length - 1];
      return fetchRoadGeometry(start[0], start[1], end[0], end[1]).catch(() => null);
    }),
  );

  for (let j = 0; j < gapIndices.length; j++) {
    if (results[j] && results[j]!.length >= 2) {
      edges[gapIndices[j]].coords = results[j]!;
    }
  }
}

export async function computeRouteMulti(waypoints: Waypoint[], profileOverride?: string): Promise<RouteResult> {
  if (waypoints.length < 2) throw new Error('Need at least 2 waypoints');
  const lonlats = waypoints.map(w => `${w.lng},${w.lat}`).join('|');
  const feature = await fetchRoute(lonlats, profileOverride);
  return parseRouteFeature(feature);
}

// ========== PBOT path → RouteResult ==========

function buildRouteFromPbotPath(path: PbotPathResult): RouteResult {
  // Concatenate edge coordinates, deduplicating shared junction points
  const coordinates: [number, number][] = [];
  for (const edge of path.edges) {
    const start = coordinates.length === 0 ? 0 : 1; // skip first point of subsequent edges (same as prev edge's last)
    for (let i = start; i < edge.coords.length; i++) {
      coordinates.push(edge.coords[i]);
    }
  }

  const distance = computeDistance(coordinates);
  const time = Math.round(distance / 4.2); // ~15 km/h average cycling speed
  const elevations = coordinates.map(() => 0); // PBOT data has no elevation
  const instructions = generatePbotInstructions(path.edges, coordinates, distance);

  return { coordinates, distance, time, elevations, ascend: 0, descend: 0, hasElevation: false, instructions };
}

function generatePbotInstructions(edges: PbotEdge[], coordinates: [number, number][], totalDistance: number): TurnInstruction[] {
  if (coordinates.length < 2) return [];

  const instructions: TurnInstruction[] = [];
  let cumulativeDist = 0;

  // Start instruction
  instructions.push({
    text: edges[0].name ? `Start on ${edges[0].name}` : 'Start your ride',
    distance: 0,
    stepDistance: 0,
    icon: 'start',
    latlng: coordinates[0],
  });

  // Turn instructions at edge transitions where the street name changes
  for (let i = 1; i < edges.length; i++) {
    cumulativeDist += edges[i - 1].distance;
    const prev = edges[i - 1];
    const cur = edges[i];

    // Only emit an instruction when the name changes (or either name is empty)
    if (cur.name && cur.name === prev.name) continue;

    const turnType = computeTurnType(prev, cur);
    const text = cur.name
      ? `${turnType} onto ${cur.name}`
      : `${turnType}`;

    instructions.push({
      text,
      distance: cumulativeDist,
      stepDistance: edges[i - 1].distance,
      icon: turnTypeIcon(turnType),
      latlng: cur.coords[0],
    });
  }

  // Arrive instruction
  instructions.push({
    text: 'Arrive at destination',
    distance: totalDistance,
    stepDistance: 0,
    icon: 'arrive',
    latlng: coordinates[coordinates.length - 1],
  });

  return instructions;
}

/** Compute the turn direction between two consecutive edges using bearing difference. */
function computeTurnType(prev: PbotEdge, cur: PbotEdge): string {
  const prevCoords = prev.coords;
  const curCoords = cur.coords;

  // Use the last segment of prev edge and first segment of cur edge
  const a = prevCoords.length >= 2 ? prevCoords[prevCoords.length - 2] : prevCoords[0];
  const b = prevCoords[prevCoords.length - 1]; // junction point
  const c = curCoords.length >= 2 ? curCoords[1] : curCoords[0];

  const bearingIn = bearing(a, b);
  const bearingOut = bearing(b, c);
  let diff = bearingOut - bearingIn;
  // Normalize to -180..180
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;

  if (Math.abs(diff) < 30) return 'Continue';
  if (diff >= 30 && diff < 150) return 'Turn right';
  if (diff <= -30 && diff > -150) return 'Turn left';
  return 'Make a U-turn';
}

function turnTypeIcon(turnType: string): string {
  if (turnType.includes('right')) return 'turn-right';
  if (turnType.includes('left')) return 'turn-left';
  if (turnType.includes('U-turn')) return 'u-turn';
  return 'continue';
}

// ========== Route stitching ==========

function stitchRoutes(
  start: LatLng,
  end: LatLng,
  firstMile: RouteResult | null,
  pbotRoute: RouteResult,
  lastMile: RouteResult | null,
): RouteResult {
  const coordinates: [number, number][] = [];
  const elevations: number[] = [];
  const instructions: TurnInstruction[] = [];
  let distance = 0;
  let ascend = 0;
  let descend = 0;

  // First mile (BRouter: start → PBOT network entry)
  if (firstMile) {
    coordinates.push(...firstMile.coordinates);
    elevations.push(...firstMile.elevations);
    instructions.push(...firstMile.instructions.filter(i => i.icon !== 'arrive'));
    distance += firstMile.distance;
    ascend += firstMile.ascend;
    descend += firstMile.descend;
  } else {
    // Direct line from start to first PBOT coord
    coordinates.push([start.lat, start.lng]);
    elevations.push(0);
  }

  // PBOT core (skip first coordinate if it's a duplicate of the last first-mile point)
  const pbotStart = pbotRoute.coordinates.length > 0 ? 1 : 0;
  for (let i = pbotStart; i < pbotRoute.coordinates.length; i++) {
    coordinates.push(pbotRoute.coordinates[i]);
    elevations.push(0);
  }
  // Adjust PBOT instructions' cumulative distances
  const distOffset = distance;
  for (const inst of pbotRoute.instructions) {
    if (inst.icon === 'arrive' && lastMile) continue; // skip intermediate arrive
    if (inst.icon === 'start' && firstMile) continue; // skip intermediate start
    instructions.push({
      ...inst,
      distance: inst.distance + distOffset,
    });
  }
  distance += pbotRoute.distance;

  // Last mile (BRouter: PBOT network exit → end)
  if (lastMile) {
    const lastStart = lastMile.coordinates.length > 0 ? 1 : 0;
    for (let i = lastStart; i < lastMile.coordinates.length; i++) {
      coordinates.push(lastMile.coordinates[i]);
      elevations.push(lastMile.elevations[i] ?? 0);
    }
    const lastOffset = distance;
    for (const inst of lastMile.instructions) {
      if (inst.icon === 'start') continue;
      instructions.push({
        ...inst,
        distance: inst.distance + lastOffset,
      });
    }
    distance += lastMile.distance;
    ascend += lastMile.ascend;
    descend += lastMile.descend;
  } else if (pbotRoute.instructions.length > 0) {
    // Ensure we have an arrive instruction
    const last = instructions[instructions.length - 1];
    if (!last || !last.text.toLowerCase().includes('arrive')) {
      instructions.push({
        text: 'Arrive at destination',
        distance,
        stepDistance: 0,
        icon: 'arrive',
        latlng: coordinates[coordinates.length - 1],
      });
    }
  }

  const time = Math.round(distance / 4.2);
  return { coordinates, distance, time, elevations, ascend, descend, hasElevation: false, instructions };
}

// ========== Instructions parsing (BRouter) ==========

function parseInstructions(feature: BRouterFeature): TurnInstruction[] {
  const instructions: TurnInstruction[] = [];
  const messages = feature.properties?.messages;

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

function generateBasicInstructions(feature: BRouterFeature): TurnInstruction[] {
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

// ========== Backtracking detection (diagnostic) ==========

/** Detect bearing reversals in a route for debugging.
 *  Logs warnings for segments where the route doubles back. */
export function detectBacktracking(coords: [number, number][]): void {
  if (coords.length < 3) return;

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
    if (diff > 120 && import.meta.env.DEV) {
      console.warn(
        `[PedalPDX] Possible backtracking at coord index ${samples[i].idx}: ` +
        `bearing changed ${diff.toFixed(0)}° (${samples[i - 1].bearing.toFixed(0)}° → ${samples[i].bearing.toFixed(0)}°)`
      );
    }
  }
}
