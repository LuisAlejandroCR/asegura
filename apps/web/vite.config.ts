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
    // Never auto-open. The DISPLAY heuristic this replaces still failed under WSLg, which
    // sets DISPLAY without installing xdg-open: `open` rejects with ENOENT, and since
    // nothing awaits it the unhandled rejection kills the whole dev server. Auto-open was
    // never useful here anyway — texto.html/voz.html need a ?token= to do anything, so the
    // opened root page is the wrong URL regardless.
    open: false,
  },
});