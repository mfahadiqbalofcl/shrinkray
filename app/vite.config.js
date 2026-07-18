import { defineConfig } from 'vite';

// jSquash ships WASM; Vite must not pre-bundle those modules, and the worker
// uses ES module format so dynamic codec imports code-split cleanly.
export default defineConfig({
  base: './', // relative paths so it works on any static host / subpath
  worker: { format: 'es' },
  optimizeDeps: {
    exclude: ['@jsquash/avif', '@jsquash/jpeg', '@jsquash/png', '@jsquash/webp', '@jsquash/resize'],
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0, // keep .wasm as real files
  },
});
