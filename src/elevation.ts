export function drawElevationProfile(
  elevations: number[],
  container: HTMLElement,
): void {
  container.innerHTML = '';
  if (elevations.length < 2) return;

  const canvas = document.createElement('canvas');
  container.appendChild(canvas);

  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const padding = { top: 10, bottom: 20, left: 5, right: 5 };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  const minElev = Math.min(...elevations);
  const maxElev = Math.max(...elevations);
  const elevRange = maxElev - minElev || 1;

  // Draw filled area
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top + plotH);

  for (let i = 0; i < elevations.length; i++) {
    const x = padding.left + (i / (elevations.length - 1)) * plotW;
    const y = padding.top + plotH - ((elevations[i] - minElev) / elevRange) * plotH;
    ctx.lineTo(x, y);
  }

  ctx.lineTo(padding.left + plotW, padding.top + plotH);
  ctx.closePath();

  const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + plotH);
  gradient.addColorStop(0, 'rgba(45, 138, 78, 0.4)');
  gradient.addColorStop(1, 'rgba(45, 138, 78, 0.05)');
  ctx.fillStyle = gradient;
  ctx.fill();

  // Draw line
  ctx.beginPath();
  for (let i = 0; i < elevations.length; i++) {
    const x = padding.left + (i / (elevations.length - 1)) * plotW;
    const y = padding.top + plotH - ((elevations[i] - minElev) / elevRange) * plotH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#2d8a4e';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Labels
  ctx.fillStyle = '#888';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${Math.round(minElev)}m`, padding.left, padding.top + plotH + 14);
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(maxElev)}m`, padding.left + plotW, padding.top + plotH + 14);
  ctx.textAlign = 'center';
  ctx.fillText('elevation', w / 2, padding.top + plotH + 14);
}
