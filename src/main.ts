import L from 'leaflet';
import {
  initMap,
  getMap,
  setStartMarker,
  setEndMarker,
  displayRoute,
  clearRoute,
  clearMarkers,
  updateUserPosition,
  clearUserPosition,
  setPlanningMarkersVisible,
} from './map';
import { computeGuidedRoute, computeRouteMulti, ROUTE_PROFILES, setRouteProfile, getRouteProfile } from './router';
import { classifyRoute } from './pbot-graph';
import type { RouteProfileKey } from './router';
import { initSearch, getActiveInput, reverseGeocode, setSearchBias } from './search';
import { getCurrentPosition } from './geolocation';
import { drawElevationProfile } from './elevation';
import { loadPbotData, togglePbotLayer } from './pbot-layer';
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
import { saveRoute as dbSaveRoute, getAllRoutes, getRoute, deleteRoute } from './saved-routes';
import type { NavUpdate } from './navigation';
import type { AppState, RouteResult, SavedRoute } from './types';
import { turnIconSvg } from './icons';

const state: AppState = {
  mode: 'start',
  start: null,
  end: null,
  route: null,
};

let routeRequestId = 0;
let followUser = true;

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function init(): void {
  const map = initMap();

  // Load PBOT data
  loadPbotData(map);

  map.on('click', (e: L.LeafletMouseEvent) => {
    if (isNavigating()) return;
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
      if (!state.start) {
        ($('input-start') as HTMLInputElement).focus();
      }
      tryRoute();
    },
  );

  initLayersMenu(map);

  // Planning buttons
  $('btn-my-location').addEventListener('click', handleLocate);
  $('btn-clear').addEventListener('click', handleClear);
  $('btn-swap').addEventListener('click', handleSwap);

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

  layersBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = layersPanel.classList.toggle('visible');
    layersBtn.classList.toggle('active', isOpen);
  });

  document.addEventListener('click', (e) => {
    if (!(e.target as Element).closest('#layers-menu-wrapper')) {
      layersPanel.classList.remove('visible');
      layersBtn.classList.remove('active');
    }
  });

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
  $('btn-layers').classList.remove('active');
}

// ========== Planning mode ==========

function updateInputDisplay(which: 'start' | 'end', text: string): void {
  const inputId = which === 'start' ? 'input-start' : 'input-end';
  ($(inputId) as HTMLInputElement).value = text;
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

  tryRoute();
}

async function handleRoute(): Promise<void> {
  if (!state.start || !state.end) return;

  const requestId = ++routeRequestId;
  $('loading').classList.remove('hidden');

  try {
    const route = await computeGuidedRoute(state.start, state.end);
    if (requestId !== routeRequestId) return;
    state.route = route;
    displayRoute(route.coordinates, classifyRoute(route.coordinates));
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
}

function showRoutePanel(route: RouteResult): void {
  const panel = $('route-panel');
  panel.classList.remove('hidden');

  // Start with details collapsed
  $('route-details').classList.add('collapsed');
  $('btn-route-details').classList.remove('expanded');

  const miles = (route.distance / 1609.34).toFixed(1);
  const minutes = Math.round(route.time / 60);
  const ascendFt = Math.round(route.ascend * 3.281);

  $('route-summary').innerHTML = `
    <div class="stat">
      <span class="stat-value">${miles} mi</span>
      <span class="stat-label">Distance</span>
    </div>
    <div class="stat">
      <span class="stat-value">${minutes} min</span>
      <span class="stat-label">Est. Time</span>
    </div>
    <div class="stat">
      <span class="stat-value">${ascendFt} ft</span>
      <span class="stat-label">Climbing</span>
    </div>
  `;

  drawElevationProfile(route.elevations, $('elevation-profile'));

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
  const miles = (route.distance / 1609.34).toFixed(1);
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
  displayRoute(route.coordinates, classifyRoute(route.coordinates));
  showRoutePanel(route);
  resolveAndDisplay('start', first.lat, first.lng);
  resolveAndDisplay('end', last.lat, last.lng);
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
          <span class="saved-route-meta">${(r.distance / 1609.34).toFixed(1)} mi &middot; ${new Date(r.createdAt).toLocaleDateString()}</span>
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
  displayRoute(route.coordinates, classifyRoute(route.coordinates));
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
    displayRoute(state.route.coordinates, classifyRoute(state.route.coordinates));
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
  const mi = meters / 1609.34;
  return `${mi.toFixed(1)} mi`;
}

function formatNavDist(meters: number): string {
  if (meters < 15) return 'Now';
  const feet = Math.round(meters * 3.281);
  if (feet <= 500) return `${Math.round(feet / 10) * 10} ft`;
  const mi = meters / 1609.34;
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
