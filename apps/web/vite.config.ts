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
        texto: resolve(__dirname, 'texto.html'),
        micTest: resolve(__dirname, 'mic-test.html'),
      },
    },
  },
  server: {
    port: 5173,
// Never auto-open: under WSLg, DISPLAY is set without xdg-open, so `open` rejects with
// ENOENT and the unhandled rejection kills the dev server. The root page is the wrong URL
// anyway — texto.html/voz.html need a ?token= to do anything.
    open: false,
  },
});
