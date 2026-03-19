const PHOTON_URL = 'https://photon.komoot.io/api/';
const PHOTON_REVERSE_URL = 'https://photon.komoot.io/reverse';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
// Dynamic bias — defaults to Portland, updated from map viewport
let biasLat = 45.52;
let biasLon = -122.68;
let biasBbox = '-123.0,45.3,-122.4,45.7'; // minLon,minLat,maxLon,maxLat

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let activeInput: 'start' | 'end' = 'end';
let searchRequestId = 0;

/** Update the search bias from the current map viewport. */
export function setSearchBias(lat: number, lon: number, bbox?: string): void {
  biasLat = lat;
  biasLon = lon;
  if (bbox) {
    // Ensure bbox is at least ~30km wide so search stays useful when zoomed in
    const p = bbox.split(',').map(Number);
    const MIN_SPAN = 0.25; // ~25-30km
    const padLon = Math.max((MIN_SPAN - (p[2] - p[0])) / 2, 0);
    const padLat = Math.max((MIN_SPAN - (p[3] - p[1])) / 2, 0);
    biasBbox = `${p[0] - padLon},${p[1] - padLat},${p[2] + padLon},${p[3] + padLat}`;
  }
}

import type { HomeAddress } from './types';

export function initSearch(
  onSelectStart: (lat: number, lon: number, displayName: string) => void,
  onSelectEnd: (lat: number, lon: number, displayName: string) => void,
  getHome?: () => HomeAddress | null,
): void {
  const inputStart = document.getElementById('input-start') as HTMLInputElement;
  const inputEnd = document.getElementById('input-end') as HTMLInputElement;
  const resultsDiv = document.getElementById('search-results')!;

  function showHomeSuggestion(input: HTMLInputElement, onSelect: (lat: number, lon: number, displayName: string) => void): void {
    const home = getHome?.();
    if (!home) return;

    resultsDiv.innerHTML = '';
    resultsDiv.dataset.for = activeInput;

    const item = document.createElement('div');
    item.className = 'search-result-item';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'result-name';
    nameSpan.textContent = 'Home';

    const addrSpan = document.createElement('span');
    addrSpan.className = 'result-address';
    addrSpan.textContent = home.displayName;

    item.appendChild(nameSpan);
    item.appendChild(addrSpan);

    item.addEventListener('click', () => {
      input.value = home.displayName;
      resultsDiv.classList.remove('visible');
      onSelect(home.lat, home.lng, home.displayName);
      input.blur();
    });

    resultsDiv.appendChild(item);
    resultsDiv.classList.add('visible');
  }

  function handleInput(input: HTMLInputElement, which: 'start' | 'end'): void {
    const onSelect = which === 'start' ? onSelectStart : onSelectEnd;
    const query = input.value.trim();

    if (query.length < 3) {
      // Show home suggestion if query partially matches "home"
      if (which === 'start' && query.length > 0 && 'home'.startsWith(query.toLowerCase())) {
        showHomeSuggestion(input, onSelect);
      } else {
        resultsDiv.classList.remove('visible');
      }
      return;
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => searchAddress(query, resultsDiv, input, onSelect), 300);
  }

  inputStart.addEventListener('input', () => {
    activeInput = 'start';
    handleInput(inputStart, 'start');
  });
  inputEnd.addEventListener('input', () => {
    activeInput = 'end';
    handleInput(inputEnd, 'end');
  });

  inputStart.addEventListener('focus', () => {
    activeInput = 'start';
    inputStart.select();
    // Show home suggestion when start input is focused and empty
    if (!inputStart.value.trim()) {
      showHomeSuggestion(inputStart, onSelectStart);
    } else if (resultsDiv.children.length > 0 && resultsDiv.dataset.for === 'start') {
      resultsDiv.classList.add('visible');
    }
  });

  inputEnd.addEventListener('focus', () => {
    activeInput = 'end';
    inputEnd.select();
    if (resultsDiv.children.length > 0 && resultsDiv.dataset.for === 'end') {
      resultsDiv.classList.add('visible');
    }
  });

  document.addEventListener('click', (e) => {
    if (!(e.target as Element).closest('#route-planner')) {
      resultsDiv.classList.remove('visible');
    }
  });
}

// ========== Geocoding result type ==========

interface GeoResult {
  lat: number;
  lon: number;
  name: string;
  detail: string;
}

// ========== Forward geocoding (Photon, with Nominatim fallback) ==========

/** Try Photon with bbox first, then Photon without bbox, then Nominatim unbounded. */
async function fetchGeoResults(query: string): Promise<GeoResult[]> {
  // Phase 1: Photon constrained to viewport bbox (fast, local results)
  const local = await fetchPhoton(query, true);
  if (local.length > 0) return local;

  // Phase 2: Photon with proximity bias only (can find results anywhere)
  const wide = await fetchPhoton(query, false);
  if (wide.length > 0) return wide;

  // Phase 3: Nominatim unbounded (final fallback)
  return fetchNominatim(query, false);
}

