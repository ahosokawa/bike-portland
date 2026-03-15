const PHOTON_URL = 'https://photon.komoot.io/api/';
const PHOTON_REVERSE_URL = 'https://photon.komoot.io/reverse';
// Dynamic bias — defaults to Portland, updated from map viewport
let biasLat = 45.52;
let biasLon = -122.68;
let biasBbox = '-123.0,45.3,-122.4,45.7'; // minLon,minLat,maxLon,maxLat

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let activeInput: 'start' | 'end' = 'end';

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

export function initSearch(
  onSelectStart: (lat: number, lon: number, displayName: string) => void,
  onSelectEnd: (lat: number, lon: number, displayName: string) => void,
): void {
  const inputStart = document.getElementById('input-start') as HTMLInputElement;
  const inputEnd = document.getElementById('input-end') as HTMLInputElement;
  const resultsDiv = document.getElementById('search-results')!;

  function handleInput(input: HTMLInputElement, which: 'start' | 'end'): void {
    const onSelect = which === 'start' ? onSelectStart : onSelectEnd;
    const query = input.value.trim();
    if (query.length < 3) {
      resultsDiv.classList.remove('visible');
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
    if (resultsDiv.children.length > 0 && resultsDiv.dataset.for === 'start') {
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

// ========== Forward geocoding (Photon) ==========

async function searchAddress(
  query: string,
  resultsDiv: HTMLElement,
  input: HTMLInputElement,
  onSelect: (lat: number, lon: number, displayName: string) => void,
): Promise<void> {
  const params = new URLSearchParams({
    q: query,
    lat: biasLat.toString(),
    lon: biasLon.toString(),
    bbox: biasBbox,
    limit: '5',
    lang: 'en',
  });

  try {
    const res = await fetch(`${PHOTON_URL}?${params}`);
    const data = await res.json();
    const features: any[] = data.features || [];

    resultsDiv.innerHTML = '';
    resultsDiv.dataset.for = activeInput;

    if (features.length === 0) {
      resultsDiv.classList.remove('visible');
      return;
    }

    for (const f of features) {
      const props = f.properties || {};
      const [lon, lat] = f.geometry.coordinates;

      const name = formatName(props);
      const detail = formatDetail(props);

      const item = document.createElement('div');
      item.className = 'search-result-item';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'result-name';
      nameSpan.textContent = name;

      const addrSpan = document.createElement('span');
      addrSpan.className = 'result-address';
      addrSpan.textContent = detail;

      item.appendChild(nameSpan);
      item.appendChild(addrSpan);

      item.addEventListener('click', () => {
        input.value = name;
        resultsDiv.classList.remove('visible');
        onSelect(lat, lon, name);
        input.blur();
      });
      resultsDiv.appendChild(item);
    }
    resultsDiv.classList.add('visible');
  } catch {
    // silently fail — search is a convenience
  }
}

// ========== Reverse geocoding (Photon) ==========

export async function reverseGeocode(lat: number, lng: number): Promise<string> {
  const params = new URLSearchParams({
    lat: lat.toString(),
    lon: lng.toString(),
  });

  try {
    const res = await fetch(`${PHOTON_REVERSE_URL}?${params}`);
    const data = await res.json();
    const f = data.features?.[0];
    if (!f) return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

    return formatName(f.properties || {});
  } catch {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}

// ========== Address formatting ==========

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
