import { haversine, pointToSegProject, FEET_PER_METER, METERS_PER_TENTH_MILE } from './geo';
import type { RouteResult, TurnInstruction } from './types';

const OFF_ROUTE_THRESHOLD = 50; // meters
const ANNOUNCE_DISTANCE = 80; // meters before turn to announce
const ARRIVAL_THRESHOLD = 30; // meters from destination to auto-finish
const ANNOUNCE_COOLDOWN = 8000; // ms between repeated announcements

export interface NavUpdate {
  userLat: number;
  userLng: number;
  heading: number | null;
  accuracy: number;
  currentInstruction: TurnInstruction;
  nextInstruction: TurnInstruction | null;
  distanceToNextTurn: number; // meters to next instruction
  distanceRemaining: number; // meters to destination
  timeRemaining: number; // seconds
  instructionIndex: number;
  offRoute: boolean;
  arrived: boolean;
}

export type NavCallback = (update: NavUpdate) => void;

/** A single position fix, GPS or simulated. */
export interface NavPosition {
  lat: number;
  lng: number;
  heading: number | null; // degrees, null if unknown/stationary
  accuracy: number;       // meters
}

/** Feeds position fixes to the navigation engine. Real GPS or a simulator. */
export interface PositionSource {
  start(onPosition: (pos: NavPosition) => void): void;
  stop(): void;
}

/** Default source: browser geolocation watch. */
class GeolocationSource implements PositionSource {
  private watchId: number | null = null;

  start(onPosition: (pos: NavPosition) => void): void {
    if (!navigator.geolocation) {
      throw new Error('Geolocation not supported');
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => onPosition({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        heading: pos.coords.heading !== null && !isNaN(pos.coords.heading) ? pos.coords.heading : null,
        accuracy: pos.coords.accuracy,
      }),
      (err) => console.warn('GPS error:', err.message),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 },
    );
  }

  stop(): void {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }
}

let positionSource: PositionSource | null = null;
let wakeLock: WakeLockSentinel | null = null;
let visibilityHandler: (() => void) | null = null;
let route: RouteResult | null = null;
let onUpdate: NavCallback | null = null;
let onOffRoute: (() => void) | null = null;
let lastAnnouncedIndex = -1;
let lastAnnounceTime = 0;
let arrived = false;
let lastPosition: NavPosition | null = null;

// Precomputed cumulative distances along route polyline
let segmentCumDist: number[] = [];
let lastSnapIndex = 0; // track last known segment for locality optimization

export function startNavigation(
  routeData: RouteResult,
  callback: NavCallback,
  offRouteCallback?: () => void,
  source?: PositionSource,
): void {
  route = routeData;
  onUpdate = callback;
  onOffRoute = offRouteCallback || null;
  lastAnnouncedIndex = -1;
  lastAnnounceTime = 0;
  arrived = false;
  lastSnapIndex = 0;

  // Precompute cumulative distances along the route polyline
  segmentCumDist = [0];
  for (let i = 1; i < route.coordinates.length; i++) {
    segmentCumDist.push(
      segmentCumDist[i - 1] + haversine(route.coordinates[i - 1], route.coordinates[i])
    );
  }

  // Request wake lock
  acquireWakeLock();

  positionSource = source ?? new GeolocationSource();
  positionSource.start(handlePosition);

  // Announce start
  speak('Navigation started. ' + route.instructions[0]?.text || 'Follow the route.');
}

export function stopNavigation(): void {
  if (positionSource) {
    positionSource.stop();
    positionSource = null;
  }
  releaseWakeLock();
  route = null;
  onUpdate = null;
  onOffRoute = null;
  arrived = false;
  lastPosition = null;
}

/**
 * Swap in a new route mid-navigation (rerouting). Keeps the position source
 * running; resets snap/announcement state so guidance follows the new route.
 */
export function updateRoute(newRoute: RouteResult): void {
  if (!positionSource) return;
  route = newRoute;
  lastAnnouncedIndex = -1;
  lastAnnounceTime = 0;
  arrived = false;
  lastSnapIndex = 0;
  segmentCumDist = [0];
  for (let i = 1; i < newRoute.coordinates.length; i++) {
    segmentCumDist.push(
      segmentCumDist[i - 1] + haversine(newRoute.coordinates[i - 1], newRoute.coordinates[i])
    );
  }
}

/** Last position fix received during navigation (null when not navigating). */
export function getLastPosition(): NavPosition | null {
  return lastPosition;
}

/** Speak an announcement through the navigation voice (no-op outside browsers). */
export function announce(text: string): void {
  speak(text);
}

export function isNavigating(): boolean {
  return positionSource !== null;
}

function handlePosition(pos: NavPosition): void {
  if (!route || !onUpdate) return;
  lastPosition = pos;

  const { lat: userLat, lng: userLng, heading, accuracy } = pos;

  // Find closest point on route
  const snap = snapToRoute(userLat, userLng);

  // Check off-route
  const offRoute = snap.distanceFromRoute > OFF_ROUTE_THRESHOLD;
  if (offRoute && onOffRoute) {
    onOffRoute();
  }

  // Determine current instruction based on distance along route
  const { instructionIndex, distanceToNextTurn } = findCurrentInstruction(snap.distanceAlongRoute);

  const currentInstruction = route.instructions[instructionIndex];
  const nextInstruction = route.instructions[instructionIndex + 1] || null;

  // Distance remaining = total route distance minus distance traveled
  const distanceRemaining = Math.max(0, route.distance - snap.distanceAlongRoute);

  // Estimate time remaining (use avg speed from route, fallback 15 km/h)
  const avgSpeed = route.distance / route.time || 4.17; // m/s
  const timeRemaining = Math.round(distanceRemaining / avgSpeed);

  // Check arrival
  if (!arrived && distanceRemaining < ARRIVAL_THRESHOLD) {
    arrived = true;
    speak('You have arrived at your destination.');
  }

  // Voice announcements for upcoming turns
  if (!arrived && nextInstruction) {
    announceIfNeeded(instructionIndex, distanceToNextTurn, nextInstruction);
  }

  onUpdate({
    userLat,
    userLng,
    heading,
    accuracy,
    currentInstruction,
    nextInstruction,
    distanceToNextTurn,
    distanceRemaining,
    timeRemaining,
    instructionIndex,
    offRoute,
    arrived,
  });
}

