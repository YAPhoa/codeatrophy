import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Where `npm run dev` forwards API and MCP requests. Override with
// CODEATHROPY_BACKEND_URL when the server listens somewhere else.
const backend = process.env.CODEATHROPY_BACKEND_URL ?? 'http://localhost:8080';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    // `vite --mode mock` (npm run dev:mock) serves the UI against the
    // in-memory API in src/mock. In every other mode this is a constant empty
    // string, so the mock is dropped from the bundle entirely.
    'import.meta.env.VITE_MOCK': JSON.stringify(mode === 'mock' ? '1' : ''),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/mcp': { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
}));
