import L from 'leaflet';
import {
  initMap,
  getMap,
  setStartMarker,
  setEndMarker,
  displayRoute,
  clearRoute,
  clearMarkers,
  clearStartMarker,
  clearEndMarker,
  updateUserPosition,
  clearUserPosition,
  setPlanningMarkersVisible,
} from './map';
import { computeGuidedRoute, computeRouteMulti, ROUTE_PROFILES, setRouteProfile, getRouteProfile, detectBacktracking } from './router';
import { classifyRoute } from './pbot-graph';
import type { RouteProfileKey } from './router';
import { initSearch, reverseGeocode, setSearchBias } from './search';
import { getCurrentPosition } from './geolocation';
import { drawElevationProfile } from './elevation';
import { loadPbotData, togglePbotLayer, getPbotLayer, showPbotLayer, hidePbotLayer, isPbotLayerVisible } from './pbot-layer';
import { nk, canonicalEdgeKey, injectPolylineEdges } from './pbot-graph';
import {
  loadPreferences,
  initPreferencesLayer,
  showPreferencesLayer,
  hidePreferencesLayer,
  onPreferenceRemoved,
  injectPreferenceEdges,
  setPreference,
  setPreferenceGroup,
  removePreference,
  getPreferences,
  getUniquePreferences,
} from './edge-preferences';
import { fetchRoadGeometry } from './router';
import type { EdgePreference } from './types';
import { startNavigation, stopNavigation, isNavigating } from './navigation';
import {
  enterBuilderMode,
  exitBuilderMode,
  isBuilding,
  addWaypoint,
  undoLastWaypoint,
  clearAllWaypoints,
  getWaypoints,
  getLastRoute,
} from './custom-route-builder';
import { saveRoute as dbSaveRoute, getAllRoutes, getRoute, deleteRoute, getHomeAddress, setHomeAddress, clearHomeAddress } from './saved-routes';
import type { NavUpdate } from './navigation';
import type { AppState, RouteResult, SavedRoute, HomeAddress } from './types';
import { turnIconSvg } from './icons';
import { METERS_PER_MILE, FEET_PER_METER } from './geo';

const state: AppState = {
  mode: 'start',
  start: null,
  end: null,
  route: null,
};

let homeAddress: HomeAddress | null = null;
let routeRequestId = 0;
let followUser = true;
let editingPreferences = false;
let pbotWasVisibleBeforePrefs = false;
let pbotClickHandler: ((e: L.LeafletEvent) => void) | null = null;
let prefMapClickHandler: ((e: L.LeafletMouseEvent) => void) | null = null;
let prefPbotFlagHandler: ((e: L.LeafletEvent) => void) | null = null;

