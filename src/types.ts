import type { LatLng } from 'leaflet';

import type { InfraTier } from './street-graph';

export interface RouteResult {
  coordinates: [number, number][]; // [lat, lng]
  /** Bike-infrastructure tier per coordinate, for colour-coded rendering. */
  tiers: InfraTier[];
  distance: number; // meters
  time: number; // seconds
  elevations: number[]; // meters, one per coordinate
  ascend: number; // total meters gained
  descend: number; // total meters descended
  hasElevation: boolean; // false until the graph carries elevation data
  instructions: TurnInstruction[];
  debug?: RouteDebugInfo; // populated for dev inspection (?debug=1)
}

/** How a route was produced, for the dev debug overlay. */
export interface RouteDebugInfo {
  source: 'street-graph';
  profile: string;
  /** Number of graph edges traversed. */
  steps: number;
  /** Where the requested points snapped onto the network. */
  snapPoints: { label: string; latlng: [number, number] }[];
}

export interface TurnInstruction {
  text: string;
  distance: number; // cumulative meters from route start to this turn
  stepDistance: number; // meters for this step
  icon: string; // emoji
  latlng: [number, number]; // [lat, lng] of the turn point
}

export interface SearchResult {
  display_name: string;
  lat: number;
  lon: number;
}

export type PointMode = 'start' | 'end';

export interface AppState {
  mode: PointMode;
  start: LatLng | null;
  end: LatLng | null;
  route: RouteResult | null;
}

export interface Waypoint {
  lat: number;
  lng: number;
}

export interface SavedRoute {
  id: string;
  name: string;
  waypoints: Waypoint[];
  distance: number;       // meters
  profileKey: string;     // which BRouter profile was used
  cachedRoute?: RouteResult; // full computed route for offline use
  createdAt: number;
  updatedAt: number;
}

export interface HomeAddress {
  lat: number;
  lng: number;
  displayName: string;
}

export interface BRouterFeature {
  geometry: {
    coordinates: number[][];
  };
  properties: {
    'track-length'?: string;
    'total-time'?: string;
    'filtered ascend'?: string;
    'filtered descend'?: string;
    messages?: string[][];
    /** Turn hints from timode=2: [coordIndex, command, roundaboutExit, distance, angle] */
    voicehints?: number[][];
    [key: string]: unknown;
  };
}