async function fetchPhoton(query: string, useBbox = true): Promise<GeoResult[]> {
  const params = new URLSearchParams({
    q: query,
    lat: biasLat.toString(),
    lon: biasLon.toString(),
    limit: '5',
    lang: 'en',
  });
  if (useBbox) {
    params.set('bbox', biasBbox);
  } else {
    params.set('zoom', '10'); // wider proximity bias radius
  }

  const res = await fetch(`${PHOTON_URL}?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  const features: any[] = data.features || [];
  return features.map((f) => {
    const props = f.properties || {};
    const [lon, lat] = f.geometry.coordinates;
    return { lat, lon, name: formatName(props), detail: formatDetail(props) };
  });
}

async function fetchNominatim(query: string, bounded = true): Promise<GeoResult[]> {
  const [minLon, minLat, maxLon, maxLat] = biasBbox.split(',');
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '5',
    viewbox: `${minLon},${maxLat},${maxLon},${minLat}`, // left,top,right,bottom
    bounded: bounded ? '1' : '0',
    'accept-language': 'en',
  });

  const res = await fetch(`${NOMINATIM_URL}?${params}`, {
    headers: { 'User-Agent': 'PedalPDX/1.0' },
  });
  if (!res.ok) return [];
  const data: any[] = await res.json();
  return data.map((r) => ({
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    name: r.name || r.display_name.split(',')[0],
    detail: r.display_name.split(',').slice(1, 4).join(',').trim(),
  }));
}

async function searchAddress(
  query: string,
  resultsDiv: HTMLElement,
  input: HTMLInputElement,
  onSelect: (lat: number, lon: number, displayName: string) => void,
): Promise<void> {
  const myRequestId = ++searchRequestId;
  try {
    const results = await fetchGeoResults(query);
    if (myRequestId !== searchRequestId) return; // superseded by newer search

    resultsDiv.innerHTML = '';
    resultsDiv.dataset.for = activeInput;

    if (results.length === 0) {
      resultsDiv.classList.remove('visible');
      return;
    }

    for (const r of results) {
      const item = document.createElement('div');
      item.className = 'search-result-item';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'result-name';
      nameSpan.textContent = r.name;

      const addrSpan = document.createElement('span');
      addrSpan.className = 'result-address';
      addrSpan.textContent = r.detail;

      item.appendChild(nameSpan);
      item.appendChild(addrSpan);

      item.addEventListener('click', () => {
        input.value = r.name;
        resultsDiv.classList.remove('visible');
        onSelect(r.lat, r.lon, r.name);
        input.blur();
      });
      resultsDiv.appendChild(item);
    }
    resultsDiv.classList.add('visible');
  } catch {
    // silently fail — search is a convenience
  }
}

// ========== Reverse geocoding (Photon, with Nominatim fallback) ==========

export async function reverseGeocode(lat: number, lng: number): Promise<string> {
  const fallback = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  try {
    const name = await reversePhoton(lat, lng);
    if (name) return name;
    return (await reverseNominatim(lat, lng)) || fallback;
  } catch {
    return fallback;
  }
}

async function reversePhoton(lat: number, lng: number): Promise<string | null> {
  const params = new URLSearchParams({
    lat: lat.toString(),
    lon: lng.toString(),
  });
  const res = await fetch(`${PHOTON_REVERSE_URL}?${params}`);
  if (!res.ok) return null;
  const data = await res.json();
  const f = data.features?.[0];
  if (!f) return null;
  return formatName(f.properties || {});
}

async function reverseNominatim(lat: number, lng: number): Promise<string | null> {
  const params = new URLSearchParams({
    lat: lat.toString(),
    lon: lng.toString(),
    format: 'jsonv2',
  });
  const res = await fetch(`${NOMINATIM_REVERSE_URL}?${params}`, {
    headers: { 'User-Agent': 'PedalPDX/1.0' },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.error) return null;
  const addr = data.address || {};
  if (addr.house_number && addr.road) return `${addr.house_number} ${addr.road}`;
  if (addr.road) return addr.road;
  return data.name || data.display_name?.split(',')[0] || null;
}

// ========== Address formatting (Photon) ==========

/** Is this a named place (business, park, etc.) rather than just a street address? */
function isNamedPlace(p: any): boolean {
  return !!(p.name && p.name !== p.street && p.name !== p.housenumber);
}

/** Primary display name for a result or reverse geocode. */
function formatName(p: any): string {
  // Named place: "Laurelhurst Theater", "Peninsula Park"
  if (isNamedPlace(p)) return p.name;
  // Street address: "431 Northeast Cook Street"
  if (p.housenumber && p.street) return `${p.housenumber} ${p.street}`;
  // Street only
  if (p.street) return p.street;
  // Fallback to name if nothing else
  if (p.name) return p.name;
  return 'Unknown location';
}

/** Secondary detail line for search results. */
function formatDetail(p: any): string {
  const parts: string[] = [];
  // For named places, show the street address first
  if (isNamedPlace(p)) {
    if (p.housenumber && p.street) parts.push(`${p.housenumber} ${p.street}`);
    else if (p.street) parts.push(p.street);
  }
  if (p.suburb) parts.push(p.suburb);
  else if (p.district) parts.push(p.district);
  if (p.city) parts.push(p.city);
  if (p.state) parts.push(p.state);
  return parts.join(', ');
}