// Multi-waypoint custom segment drawing state
let prefWaypoints: { lat: number; lng: number }[] = [];
let prefWaypointMarkers: L.CircleMarker[] = [];
let prefRouteLine: L.Polyline | null = null;
let prefRouteCoords: [number, number][] = []; // accumulated BRouter coords
let prefComputeId = 0;

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function init(): void {
  const map = initMap();

  // Load PBOT data and preferences in parallel, then inject preference edges
  Promise.all([loadPbotData(map), loadPreferences()]).then(() => {
    injectPreferenceEdges();
    initPreferencesLayer(map);
    onPreferenceRemoved(() => {
      updatePreferencesStatus();
    });
  });

  map.on('click', (e: L.LeafletMouseEvent) => {
    if (isNavigating()) return;
    if (editingPreferences) return; // clicks handled by PBOT layer
    if (isBuilding()) {
      addWaypoint(e.latlng);
      return;
    }
    handleMapTap(e.latlng);
  });

  document.addEventListener('marker-drag', ((e: CustomEvent) => {
    if (isNavigating() || isBuilding()) return;
    const { type, latlng } = e.detail;
    if (type === 'start') {
      state.start = latlng;
      resolveAndDisplay('start', latlng.lat, latlng.lng);
    } else {
      state.end = latlng;
      resolveAndDisplay('end', latlng.lat, latlng.lng);
    }
    tryRoute();
  }) as EventListener);

  // Two-input search: start and end
  initSearch(
    (lat, lon, displayName) => {
      const latlng = L.latLng(lat, lon);
      getMap().setView(latlng, 15);
      state.start = latlng;
      setStartMarker(latlng);
      updateInputDisplay('start', displayName);
      updateClearButtons();
      if (!state.end) {
        ($('input-end') as HTMLInputElement).focus();
      }
      tryRoute();
    },
    (lat, lon, displayName) => {
      const latlng = L.latLng(lat, lon);
      getMap().setView(latlng, 15);
      state.end = latlng;
      setEndMarker(latlng);
      updateInputDisplay('end', displayName);
      updateClearButtons();
      if (!state.start) {
        ($('input-start') as HTMLInputElement).focus();
      }
      tryRoute();
    },
    () => homeAddress,
  );

  initLayersMenu(map);

  // Planning buttons — btn-my-location is dual-purpose: GPS when empty, clear when filled
  $('btn-my-location').addEventListener('click', () => {
    if (($('input-start') as HTMLInputElement).value.trim()) {
      handleClearStart();
    } else {
      handleLocate();
    }
  });
  $('btn-clear-end').addEventListener('click', handleClearEnd);
  $('btn-swap').addEventListener('click', handleSwap);

  // Home address buttons
  $('btn-set-home').addEventListener('click', handleSetHome);
  $('btn-clear-home').addEventListener('click', handleClearHome);

  // Load home address from IndexedDB and auto-populate start
  getHomeAddress().then(home => {
    homeAddress = home;
    updateHomeAddressUI();
    if (home && !state.start) {
      state.start = L.latLng(home.lat, home.lng);
      setStartMarker(state.start);
      updateInputDisplay('start', home.displayName);
    }
  });

  // Navigation buttons
  $('btn-go').addEventListener('click', handleStartNav);
  $('btn-stop-nav').addEventListener('click', handleStopNav);

  // Route details toggle
  $('btn-route-details').addEventListener('click', () => {
    $('route-details').classList.toggle('collapsed');
    $('btn-route-details').classList.toggle('expanded');
  });

  // Builder buttons
  $('btn-create-route').addEventListener('click', () => handleEnterBuilder(map));
  $('btn-undo-waypoint').addEventListener('click', handleUndoWaypoint);
  $('btn-clear-waypoints').addEventListener('click', handleClearWaypoints);
  $('btn-save-route').addEventListener('click', handleSaveRoute);
  $('btn-exit-builder').addEventListener('click', handleExitBuilder);

  // Saved routes buttons
  $('btn-saved-routes').addEventListener('click', handleShowSavedRoutes);
  $('btn-close-saved').addEventListener('click', () => $('saved-routes-panel').classList.add('hidden'));

  // Preferences buttons
  $('btn-preferences').addEventListener('click', () => handleEnterPreferences(map));
  $('btn-exit-preferences').addEventListener('click', handleExitPreferences);
  $('btn-pref-undo').addEventListener('click', handlePrefUndo);
  $('btn-pref-save-prefer').addEventListener('click', () => handlePrefSave('preferred'));
  $('btn-pref-save-block').addEventListener('click', () => handlePrefSave('nogo'));

  // Initialize button states (end clear button hidden on load)
  updateClearButtons();

  // Keep search bias in sync with map viewport
  map.on('moveend', () => {
    const c = map.getCenter();
    const b = map.getBounds();
    const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
    setSearchBias(c.lat, c.lng, bbox);
  });

  // During nav, let user drag map to explore, but tap to re-center
  map.on('dragstart', () => {
    if (isNavigating()) followUser = false;
  });
  map.on('click', () => {
    if (isNavigating()) followUser = true;
  });
}

// ========== Layers menu ==========

function initLayersMenu(map: L.Map): void {
  const layersBtn = $('btn-layers');
  const layersPanel = $('layers-panel');
  const backdrop = $('layers-backdrop');

  layersBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = layersPanel.classList.toggle('visible');
    backdrop.classList.toggle('visible', isOpen);
    layersBtn.classList.toggle('active', isOpen);
  });

  backdrop.addEventListener('click', () => {
    closeLayersMenu();
  });

  // Legend collapse toggle
  const legendToggle = layersPanel.querySelector('.legend-toggle');
  if (legendToggle) {
    legendToggle.addEventListener('click', () => {
      const legend = layersPanel.querySelector('.legend-collapsible');
      if (legend) {
        legend.classList.toggle('collapsed');
        legendToggle.classList.toggle('expanded');
      }
    });
  }

  // Profile options
  const profileContainer = $('profile-options');
  profileContainer.innerHTML = (Object.entries(ROUTE_PROFILES) as [RouteProfileKey, typeof ROUTE_PROFILES[RouteProfileKey]][])
    .map(([key, val]) =>
      `<div class="profile-option${key === getRouteProfile() ? ' active' : ''}" data-profile="${key}">
        <div class="profile-radio"><div class="profile-radio-inner"></div></div>
        <div class="profile-label">
          <span class="profile-label-name">${val.label}</span>
          <span class="profile-label-desc">${val.description}</span>
        </div>
      </div>`
    )
    .join('');

  profileContainer.addEventListener('click', (e) => {
    const option = (e.target as HTMLElement).closest('.profile-option') as HTMLElement | null;
    if (!option) return;
    const key = option.dataset.profile as RouteProfileKey;
    if (key === getRouteProfile()) return;
    setRouteProfile(key);
    profileContainer.querySelectorAll('.profile-option').forEach((o) => o.classList.remove('active'));
    option.classList.add('active');
    tryRoute();
  });

  // Bike routes overlay toggle
  const toggleRow = $('layer-toggle');
  const toggleSwitch = toggleRow.querySelector('.toggle-switch')!;
  toggleRow.addEventListener('click', () => {
    const isVisible = togglePbotLayer(map);
    toggleSwitch.classList.toggle('on', isVisible);
  });
}

function closeLayersMenu(): void {
  $('layers-panel').classList.remove('visible');
  $('layers-backdrop').classList.remove('visible');
  $('btn-layers').classList.remove('active');
}

// ========== Planning mode ==========

