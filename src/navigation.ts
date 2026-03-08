import { haversine } from './router';
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

let watchId: number | null = null;
let wakeLock: WakeLockSentinel | null = null;
let route: RouteResult | null = null;
let onUpdate: NavCallback | null = null;
let onOffRoute: (() => void) | null = null;
let lastAnnouncedIndex = -1;
let lastAnnounceTime = 0;
let arrived = false;

// Precomputed cumulative distances along route polyline
let segmentCumDist: number[] = [];

export function startNavigation(
  routeData: RouteResult,
  callback: NavCallback,
  offRouteCallback?: () => void,
): void {
  route = routeData;
  onUpdate = callback;
  onOffRoute = offRouteCallback || null;
  lastAnnouncedIndex = -1;
  lastAnnounceTime = 0;
  arrived = false;

  // Precompute cumulative distances along the route polyline
  segmentCumDist = [0];
  for (let i = 1; i < route.coordinates.length; i++) {
    segmentCumDist.push(
      segmentCumDist[i - 1] + haversine(route.coordinates[i - 1], route.coordinates[i])
    );
  }

  // Request wake lock
  acquireWakeLock();

  // Start GPS tracking
  if (!navigator.geolocation) {
    throw new Error('Geolocation not supported');
  }

  watchId = navigator.geolocation.watchPosition(
    handlePosition,
    handleError,
    {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 10000,
    },
  );

  // Announce start
  speak('Navigation started. ' + route.instructions[0]?.text || 'Follow the route.');
}

export function stopNavigation(): void {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  releaseWakeLock();
  route = null;
  onUpdate = null;
  onOffRoute = null;
  arrived = false;
}

export function isNavigating(): boolean {
  return watchId !== null;
}

function handlePosition(pos: GeolocationPosition): void {
  if (!route || !onUpdate) return;

  const userLat = pos.coords.latitude;
  const userLng = pos.coords.longitude;
  const heading = pos.coords.heading; // null if stationary
  const accuracy = pos.coords.accuracy;

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
    heading: heading !== null && !isNaN(heading) ? heading : null,
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

function handleError(err: GeolocationPositionError): void {
  console.warn('GPS error:', err.message);
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

  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const result = pointToSegment(lat, lng, a, b);

    if (result.distance < bestDist) {
      bestDist = result.distance;
      bestPoint = result.closest;
      // Distance along route = cumulative distance to segment start + fraction of segment
      const segLen = segmentCumDist[i + 1] - segmentCumDist[i];
      bestAlongRoute = segmentCumDist[i] + result.t * segLen;
    }
  }

  return {
    distanceFromRoute: bestDist,
    distanceAlongRoute: bestAlongRoute,
    closestPoint: bestPoint,
  };
}

interface SegmentResult {
  distance: number;
  closest: [number, number];
  t: number; // 0-1 fraction along segment
}

function pointToSegment(
  lat: number, lng: number,
  a: [number, number], b: [number, number],
): SegmentResult {
  // Project point onto segment in approximate Cartesian coordinates
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const ax = a[1] * cosLat, ay = a[0];
  const bx = b[1] * cosLat, by = b[0];
  const px = lng * cosLat, py = lat;

  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  let t = 0;
  if (lenSq > 0) {
    t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  }

  const closestLat = a[0] + t * (b[0] - a[0]);
  const closestLng = a[1] + t * (b[1] - a[1]);
  const distance = haversine([lat, lng], [closestLat, closestLng]);

  return { distance, closest: [closestLat, closestLng], t };
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
  const feet = Math.round(meters * 3.281);
  if (feet <= 200) return `${Math.round(feet / 10) * 10} feet`;
  const tenths = Math.round(meters / 160.934);
  if (tenths <= 1) return 'a tenth of a mile';
  return `${tenths} tenths of a mile`;
}

function speak(text: string): void {
  if (!('speechSynthesis' in window)) return;

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
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && isNavigating()) {
          try {
            wakeLock = await navigator.wakeLock.request('screen');
          } catch { /* best effort */ }
        }
      });
    }
  } catch {
    // Wake Lock not supported or denied — continue without it
  }
}

function releaseWakeLock(): void {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
