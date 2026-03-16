import L from 'leaflet';
import { getDB } from './saved-routes';
import { canonicalEdgeKey, injectEdge, injectPolylineEdges } from './pbot-graph';
import type { EdgePreference } from './types';

// ========== In-memory state ==========

const preferences = new Map<string, EdgePreference>();
let preferencesLayer: L.LayerGroup | null = null;

// ========== Persistence ==========

export async function loadPreferences(): Promise<void> {
  const db = await getDB();
  const all = await db.getAll('edgePreferences');
  preferences.clear();
  for (const pref of all) {
    preferences.set(pref.edgeKey, pref);
  }
}

export async function setPreference(pref: EdgePreference): Promise<void> {
  const db = await getDB();
  await db.put('edgePreferences', pref);
  preferences.set(pref.edgeKey, pref);
  injectEdgeForPreference(pref);
  refreshPreferencesLayer();
}

/** Save a group of preferences (for custom multi-edge segments). */
export async function setPreferenceGroup(prefs: EdgePreference[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('edgePreferences', 'readwrite');
  for (const pref of prefs) {
    tx.store.put(pref);
    preferences.set(pref.edgeKey, pref);
  }
  await tx.done;
  refreshPreferencesLayer();
}

export async function removePreference(edgeKey: string): Promise<void> {
  const db = await getDB();

  // If this preference is part of a group, remove all members
  const pref = preferences.get(edgeKey);
  if (pref?.groupId && pref.allEdgeKeys) {
    const tx = db.transaction('edgePreferences', 'readwrite');
    for (const ek of pref.allEdgeKeys) {
      tx.store.delete(ek);
      preferences.delete(ek);
    }
    await tx.done;
  } else {
    await db.delete('edgePreferences', edgeKey);
    preferences.delete(edgeKey);
  }

  refreshPreferencesLayer();
}

// ========== Graph edge injection ==========

function injectEdgeForPreference(pref: EdgePreference): void {
  // For custom segments with multiple edge keys, use injectPolylineEdges
  // (which creates intermediate nodes). For single PBOT edges, use injectEdge.
  if (pref.allEdgeKeys && pref.allEdgeKeys.length > 1 && pref.coords.length > 0) {
    // The polyline was already injected when the preference was created;
    // on reload we need to re-inject from stored coords.
    injectPolylineEdges(pref.coords[0], pref.name);
    return;
  }

  // Single edge — parse node keys from edge key
  const parts = pref.edgeKey.split('|');
  if (parts.length !== 2) return;
  if (pref.coords.length > 0 && pref.coords[0].length >= 2) {
    injectEdge(parts[0], parts[1], pref.coords[0], pref.name);
  }
}

/** Inject synthetic graph edges for all saved preferences.
 *  Call after both the graph is built and preferences are loaded. */
export function injectPreferenceEdges(): void {
  for (const pref of preferences.values()) {
    injectEdgeForPreference(pref);
  }
}

// ========== Overrides map for A* ==========

export function getOverridesMap(): Map<string, 'preferred' | 'nogo'> | undefined {
  if (preferences.size === 0) return undefined;
  const map = new Map<string, 'preferred' | 'nogo'>();
  for (const [key, pref] of preferences) {
    map.set(key, pref.type);
    // For grouped custom segments, all edge keys get the same override
    if (pref.allEdgeKeys) {
      for (const ek of pref.allEdgeKeys) {
        map.set(ek, pref.type);
      }
    }
  }
  return map;
}

// ========== Query ==========

export function getPreferences(): Map<string, EdgePreference> {
  return preferences;
}

/** Get unique preferences for display (deduplicates grouped preferences). */
export function getUniquePreferences(): EdgePreference[] {
  const seen = new Set<string>();
  const result: EdgePreference[] = [];
  for (const pref of preferences.values()) {
    const id = pref.groupId || pref.edgeKey;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(pref);
  }
  return result;
}

export { canonicalEdgeKey };

// ========== Map visualization ==========

let layerMap: L.Map | null = null;
let onRemoveCallback: (() => void) | null = null;

export function initPreferencesLayer(map: L.Map): void {
  layerMap = map;
  preferencesLayer = L.layerGroup(); // don't add to map — only visible in preferences mode
  refreshPreferencesLayer();
}

export function showPreferencesLayer(): void {
  if (preferencesLayer && layerMap && !layerMap.hasLayer(preferencesLayer)) {
    preferencesLayer.addTo(layerMap);
  }
}

export function hidePreferencesLayer(): void {
  if (preferencesLayer && layerMap && layerMap.hasLayer(preferencesLayer)) {
    layerMap.removeLayer(preferencesLayer);
  }
}

/** Register a callback invoked after a preference is removed via the overlay popup. */
export function onPreferenceRemoved(cb: () => void): void {
  onRemoveCallback = cb;
}

function refreshPreferencesLayer(): void {
  if (!preferencesLayer) return;
  preferencesLayer.clearLayers();

  for (const pref of getUniquePreferences()) {
    for (const coords of pref.coords) {
      const latlngs = coords.map(c => L.latLng(c[0], c[1]));
      const style: L.PolylineOptions = pref.type === 'preferred'
        ? { color: '#00c853', weight: 8, opacity: 0.7 }
        : { color: '#e74c3c', weight: 8, opacity: 0.7, dashArray: '8,6' };
      const line = L.polyline(latlngs, { ...style, interactive: true }).addTo(preferencesLayer!);
      line.on('click', (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        showRemovePopup(pref, e.latlng);
      });
    }
  }
}

function showRemovePopup(pref: EdgePreference, latlng: L.LatLng): void {
  if (!layerMap) return;
  const typeLabel = pref.type === 'preferred' ? 'Safe' : 'Blocked';
  const popup = L.popup()
    .setLatLng(latlng)
    .setContent(
      `<strong>${pref.name}</strong> (${typeLabel})` +
      `<div class="pref-popup-actions">` +
      `<button class="pref-popup-btn pref-popup-btn-clear" data-action="remove">Remove</button>` +
      `</div>`
    )
    .openOn(layerMap);

  const container = popup.getElement();
  if (container) {
    container.addEventListener('click', async (ev) => {
      const btn = (ev.target as HTMLElement).closest('.pref-popup-btn') as HTMLElement | null;
      if (!btn || btn.dataset.action !== 'remove') return;
      await removePreference(pref.edgeKey);
      layerMap!.closePopup();
      onRemoveCallback?.();
    });
  }
}
