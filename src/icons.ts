// SVG turn-by-turn navigation icons.
// All SVGs use currentColor so they inherit the parent's text color.

const S = 'stroke="currentColor" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"';

const ICONS: Record<string, string> = {
  start: `<svg viewBox="0 0 24 24" ${S}><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/></svg>`,

  arrive: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/></svg>`,

  straight: `<svg viewBox="0 0 24 24" ${S}><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>`,

  'turn-left': `<svg viewBox="0 0 24 24" ${S}><path d="M15 19v-6a3 3 0 00-3-3H6"/><path d="M10 6L6 10l4 4"/></svg>`,

  'turn-right': `<svg viewBox="0 0 24 24" ${S}><path d="M9 19v-6a3 3 0 013-3h6"/><path d="M14 6l4 4-4 4"/></svg>`,

  'u-turn': `<svg viewBox="0 0 24 24" ${S}><path d="M9 19V9a5 5 0 0110 0v1"/><path d="M16 13l3-3-3-3"/></svg>`,

  continue: `<svg viewBox="0 0 24 24" ${S}><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>`,
};

export function turnIconSvg(key: string): string {
  return ICONS[key] || ICONS.continue;
}
