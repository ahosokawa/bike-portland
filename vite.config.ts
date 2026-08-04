import { resolve } from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/** Path the site is served from — the GitHub Pages project name.
 *  Single source of truth: everything below derives from it. */
const BASE = '/pedalpdx/';

export default defineConfig({
  base: BASE,
  appType: 'mpa',
  root: 'src',
  publicDir: '../public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/index.html'),
        info: resolve(__dirname, 'src/info/index.html'),
      },
    },
  },
  plugins: [
    {
      name: 'trailing-slash-redirect',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === `${BASE}info`) {
            res.writeHead(301, { Location: `${BASE}info/` });
            res.end();
            return;
          }
          next();
        });
      },
    },
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'PedalPDX',
        short_name: 'PedalPDX',
        description: 'Bike-friendly routing in Portland, OR',
        theme_color: '#2d8a4e',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: BASE,
        icons: [
          { src: 'favicon.ico', sizes: '16x16 32x32', type: 'image/x-icon' },
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,geojson,json}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024, // 6MB for PBOT geojson
        skipWaiting: true,
        clientsClaim: true,
        navigateFallbackDenylist: [new RegExp(`^${BASE}info`)],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/[abc]\.tile\.openstreetmap\.org\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'osm-tiles',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
});
