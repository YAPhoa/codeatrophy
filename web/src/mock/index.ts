// An in-memory implementation of the HTTP API in docs/api.md, for developing
// the UI without a backend (`npm run dev:mock`) and for tests.
//
// State lives in memory only: reloading the page starts over from the seed.

import { setTransport } from '../api/client';
import type { MockOptions } from './db';
import { MockDb } from './db';
import { aiRoutes } from './handlers/ai';
import { bundleRoutes } from './handlers/bundles';
import { itemRoutes } from './handlers/items';
import { organiseRoutes } from './handlers/organise';
import { settingsRoutes } from './handlers/settings';
import { solutionRoutes } from './handlers/solutions';
import { styleRoutes } from './handlers/styles';
import { submissionRoutes } from './handlers/submissions';
import { testCaseRoutes } from './handlers/testcases';
import type { Handler, Reply, Req } from './http';
import { badRequest, forbidden, forbiddenHost, HttpError, methodNotAllowed, notFound } from './http';
import { seedDatabase, seedStyles } from './seed';
import { abortError, sleep } from './util';

export type { MockOptions } from './db';
export { MockDb } from './db';
export { seedIds } from './seed';
export { buildBundleZip, parseBundleZip } from './bundle';
export type { BundleCollection, BundleData, BundleItem, BundleSolution, BundleTestCase } from './bundle';

export interface MockServer {
  /** Drop-in for `fetch`, answering requests under `/api/v1`. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** The live state, for inspection and for arranging scenarios by hand. */
  db: MockDb;
  /**
   * Change an item behind the UI's back, as an assistant connected over MCP
   * would: the title and body change and the revision goes up, so the next
   * save that carries the old `expectedRevision` gets a `409`.
   */
  externalEdit(itemId: string): void;
}

