// Shared route test scenarios — used by router tests (fixture replay) and
// scripts/record-brouter-fixtures.ts (fixture recording). Coordinates are
// real geocoded Portland locations.

export interface RouteScenario {
  name: string;
  profile: 'safest' | 'balanced';
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
}

export const PLACES = {
  COOK_431: { lat: 45.5473593, lng: -122.6608221 },
  THE_REDD: { lat: 45.5145893, lng: -122.6569925 },
  SELLWOOD_PARK: { lat: 45.467536, lng: -122.6603582 },
  ZOIGLHAUS: { lat: 45.4809278, lng: -122.568338 },
} as const;

export const SCENARIOS: RouteScenario[] = [
  { name: 'cook-to-redd-safest', profile: 'safest', from: PLACES.COOK_431, to: PLACES.THE_REDD },
  { name: 'cook-to-sellwood-safest', profile: 'safest', from: PLACES.COOK_431, to: PLACES.SELLWOOD_PARK },
  { name: 'cook-to-zoiglhaus-safest', profile: 'safest', from: PLACES.COOK_431, to: PLACES.ZOIGLHAUS },
  { name: 'cook-to-redd-balanced', profile: 'balanced', from: PLACES.COOK_431, to: PLACES.THE_REDD },
];

export const FIXTURES_PATH = 'src/__fixtures__/brouter-fixtures.json';

/** Key for one recorded BRouter request/response pair. */
export function fixtureKey(profile: string, lonlats: string): string {
  return `${profile}|${lonlats}`;
}
