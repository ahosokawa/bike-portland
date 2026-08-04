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
  debug?: RouteDebugInfo; // populated for dev inspection (?debug=1)
}

/** Internals of how a route was assembled, for the dev debug overlay. */
export interface RouteDebugInfo {
  source: 'pbot+brouter' | 'brouter';
  /** PBOT network entry/exit where BRouter segments are stitched on. */
  stitchPoints: { label: string; latlng: [number, number] }[];
  /** Geometry of synthetic gap/preference edges (after BRouter resolution). */
  gapSegments: [number, number][][];
  /**
   * Coordinate indices where independently computed sections join
   * (first-mile→core, core→last-mile). coords[i-1] and coords[i] at each
   * index i come from different sources and must be adjacent on the ground.
   */
  sectionBoundaries: number[];
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
    [key: string]: unknown;
  };
}
