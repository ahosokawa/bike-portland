// Unit tests for the turn-by-turn navigation engine, driven by a scripted
// PositionSource — no GPS, no browser. Voice/wake-lock are no-ops in Node.

import { describe, it, expect, afterEach } from 'vitest';
import {
  startNavigation,
  stopNavigation,
  updateRoute,
  isNavigating,
  getLastPosition,
} from './navigation';
import type { PositionSource, NavPosition, NavUpdate } from './navigation';
import type { RouteResult, TurnInstruction } from './types';

/** Position source the test drives by hand. */
class ManualSource implements PositionSource {
  private cb: ((pos: NavPosition) => void) | null = null;
  start(onPosition: (pos: NavPosition) => void): void {
    this.cb = onPosition;
  }
  stop(): void {
    this.cb = null;
  }
  emit(lat: number, lng: number, heading: number | null = 0, accuracy = 5): void {
    this.cb?.({ lat, lng, heading, accuracy });
  }
}

// Synthetic route: due north along lng -122.66, one point every 0.0005° lat
// (~55.6m). 19 segments ≈ 1000m total.
const LNG = -122.66;
const LAT0 = 45.5;
const STEP = 0.0005; // ≈ 55.6m
const N_POINTS = 20;

function makeRoute(): RouteResult {
  const coordinates: [number, number][] = [];
  for (let i = 0; i < N_POINTS; i++) {
    coordinates.push([LAT0 + i * STEP, LNG]);
  }
  const total = 1056; // ~19 × 55.6m
  const instructions: TurnInstruction[] = [
    { text: 'Start your ride', distance: 0, stepDistance: 0, icon: 'start', latlng: coordinates[0] },
    { text: 'Turn right onto Test St', distance: total / 2, stepDistance: total / 2, icon: 'turn-right', latlng: coordinates[10] },
    { text: 'Arrive at destination', distance: total, stepDistance: total / 2, icon: 'arrive', latlng: coordinates[N_POINTS - 1] },
  ];
  return {
    coordinates,
    tiers: coordinates.map(() => 'lane' as const),
    distance: total,
    time: Math.round(total / 4.2),
    elevations: coordinates.map(() => 0),
    ascend: 0,
    descend: 0,
    hasElevation: false,
    instructions,
  };
}

function startWithCapture(route: RouteResult, source: ManualSource): NavUpdate[] {
  const updates: NavUpdate[] = [];
  startNavigation(route, (u) => updates.push(u), undefined, source);
  return updates;
}

afterEach(() => {
  stopNavigation();
});

describe('navigation engine', () => {
  it('tracks progress and advances instructions along the route', () => {
    const source = new ManualSource();
    const updates = startWithCapture(makeRoute(), source);

    source.emit(LAT0, LNG);
    expect(updates.at(-1)!.instructionIndex).toBe(0);
    expect(updates.at(-1)!.offRoute).toBe(false);
    expect(updates.at(-1)!.distanceRemaining).toBeGreaterThan(1000);

    // Ride to ~75% — past the mid-route turn instruction
    source.emit(LAT0 + 15 * STEP, LNG);
    const u = updates.at(-1)!;
    expect(u.instructionIndex).toBe(1);
    expect(u.nextInstruction!.icon).toBe('arrive');
    expect(u.distanceRemaining).toBeLessThan(300);
    expect(u.arrived).toBe(false);
  });

  it('reports distanceToNextTurn shrinking as the turn approaches', () => {
    const source = new ManualSource();
    const updates = startWithCapture(makeRoute(), source);

    source.emit(LAT0 + 5 * STEP, LNG);
    const far = updates.at(-1)!.distanceToNextTurn;
    source.emit(LAT0 + 8 * STEP, LNG);
    const near = updates.at(-1)!.distanceToNextTurn;
    expect(near).toBeLessThan(far);
    expect(near).toBeGreaterThan(0);
  });

  it('flags off-route beyond the 50m threshold, clears when back on', () => {
    const source = new ManualSource();
    const updates = startWithCapture(makeRoute(), source);

    // ~78m east of the line at this latitude (0.001°)
    source.emit(LAT0 + 5 * STEP, LNG + 0.001);
    expect(updates.at(-1)!.offRoute).toBe(true);

    source.emit(LAT0 + 5 * STEP, LNG);
    expect(updates.at(-1)!.offRoute).toBe(false);
  });

  it('detects arrival near the destination', () => {
    const source = new ManualSource();
    const updates = startWithCapture(makeRoute(), source);

    source.emit(LAT0 + (N_POINTS - 1) * STEP, LNG);
    const u = updates.at(-1)!;
    expect(u.arrived).toBe(true);
    expect(u.distanceRemaining).toBeLessThan(30);
  });

  it('updateRoute swaps guidance onto a new route mid-navigation', () => {
    const source = new ManualSource();
    const updates = startWithCapture(makeRoute(), source);

    // Rider drifts a block east — off the original route
    const eastLng = LNG + 0.001;
    source.emit(LAT0 + 5 * STEP, eastLng);
    expect(updates.at(-1)!.offRoute).toBe(true);

    // Reroute: new route runs north along the east street from the rider
    const newRoute = makeRoute();
    newRoute.coordinates = newRoute.coordinates.map(
      ([lat]) => [lat, eastLng] as [number, number],
    );
    newRoute.instructions = newRoute.instructions.map((inst, i) => ({
      ...inst,
      latlng: newRoute.coordinates[i === 0 ? 0 : i === 1 ? 10 : N_POINTS - 1],
    }));
    updateRoute(newRoute);

    source.emit(LAT0 + 5 * STEP, eastLng);
    const u = updates.at(-1)!;
    expect(u.offRoute).toBe(false);
    expect(u.instructionIndex).toBe(0);
    expect(u.distanceRemaining).toBeGreaterThan(700);
    expect(u.arrived).toBe(false);
  });

  it('exposes navigation state and last position', () => {
    const source = new ManualSource();
    expect(isNavigating()).toBe(false);
    startWithCapture(makeRoute(), source);
    expect(isNavigating()).toBe(true);

    source.emit(LAT0, LNG, 42, 7);
    expect(getLastPosition()).toMatchObject({ lat: LAT0, lng: LNG, heading: 42, accuracy: 7 });

    stopNavigation();
    expect(isNavigating()).toBe(false);
    expect(getLastPosition()).toBeNull();
  });
});