function updateInputDisplay(which: 'start' | 'end', text: string): void {
  const inputId = which === 'start' ? 'input-start' : 'input-end';
  ($(inputId) as HTMLInputElement).value = text;
  updateClearButtons();
}

/** Show coords immediately, then resolve to a street address. */
function resolveAndDisplay(which: 'start' | 'end', lat: number, lng: number): void {
  updateInputDisplay(which, `${lat.toFixed(4)}, ${lng.toFixed(4)}`);
  reverseGeocode(lat, lng).then(address => {
    // Only update if the point hasn't changed since we fired the request
    const current = which === 'start' ? state.start : state.end;
    if (current && Math.abs(current.lat - lat) < 0.0001 && Math.abs(current.lng - lng) < 0.0001) {
      updateInputDisplay(which, address);
    }
  });
}

function handleMapTap(latlng: L.LatLng): void {
  const activeEl = document.activeElement;
  const startInput = $('input-start');
  const endInput = $('input-end');

  if (activeEl === startInput) {
    state.start = latlng;
    setStartMarker(latlng);
    resolveAndDisplay('start', latlng.lat, latlng.lng);
    startInput.blur();
    if (!state.end) (endInput as HTMLInputElement).focus();
  } else if (activeEl === endInput) {
    state.end = latlng;
    setEndMarker(latlng);
    resolveAndDisplay('end', latlng.lat, latlng.lng);
    endInput.blur();
    if (!state.start) (startInput as HTMLInputElement).focus();
  } else if (!state.route) {
    // Only auto-fill from map taps when no route is showing.
    // Once a route exists, user must tap an input field first.
    if (!state.end) {
      state.end = latlng;
      setEndMarker(latlng);
      resolveAndDisplay('end', latlng.lat, latlng.lng);
    } else if (!state.start) {
      state.start = latlng;
      setStartMarker(latlng);
      resolveAndDisplay('start', latlng.lat, latlng.lng);
    } else {
      state.end = latlng;
      setEndMarker(latlng);
      resolveAndDisplay('end', latlng.lat, latlng.lng);
    }
  } else {
    // Route is showing and no input focused — ignore tap
    return;
  }

  tryRoute();
}

function tryRoute(): void {
  if (state.start && state.end) {
    handleRoute();
  }
}

async function handleLocate(): Promise<void> {
  const btn = $('btn-my-location');
  btn.classList.add('locating');
  try {
    const pos = await getCurrentPosition();
    const latlng = L.latLng(pos.lat, pos.lng);
    setSearchBias(pos.lat, pos.lng);
    getMap().setView(latlng, 15);
    state.start = latlng;
    setStartMarker(latlng);
    resolveAndDisplay('start', latlng.lat, latlng.lng);
    if (!state.end) {
      ($('input-end') as HTMLInputElement).focus();
    }
    tryRoute();
  } catch {
    alert('Could not get your location. Please enable location services.');
  } finally {
    btn.classList.remove('locating');
  }
}

function handleSwap(): void {
  const tempLatlng = state.start;
  state.start = state.end;
  state.end = tempLatlng;

  const startInput = $('input-start') as HTMLInputElement;
  const endInput = $('input-end') as HTMLInputElement;
  const tempText = startInput.value;
  startInput.value = endInput.value;
  endInput.value = tempText;

  clearMarkers();
  if (state.start) setStartMarker(state.start);
  if (state.end) setEndMarker(state.end);

  updateClearButtons();
  tryRoute();
}

/** Collect preference polylines for route classification coloring. */
function getPreferenceCoords(): { preferred?: [number, number][][]; nogo?: [number, number][][] } {
  const all = getUniquePreferences();
  const preferred = all.filter(p => p.type === 'preferred').flatMap(p => p.coords);
  const nogo = all.filter(p => p.type === 'nogo').flatMap(p => p.coords);
  return {
    preferred: preferred.length > 0 ? preferred : undefined,
    nogo: nogo.length > 0 ? nogo : undefined,
  };
}

async function handleRoute(): Promise<void> {
  if (!state.start || !state.end) return;

  const requestId = ++routeRequestId;
  $('loading').classList.remove('hidden');

  try {
    const route = await computeGuidedRoute(state.start, state.end);
    if (requestId !== routeRequestId) return;
    state.route = route;
    detectBacktracking(route.coordinates);
    displayRoute(route.coordinates, classifyRoute(route.coordinates, getPreferenceCoords()));
    showRoutePanel(route);
  } catch (err) {
    if (requestId !== routeRequestId) return;
    alert(`Routing error: ${err instanceof Error ? err.message : 'Unknown error'}`);
  } finally {
    if (requestId === routeRequestId) {
      $('loading').classList.add('hidden');
    }
  }
}

function handleClear(): void {
  state.start = null;
  state.end = null;
  state.route = null;
  routeRequestId++;
  clearRoute();
  clearMarkers();
  ($('input-start') as HTMLInputElement).value = '';
  ($('input-end') as HTMLInputElement).value = '';
  $('route-panel').classList.add('hidden');
  $('loading').classList.add('hidden');
  // Clear stale search results
  const results = $('search-results');
  results.innerHTML = '';
  results.classList.remove('visible');
  updateClearButtons();
}

