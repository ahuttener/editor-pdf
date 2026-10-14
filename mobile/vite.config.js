import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 8000 },
  worker: { format: 'es' },
  // O motor (../engine/ops.mjs) é compartilhado com o desktop; no app o node:fs vira um stub
  resolve: { alias: { 'node:fs/promises': fileURLToPath(new URL('./src/node-stub.js', import.meta.url)) } },
  optimizeDeps: { exclude: ['mupdf'] },
  server: { host: true },
});
