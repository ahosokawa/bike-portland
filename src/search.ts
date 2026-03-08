import type { SearchResult } from './types';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const PORTLAND_BBOX = '-122.84,45.42,-122.47,45.65';

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function initSearch(onSelect: (lat: number, lon: number) => void): void {
  const input = document.getElementById('search-input') as HTMLInputElement;
  const resultsDiv = document.getElementById('search-results')!;

  input.addEventListener('input', () => {
    const query = input.value.trim();
    if (query.length < 3) {
      resultsDiv.classList.remove('visible');
      return;
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => searchAddress(query, resultsDiv, onSelect), 400);
  });

  input.addEventListener('focus', () => {
    if (resultsDiv.children.length > 0) {
      resultsDiv.classList.add('visible');
    }
  });

  document.addEventListener('click', (e) => {
    if (!(e.target as Element).closest('#search-bar')) {
      resultsDiv.classList.remove('visible');
    }
  });
}

async function searchAddress(
  query: string,
  resultsDiv: HTMLElement,
  onSelect: (lat: number, lon: number) => void,
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
    if (results.length === 0) {
      resultsDiv.classList.remove('visible');
      return;
    }

    for (const r of results) {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.textContent = r.display_name;
      item.addEventListener('click', () => {
        const input = document.getElementById('search-input') as HTMLInputElement;
        input.value = r.display_name.split(',')[0];
        resultsDiv.classList.remove('visible');
        onSelect(parseFloat(String(r.lat)), parseFloat(String(r.lon)));
      });
      resultsDiv.appendChild(item);
    }
    resultsDiv.classList.add('visible');
  } catch {
    // silently fail — search is a convenience
  }
}