function handleClearStart(): void {
  state.start = null;
  clearStartMarker();
  ($('input-start') as HTMLInputElement).value = '';
  if (state.route) {
    state.route = null;
    routeRequestId++;
    clearRoute();
    $('route-panel').classList.add('hidden');
  }
  updateClearButtons();
}

function handleClearEnd(): void {
  state.end = null;
  clearEndMarker();
  ($('input-end') as HTMLInputElement).value = '';
  if (state.route) {
    state.route = null;
    routeRequestId++;
    clearRoute();
    $('route-panel').classList.add('hidden');
  }
  updateClearButtons();
}

const GPS_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2"/></svg>';
const CLEAR_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

function updateClearButtons(): void {
  const startHasContent = !!($('input-start') as HTMLInputElement).value.trim();
  const endHasContent = !!($('input-end') as HTMLInputElement).value.trim();

  // Start row: toggle btn-my-location between GPS icon and clear icon
  const startBtn = $('btn-my-location');
  if (startHasContent) {
    startBtn.innerHTML = CLEAR_ICON;
    startBtn.title = 'Clear start';
    startBtn.setAttribute('aria-label', 'Clear start');
  } else {
    startBtn.innerHTML = GPS_ICON;
    startBtn.title = 'Use my location';
    startBtn.setAttribute('aria-label', 'Use my location');
  }

  // End row: toggle visibility (not display) to preserve layout space
  $('btn-clear-end').style.visibility = endHasContent ? 'visible' : 'hidden';
}

async function handleSetHome(): Promise<void> {
  if (!state.start) {
    showToast('Set a start location first');
    return;
  }
  const displayName = ($('input-start') as HTMLInputElement).value.trim() || `${state.start.lat.toFixed(4)}, ${state.start.lng.toFixed(4)}`;
  const home: HomeAddress = { lat: state.start.lat, lng: state.start.lng, displayName };
  await setHomeAddress(home);
  homeAddress = home;
  updateHomeAddressUI();
  showToast('Home address saved');
}

async function handleClearHome(): Promise<void> {
  await clearHomeAddress();
  homeAddress = null;
  updateHomeAddressUI();
  showToast('Home address cleared');
}

function updateHomeAddressUI(): void {
  $('home-address-text').textContent = homeAddress ? homeAddress.displayName : 'Not set';
  $('btn-clear-home').classList.toggle('hidden', !homeAddress);
}

function showRoutePanel(route: RouteResult): void {
  const panel = $('route-panel');
  panel.classList.remove('hidden');

  // Start with details collapsed
  $('route-details').classList.add('collapsed');
  $('btn-route-details').classList.remove('expanded');

  const miles = (route.distance / METERS_PER_MILE).toFixed(1);
  const minutes = Math.round(route.time / 60);
  const ascendFt = Math.round(route.ascend * FEET_PER_METER);

  $('route-summary').innerHTML = `
    <div class="stat">
      <span class="stat-value">${miles} mi</span>
      <span class="stat-label">Distance</span>
    </div>
    <div class="stat">
      <span class="stat-value">${minutes} min</span>
      <span class="stat-label">Est. Time</span>
    </div>
    ${route.hasElevation ? `<div class="stat">
      <span class="stat-value">${ascendFt} ft</span>
      <span class="stat-label">Climbing</span>
    </div>` : ''}
  `;

  const elevationEl = $('elevation-profile');
  if (route.hasElevation) {
    elevationEl.classList.remove('hidden');
    drawElevationProfile(route.elevations, elevationEl);
  } else {
    elevationEl.classList.add('hidden');
    elevationEl.innerHTML = '';
  }

  const directionsHtml = route.instructions
    .map(
      (step) => `
      <div class="direction-step">
        <span class="direction-icon">${turnIconSvg(step.icon)}</span>
        <span class="direction-text">${step.text}</span>
        <span class="direction-dist">${step.distance > 0 ? formatDist(step.stepDistance) : ''}</span>
      </div>
    `,
    )
    .join('');
  $('turn-directions').innerHTML = directionsHtml;
}

// ========== Custom route builder ==========

function handleEnterBuilder(map: L.Map): void {
  closeLayersMenu();
  handleClear();

  document.body.classList.add('custom-building');
  $('builder-toolbar').classList.remove('hidden');
  ($('btn-save-route') as HTMLButtonElement).disabled = true;
  $('builder-status').textContent = 'Tap map to add points';

  enterBuilderMode(
    map,
    onBuilderRouteComputed,
    onBuilderWaypointsChanged,
  );
}

function handleExitBuilder(): void {
  exitBuilderMode();
  document.body.classList.remove('custom-building');
  $('builder-toolbar').classList.add('hidden');
}

function onBuilderRouteComputed(route: RouteResult): void {
  // Just enable save — the builder draws the route on the map itself.
  // Do NOT show route panel or set state.route during building.
  ($('btn-save-route') as HTMLButtonElement).disabled = false;
  const miles = (route.distance / METERS_PER_MILE).toFixed(1);
  $('builder-status').textContent = `${getWaypoints().length} points \u00B7 ${miles} mi`;
}

