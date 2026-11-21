import react from '@vitejs/plugin-react';
import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// Where `npm run dev` forwards API and MCP requests. Override with
// CODEATROPHY_BACKEND_URL when the server listens somewhere else.
const backend = process.env.CODEATROPHY_BACKEND_URL ?? 'http://localhost:8080';

/**
 * Under the mock nothing is forwarded to a real server. The app's own client
 * goes to the in-memory API, so only a request made some other way (a plain
 * fetch from a script, say) gets here, and it must not reach a live instance.
 */
const noBackend = (): Plugin => {
  const refuse: Connect.NextHandleFunction = (req, res, next) => {
    if (!/^\/(api|mcp)(\/|\?|$)/.test(req.url ?? '')) return next();
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'mock_only', message: 'The mock dev server forwards nothing to a real server; use window.__codeatrophyMock.fetch.' } }));
  };
  return {
    name: 'codeatrophy-no-backend',
    configureServer: (server) => void server.middlewares.use(refuse),
    // A build made with `--mode mock` and served by `vite preview` (the built-app tests).
    configurePreviewServer: (server) => void server.middlewares.use(refuse),
  };
};

/** The font files the first screen draws with: IBM Plex Sans (Latin, upright) and the wordmark. */
const FIRST_SCREEN_FONTS = ['ibm-plex-sans-latin-wght-normal.woff2', 'JetBrainsMono-ExtraBold-ascii.woff2'];

/**
 * Preload the first screen's fonts from index.html, under the names the build
 * gives them. The app is shown once they have loaded (lib/boot.ts), and asked
 * for this early they are in by then, so no text is drawn twice.
 */
const preloadFonts = (): Plugin => {
  let base = '/';
  return {
    name: 'codeatrophy-preload-fonts',
    apply: 'build',
    configResolved: (config) => void (base = config.base),
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const files = Object.values(ctx.bundle ?? {})
          .filter((f) => f.type === 'asset' && f.names.some((n) => FIRST_SCREEN_FONTS.includes(n.split('/').pop() ?? '')))
          .map((f) => f.fileName);
        if (files.length !== FIRST_SCREEN_FONTS.length) throw new Error(`expected the first screen's fonts in the build, found ${files.join(', ') || 'none'}`);
        return files.map((file) => ({
          tag: 'link',
          attrs: { rel: 'preload', href: base + file, as: 'font', type: 'font/woff2', crossorigin: '' },
          injectTo: 'head' as const,
        }));
      },
    },
  };
};

export default defineConfig(({ mode }) => ({
  plugins: mode === 'mock' ? [react(), preloadFonts(), noBackend()] : [react(), preloadFonts()],
  define: {
    // `vite --mode mock` (npm run dev:mock) serves the UI against the
    // in-memory API in src/mock. In every other mode this is a constant empty
    // string, so the mock is dropped from the bundle entirely.
    'import.meta.env.VITE_MOCK': JSON.stringify(mode === 'mock' ? '1' : ''),
  },
  server: {
    port: 5173,
    proxy:
      mode === 'mock'
        ? undefined
        : {
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
    // The code themes' contrast test reads the tokens as text (`?raw`); other CSS stays out.
    css: { include: /tokens\.css/ },
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
}));
