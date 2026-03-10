// Shared geographic utility functions used across the routing pipeline.

/** Haversine distance between two [lat, lng] points, in meters. */
export function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dlat = toRad(b[0] - a[0]);
  const dlon = toRad(b[1] - a[1]);
  const sinLat = Math.sin(dlat / 2);
  const sinLon = Math.sin(dlon / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * sinLon * sinLon;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Total distance along a coordinate array, in meters. */
export function computeDistance(coords: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversine(coords[i - 1], coords[i]);
  }
  return total;
}

/** Distance from point p to the closest point on segment a–b (flat-earth approx), in meters. */
export function pointToSegDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const cosLat = Math.cos(p[0] * Math.PI / 180);
  const px = (p[1] - a[1]) * cosLat;
  const py = p[0] - a[0];
  const dx = (b[1] - a[1]) * cosLat;
  const dy = b[0] - a[0];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return haversine(p, a);
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
  return haversine(p, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
}

/** Minimum distance from point p to any segment of a polyline, in meters. */
export function pointToEdgeDist(p: [number, number], coords: [number, number][]): number {
  if (coords.length === 0) return Infinity;
  if (coords.length === 1) return haversine(p, coords[0]);
  let min = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = pointToSegDist(p, coords[i], coords[i + 1]);
    if (d < min) min = d;
  }
  return min;
}
