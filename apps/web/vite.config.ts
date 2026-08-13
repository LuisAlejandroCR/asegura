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
    // Headless (container, WSL, SSH) has no xdg-open, so `open: true` threw ENOENT on
    // every run. Keeps auto-open on desktops, where DISPLAY is set.
    open: process.platform !== 'linux' || !!process.env.DISPLAY,
  },
});