function onBuilderWaypointsChanged(count: number): void {
  if (count === 0) {
    $('builder-status').textContent = 'Tap map to add points';
    ($('btn-save-route') as HTMLButtonElement).disabled = true;
  } else if (count === 1) {
    $('builder-status').textContent = '1 point \u2014 add more';
    ($('btn-save-route') as HTMLButtonElement).disabled = true;
  } else {
    $('builder-status').textContent = `${count} points`;
    // Save stays disabled until route is computed (callback above enables it)
  }
}

function handleUndoWaypoint(): void {
  undoLastWaypoint();
}

function handleClearWaypoints(): void {
  clearAllWaypoints();
  clearRoute();
  state.route = null;
  $('route-panel').classList.add('hidden');
}

async function handleSaveRoute(): Promise<void> {
  const waypoints = getWaypoints();
  const route = getLastRoute();
  if (waypoints.length < 2 || !route) return;

  const name = prompt('Name this route:');
  if (!name?.trim()) return;

  const saved: SavedRoute = {
    id: crypto.randomUUID(),
    name: name.trim(),
    waypoints,
    distance: route.distance,
    profileKey: 'shortest',
    cachedRoute: route,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await dbSaveRoute(saved);
  showToast('Route saved');

  // Exit builder and load the route for navigation
  exitBuilderMode();
  document.body.classList.remove('custom-building');
  $('builder-toolbar').classList.add('hidden');

  // Show the saved route ready for navigation
  state.route = route;
  const first = waypoints[0];
  const last = waypoints[waypoints.length - 1];
  state.start = L.latLng(first.lat, first.lng);
  state.end = L.latLng(last.lat, last.lng);
  setStartMarker(state.start);
  setEndMarker(state.end);
  displayRoute(route.coordinates, classifyRoute(route.coordinates, getPreferenceCoords()));
  showRoutePanel(route);
  resolveAndDisplay('start', first.lat, first.lng);
  resolveAndDisplay('end', last.lat, last.lng);
}

// ========== Road preferences mode ==========

function handleEnterPreferences(map: L.Map): void {
  closeLayersMenu();
  editingPreferences = true;
  document.body.classList.add('editing-preferences');
  $('preferences-toolbar').classList.remove('hidden');
  clearRoute();
  clearMarkers();
  $('route-panel').classList.add('hidden');
  pbotWasVisibleBeforePrefs = isPbotLayerVisible();
  showPbotLayer(map);
  showPreferencesLayer();
  clearPrefDrawing(map);
  updatePreferencesStatus();

  // PBOT layer click handler — for segments that have PBOT data
  const layer = getPbotLayer();
  if (layer) {
    pbotClickHandler = (e: L.LeafletEvent) => {
      const le = e as L.LeafletMouseEvent;
      const featureLayer = (le as any).layer;
      const feature = featureLayer?.feature;
      if (!feature) return;

      // If currently drawing a custom segment, ignore PBOT clicks
      if (prefWaypoints.length > 0) return;

      const geom = feature.geometry;
      const name = feature.properties?.StreetName || 'Unnamed';

      const edgeKeys: string[] = [];
      const edgeCoords: [number, number][][] = [];

      const lines: number[][][] =
        geom.type === 'MultiLineString' ? geom.coordinates :
        geom.type === 'LineString' ? [geom.coordinates] : [];

      for (const line of lines) {
        if (line.length < 2) continue;
        const a = line[0]; // [lng, lat]
        const b = line[line.length - 1];
        const nkA = nk(a[1], a[0]);
        const nkB = nk(b[1], b[0]);
        if (nkA === nkB) continue;
        edgeKeys.push(canonicalEdgeKey(nkA, nkB));
        edgeCoords.push(line.map(c => [c[1], c[0]] as [number, number]));
      }

      if (edgeKeys.length === 0) return;

      showPbotPreferencePopup(map, le.latlng, edgeKeys, edgeCoords, name);
    };
    layer.on('click', pbotClickHandler);
  }

  // Map click handler — multi-waypoint drawing for custom segments
  prefMapClickHandler = (e: L.LeafletMouseEvent) => {
    if ((e as any).originalEvent._pbotHandled) return;
    addPrefWaypoint(map, e.latlng);
  };
  map.on('click', prefMapClickHandler);

  // Mark PBOT layer clicks so the map handler ignores them
  if (layer) {
    prefPbotFlagHandler = (e: L.LeafletEvent) => {
      ((e as L.LeafletMouseEvent).originalEvent as any)._pbotHandled = true;
    };
    layer.on('click', prefPbotFlagHandler);
  }
}

// ---- Multi-waypoint custom segment drawing ----

function addPrefWaypoint(map: L.Map, latlng: L.LatLng): void {
  const wp = { lat: latlng.lat, lng: latlng.lng };
  prefWaypoints.push(wp);

  const marker = L.circleMarker(latlng, {
    radius: 7, color: '#2d8a4e', fillColor: '#2d8a4e', fillOpacity: 0.9, weight: 2,
  }).addTo(map);
  prefWaypointMarkers.push(marker);

  if (prefWaypoints.length === 1) {
    $('preferences-status').textContent = 'Tap to extend the route';
    updatePrefButtons();
    return;
  }

  // Fetch BRouter segment between the last two waypoints
  const prev = prefWaypoints[prefWaypoints.length - 2];
  const cur = wp;
  const reqId = ++prefComputeId;

  $('preferences-status').textContent = 'Routing...';

  fetchRoadGeometry(prev.lat, prev.lng, cur.lat, cur.lng)
    .then(segCoords => {
      if (reqId !== prefComputeId) return;
      if (segCoords.length < 2) {
        showToast('Could not find road between points');
        return;
      }

      // Append segment coords (skip first point to avoid duplicate at junction)
      const startIdx = prefRouteCoords.length === 0 ? 0 : 1;
      for (let i = startIdx; i < segCoords.length; i++) {
        prefRouteCoords.push(segCoords[i]);
      }

      // Update the route line on the map
      if (prefRouteLine) map.removeLayer(prefRouteLine);
      prefRouteLine = L.polyline(
        prefRouteCoords.map(c => L.latLng(c[0], c[1])),
        { color: '#2196f3', weight: 6, opacity: 0.8 },
      ).addTo(map);

      updatePrefButtons();
      const miles = (computePrefDistance() / 1609.34).toFixed(1);
      $('preferences-status').textContent = `${prefWaypoints.length} points \u00B7 ${miles} mi`;
    })
    .catch(() => {
      if (reqId !== prefComputeId) return;
      showToast('Could not fetch road geometry');
      // Remove the failed waypoint
      prefWaypoints.pop();
      const m = prefWaypointMarkers.pop();
      if (m) map.removeLayer(m);
      updatePrefButtons();
    });
}

function computePrefDistance(): number {
  let d = 0;
  for (let i = 1; i < prefRouteCoords.length; i++) {
    const [lat1, lng1] = prefRouteCoords[i - 1];
    const [lat2, lng2] = prefRouteCoords[i];
    const dlat = (lat2 - lat1) * 111320;
    const dlng = (lng2 - lng1) * 111320 * Math.cos(lat1 * Math.PI / 180);
    d += Math.sqrt(dlat * dlat + dlng * dlng);
  }
  return d;
}

function handlePrefUndo(): void {
  const map = getMap();
  if (prefWaypoints.length === 0) return;

  prefWaypoints.pop();
  const m = prefWaypointMarkers.pop();
  if (m) map.removeLayer(m);

  if (prefWaypoints.length < 2) {
    // Not enough points for a route — clear everything
    prefRouteCoords = [];
    if (prefRouteLine) { map.removeLayer(prefRouteLine); prefRouteLine = null; }
    prefComputeId++; // cancel any in-flight requests
    updatePrefButtons();
    if (prefWaypoints.length === 1) {
      $('preferences-status').textContent = 'Tap to extend the route';
    } else {
      updatePreferencesStatus();
    }
    return;
  }

  // Recompute the full route from remaining waypoints
  prefRouteCoords = [];
  if (prefRouteLine) { map.removeLayer(prefRouteLine); prefRouteLine = null; }
  const reqId = ++prefComputeId;

  $('preferences-status').textContent = 'Recalculating...';

  // Chain BRouter calls for each consecutive pair
  let chain = Promise.resolve();
  for (let i = 1; i < prefWaypoints.length; i++) {
    const prev = prefWaypoints[i - 1];
    const cur = prefWaypoints[i];
    chain = chain.then(() =>
      fetchRoadGeometry(prev.lat, prev.lng, cur.lat, cur.lng).then(segCoords => {
        if (reqId !== prefComputeId) return;
        if (segCoords.length < 2) return;
        const startIdx = prefRouteCoords.length === 0 ? 0 : 1;
        for (let j = startIdx; j < segCoords.length; j++) {
          prefRouteCoords.push(segCoords[j]);
        }
      })
    );
  }

  chain.then(() => {
    if (reqId !== prefComputeId) return;
    if (prefRouteCoords.length >= 2) {
      prefRouteLine = L.polyline(
        prefRouteCoords.map(c => L.latLng(c[0], c[1])),
        { color: '#2196f3', weight: 6, opacity: 0.8 },
      ).addTo(map);
    }
    updatePrefButtons();
    const miles = (computePrefDistance() / 1609.34).toFixed(1);
    $('preferences-status').textContent = `${prefWaypoints.length} points \u00B7 ${miles} mi`;
  });
}

async function handlePrefSave(type: 'preferred' | 'nogo'): Promise<void> {
  if (prefRouteCoords.length < 2) return;

  const map = getMap();
  const coords = prefRouteCoords.slice();

  // Inject into graph and get edge keys
  const allEdgeKeys = injectPolylineEdges(coords, 'Custom segment');
  if (allEdgeKeys.length === 0) {
    showToast('Could not create segment');
    return;
  }

  const groupId = crypto.randomUUID();
  const prefs: EdgePreference[] = allEdgeKeys.map(ek => ({
    edgeKey: ek,
    type,
    name: 'Custom segment',
    coords: [coords],
    createdAt: Date.now(),
    groupId,
    allEdgeKeys,
  }));

  await setPreferenceGroup(prefs);

  // Clear the drawing state but stay in preferences mode
  clearPrefDrawing(map);
  updatePreferencesStatus();
  showToast(type === 'preferred' ? 'Safe route saved' : 'Blocked route saved');
}

function updatePrefButtons(): void {
  const hasRoute = prefRouteCoords.length >= 2;
  ($('btn-pref-save-prefer') as HTMLButtonElement).disabled = !hasRoute;
  ($('btn-pref-save-block') as HTMLButtonElement).disabled = !hasRoute;
}

function clearPrefDrawing(map: L.Map): void {
  for (const m of prefWaypointMarkers) map.removeLayer(m);
  prefWaypointMarkers = [];
  prefWaypoints = [];
  prefRouteCoords = [];
  prefComputeId++;
  if (prefRouteLine) { map.removeLayer(prefRouteLine); prefRouteLine = null; }
  updatePrefButtons();
}

// ---- PBOT feature popup (single-tap on existing bike route) ----

function showPbotPreferencePopup(
  map: L.Map,
  latlng: L.LatLng,
  edgeKeys: string[],
  edgeCoords: [number, number][][],
  name: string,
): void {
  const existing = getPreferences().get(edgeKeys[0]);
  const existingLabel = existing ? (existing.type === 'preferred' ? ' (Safe)' : ' (Blocked)') : '';

  const popup = L.popup()
    .setLatLng(latlng)
    .setContent(
      `<strong>${name}</strong>${existingLabel}` +
      `<div class="pref-popup-actions">` +
      `<button class="pref-popup-btn pref-popup-btn-prefer" data-action="prefer">Safe</button>` +
      `<button class="pref-popup-btn pref-popup-btn-block" data-action="block">Block</button>` +
      `<button class="pref-popup-btn pref-popup-btn-clear" data-action="clear">Clear</button>` +
      `</div>`
    )
    .openOn(map);

  const container = popup.getElement();
  if (container) {
    container.addEventListener('click', async (ev) => {
      const btn = (ev.target as HTMLElement).closest('.pref-popup-btn') as HTMLElement | null;
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === 'prefer' || action === 'block') {
        for (let i = 0; i < edgeKeys.length; i++) {
          const pref: EdgePreference = {
            edgeKey: edgeKeys[i],
            type: action === 'prefer' ? 'preferred' : 'nogo',
            name,
            coords: [edgeCoords[i]],
            createdAt: Date.now(),
          };
          await setPreference(pref);
        }
      } else if (action === 'clear') {
        for (const ek of edgeKeys) {
          await removePreference(ek);
        }
      }

      map.closePopup();
      updatePreferencesStatus();
    });
  }
}

