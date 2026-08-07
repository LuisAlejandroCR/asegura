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
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
});