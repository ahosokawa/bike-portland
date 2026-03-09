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
import { computeRoute, ROUTE_PROFILES, setRouteProfile, getRouteProfile } from './router';
import type { RouteProfileKey } from './router';
import { initSearch, getActiveInput } from './search';
import { getCurrentPosition } from './geolocation';
import { drawElevationProfile } from './elevation';
import { loadPbotData, togglePbotLayer } from './pbot-layer';
import { startNavigation, stopNavigation, isNavigating } from './navigation';
import type { NavUpdate } from './navigation';
import type { AppState, RouteResult } from './types';

const state: AppState = {
  mode: 'start',
  start: null,
  end: null,
  route: null,
};

let routeRequestId = 0;
let followUser = true; // auto-center map on user during nav

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function init(): void {
  const map = initMap();

  // Load PBOT data
  loadPbotData(map);

  map.on('click', (e: L.LeafletMouseEvent) => {
    if (isNavigating()) return; // ignore taps during navigation
    handleMapTap(e.latlng);
  });

  document.addEventListener('marker-drag', ((e: CustomEvent) => {
    if (isNavigating()) return;
    const { type, latlng } = e.detail;
    if (type === 'start') {
      state.start = latlng;
      updateInputDisplay('start', `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`);
    } else {
      state.end = latlng;
      updateInputDisplay('end', `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`);
    }
    tryRoute();
  }) as EventListener);

  // Two-input search: start and end
  initSearch(
    // onSelectStart
    (lat, lon, displayName) => {
      const latlng = L.latLng(lat, lon);
      getMap().setView(latlng, 15);
      state.start = latlng;
      setStartMarker(latlng);
      updateInputDisplay('start', displayName);
      // If end is not set, focus it
      if (!state.end) {
        ($('input-end') as HTMLInputElement).focus();
      }
      tryRoute();
    },
    // onSelectEnd
    (lat, lon, displayName) => {
      const latlng = L.latLng(lat, lon);
      getMap().setView(latlng, 15);
      state.end = latlng;
      setEndMarker(latlng);
      updateInputDisplay('end', displayName);
      // If start is not set, focus it
      if (!state.start) {
        ($('input-start') as HTMLInputElement).focus();
      }
      tryRoute();
    },
  );

  initLayersMenu(map);

  // My Location button
  $('btn-my-location').addEventListener('click', handleLocate);

  // Clear button
  $('btn-clear').addEventListener('click', handleClear);

  // Swap button
  $('btn-swap').addEventListener('click', handleSwap);

  // Navigation buttons
  $('btn-go').addEventListener('click', handleStartNav);
  $('btn-stop-nav').addEventListener('click', handleStopNav);

  // During nav, let user drag map to explore, but tap to re-center
  map.on('dragstart', () => {
    if (isNavigating()) followUser = false;
  });
  map.on('click', () => {
    if (isNavigating()) followUser = true;
  });
}

function initLayersMenu(map: L.Map): void {
  const layersBtn = $('btn-layers');
  const layersPanel = $('layers-panel');

  // Toggle panel
  layersBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = layersPanel.classList.toggle('visible');
    layersBtn.classList.toggle('active', isOpen);
  });

  // Close panel when clicking outside
  document.addEventListener('click', (e) => {
    if (!(e.target as Element).closest('#layers-menu-wrapper')) {
      layersPanel.classList.remove('visible');
      layersBtn.classList.remove('active');
    }
  });

  // Build profile options
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

function updateInputDisplay(which: 'start' | 'end', text: string): void {
  const inputId = which === 'start' ? 'input-start' : 'input-end';
  ($(inputId) as HTMLInputElement).value = text;
}