// ---- Mode exit ----

function handleExitPreferences(): void {
  const map = getMap();
  editingPreferences = false;
  document.body.classList.remove('editing-preferences');
  $('preferences-toolbar').classList.add('hidden');

  clearPrefDrawing(map);
  hidePreferencesLayer();

  // Restore PBOT layer to its previous visibility state
  if (!pbotWasVisibleBeforePrefs) {
    hidePbotLayer(map);
  }

  const layer = getPbotLayer();
  if (layer) {
    if (pbotClickHandler) {
      layer.off('click', pbotClickHandler);
      pbotClickHandler = null;
    }
    if (prefPbotFlagHandler) {
      layer.off('click', prefPbotFlagHandler);
      prefPbotFlagHandler = null;
    }
  }

  if (prefMapClickHandler) {
    map.off('click', prefMapClickHandler);
    prefMapClickHandler = null;
  }

  if (state.start && state.end) tryRoute();
}

function updatePreferencesStatus(): void {
  const count = getUniquePreferences().length;
  const status = count === 0
    ? 'Tap a bike route or map to draw'
    : `${count} preference${count !== 1 ? 's' : ''} set \u00B7 tap to draw more`;
  $('preferences-status').textContent = status;
}

// ========== Saved routes ==========

async function handleShowSavedRoutes(): Promise<void> {
  closeLayersMenu();
  const routes = await getAllRoutes();
  const list = $('saved-routes-list');

  if (routes.length === 0) {
    list.innerHTML = '<div class="empty-state">No saved routes yet</div>';
  } else {
    list.innerHTML = routes.map(r => `
      <div class="saved-route-item" data-id="${r.id}">
        <div class="saved-route-info">
          <span class="saved-route-name">${escapeHtml(r.name)}</span>
          <span class="saved-route-meta">${(r.distance / METERS_PER_MILE).toFixed(1)} mi &middot; ${new Date(r.createdAt).toLocaleDateString()}</span>
        </div>
        <button class="saved-route-delete" data-id="${r.id}" aria-label="Delete route">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    `).join('');

    // Wire up click handlers
    list.querySelectorAll('.saved-route-item').forEach(item => {
      item.addEventListener('click', (e) => {
        // Don't load route if delete button was clicked
        if ((e.target as Element).closest('.saved-route-delete')) return;
        const id = (item as HTMLElement).dataset.id!;
        handleLoadSavedRoute(id);
      });
    });

    list.querySelectorAll('.saved-route-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = (btn as HTMLElement).dataset.id!;
        await deleteRoute(id);
        // Refresh list
        handleShowSavedRoutes();
        showToast('Route deleted');
      });
    });
  }

  $('saved-routes-panel').classList.remove('hidden');
}

