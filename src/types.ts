import type { LatLng } from 'leaflet';

export interface RouteResult {
  coordinates: [number, number][]; // [lat, lng]
  distance: number; // meters
  time: number; // seconds
  elevations: number[]; // meters, one per coordinate
  ascend: number; // total meters gained
  descend: number; // total meters descended
  hasElevation: boolean; // true if elevation data is real (BRouter), false if unavailable (PBOT-only)
  instructions: TurnInstruction[];
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

export interface EdgePreference {
  edgeKey: string;              // canonical edge key (DB primary key) — for single-edge prefs
  type: 'preferred' | 'nogo';
  name: string;
  coords: [number, number][][]; // array of [lat, lng][] polylines (one per sub-edge)
  createdAt: number;
  groupId?: string;             // links multi-edge custom segments (all edges share one groupId)
  allEdgeKeys?: string[];       // all edge keys in the group (only set on custom segments)
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
    [key: string]: unknown;
  };
}
