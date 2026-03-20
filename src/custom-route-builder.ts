import L from 'leaflet';
import { computeRouteMulti } from './router';
import type { RouteResult, Waypoint } from './types';

// Use 'shortest' profile so the route follows roads but takes the most
// direct path between waypoints — giving the user full control over routing.
const BUILDER_PROFILE = 'shortest';

let active = false;
let map: L.Map;
let waypoints: Waypoint[] = [];
let waypointMarkers: L.Marker[] = [];
let previewLine: L.Polyline | null = null;
let routeLine: L.Polyline | null = null;
let lastRoute: RouteResult | null = null;
let onRouteComputed: ((route: RouteResult) => void) | null = null;
let onWaypointsChanged: ((count: number) => void) | null = null;
let computeRequestId = 0;

// ========== Waypoint marker icon ==========

function createWaypointIcon(index: number): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div class="waypoint-marker"><span>${index + 1}</span></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
  });
}

// ========== Lifecycle ==========

export function enterBuilderMode(
  leafletMap: L.Map,
  routeCallback: (route: RouteResult) => void,
  waypointCallback: (count: number) => void,
): void {
  map = leafletMap;
  active = true;
  onRouteComputed = routeCallback;
  onWaypointsChanged = waypointCallback;
  waypoints = [];
  waypointMarkers = [];
  lastRoute = null;
  computeRequestId = 0;
}

export function exitBuilderMode(): void {
  clearAllWaypoints();
  clearRouteLine();
  active = false;
  lastRoute = null;
  onRouteComputed = null;
  onWaypointsChanged = null;
}

export function isBuilding(): boolean {
  return active;
}

export function getWaypoints(): Waypoint[] {
  return waypoints.slice();
}

export function getLastRoute(): RouteResult | null {
  return lastRoute;
}

// ========== Waypoint management ==========

export function addWaypoint(latlng: L.LatLng): void {
  const wp: Waypoint = { lat: latlng.lat, lng: latlng.lng };
  waypoints.push(wp);

  const index = waypoints.length - 1;
  const marker = L.marker(latlng, {
    icon: createWaypointIcon(index),
    draggable: true,
    zIndexOffset: 500,
  }).addTo(map);

  marker.on('dragend', () => {
    const pos = marker.getLatLng();
    const idx = waypointMarkers.indexOf(marker);
    if (idx >= 0) {
      waypoints[idx] = { lat: pos.lat, lng: pos.lng };
      updatePreviewLine();
      autoCompute();
    }
  });

  waypointMarkers.push(marker);
  updatePreviewLine();
  notifyWaypointsChanged();
  autoCompute();
}

export function undoLastWaypoint(): void {
  if (waypoints.length === 0) return;
  waypoints.pop();
  const marker = waypointMarkers.pop();
  if (marker) map.removeLayer(marker);
  updatePreviewLine();
  notifyWaypointsChanged();

  if (waypoints.length >= 2) {
    autoCompute();
  } else {
    clearRouteLine();
    lastRoute = null;
  }
}

export function clearAllWaypoints(): void {
  for (const m of waypointMarkers) {
    map.removeLayer(m);
  }
  waypointMarkers = [];
  waypoints = [];
  if (previewLine) {
    map.removeLayer(previewLine);
    previewLine = null;
  }
  clearRouteLine();
  lastRoute = null;
  notifyWaypointsChanged();
}

// ========== Internals ==========

function rebuildMarkers(): void {
  for (const m of waypointMarkers) {
    map.removeLayer(m);
  }
  waypointMarkers = [];

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    const marker = L.marker(L.latLng(wp.lat, wp.lng), {
      icon: createWaypointIcon(i),
      draggable: true,
      zIndexOffset: 500,
    }).addTo(map);

    marker.on('dragend', () => {
      const pos = marker.getLatLng();
      const idx = waypointMarkers.indexOf(marker);
      if (idx >= 0) {
        waypoints[idx] = { lat: pos.lat, lng: pos.lng };
        updatePreviewLine();
        autoCompute();
      }
    });

    waypointMarkers.push(marker);
  }
}

function updatePreviewLine(): void {
  if (previewLine) {
    map.removeLayer(previewLine);
    previewLine = null;
  }
  if (waypoints.length >= 2) {
    const coords = waypoints.map(w => L.latLng(w.lat, w.lng));
    previewLine = L.polyline(coords, {
      color: '#3498db',
      weight: 3,
      opacity: 0.4,
      dashArray: '6, 8',
    }).addTo(map);
  }
}

function clearRouteLine(): void {
  if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
  }
}

function displayBuilderRoute(coords: [number, number][]): void {
  clearRouteLine();
  routeLine = L.polyline(coords, {
    color: '#2d8a4e',
    weight: 5,
    opacity: 0.85,
  }).addTo(map);
}

function notifyWaypointsChanged(): void {
  if (onWaypointsChanged) {
    onWaypointsChanged(waypoints.length);
  }
}

function autoCompute(): void {
  if (waypoints.length < 2) return;

  const requestId = ++computeRequestId;

  computeRouteMulti(waypoints, BUILDER_PROFILE)
    .then((route) => {
      if (requestId !== computeRequestId) return;
      lastRoute = route;
      displayBuilderRoute(route.coordinates);
      if (onRouteComputed) onRouteComputed(route);
    })
    .catch((err) => {
      if (requestId !== computeRequestId) return;
      console.debug('[PedalPDX] Builder route preview failed:', err);
    });
}

