import L from 'leaflet';

const PORTLAND_CENTER: [number, number] = [45.523064, -122.676483];
const DEFAULT_ZOOM = 13;
const NAV_ZOOM = 17;

let map: L.Map;
let startMarker: L.Marker | null = null;
let endMarker: L.Marker | null = null;
let routeLine: L.Polyline | null = null;
let userMarker: L.Marker | null = null;
let accuracyCircle: L.Circle | null = null;

function createMarkerIcon(label: string, color: 'green' | 'red'): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div class="custom-marker marker-${color}"><span>${label}</span></div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 32],
  });
}

function createUserIcon(heading: number | null): L.DivIcon {
  const rotation = heading !== null ? heading : 0;
  const arrow = heading !== null
    ? `<div class="user-heading" style="transform: rotate(${rotation}deg)"></div>`
    : '';
  return L.divIcon({
    className: '',
    html: `<div class="user-marker">${arrow}<div class="user-dot"></div></div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
}

export function initMap(): L.Map {
  map = L.map('map', {
    center: PORTLAND_CENTER,
    zoom: DEFAULT_ZOOM,
    zoomControl: false,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  L.control.zoom({ position: 'topright' }).addTo(map);

  return map;
}

export function getMap(): L.Map {
  return map;
}

export function setStartMarker(latlng: L.LatLng): void {
  if (startMarker) {
    startMarker.setLatLng(latlng);
  } else {
    startMarker = L.marker(latlng, {
      icon: createMarkerIcon('A', 'green'),
      draggable: true,
    }).addTo(map);
    startMarker.on('dragend', () => {
      const event = new CustomEvent('marker-drag', {
        detail: { type: 'start', latlng: startMarker!.getLatLng() },
      });
      document.dispatchEvent(event);
    });
  }
}

export function setEndMarker(latlng: L.LatLng): void {
  if (endMarker) {
    endMarker.setLatLng(latlng);
  } else {
    endMarker = L.marker(latlng, {
      icon: createMarkerIcon('B', 'red'),
      draggable: true,
    }).addTo(map);
    endMarker.on('dragend', () => {
      const event = new CustomEvent('marker-drag', {
        detail: { type: 'end', latlng: endMarker!.getLatLng() },
      });
      document.dispatchEvent(event);
    });
  }
}

export function displayRoute(coords: [number, number][]): void {
  clearRoute();
  routeLine = L.polyline(coords, {
    color: '#2d8a4e',
    weight: 5,
    opacity: 0.85,
  }).addTo(map);
  map.fitBounds(routeLine.getBounds(), { padding: [60, 60] });
}

export function clearRoute(): void {
  if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
  }
}

export function clearMarkers(): void {
  if (startMarker) {
    map.removeLayer(startMarker);
    startMarker = null;
  }
  if (endMarker) {
    map.removeLayer(endMarker);
    endMarker = null;
  }
}

/** Update user's live position on the map during navigation */
export function updateUserPosition(
  lat: number,
  lng: number,
  heading: number | null,
  accuracy: number,
  followUser: boolean,
): void {
  const latlng = L.latLng(lat, lng);

  if (userMarker) {
    userMarker.setLatLng(latlng);
    userMarker.setIcon(createUserIcon(heading));
  } else {
    userMarker = L.marker(latlng, {
      icon: createUserIcon(heading),
      zIndexOffset: 1000, // above route and other markers
      interactive: false,
    }).addTo(map);
  }

  // Accuracy circle
  if (accuracyCircle) {
    accuracyCircle.setLatLng(latlng);
    accuracyCircle.setRadius(accuracy);
  } else {
    accuracyCircle = L.circle(latlng, {
      radius: accuracy,
      color: '#4285f4',
      fillColor: '#4285f4',
      fillOpacity: 0.1,
      weight: 1,
      opacity: 0.3,
      interactive: false,
    }).addTo(map);
  }

  if (followUser) {
    map.setView(latlng, Math.max(map.getZoom(), NAV_ZOOM), { animate: true });
  }
}

/** Remove user position marker */
export function clearUserPosition(): void {
  if (userMarker) {
    map.removeLayer(userMarker);
    userMarker = null;
  }
  if (accuracyCircle) {
    map.removeLayer(accuracyCircle);
    accuracyCircle = null;
  }
}

/** Hide planning markers during navigation to declutter */
export function setPlanningMarkersVisible(visible: boolean): void {
  if (startMarker) {
    if (visible) startMarker.addTo(map);
    else map.removeLayer(startMarker);
  }
  if (endMarker) {
    if (visible) endMarker.addTo(map);
    else map.removeLayer(endMarker);
  }
}
