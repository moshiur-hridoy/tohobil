import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import { isOfflineReadableApiRequest } from './src/lib/api-cache-matcher';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // `prompt`: a new service worker waits until the user taps "reload" in <UpdatePrompt/>.
      registerType: 'prompt',
      includeAssets: ['favicon.ico', 'icon.svg', 'apple-touch-icon.png', 'offline.html'],
      manifest: {
        id: '/',
        name: 'বারাকাহ ফান্ড',
        short_name: 'বারাকাহ',
        description: 'Barakah Fund Management System',
        lang: 'bn',
        dir: 'ltr',
        scope: '/',
        start_url: '/',
        display: 'standalone',
        theme_color: '#aff900',
        background_color: '#ffffff',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,webmanifest}'],
        // Old precaches are deleted when a new service worker activates (no "stale until data is cleared").
        cleanupOutdatedCaches: true,
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // A function, not a regex: Workbox tests a RegExp against the full URL for same-origin
            // requests, so the original `^\/api\/...` pattern never matched and nothing was cached.
            // The function is serialised into the worker, so it must be self-contained (see its file).
            urlPattern: isOfflineReadableApiRequest,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache-v1',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 100, maxAgeSeconds: 24 * 60 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Listen on the local network so a phone on the same Wi-Fi can open http://<this Mac's IP>:5173.
    host: true,
    proxy: {
      '/api': {
        // Overridable so the e2e stack can run beside a normal `pnpm dev`.
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