async function handleLoadSavedRoute(id: string): Promise<void> {
  const saved = await getRoute(id);
  if (!saved) return;

  $('saved-routes-panel').classList.add('hidden');
  handleClear();
  $('loading').classList.remove('hidden');

  const first = saved.waypoints[0];
  const last = saved.waypoints[saved.waypoints.length - 1];

  let route: RouteResult;

  try {
    // Try fresh computation for latest road data & instructions
    route = await computeRouteMulti(saved.waypoints, saved.profileKey);
    // Update the cache with the fresh result
    saved.cachedRoute = route;
    saved.updatedAt = Date.now();
    dbSaveRoute(saved); // fire-and-forget update
  } catch {
    // Offline or BRouter unavailable — fall back to cached route
    if (saved.cachedRoute) {
      route = saved.cachedRoute;
      showToast('Loaded from cache (offline)');
    } else {
      alert('Could not load route. No cached version available — connect to the internet and try again.');
      $('loading').classList.add('hidden');
      return;
    }
  }

  state.route = route;
  state.start = L.latLng(first.lat, first.lng);
  state.end = L.latLng(last.lat, last.lng);

  setStartMarker(state.start);
  setEndMarker(state.end);
  displayRoute(route.coordinates, classifyRoute(route.coordinates, getPreferenceCoords()));
  showRoutePanel(route);

  resolveAndDisplay('start', first.lat, first.lng);
  resolveAndDisplay('end', last.lat, last.lng);

  $('loading').classList.add('hidden');
}

