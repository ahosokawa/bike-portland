/**
 * Fetches major roads from OpenStreetMap via Overpass API for Portland, OR.
 * Used to penalize bike routes that cross busy streets without bike infrastructure.
 *
 * Run: npx tsx scripts/fetch-busy-roads.ts
 */

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// Portland metro bounding box
const BBOX = '45.43,-122.83,45.60,-122.47';

const QUERY = `
[out:json][bbox:${BBOX}];
way["highway"~"^(trunk|primary|secondary|motorway|trunk_link|primary_link|secondary_link|motorway_link)$"];
out geom;
`;

interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

interface Feature {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: number[][] };
  properties: { highway: string; name?: string };
}

async function main(): Promise<void> {
  console.log('Querying Overpass API for major roads in Portland...');

  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: `data=${encodeURIComponent(QUERY)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (!res.ok) {
    throw new Error(`Overpass API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const elements: OverpassElement[] = data.elements || [];

  console.log(`Got ${elements.length} way elements`);

  const features: Feature[] = [];

  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;

    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: el.geometry.map(g => [
          Math.round(g.lon * 100000) / 100000,
          Math.round(g.lat * 100000) / 100000,
        ]),
      },
      properties: {
        highway: el.tags?.highway || 'unknown',
        ...(el.tags?.name ? { name: el.tags.name } : {}),
      },
    });
  }

  console.log(`Converted to ${features.length} GeoJSON features`);

  const geojson = {
    type: 'FeatureCollection',
    features,
  };

  const json = JSON.stringify(geojson);
  const fs = await import('fs');
  const path = await import('path');

  const outPath = path.join(process.cwd(), 'public', 'data', 'busy-roads.geojson');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json);

  const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
  console.log(`Saved to ${outPath} (${sizeMB} MB)`);
}

main().catch((err) => {
  console.error('Failed to fetch busy roads data:', err);
  process.exit(1);
});
