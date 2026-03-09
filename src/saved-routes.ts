import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import type { SavedRoute } from './types';

interface PedalPDXDB extends DBSchema {
  savedRoutes: {
    key: string;
    value: SavedRoute;
    indexes: { 'by-date': number };
  };
}

let dbPromise: Promise<IDBPDatabase<PedalPDXDB>> | null = null;

function getDB(): Promise<IDBPDatabase<PedalPDXDB>> {
  if (!dbPromise) {
    dbPromise = openDB<PedalPDXDB>('pedalpdx', 1, {
      upgrade(db) {
        const store = db.createObjectStore('savedRoutes', { keyPath: 'id' });
        store.createIndex('by-date', 'createdAt');
      },
    });
  }
  return dbPromise;
}

export async function saveRoute(route: SavedRoute): Promise<void> {
  const db = await getDB();
  await db.put('savedRoutes', route);
}

export async function getAllRoutes(): Promise<SavedRoute[]> {
  const db = await getDB();
  const routes = await db.getAllFromIndex('savedRoutes', 'by-date');
  return routes.reverse(); // newest first
}

export async function getRoute(id: string): Promise<SavedRoute | undefined> {
  const db = await getDB();
  return db.get('savedRoutes', id);
}

export async function deleteRoute(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('savedRoutes', id);
}
