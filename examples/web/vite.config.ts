import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// Shama's packages from their sources, workers as ES modules; the examples' vocabulary is in
// tests/fixtures, two folders up.
export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  worker: { format: 'es' },
  // The AudioWorklet's module stays a file: not every browser takes one as a data URL.
  build: { assetsInlineLimit: (file) => (file.endsWith('.js') ? false : undefined) },
  server: { port: 5181, strictPort: true, fs: { allow: ['../..'] } },
  preview: { port: 4181, strictPort: true },
});