// ========== Navigation mode ==========

function handleStartNav(): void {
  if (!state.route) return;

  if ('speechSynthesis' in window) {
    const unlock = new SpeechSynthesisUtterance('');
    unlock.volume = 0;
    speechSynthesis.speak(unlock);
  }

  document.body.classList.add('navigating');
  $('nav-hud').classList.remove('hidden');
  setPlanningMarkersVisible(false);
  followUser = true;

  startNavigation(state.route, onNavUpdate, onNavOffRoute);
}

function handleStopNav(): void {
  stopNavigation();
  document.body.classList.remove('navigating');
  $('nav-hud').classList.add('hidden');
  $('nav-off-route').classList.add('hidden');
  clearUserPosition();
  setPlanningMarkersVisible(true);

  if (state.route) {
    displayRoute(state.route.coordinates, classifyRoute(state.route.coordinates, getPreferenceCoords()));
  }
}

let offRouteTimeout: ReturnType<typeof setTimeout> | null = null;

function onNavUpdate(update: NavUpdate): void {
  updateUserPosition(
    update.userLat,
    update.userLng,
    update.heading,
    update.accuracy,
    followUser,
  );

  const nextInst = update.nextInstruction;
  if (nextInst && !update.arrived) {
    $('nav-turn-icon').innerHTML = turnIconSvg(nextInst.icon);
    $('nav-turn-distance').textContent = formatNavDist(update.distanceToNextTurn);
    $('nav-turn-text').textContent = nextInst.text;
  } else if (update.arrived) {
    $('nav-turn-icon').innerHTML = turnIconSvg('arrive');
    $('nav-turn-distance').textContent = 'Arrived';
    $('nav-turn-text').textContent = 'You have reached your destination';
  } else {
    $('nav-turn-icon').innerHTML = turnIconSvg(update.currentInstruction.icon);
    $('nav-turn-distance').textContent = '';
    $('nav-turn-text').textContent = update.currentInstruction.text;
  }

  $('nav-remaining-dist').textContent = formatDist(update.distanceRemaining);
  $('nav-remaining-time').textContent = formatTime(update.timeRemaining);

  if (update.offRoute) {
    $('nav-off-route').classList.remove('hidden');
    if (offRouteTimeout) clearTimeout(offRouteTimeout);
  } else {
    if (!$('nav-off-route').classList.contains('hidden')) {
      if (offRouteTimeout) clearTimeout(offRouteTimeout);
      offRouteTimeout = setTimeout(() => {
        $('nav-off-route').classList.add('hidden');
      }, 2000);
    }
  }
}

function onNavOffRoute(): void {
  // Could trigger re-routing here in the future
}

// ========== Utilities ==========

function formatDist(meters: number): string {
  if (meters < 160) return `${Math.round(meters)} m`;
  const mi = meters / METERS_PER_MILE;
  return `${mi.toFixed(1)} mi`;
}

function formatNavDist(meters: number): string {
  if (meters < 15) return 'Now';
  const feet = Math.round(meters * FEET_PER_METER);
  if (feet <= 500) return `${Math.round(feet / 10) * 10} ft`;
  const mi = meters / METERS_PER_MILE;
  if (mi < 0.15) return `${Math.round(feet / 50) * 50} ft`;
  return `${mi.toFixed(1)} mi`;
}

function formatTime(seconds: number): string {
  if (seconds < 60) return '<1 min';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m`;
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message: string): void {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

document.addEventListener('DOMContentLoaded', init);
