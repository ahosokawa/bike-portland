// Instruction generation over real routes from the shipped street graph.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { StreetGraph } from './street-graph';
import type { EncodedGraph } from './street-graph';
import { buildInstructions } from './route-instructions';
import { SCENARIOS, PLACES } from './route-scenarios';
import { haversine } from './geo';

let graph: StreetGraph;

beforeAll(() => {
  const data = JSON.parse(
    readFileSync(resolve(__dirname, '../public/data/street-graph.json'), 'utf8'),
  ) as EncodedGraph;
  graph = new StreetGraph(data);
});

describe.each(SCENARIOS)('instructions: $name', (scenario) => {
  it('are well-formed end to end', () => {
    const route = graph.route(scenario.from, scenario.to, scenario.profile)!;
    const inst = buildInstructions(graph, route);

    expect(inst.length).toBeGreaterThanOrEqual(3);
    expect(inst[0].icon).toBe('start');
    expect(inst[inst.length - 1].icon).toBe('arrive');

    // Cumulative distances advance monotonically and finish at the route length
    for (let i = 1; i < inst.length; i++) {
      expect(inst[i].distance).toBeGreaterThanOrEqual(inst[i - 1].distance);
    }
    expect(inst[inst.length - 1].distance).toBeCloseTo(route.distance, 0);

    // Step distances sum to the route length
    const summed = inst.reduce((s, i) => s + i.stepDistance, 0);
    expect(Math.abs(summed - route.distance)).toBeLessThan(1);

    for (const step of inst) {
      expect(step.text.trim().length).toBeGreaterThan(0);
      expect(step.text).not.toMatch(/undefined|NaN|\[object/);
      // Every instruction sits on the route geometry
      const onRoute = route.coordinates.some(c => haversine(c, step.latlng) < 1);
      expect(onRoute, `instruction "${step.text}" should sit on the route`).toBe(true);
    }
  });

  it('names the streets it directs the rider onto', () => {
    const route = graph.route(scenario.from, scenario.to, scenario.profile)!;
    const inst = buildInstructions(graph, route);
    const turns = inst.filter(i => i.icon !== 'start' && i.icon !== 'arrive');
    const named = turns.filter(i => / onto /.test(i.text));
    // The whole point of routing on OSM: turns reference real street names
    expect(named.length / Math.max(1, turns.length)).toBeGreaterThan(0.85);
  });

  it('does not emit instructions a rider cannot act on', () => {
    const route = graph.route(scenario.from, scenario.to, scenario.profile)!;
    const inst = buildInstructions(graph, route);
    // Consecutive instructions closer than 12m are noise from junction jogs
    for (let i = 1; i < inst.length - 1; i++) {
      expect(
        inst[i].stepDistance,
        `"${inst[i - 1].text}" → "${inst[i].text}" are too close together`,
      ).toBeGreaterThanOrEqual(11.9);
    }
  });
});

describe('instruction wording', () => {
  it('treats a Portland quadrant rename as the same street', () => {
    // NE 7th Ave becomes SE 7th Ave at Burnside — riders just keep pedalling
    const route = graph.route(PLACES.COOK_431, PLACES.THE_REDD, 'safest')!;
    const inst = buildInstructions(graph, route);
    const quadrantOnly = inst.filter(i =>
      /Continue onto (North|South)(east|west)? \d+\w* Avenue/.test(i.text),
    );
    for (const step of quadrantOnly) {
      // Any such instruction must be a genuine change of street, not 7th→7th
      const prevIdx = inst.indexOf(step) - 1;
      expect(inst[prevIdx].text).not.toContain(step.text.replace(/^Continue onto \w+ /, ''));
    }
  });

  it('describes unnamed ways by what they are', () => {
    const route = graph.route(PLACES.COOK_431, PLACES.SELLWOOD_PARK, 'safest')!;
    const inst = buildInstructions(graph, route);
    for (const step of inst) {
      expect(step.text).not.toMatch(/ onto\s*$/); // never a dangling "onto"
    }
  });

  it('uses turn icons consistent with the wording', () => {
    for (const scenario of SCENARIOS) {
      const route = graph.route(scenario.from, scenario.to, scenario.profile)!;
      for (const step of buildInstructions(graph, route)) {
        if (/left/i.test(step.text)) expect(step.icon).toBe('turn-left');
        if (/right/i.test(step.text)) expect(step.icon).toBe('turn-right');
        if (/U-turn/i.test(step.text)) expect(step.icon).toBe('u-turn');
      }
    }
  });
});
