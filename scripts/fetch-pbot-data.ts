/**
 * Fetches PBOT Recommended Bicycle Routes from ArcGIS and saves as GeoJSON.
 * Handles pagination (ArcGIS typically returns max 1000-2000 features per request).
 *
 * Run: npx tsx scripts/fetch-pbot-data.ts
 */

const BASE_URL =
  'https://www.portlandmaps.com/arcgis/rest/services/Public/PBOT_RecommendedBicycleRoutes/MapServer/4/query';

const PAGE_SIZE = 1000;

interface Feature {
  type: 'Feature';
  geometry: any;
  properties: Record<string, any>;
}

interface GeoJSON {
  type: 'FeatureCollection';
  features: Feature[];
}

async function fetchPage(offset: number): Promise<{ features: Feature[]; exceededLimit: boolean }> {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    f: 'geojson',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    outSR: '4326',
  });

  const url = `${BASE_URL}?${params}`;
  console.log(`Fetching offset ${offset}...`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();
  const features: Feature[] = data.features || [];
  const exceededLimit = data.exceededTransferLimit === true || features.length === PAGE_SIZE;

  return { features, exceededLimit };
}

function simplifyCoord(coord: number[]): number[] {
  // Round to 5 decimal places (~1m precision)
  return coord.map((v) => Math.round(v * 100000) / 100000);
}

function simplifyGeometry(geometry: any): any {
  if (!geometry) return geometry;

  if (geometry.type === 'LineString') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map(simplifyCoord),
    };
  }

  if (geometry.type === 'MultiLineString') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((line: number[][]) =>
        line.map(simplifyCoord),
      ),
    };
  }

  return geometry;
}

async function main(): Promise<void> {
  const allFeatures: Feature[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { features, exceededLimit } = await fetchPage(offset);
    allFeatures.push(
      ...features.map((f) => ({
        ...f,
        geometry: simplifyGeometry(f.geometry),
      })),
    );
    offset += features.length;
    hasMore = exceededLimit && features.length > 0;
  }

  console.log(`Total features: ${allFeatures.length}`);

  const geojson: GeoJSON = {
    type: 'FeatureCollection',
    features: allFeatures,
  };

  const json = JSON.stringify(geojson);
  const fs = await import('fs');
  const path = await import('path');

  const outPath = path.join(process.cwd(), 'public', 'data', 'pbot-routes.geojson');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json);

  const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
  console.log(`Saved to ${outPath} (${sizeMB} MB)`);
}

main().catch((err) => {
  console.error('Failed to fetch PBOT data:', err);
  process.exit(1);
});
