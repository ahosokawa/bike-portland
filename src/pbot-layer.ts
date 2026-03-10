import L from 'leaflet';
import { buildGraph } from './pbot-graph';

let pbotLayer: L.GeoJSON | null = null;
let visible = false;

type Tier = 'best' | 'good' | 'ok' | 'caution' | 'avoid';

const TIER_STYLES: Record<Tier, { color: string; weight: number; opacity: number; dashArray?: string }> = {
  best:    { color: '#00c853', weight: 4, opacity: 0.85 },
  good:    { color: '#2ecc71', weight: 3, opacity: 0.8 },
  ok:      { color: '#2196f3', weight: 3, opacity: 0.75 },
  caution: { color: '#ff9800', weight: 2, opacity: 0.7 },
  avoid:   { color: '#e74c3c', weight: 2, opacity: 0.75, dashArray: '6,4' },
};

const CONNECTION_TYPE_LABELS: Record<string, string> = {
  'MUP_P':    'Multi-Use Path (Paved)',
  'MUP_U':    'Multi-Use Path (Unpaved)',
  'NG':       'Neighborhood Greenway',
  'BBL':      'Buffered Bike Lane',
  'BL':       'Bike Lane',
  'BL-MUP':   'Bike Lane / Multi-Use Path',
  'BL-SR_LT': 'Bike Lane / Shared Road (Low Traffic)',
  'BL-SR_MT': 'Bike Lane / Shared Road (Med Traffic)',
  'BL_VHT':   'Bike Lane (Very High Traffic)',
  'BL-DC':    'Bike Lane (Difficult Connection)',
  'SR_LT':    'Shared Road (Low Traffic)',
  'SR_MT':    'Shared Road (Medium Traffic)',
  'SC':       'Signed Connection',
  'SR_DC':    'Shared Road (Difficult Connection)',
  'SR_MT-DC': 'Shared Road (Med Traffic, Difficult)',
  'DC':       'Difficult Connection',
};

function classifyConnection(connectionType: string | null | undefined): Tier {
  const ct = (connectionType || '').toUpperCase();

  if (ct === 'MUP_P' || ct === 'MUP_U' || ct === 'BL-MUP') return 'best';
  if (ct === 'NG' || ct === 'BBL') return 'good';
  if (ct === 'BL' || ct === 'BL-SR_LT' || ct === 'SR_LT' || ct === 'SC') return 'ok';
  if (ct === 'SR_MT' || ct === 'BL-SR_MT' || ct === 'BL_VHT') return 'caution';
  if (ct === 'DC' || ct === 'SR_DC' || ct === 'BL-DC' || ct === 'SR_MT-DC') return 'avoid';

  return 'caution';
}

export async function loadPbotData(map: L.Map): Promise<void> {
  try {
    const res = await fetch(import.meta.env.BASE_URL + 'data/pbot-routes.geojson');
    if (!res.ok) return;
    const geojson = await res.json();

    // Build routing graph from PBOT data for guided waypoint routing
    buildGraph(geojson);

    pbotLayer = L.geoJSON(geojson, {
      style: (feature) => {
        const tier = classifyConnection(feature?.properties?.ConnectionType);
        return TIER_STYLES[tier];
      },
      onEachFeature: (feature, layer) => {
        const p = feature.properties || {};
        const name = p.StreetName || 'Unnamed';
        const ct = p.ConnectionType || '';
        const label = CONNECTION_TYPE_LABELS[ct] || ct || 'Unknown';
        const tier = classifyConnection(ct);
        const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
        const from = p.FromStreet ? `<br/>From: ${p.FromStreet}` : '';
        const to = p.ToStreet ? `<br/>To: ${p.ToStreet}` : '';
        layer.bindPopup(
          `<strong>${name}</strong><br/>${label}<br/><em>${tierLabel}</em>${from}${to}`
        );
      },
    });
  } catch {
    // PBOT data not available — not critical
  }
}

export function togglePbotLayer(map: L.Map): boolean {
  if (!pbotLayer) return false;

  if (visible) {
    map.removeLayer(pbotLayer);
    visible = false;
  } else {
    pbotLayer.addTo(map);
    visible = true;
  }
  return visible;
}