/** Handle map tap — intelligently pick which point to set */
function handleMapTap(latlng: L.LatLng): void {
  const coordLabel = `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;

  // Check which input is currently focused
  const activeEl = document.activeElement;
  const startInput = $('input-start');
  const endInput = $('input-end');

  if (activeEl === startInput) {
    // Start input is focused — set start
    state.start = latlng;
    setStartMarker(latlng);
    updateInputDisplay('start', coordLabel);
    startInput.blur();
    if (!state.end) (endInput as HTMLInputElement).focus();
  } else if (activeEl === endInput) {
    // End input is focused — set end
    state.end = latlng;
    setEndMarker(latlng);
    updateInputDisplay('end', coordLabel);
    endInput.blur();
    if (!state.start) (startInput as HTMLInputElement).focus();
  } else {
    // No input focused — fill the first empty field, prefer end
    if (!state.end) {
      state.end = latlng;
      setEndMarker(latlng);
      updateInputDisplay('end', coordLabel);
    } else if (!state.start) {
      state.start = latlng;
      setStartMarker(latlng);
      updateInputDisplay('start', coordLabel);
    } else {
      // Both set — replace destination
      state.end = latlng;
      setEndMarker(latlng);
      updateInputDisplay('end', coordLabel);
    }
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
    getMap().setView(latlng, 15);
    state.start = latlng;
    setStartMarker(latlng);
    updateInputDisplay('start', 'My Location');
    // Focus destination if empty
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

  // Swap input text
  const startInput = $('input-start') as HTMLInputElement;
  const endInput = $('input-end') as HTMLInputElement;
  const tempText = startInput.value;
  startInput.value = endInput.value;
  endInput.value = tempText;

  // Update markers
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
    const route = await computeRoute(state.start, state.end);
    if (requestId !== routeRequestId) return;
    state.route = route;
    displayRoute(route.coordinates);
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
}

function showRoutePanel(route: RouteResult): void {
  const panel = $('route-panel');
  panel.classList.remove('hidden');

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
        <span class="direction-icon">${step.icon}</span>
        <span class="direction-text">${step.text}</span>
        <span class="direction-dist">${step.distance > 0 ? formatDist(step.stepDistance) : ''}</span>
      </div>
    `,
    )
    .join('');
  $('turn-directions').innerHTML = directionsHtml;
}

// ========== Navigation mode ==========

function handleStartNav(): void {
  if (!state.route) return;

  // iOS Safari requires a user gesture to enable speechSynthesis
  // Trigger a silent utterance to unlock it
  if ('speechSynthesis' in window) {
    const unlock = new SpeechSynthesisUtterance('');
    unlock.volume = 0;
    speechSynthesis.speak(unlock);
  }

  // Enter navigation mode
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

  // Re-fit route on map
  if (state.route) {
    displayRoute(state.route.coordinates);
  }
}

let offRouteTimeout: ReturnType<typeof setTimeout> | null = null;

function onNavUpdate(update: NavUpdate): void {
  // Update user position on map
  updateUserPosition(
    update.userLat,
    update.userLng,
    update.heading,
    update.accuracy,
    followUser,
  );

  // Update turn banner
  const nextInst = update.nextInstruction;
  if (nextInst && !update.arrived) {
    $('nav-turn-icon').textContent = nextInst.icon;
    $('nav-turn-distance').textContent = formatNavDist(update.distanceToNextTurn);
    $('nav-turn-text').textContent = nextInst.text;
  } else if (update.arrived) {
    $('nav-turn-icon').textContent = '\uD83C\uDFC1';
    $('nav-turn-distance').textContent = 'Arrived';
    $('nav-turn-text').textContent = 'You have reached your destination';
  } else {
    $('nav-turn-icon').textContent = update.currentInstruction.icon;
    $('nav-turn-distance').textContent = '';
    $('nav-turn-text').textContent = update.currentInstruction.text;
  }

  // Update stats
  $('nav-remaining-dist').textContent = formatDist(update.distanceRemaining);
  $('nav-remaining-time').textContent = formatTime(update.timeRemaining);

  // Off-route indicator
  if (update.offRoute) {
    $('nav-off-route').classList.remove('hidden');
    // Clear any existing timeout
    if (offRouteTimeout) clearTimeout(offRouteTimeout);
  } else {
    // Slight delay before hiding to avoid flicker
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

// ========== Formatting ==========

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

document.addEventListener('DOMContentLoaded', init);
