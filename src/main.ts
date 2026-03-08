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
import { initSearch } from './search';
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

  // Load PBOT data and add toggle button
  loadPbotData(map).then(() => {
    const btn = document.createElement('button');
    btn.id = 'layer-toggle';
    btn.textContent = 'Bike Routes';
    btn.addEventListener('click', () => {
      const isVisible = togglePbotLayer(map);
      btn.classList.toggle('active', isVisible);
    });
    document.getElementById('app')!.appendChild(btn);
  });

  map.on('click', (e: L.LeafletMouseEvent) => {
    if (isNavigating()) return; // ignore taps during navigation
    placePoint(e.latlng);
  });

  document.addEventListener('marker-drag', ((e: CustomEvent) => {
    if (isNavigating()) return;
    const { type, latlng } = e.detail;
    if (type === 'start') state.start = latlng;
    else state.end = latlng;
    tryRoute();
  }) as EventListener);

  initSearch((lat, lon) => {
    if (isNavigating()) return;
    const latlng = L.latLng(lat, lon);
    getMap().setView(latlng, 15);
    placePoint(latlng);
  });

  initProfileSelector();

  // Planning buttons
  $('btn-start').addEventListener('click', () => setMode('start'));
  $('btn-end').addEventListener('click', () => setMode('end'));
  $('btn-locate').addEventListener('click', handleLocate);
  $('btn-clear').addEventListener('click', handleClear);

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

function initProfileSelector(): void {
  const container = document.createElement('div');
  container.id = 'profile-selector';
  container.innerHTML = (Object.entries(ROUTE_PROFILES) as [RouteProfileKey, typeof ROUTE_PROFILES[RouteProfileKey]][])
    .map(([key, val]) =>
      `<button class="profile-btn${key === getRouteProfile() ? ' active' : ''}" data-profile="${key}" title="${val.description}">${val.label}</button>`
    )
    .join('');

  container.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.profile-btn') as HTMLElement | null;
    if (!btn) return;
    const key = btn.dataset.profile as RouteProfileKey;
    if (key === getRouteProfile()) return;
    setRouteProfile(key);
    container.querySelectorAll('.profile-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    tryRoute();
  });

  document.getElementById('app')!.appendChild(container);
}

function setMode(mode: 'start' | 'end'): void {
  state.mode = mode;
  $('btn-start').classList.toggle('active', mode === 'start');
  $('btn-end').classList.toggle('active', mode === 'end');
}

function placePoint(latlng: L.LatLng): void {
  if (state.mode === 'start') {
    state.start = latlng;
    setStartMarker(latlng);
    setMode('end');
  } else {
    state.end = latlng;
    setEndMarker(latlng);
  }
  tryRoute();
}

function tryRoute(): void {
  if (state.start && state.end) {
    handleRoute();
  }
}

async function handleLocate(): Promise<void> {
  try {
    const pos = await getCurrentPosition();
    const latlng = L.latLng(pos.lat, pos.lng);
    getMap().setView(latlng, 15);
    state.start = latlng;
    setStartMarker(latlng);
    setMode('end');
    tryRoute();
  } catch {
    alert('Could not get your location. Please enable location services.');
  }
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
  setMode('start');
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
    $('nav-turn-icon').textContent = '🏁';
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
