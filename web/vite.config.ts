import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  server: { fs: { allow: ['..'] } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 800 },
});
