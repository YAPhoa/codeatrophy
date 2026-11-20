// The HTTP API contract, docs/api.md, against the client that calls it and
// the mock that stands in for the server.

import { afterEach, describe, expect, it, vi } from 'vitest';
import apiDoc from '../../../docs/api.md?raw';
import { createMockServer } from '../mock/index';
import { API_BASE, api, setTransport } from './client';

/** A route as `METHOD /path`, with every path parameter written `{}`. */
type Route = string;

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Strip the query, the API prefix and a trailing slash, and write every `{param}` as `{}`. */
function normalise(method: string, path: string): Route {
  const bare = path.split(/[?#]/)[0]!.replace(new RegExp(`^${API_BASE}(?=/)`), '').replace(/\/+$/, '');
  return `${method.toUpperCase()} ${bare.replace(/\{[^}/]*\}/g, '{}') || '/'}`;
}

/**
 * Every route docs/api.md names in code: a heading, a table row or a mention
 * in the text, such as `PATCH /items/{id}` or `GET /items?collectionId={id}`.
 */
function documentedRoutes(markdown: string): Set<Route> {
  const pattern = new RegExp(`\`(${METHODS.join('|')})\\s+(/[^\\s\`]*)\``, 'g');
  return new Set([...markdown.matchAll(pattern)].map((m) => normalise(m[1]!, m[2]!)));
}

const PLACEHOLDER = 'PARAM';

/** Every route the client's `api` object calls, found by calling each function with placeholders. */
async function clientRoutes(): Promise<Map<Route, string>> {
  const routes = new Map<Route, string>();
  let current = '';
  setTransport(async (url, init = {}) => {
    const path = new URL(url, 'http://client.test').pathname.split('/').map((s) => (s === PLACEHOLDER ? '{}' : s)).join('/');
    routes.set(normalise(init.method ?? 'GET', path), current);
    return new Response(null, { status: 204 });
  });
  const visit = async (node: object, name: string): Promise<void> => {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'function') {
        current = `api.${name}${key}`;
        await (value as (...args: unknown[]) => Promise<unknown>)(PLACEHOLDER, PLACEHOLDER);
      } else if (value && typeof value === 'object') {
        await visit(value as object, `${name}${key}.`);
      }
    }
  };
  await visit(api, '');
  return routes;
}

const sorted = (routes: Iterable<Route>) => [...routes].sort();

afterEach(() => {
  setTransport(() => Promise.reject(new Error('no transport')));
  vi.restoreAllMocks();
});

describe('docs/api.md', () => {
  const documented = documentedRoutes(apiDoc);

  it('is read: its routes are found', () => {
    // Guards against a parser that silently finds nothing.
    expect(documented.size).toBeGreaterThan(50);
    expect(documented).toContain('PATCH /items/{}');
    expect(documented).toContain('GET /items');
  });

  it('documents every route the client calls, and the client calls every documented route', async () => {
    const called = await clientRoutes();
    const undocumented = sorted([...called.keys()].filter((r) => !documented.has(r))).map((r) => `${r} (${called.get(r)})`);
    const uncalled = sorted([...documented].filter((r) => !called.has(r)));
    expect(undocumented, 'routes api/client.ts calls that docs/api.md does not document').toEqual([]);
    expect(uncalled, 'routes docs/api.md documents that api/client.ts never calls').toEqual([]);
  });

  it('describes no route the mock does not answer', async () => {
    const server = createMockServer({ speed: 'instant' });
    // A handler that throws on an empty request is still routed; keep its log out of the output.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const unrouted: string[] = [];
    for (const route of sorted(documented)) {
      const [method, path] = route.split(' ') as [string, string];
      const res = await server.fetch(API_BASE + path.replaceAll('{}', '00000000-0000-4000-8000-000000000000'), { method });
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (res.status === 405 || (res.status === 404 && body?.error?.message === 'no such endpoint')) {
        unrouted.push(`${route} → ${res.status} ${body?.error?.message ?? ''}`);
      }
    }
    expect(unrouted, 'routes in docs/api.md that the mock (src/mock) has no handler for').toEqual([]);
  });

  it('publishes the limits of GET /meta in the mock as documented', async () => {
    const section = apiDoc.slice(apiDoc.indexOf('### `GET /meta`'));
    const example = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
    expect(example, 'the JSON example under GET /meta in docs/api.md').toBeDefined();
    const documentedMeta = JSON.parse(example!) as { limits: Record<string, unknown>; ai: object; judge: object; mcp: object };

    setTransport(createMockServer({ speed: 'instant' }).fetch);
    const meta = await api.meta();
    expect(meta.limits).toEqual(documentedMeta.limits);
    for (const part of ['ai', 'judge', 'mcp'] as const) expect(Object.keys(meta[part]).sort(), part).toEqual(Object.keys(documentedMeta[part]).sort());
  });
});
