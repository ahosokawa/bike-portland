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
  CATHEDRAL_PARK: { lat: 45.5873, lng: -122.7595 },      // St Johns, under the bridge
  PENINSULA_PARK: { lat: 45.5729, lng: -122.6722 },      // N Portland rose garden
  PSU: { lat: 45.5119, lng: -122.6845 },                 // downtown west side
  BAGDAD_THEATER: { lat: 45.5120, lng: -122.6224 },      // SE Hawthorne & 37th
  ALBERTA_15TH: { lat: 45.5590, lng: -122.6510 },        // NE Alberta arts district
  MODA_CENTER: { lat: 45.5316, lng: -122.6668 },         // Rose Quarter
  MONTAVILLA: { lat: 45.5111, lng: -122.5588 },          // SE 76th & Stark area
  LAURELHURST_PARK: { lat: 45.5210, lng: -122.6262 },
  KENTON: { lat: 45.5830, lng: -122.6875 },              // N Denver Ave
  MISSISSIPPI_SKIDMORE: { lat: 45.5525, lng: -122.6755 },
} as const;

export const SCENARIOS: RouteScenario[] = [
  // Inner NE/SE
  { name: 'cook-to-redd-safest', profile: 'safest', from: PLACES.COOK_431, to: PLACES.THE_REDD },
  { name: 'cook-to-sellwood-safest', profile: 'safest', from: PLACES.COOK_431, to: PLACES.SELLWOOD_PARK },
  { name: 'cook-to-zoiglhaus-safest', profile: 'safest', from: PLACES.COOK_431, to: PLACES.ZOIGLHAUS },
  // North Portland
  { name: 'stjohns-to-peninsula-safest', profile: 'safest', from: PLACES.CATHEDRAL_PARK, to: PLACES.PENINSULA_PARK },
  { name: 'kenton-to-mississippi-safest', profile: 'safest', from: PLACES.KENTON, to: PLACES.MISSISSIPPI_SKIDMORE },
  // River crossing west↔east
  { name: 'psu-to-hawthorne-safest', profile: 'safest', from: PLACES.PSU, to: PLACES.BAGDAD_THEATER },
  // NE → Lloyd
  { name: 'alberta-to-moda-safest', profile: 'safest', from: PLACES.ALBERTA_15TH, to: PLACES.MODA_CENTER },
  // Outer SE east-west
  { name: 'montavilla-to-laurelhurst-safest', profile: 'safest', from: PLACES.MONTAVILLA, to: PLACES.LAURELHURST_PARK },
  // Pure-BRouter profile
  { name: 'cook-to-redd-balanced', profile: 'balanced', from: PLACES.COOK_431, to: PLACES.THE_REDD },
];

export const FIXTURES_PATH = 'src/__fixtures__/brouter-fixtures.json';

/** Key for one recorded BRouter request/response pair. */
export function fixtureKey(profile: string, lonlats: string): string {
  return `${profile}|${lonlats}`;
}
