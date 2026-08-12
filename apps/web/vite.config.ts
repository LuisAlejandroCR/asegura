// vite.config.ts: Vite build config for the pitch web app (apps/web).

import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        pitch: resolve(__dirname, 'pitch.html'),
        voz: resolve(__dirname, 'voz.html'),
        micTest: resolve(__dirname, 'mic-test.html'),
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
});