const API_PREFIX = '/api/v1';

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function compile([method, path, handler]: [string, string, Handler]): Route {
  const keys: string[] = [];
  const source = path.replace(/:(\w+)/g, (_match, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  return { method, pattern: new RegExp(`^${source}$`), keys, handler };
}

function toResponse(reply: Reply): Response {
  if (reply.raw) return new Response(reply.raw.bytes, { status: reply.status, headers: reply.raw.headers });
  if (reply.status === 204 || reply.body === undefined) return new Response(null, { status: reply.status });
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(err: HttpError): Response {
  const error: Record<string, unknown> = { code: err.code, message: err.message };
  if (err.fields) error.fields = err.fields;
  return new Response(JSON.stringify({ error }), {
    status: err.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function createMockServer(options: MockOptions = {}): MockServer {
  const db = new MockDb(options);
  if (db.options.library === 'seed') {
    seedDatabase(db);
    if (db.options.styles === 'seed') seedStyles(db);
  }

  const routes = [
    ...itemRoutes(db),
    ...testCaseRoutes(db),
    ...solutionRoutes(db),
    ...organiseRoutes(db),
    ...submissionRoutes(db),
    ...aiRoutes(db),
    ...styleRoutes(db),
    ...settingsRoutes(db),
    ...bundleRoutes(db),
  ].map(compile);

  async function handle(input: string, init: RequestInit): Promise<Response> {
    const url = new URL(input, 'http://mock.local');
    const method = (init.method ?? 'GET').toUpperCase();
    if (!url.pathname.startsWith(`${API_PREFIX}/`)) throw notFound('route');
    const path = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '');
    // The host and origin checks come before routing, as server middleware would run them.
    if (db.options.forbidden === 'host') {
      throw forbiddenHost(typeof location !== 'undefined' && location.host ? location.host : url.host);
    }
    if (db.options.forbidden === 'origin' && !['GET', 'HEAD', 'OPTIONS'].includes(method)) throw forbidden();

    let params: Record<string, string> = {};
    let pathKnown = false;
    const route = routes.find((r) => {
      const match = r.pattern.exec(path);
      if (!match) return false;
      pathKnown = true;
      if (r.method !== method) return false;
      try {
        params = Object.fromEntries(r.keys.map((key, i) => [key, decodeURIComponent(match[i + 1]!)]));
      } catch {
        throw badRequest('malformed path');
      }
      return true;
    });
    if (!route) {
      if (pathKnown) throw methodNotAllowed(method);
      throw new HttpError(404, 'not_found', 'no such endpoint');
    }

    const req: Req = { method, path, params, query: url.searchParams, body: undefined, form: null };
    const body = init.body;
    if (typeof FormData !== 'undefined' && body instanceof FormData) req.form = body;
    else if (typeof body === 'string' && body !== '') {
      try {
        req.body = JSON.parse(body) as unknown;
      } catch {
        throw badRequest('request body is not valid JSON');
      }
    } else if (body != null && body !== '') throw badRequest('unsupported request body');
    return toResponse(await route.handler(req));
  }

  async function mockFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const signal = init.signal ?? undefined;
    // Latency first, so that a cancelled request never reaches the handler.
    await sleep(db.delay(), signal);
    let response: Response;
    try {
      response = await handle(input, init);
    } catch (err) {
      if (!(err instanceof HttpError)) {
        console.error('[mock] handler failed', err);
        response = errorResponse(new HttpError(500, 'internal', 'unexpected error in the API mock'));
      } else response = errorResponse(err);
    }
    // Long-running handlers (AI, verification) do not watch the signal themselves.
    if (signal?.aborted) throw abortError();
    return response;
  }

  return {
    fetch: mockFetch,
    db,
    externalEdit(itemId: string) {
      const item = db.getItem(itemId);
      if (!item.title.endsWith(' (edited elsewhere)')) item.title = `${item.title} (edited elsewhere)`.slice(0, 200);
      item.body = `${item.body.trimEnd()}\n\n> Added by a simulated external edit at revision ${item.revision + 1}.\n`;
      db.touch(item);
    },
  };
}

const FLAGS = [
  'no-ai',
  'ai-env',
  'no-judge',
  'judge-down',
  'mcp-token',
  'mcp-off',
  'mcp-url',
  'forbidden',
  'forbidden-writes',
  'empty',
  'no-styles',
  'show-tests',
  'fast',
  'instant',
] as const;
const STORAGE_KEY = 'codeatrophy:mock';

/** Translate scenario flags (from `?mock=`) into server options. */
export function optionsFromFlags(flags: readonly string[]): MockOptions {
  const has = (flag: (typeof FLAGS)[number]) => flags.includes(flag);
  return {
    ai: !has('no-ai'),
    judge: has('no-judge') ? 'none' : has('judge-down') ? 'down' : 'ok',
    mcp: has('mcp-off') ? 'off' : has('mcp-token') ? 'token' : 'open',
    library: has('empty') ? 'empty' : 'seed',
    styles: has('no-styles') ? 'none' : 'seed',
    speed: has('instant') ? 'instant' : has('fast') ? 'fast' : 'normal',
    publicUrl: has('mcp-url'),
    aiSource: has('ai-env') ? 'environment' : 'settings',
    forbidden: has('forbidden') ? 'host' : has('forbidden-writes') ? 'origin' : false,
    hideTestCases: !has('show-tests'),
  };
}

declare global {
  interface Window {
    /** The API mock, present only under `npm run dev:mock`. */
    __codeatrophyMock?: MockServer;
  }
}

/**
 * Route the API client to an in-memory server. Scenario flags come from the
 * `?mock=` query parameter (comma-separated) and are remembered for the tab
 * session, so they survive navigation and reloads; `?mock=default` clears them.
 */
export function installMock(): void {
  let flags: string[] = [];
  try {
    const param = new URLSearchParams(window.location.search).get('mock');
    if (param !== null) {
      flags = param === 'default' ? [] : param.split(',').map((f) => f.trim()).filter(Boolean);
      window.sessionStorage.setItem(STORAGE_KEY, flags.join(','));
    } else {
      flags = (window.sessionStorage.getItem(STORAGE_KEY) ?? '').split(',').filter(Boolean);
    }
  } catch {
    // Storage can be unavailable (private mode); the flags then last until reload.
  }
  const unknown = flags.filter((f) => !(FLAGS as readonly string[]).includes(f));
  if (unknown.length > 0) console.warn(`[mock] unknown scenario flag(s): ${unknown.join(', ')}. Known: ${FLAGS.join(', ')}`);

  const server = createMockServer(optionsFromFlags(flags));
  setTransport(server.fetch);
  window.__codeatrophyMock = server;
  console.info(
    `[mock] Using the in-memory API mock (${flags.length > 0 ? `flags: ${flags.join(', ')}` : 'default scenario'}). ` +
      'State resets on reload. Scenarios: ?mock=' +
      FLAGS.join(','),
  );
}
