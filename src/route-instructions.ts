// Turn-by-turn instructions from a client-side route.
//
// Consecutive steps along the same street are merged into one leg; an
// instruction is emitted where the rider must actually do something — the
// street name changes, or the way bends sharply enough to be a decision point.

import type { StreetGraph, StreetRoute } from './street-graph';
import type { TurnInstruction } from './types';
import { haversine, bearing } from './geo';

/** Bearings are measured over this span so small kinks don't read as turns. */
const BEARING_SPAN = 20; // meters

/** Below this the ways are effectively continuous and no turn is announced. */
const CONTINUE_ANGLE = 25;
const SLIGHT_ANGLE = 60;
const SHARP_ANGLE = 150;

/** A bend on the same street still needs an instruction past this angle. */
const BEND_ANGLE = 75;

/** Legs shorter than this are absorbed into the previous one — riders don't
 *  need to be told about a way they are on for a few metres. */
const MIN_LEG = 25; // meters

/** A leg this short is a jog through a junction, not a decision point, so it
 *  is absorbed even when the geometry turns sharply. */
const MIN_TIGHT_LEG = 12; // meters

/** Portland renames streets across the quadrant boundaries (NE 7th becomes
 *  SE 7th at Burnside). Riders just keep going, so treat those as one street. */
const DIRECTIONAL_PREFIX = /^(north|south|east|west|northeast|northwest|southeast|southwest|n|s|e|w|ne|nw|se|sw)\s+/i;

function streetKey(name: string): string {
  return name.replace(DIRECTIONAL_PREFIX, '').toLowerCase();
}

interface Leg {
  name: string;
  coordIndex: number;
  distance: number;
  /** Signed turn angle entering this leg; null for the first leg. */
  angle: number | null;
}

/** Human-facing name for a step, falling back to the kind of way it is. */
function displayName(graph: StreetGraph, edge: number): string {
  const name = graph.edgeName(edge);
  if (name) return name;
  const hw = graph.edgeHighway(edge);
  if (hw === 'cycleway') return 'the bike path';
  if (hw === 'path' || hw === 'track') return 'the path';
  if (hw === 'footway' || hw === 'pedestrian') return 'the walkway';
  return '';
}

/** Bearing of travel approaching (`before`) or leaving (`after`) a coordinate. */
function spanBearing(
  coords: [number, number][],
  index: number,
  side: 'before' | 'after',
): number | null {
  if (side === 'before') {
    if (index < 1) return null;
    let j = index - 1;
    let acc = 0;
    while (j > 0 && acc < BEARING_SPAN) {
      acc += haversine(coords[j - 1], coords[j]);
      j--;
    }
    if (haversine(coords[j], coords[index]) < 1) return null;
    return bearing(coords[j], coords[index]);
  }
  if (index >= coords.length - 1) return null;
  let j = index + 1;
  let acc = 0;
  while (j < coords.length - 1 && acc < BEARING_SPAN) {
    acc += haversine(coords[j], coords[j + 1]);
    j++;
  }
  if (haversine(coords[index], coords[j]) < 1) return null;
  return bearing(coords[index], coords[j]);
}

/** Signed turn angle in degrees: negative left, positive right. */
function turnAngle(inB: number, outB: number): number {
  let d = outB - inB;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function turnWords(angle: number): { text: string; icon: string } {
  const mag = Math.abs(angle);
  if (mag < CONTINUE_ANGLE) return { text: 'Continue', icon: 'continue' };
  if (mag > SHARP_ANGLE) return { text: 'Make a U-turn', icon: 'u-turn' };
  const dir = angle < 0 ? 'left' : 'right';
  const icon = angle < 0 ? 'turn-left' : 'turn-right';
  if (mag < SLIGHT_ANGLE) return { text: `Slight ${dir}`, icon };
  return { text: `Turn ${dir}`, icon };
}

/**
 * Build turn-by-turn instructions for a route computed by StreetGraph.
 */
export function buildInstructions(graph: StreetGraph, route: StreetRoute): TurnInstruction[] {
  const { coordinates, steps } = route;
  if (coordinates.length < 2 || steps.length === 0) return [];

  // Cumulative distance at each coordinate, for instruction positions
  const cum: number[] = [0];
  for (let i = 1; i < coordinates.length; i++) {
    cum.push(cum[i - 1] + haversine(coordinates[i - 1], coordinates[i]));
  }
  const total = cum[cum.length - 1];

  // --- group steps into legs of continuous travel on one street ---
  const legs: Leg[] = [];
  for (let i = 0; i < steps.length; i++) {
    const name = displayName(graph, steps[i].edge);
    const startIdx = steps[i].coordIndex;
    const endIdx = i + 1 < steps.length ? steps[i + 1].coordIndex : coordinates.length - 1;
    const stepDist = cum[endIdx] - cum[startIdx];

    const inB = spanBearing(coordinates, startIdx, 'before');
    const outB = spanBearing(coordinates, startIdx, 'after');
    const angle = inB !== null && outB !== null ? turnAngle(inB, outB) : null;

    const prev = legs[legs.length - 1];
    if (prev && streetKey(prev.name) === streetKey(name)) {
      // Same street — carry on unless it bends sharply enough to be a decision
      if (angle === null || Math.abs(angle) < BEND_ANGLE) {
        prev.distance += stepDist;
        continue;
      }
    }
    legs.push({ name, coordIndex: startIdx, distance: stepDist, angle });
  }

  // --- absorb legs too short to be worth an instruction ---
  const merged: Leg[] = [];
  for (const leg of legs) {
    const prev = merged[merged.length - 1];
    const trivial =
      prev !== undefined &&
      (leg.distance < MIN_TIGHT_LEG ||
        (leg.distance < MIN_LEG &&
          (leg.angle === null || Math.abs(leg.angle) < SLIGHT_ANGLE)));
    if (trivial) {
      prev.distance += leg.distance;
      continue;
    }
    merged.push({ ...leg });
  }

  // A very short opening leg has nothing before it to absorb into, so fold it
  // forward instead: riders would rather be told the street they are heading
  // for than the driveway they start on.
  if (merged.length >= 2 && merged[0].distance < MIN_TIGHT_LEG) {
    merged[1].distance += merged[0].distance;
    merged[1].coordIndex = 0;
    merged[1].angle = null;
    merged.shift();
  }

  // --- emit instructions at leg boundaries ---
  const instructions: TurnInstruction[] = [];
  const firstName = merged[0].name;
  instructions.push({
    text: firstName ? `Start on ${firstName}` : 'Start your ride',
    distance: 0,
    stepDistance: 0,
    icon: 'start',
    latlng: coordinates[0],
  });

  let lastAnnounced = 0; // cumulative distance of the previous instruction
  for (let i = 1; i < merged.length; i++) {
    const leg = merged[i];
    const idx = leg.coordIndex;
    if (leg.angle === null) continue;

    const { text, icon } = turnWords(leg.angle);

    // "Continue" onto an unnamed way tells the rider nothing — skip it
    if (icon === 'continue' && !leg.name) continue;

    const at = cum[idx];
    instructions.push({
      text: leg.name ? `${text} onto ${leg.name}` : text,
      distance: at,
      stepDistance: at - lastAnnounced,
      icon,
      latlng: coordinates[idx],
    });
    lastAnnounced = at;
  }

  instructions.push({
    text: 'Arrive at destination',
    distance: total,
    stepDistance: total - lastAnnounced,
    icon: 'arrive',
    latlng: coordinates[coordinates.length - 1],
  });

  return instructions;
}
