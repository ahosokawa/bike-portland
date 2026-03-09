import type { SearchResult } from './types';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const PORTLAND_BBOX = '-122.84,45.42,-122.47,45.65';

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let activeInput: 'start' | 'end' = 'end';

export function getActiveInput(): 'start' | 'end' {
  return activeInput;
}

export function setActiveInput(which: 'start' | 'end'): void {
  activeInput = which;
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
    debounceTimer = setTimeout(() => searchAddress(query, resultsDiv, input, onSelect), 400);
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

async function searchAddress(
  query: string,
  resultsDiv: HTMLElement,
  input: HTMLInputElement,
  onSelect: (lat: number, lon: number, displayName: string) => void,
): Promise<void> {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    viewbox: PORTLAND_BBOX,
    bounded: '1',
    limit: '5',
    addressdetails: '1',
  });

  try {
    const res = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'Accept-Language': 'en' },
    });
    const results: SearchResult[] = await res.json();

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
      nameSpan.textContent = r.display_name.split(',')[0];

      const addrSpan = document.createElement('span');
      addrSpan.className = 'result-address';
      addrSpan.textContent = r.display_name.split(',').slice(1, 3).join(',').trim();

      item.appendChild(nameSpan);
      item.appendChild(addrSpan);

      item.addEventListener('click', () => {
        const shortName = r.display_name.split(',')[0];
        input.value = shortName;
        resultsDiv.classList.remove('visible');
        onSelect(parseFloat(String(r.lat)), parseFloat(String(r.lon)), shortName);
        input.blur();
      });
      resultsDiv.appendChild(item);
    }
    resultsDiv.classList.add('visible');
  } catch {
    // silently fail — search is a convenience
  }
}

export async function reverseGeocode(lat: number, lng: number): Promise<string> {
  const params = new URLSearchParams({
    lat: lat.toString(),
    lon: lng.toString(),
    format: 'json',
    zoom: '18',
    addressdetails: '1',
  });

  try {
    const res = await fetch(`${NOMINATIM_REVERSE_URL}?${params}`, {
      headers: { 'Accept-Language': 'en' },
    });
    const data = await res.json();
    if (data.error) return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

    const addr = data.address || {};

    // Build a short, useful label like "123 NW Everett St"
    if (addr.house_number && addr.road) {
      return `${addr.house_number} ${addr.road}`;
    }
    if (addr.road) return addr.road;
    if (addr.pedestrian) return addr.pedestrian;
    if (addr.path) return addr.path;
    if (addr.cycleway) return addr.cycleway;

    // Fallback to first part of display_name
    return data.display_name?.split(',')[0] || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  } catch {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}
