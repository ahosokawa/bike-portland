// Dev-only simulated GPS: replays positions along the active route so the
// full navigation engine (snap, announcements, HUD, off-route) can be tested
// without riding. Enabled via the ?sim URL param — see main.ts.

import type { PositionSource, NavPosition } from './navigation';
import type { RouteResult } from './types';
import { haversine, bearing, pointToSegProject } from './geo';

const TICK_MS = 1000;        // one fix per second, like real GPS
const BASE_SPEED = 4.7;      // m/s ≈ 10.5 mph cycling
const VEER_RATE = 3;         // m/s of perpendicular drift while veering

export class RideSimulator implements PositionSource {
  private coords: [number, number][];
  private cumDist: number[];
  private totalDist: number;
  private distAlong = 0;
  private veerOffset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cb: ((pos: NavPosition) => void) | null = null;

  speedMultiplier = 1;
  paused = false;
  veering = false;
  noiseSigma = 3; // meters of gaussian position jitter

  constructor(route: RouteResult) {
    this.coords = route.coordinates;
    this.cumDist = [0];
    for (let i = 1; i < this.coords.length; i++) {
      this.cumDist.push(this.cumDist[i - 1] + haversine(this.coords[i - 1], this.coords[i]));
    }
    this.totalDist = this.cumDist[this.cumDist.length - 1];
  }

  start(onPosition: (pos: NavPosition) => void): void {
    this.cb = onPosition;
    this.emit();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.cb = null;
  }

  /** Fraction of route completed, 0..1. */
  getProgress(): number {
    return this.totalDist > 0 ? this.distAlong / this.totalDist : 1;
  }

  getDistAlong(): number {
    return this.distAlong;
  }

  /** Jump to a fraction of the route (0..1). */
  seek(fraction: number): void {
    this.distAlong = Math.max(0, Math.min(1, fraction)) * this.totalDist;
    this.emit();
  }

  /**
   * Follow a new route after a reroute: continue riding from the point on
   * the new route nearest the current simulated position.
   */
  retarget(route: RouteResult): void {
    const { point } = this.pointAt(this.distAlong);
    this.coords = route.coordinates;
    this.cumDist = [0];
    for (let i = 1; i < this.coords.length; i++) {
      this.cumDist.push(this.cumDist[i - 1] + haversine(this.coords[i - 1], this.coords[i]));
    }
    this.totalDist = this.cumDist[this.cumDist.length - 1];

    let bestDist = Infinity;
    let bestAlong = 0;
    for (let i = 0; i < this.coords.length - 1; i++) {
      const r = pointToSegProject(point, this.coords[i], this.coords[i + 1]);
      if (r.distance < bestDist) {
        bestDist = r.distance;
        bestAlong = this.cumDist[i] + r.t * (this.cumDist[i + 1] - this.cumDist[i]);
      }
    }
    this.distAlong = bestAlong;
    this.veerOffset = 0;
    this.veering = false;
  }

  private tick(): void {
    if (!this.paused) {
      this.distAlong = Math.min(this.totalDist, this.distAlong + BASE_SPEED * this.speedMultiplier);
    }
    // Perpendicular drift grows while veering, decays back when not
    if (this.veering) {
      this.veerOffset += VEER_RATE * this.speedMultiplier;
    } else if (this.veerOffset > 0) {
      this.veerOffset = Math.max(0, this.veerOffset - VEER_RATE * 2 * this.speedMultiplier);
    }
    this.emit();
  }

  private emit(): void {
    if (!this.cb) return;
    const { point, heading } = this.pointAt(this.distAlong);
    const noiseE = gaussian() * this.noiseSigma;
    const noiseN = gaussian() * this.noiseSigma;
    // Veer perpendicular (to the right of travel) plus GPS jitter.
    // Compass bearing convention: east = sin, north = cos.
    const veerRad = (heading + 90) * Math.PI / 180;
    const east = this.veerOffset * Math.sin(veerRad) + noiseE;
    const north = this.veerOffset * Math.cos(veerRad) + noiseN;
    const lat = point[0] + north / 111320;
    const lng = point[1] + east / (111320 * Math.cos(point[0] * Math.PI / 180));
    this.cb({
      lat,
      lng,
      heading: this.paused ? null : heading,
      accuracy: 5 + Math.abs(noiseE),
    });
  }

  /** Interpolated point and segment heading at a distance along the polyline. */
  private pointAt(dist: number): { point: [number, number]; heading: number } {
    const coords = this.coords;
    if (coords.length < 2) return { point: coords[0] ?? [0, 0], heading: 0 };

    let i = 1;
    while (i < this.cumDist.length - 1 && this.cumDist[i] < dist) i++;
    const a = coords[i - 1];
    const b = coords[i];
    const segLen = this.cumDist[i] - this.cumDist[i - 1];
    const t = segLen > 0 ? (dist - this.cumDist[i - 1]) / segLen : 0;
    return {
      point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
      heading: (bearing(a, b) + 360) % 360,
    };
  }
}

function gaussian(): number {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ========== Dev control panel ==========

const SPEED_STEPS = [1, 3, 10, 30];

/** Mount floating simulator controls; returns an unmount function. */
export function mountSimulatorControls(sim: RideSimulator): () => void {
  const panel = document.createElement('div');
  panel.className = 'sim-panel';
  panel.innerHTML = `
    <span class="sim-label">SIM</span>
    <button class="sim-btn" data-act="pause" title="Pause/resume">&#10074;&#10074;</button>
    <button class="sim-btn" data-act="speed" title="Cycle speed">1&times;</button>
    <button class="sim-btn" data-act="veer" title="Drift off route">Veer</button>
    <span class="sim-progress">0%</span>
  `;
  document.body.appendChild(panel);

  const pauseBtn = panel.querySelector('[data-act="pause"]') as HTMLButtonElement;
  const speedBtn = panel.querySelector('[data-act="speed"]') as HTMLButtonElement;
  const veerBtn = panel.querySelector('[data-act="veer"]') as HTMLButtonElement;
  const progress = panel.querySelector('.sim-progress') as HTMLElement;

  pauseBtn.addEventListener('click', () => {
    sim.paused = !sim.paused;
    pauseBtn.innerHTML = sim.paused ? '&#9654;' : '&#10074;&#10074;';
  });

  speedBtn.addEventListener('click', () => {
    const idx = SPEED_STEPS.indexOf(sim.speedMultiplier);
    sim.speedMultiplier = SPEED_STEPS[(idx + 1) % SPEED_STEPS.length];
    speedBtn.textContent = `${sim.speedMultiplier}×`;
  });

  veerBtn.addEventListener('click', () => {
    sim.veering = !sim.veering;
    veerBtn.classList.toggle('active', sim.veering);
  });

  const progressTimer = setInterval(() => {
    progress.textContent = `${Math.round(sim.getProgress() * 100)}%`;
    // Veering can be reset externally (reroute retarget) — keep button in sync
    veerBtn.classList.toggle('active', sim.veering);
  }, 500);

  return () => {
    clearInterval(progressTimer);
    panel.remove();
  };
}