interface SnapResult {
  distanceFromRoute: number; // meters from user to closest point on route
  distanceAlongRoute: number; // meters from route start to snapped point
  closestPoint: [number, number];
}

function snapToRoute(lat: number, lng: number): SnapResult {
  if (!route) return { distanceFromRoute: Infinity, distanceAlongRoute: 0, closestPoint: [lat, lng] };

  const coords = route.coordinates;
  let bestDist = Infinity;
  let bestAlongRoute = 0;
  let bestPoint: [number, number] = coords[0];
  let bestIdx = 0;

  // Search near the last known position first (±20 segments)
  const LOCALITY_RADIUS = 20;
  const localStart = Math.max(0, lastSnapIndex - LOCALITY_RADIUS);
  const localEnd = Math.min(coords.length - 1, lastSnapIndex + LOCALITY_RADIUS);

  for (let i = localStart; i < localEnd; i++) {
    const result = pointToSegProject([lat, lng], coords[i], coords[i + 1]);
    if (result.distance < bestDist) {
      bestDist = result.distance;
      bestPoint = result.closest;
      bestIdx = i;
      const segLen = segmentCumDist[i + 1] - segmentCumDist[i];
      bestAlongRoute = segmentCumDist[i] + result.t * segLen;
    }
  }

  // If local search found a close match, skip the full scan
  if (bestDist > OFF_ROUTE_THRESHOLD) {
    for (let i = 0; i < coords.length - 1; i++) {
      if (i >= localStart && i < localEnd) continue; // already checked
      const result = pointToSegProject([lat, lng], coords[i], coords[i + 1]);
      if (result.distance < bestDist) {
        bestDist = result.distance;
        bestPoint = result.closest;
        bestIdx = i;
        const segLen = segmentCumDist[i + 1] - segmentCumDist[i];
        bestAlongRoute = segmentCumDist[i] + result.t * segLen;
      }
    }
  }

  lastSnapIndex = bestIdx;

  return {
    distanceFromRoute: bestDist,
    distanceAlongRoute: bestAlongRoute,
    closestPoint: bestPoint,
  };
}

function findCurrentInstruction(distanceAlongRoute: number): {
  instructionIndex: number;
  distanceToNextTurn: number;
} {
  if (!route) return { instructionIndex: 0, distanceToNextTurn: 0 };

  const instructions = route.instructions;

  // Find the last instruction whose cumulative distance we've passed
  let idx = 0;
  for (let i = 1; i < instructions.length; i++) {
    if (distanceAlongRoute >= instructions[i].distance - 10) {
      idx = i;
    } else {
      break;
    }
  }

  // Distance to next turn
  const nextIdx = idx + 1;
  let distanceToNextTurn = 0;
  if (nextIdx < instructions.length) {
    distanceToNextTurn = Math.max(0, instructions[nextIdx].distance - distanceAlongRoute);
  }

  return { instructionIndex: idx, distanceToNextTurn };
}

function announceIfNeeded(
  instructionIndex: number,
  distanceToNextTurn: number,
  nextInstruction: TurnInstruction,
): void {
  const now = Date.now();

  // Announce when approaching a turn (within ANNOUNCE_DISTANCE)
  // or when we've just passed a turn (new instruction)
  if (instructionIndex !== lastAnnouncedIndex && distanceToNextTurn <= ANNOUNCE_DISTANCE) {
    lastAnnouncedIndex = instructionIndex;
    lastAnnounceTime = now;

    const distText = formatVoiceDistance(distanceToNextTurn);
    speak(`In ${distText}, ${nextInstruction.text}`);
  } else if (
    distanceToNextTurn <= 20 &&
    instructionIndex === lastAnnouncedIndex &&
    now - lastAnnounceTime > ANNOUNCE_COOLDOWN
  ) {
    // Remind when very close
    lastAnnounceTime = now;
    speak(nextInstruction.text);
  }
}

function formatVoiceDistance(meters: number): string {
  if (meters < 30) return 'a few yards';
  const feet = Math.round(meters * FEET_PER_METER);
  if (feet <= 200) return `${Math.round(feet / 10) * 10} feet`;
  const tenths = Math.round(meters / METERS_PER_TENTH_MILE);
  if (tenths <= 1) return 'a tenth of a mile';
  return `${tenths} tenths of a mile`;
}

function speak(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

  // Cancel any pending speech
  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;
  utterance.lang = 'en-US';
  speechSynthesis.speak(utterance);
}

async function acquireWakeLock(): Promise<void> {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      // Re-acquire on visibility change (iOS Safari releases it when tab hidden)
      visibilityHandler = async () => {
        if (document.visibilityState === 'visible' && isNavigating()) {
          try {
            wakeLock = await navigator.wakeLock.request('screen');
          } catch { /* best effort */ }
        }
      };
      document.addEventListener('visibilitychange', visibilityHandler);
    }
  } catch {
    // Wake Lock not supported or denied — continue without it
  }
}

function releaseWakeLock(): void {
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
