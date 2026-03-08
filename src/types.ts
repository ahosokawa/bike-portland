import type { LatLng } from 'leaflet';

export interface RouteResult {
  coordinates: [number, number][]; // [lat, lng]
  distance: number; // meters
  time: number; // seconds
  elevations: number[]; // meters, one per coordinate
  ascend: number; // total meters gained
  descend: number; // total meters descended
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
