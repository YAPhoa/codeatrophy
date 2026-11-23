import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorCode } from './types';
import { ApiError, KNOWN_CODES, api, buildQuery, fitsKeepalive, isAbort, jobError, request, setTransport, validationFields } from './client';

type Call = { url: string; init: RequestInit };

/** Install a transport that records calls and answers with `respond`. */
function stub(respond: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  setTransport(async (url, init = {}) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  });
  return calls;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const failure = async (p: Promise<unknown>): Promise<ApiError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected the request to fail');
};

afterEach(() => vi.restoreAllMocks());

describe('buildQuery', () => {
  it('repeats array parameters and drops empty values', () => {
    expect(buildQuery({ q: 'two sum', status: ['todo', 'done'], tag: [], type: undefined, favorite: true, offset: 0, x: null, y: '' })).toBe(
      '?q=two+sum&status=todo&status=done&favorite=true&offset=0',
    );
  });

  it('returns an empty string when there is nothing to send', () => {
    expect(buildQuery(undefined)).toBe('');
    expect(buildQuery({ a: undefined })).toBe('');
  });
});

describe('validationFields', () => {
  it('is the fields of a validation_failed error, and none for anything else', () => {
    expect(validationFields(new ApiError(400, 'validation_failed', 'invalid', { name: 'is required' }))).toEqual({ name: 'is required' });
    expect(validationFields(new ApiError(409, 'conflict', 'changed', { revision: 4 }))).toEqual({});
    expect(validationFields(new Error('boom'))).toEqual({});
    expect(validationFields(null)).toEqual({});
  });
});

describe('item links', () => {
  it('lists, adds and removes the links of an item', async () => {
    const calls = stub((c) => (c.init.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ links: [] })));
    expect(await api.items.links.list('a b')).toEqual({ links: [] });
    await api.items.links.add('a', 'b');
    await api.items.links.remove('a', 'b/c');
    expect(calls.map((c) => `${c.init.method} ${c.url} ${c.init.body ?? ''}`)).toEqual([
      'GET /api/v1/items/a%20b/links ',
      'POST /api/v1/items/a/links {"itemId":"b"}',
      'DELETE /api/v1/items/a/links/b%2Fc ',
    ]);
  });
});

describe('request', () => {
  it('marks a last-chance save as a request that outlives the page', async () => {
    const calls = stub(() => json({ id: '1' }));
    await api.items.update('1', { notes: 'n' }, { keepalive: true });
    await api.items.update('1', { notes: 'n' });
    await api.drafts.update('d1', { content: {} }, { keepalive: true });
    await api.drafts.update('d1', { content: {} });
    expect(calls.map((c) => `${c.init.method} ${c.url} ${c.init.keepalive}`)).toEqual([
      'PATCH /api/v1/items/1 true',
      'PATCH /api/v1/items/1 undefined',
      'PATCH /api/v1/drafts/d1 true',
      'PATCH /api/v1/drafts/d1 undefined',
    ]);
  });

  it('lets a request outlive the page only while its body fits in 64 KiB, measured in bytes', async () => {
    const calls = stub(() => json({ id: '1' }));
    // {"notes":"…"} is 12 bytes around the text; é is two bytes in UTF-8 and one UTF-16 unit.
    await api.items.update('1', { notes: 'é'.repeat(32_762) }, { keepalive: true });
    await api.items.update('1', { notes: 'é'.repeat(32_763) }, { keepalive: true });
    await api.items.update('1', { notes: 'a'.repeat(65_524) }, { keepalive: true });
    expect(calls.map((c) => [new TextEncoder().encode(c.init.body as string).length, c.init.keepalive])).toEqual([
      [65_536, true],
      [65_538, undefined],
      [65_536, true],
    ]);
  });

  it('says whether a body fits a request that outlives the page, in bytes', () => {
    // Short in UTF-16 units, too large in bytes.
    expect(fitsKeepalive({ content: { body: 'é'.repeat(40_000) } })).toBe(false);
    // Past 60,000 units, still within 64 KiB.
    expect(fitsKeepalive({ content: { body: 'a'.repeat(62_000) } })).toBe(true);
    expect(fitsKeepalive({ notes: 'é'.repeat(32_762) })).toBe(true);
    expect(fitsKeepalive({ notes: 'é'.repeat(32_763) })).toBe(false);
  });

  it('sends JSON under /api/v1 and parses the response', async () => {
    const calls = stub(() => json({ id: '1', title: 'T' }, 201));
    const item = await api.items.create({ type: 'problem', title: 'T' });
    expect(item).toEqual({ id: '1', title: 'T' });
    expect(calls[0]?.url).toBe('/api/v1/items');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe(JSON.stringify({ type: 'problem', title: 'T' }));
    expect((calls[0]?.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('serialises list filters as repeated query parameters', async () => {
    const calls = stub(() => json({ items: [], total: 0 }));
    await api.items.list({ status: ['todo', 'in_progress'], tag: ['dp', 'graph'], collectionId: 'c1', recursive: true, sort: 'title' });
    expect(calls[0]?.url).toBe('/api/v1/items?status=todo&status=in_progress&tag=dp&tag=graph&collectionId=c1&recursive=true&sort=title');
  });

  it('URL-encodes path segments', async () => {
    const calls = stub(() => json({ name: 'c++', count: 1 }));
    await api.tags.rename('c/c++ & more', 'cpp');
    expect(calls[0]?.url).toBe('/api/v1/tags/c%2Fc%2B%2B%20%26%20more');
  });

  it('resolves to undefined for 204', async () => {
    stub(() => new Response(null, { status: 204 }));
    await expect(api.items.remove('x')).resolves.toBeUndefined();
  });

  it('maps the error body to an ApiError with fields', async () => {
    stub(() => json({ error: { code: 'validation_failed', message: 'title is required', fields: { title: 'is required' } } }, 422));
    const err = await failure(api.items.create({ type: 'problem', title: '' }));
    expect(err.status).toBe(422);
    expect(err.code).toBe('validation_failed');
    expect(err.message).toBe('title is required');
    expect(err.fields).toEqual({ title: 'is required' });
    expect(err.isRevisionConflict).toBe(false);
  });

  it('recognises a revision conflict and exposes the current revision', async () => {
    stub(() => json({ error: { code: 'conflict', message: 'item has changed', fields: { revision: 7 } } }, 409));
    const err = await failure(api.items.update('x', { title: 'New', expectedRevision: 3 }));
    expect(err.isRevisionConflict).toBe(true);
    expect(err.currentRevision).toBe(7);
  });

  it('does not treat other conflicts as revision conflicts', async () => {
    stub(() => json({ error: { code: 'conflict', message: 'a collection cannot be moved under itself' } }, 409));
    const err = await failure(api.collections.update('c', { parentId: 'c' }));
    expect(err.code).toBe('conflict');
    expect(err.isRevisionConflict).toBe(false);
    expect(err.currentRevision).toBeNull();
  });

  it('passes every error code of the contract through with its status, the two 503s apart', async () => {
    // The statuses of docs/api.md, Errors.
    const statusOf: Record<ErrorCode, number> = {
      bad_request: 400,
      forbidden: 403,
      not_found: 404,
      conflict: 409,
      too_large: 413,
      validation_failed: 422,
      upstream_error: 502,
      ai_unavailable: 503,
      judge_unavailable: 503,
      internal: 500,
      unauthorized: 401,
      rate_limited: 429,
    };
    expect([...KNOWN_CODES].sort()).toEqual(Object.keys(statusOf).sort());
    for (const [code, status] of Object.entries(statusOf)) {
      stub(() => json({ error: { code, message: `the server says ${code}` } }, status));
      const err = await failure(api.collections.create({ name: 'x' }));
      expect({ status: err.status, code: err.code, message: err.message }, code).toEqual({ status, code, message: `the server says ${code}` });
    }
  });

  it('reports a gateway error page as an unreachable server', async () => {
    stub(() => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
    const err = await failure(api.meta());
    expect(err.code).toBe('network');
    expect(err.status).toBe(502);
  });

  it('reports an unrecognised error body as unknown', async () => {
    stub(() => json({ message: 'nope' }, 418));
    expect((await failure(api.meta())).code).toBe('unknown');
    stub(() => json({ error: { code: 'teapot', message: 'short and stout' } }, 418));
    expect((await failure(api.meta())).code).toBe('unknown');
  });

  it('reports a success that is not JSON as unknown, or as aborted when the request was cancelled', async () => {
    stub(() => new Response('<html>Welcome to nginx</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    const err = await failure(api.meta());
    expect(err).toMatchObject({ status: 200, code: 'unknown' });

    // Cancelled while the body was being read, which cuts it short.
    const controller = new AbortController();
    stub(() => {
      const body = new ReadableStream({
        pull: (stream) => {
          controller.abort();
          stream.enqueue(new TextEncoder().encode('{"ver'));
          stream.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    expect((await failure(api.meta(controller.signal))).code).toBe('aborted');
  });

  it('reports a transport failure as a network error', async () => {
    setTransport(async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = await failure(api.meta());
    expect(err.code).toBe('network');
    expect(err.status).toBe(0);
  });

  it('reports cancellation as aborted, not as a failure of the server', async () => {
    const controller = new AbortController();
    setTransport(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const pending = failure(api.drafts.get('d1', controller.signal));
    controller.abort();
    const err = await pending;
    expect(err.code).toBe('aborted');
    expect(isAbort(err)).toBe(true);
  });

  it('uploads bundles as multipart without a JSON content type', async () => {
    const calls = stub(() => json({ created: 1, updated: 0, skipped: 0, duplicated: 0, unchanged: 0, collectionsCreated: 0, warnings: [] }));
    await api.bundle.import(new File(['zip'], 'b.codeatrophy.zip'), 'overwrite');
    const body = calls[0]?.init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('strategy')).toBe('overwrite');
    expect((body.get('file') as File).name).toBe('b.codeatrophy.zip');
    expect((calls[0]?.init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('returns an export as a blob with the file name from Content-Disposition', async () => {
    stub(() => new Response('PK', { status: 200, headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="dp-study-plan.codeatrophy.zip"' } }));
    const res = await api.bundle.export({ scope: 'all', includeSolutions: true, includeHiddenTests: true });
    expect(res.filename).toBe('dp-study-plan.codeatrophy.zip');
    expect(await res.blob.text()).toBe('PK');
  });

  it('reads the file name in every form the server writes it, and none when there is none', async () => {
    const filename = async (disposition: string | null) => {
      stub(() => new Response('PK', { status: 200, headers: disposition === null ? {} : { 'Content-Disposition': disposition } }));
      return (await api.bundle.export({ scope: 'all', includeSolutions: true, includeHiddenTests: true })).filename;
    };
    // Go's mime.FormatMediaType leaves a plain name unquoted, and encodes any other as RFC 5987 does.
    expect(await filename('attachment; filename=dp.codeatrophy.zip')).toBe('dp.codeatrophy.zip');
    expect(await filename("attachment; filename*=utf-8''caf%C3%A9%20notes.codeatrophy.zip")).toBe('café notes.codeatrophy.zip');
    expect(await filename("attachment; filename*=UTF-8''%E6%97%A5%E6%9C%AC.zip")).toBe('日本.zip');
    expect(await filename('attachment')).toBeNull();
    expect(await filename(null)).toBeNull();
  });

  it('turns an error response to an export into an ApiError', async () => {
    stub(() => json({ error: { code: 'not_found', message: 'collection not found' } }, 404));
    const err = await failure(api.bundle.export({ scope: 'collection', collectionId: 'gone', includeSolutions: true, includeHiddenTests: true }));
    expect(err.code).toBe('not_found');
  });

  it('sends an explicit null styleId rather than omitting it', async () => {
    const calls = stub(() => json({ id: 'd1' }, 202));
    await api.drafts.create({ kind: 'capture', generate: { text: 'x', styleId: null } });
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ kind: 'capture', generate: { text: 'x', styleId: null } });
  });

  it('revises a variant draft through its generate endpoint, with the draft under review', async () => {
    const calls = stub(() => json({ id: 'd1' }, 202));
    const previousDraft = { type: 'problem' as const, title: 'T', summary: '', body: '', difficulty: null, tags: [], problem: null, testCases: [], assumptions: [] };
    await api.drafts.generate('d 1', { mode: 'harder', instruction: 'on a grid', previousDraft, styleId: 's1' });
    expect(calls[0]?.url).toBe('/api/v1/drafts/d%201/generate');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ mode: 'harder', instruction: 'on a grid', previousDraft, styleId: 's1' });
  });

  it('lists the jobs not collected yet, and filters them in the query', async () => {
    const calls = stub(() => json({ items: [] }));
    await api.ai.jobs();
    await api.ai.jobs({ kind: 'testcases', itemId: 'i1', active: true, pickedUp: false });
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/ai/jobs', '/api/v1/ai/jobs?kind=testcases&itemId=i1&active=true&pickedUp=false']);
  });

  it('cancels, collects and dismisses a job at its own address', async () => {
    const calls = stub(() => json({ id: 'j1' }));
    await api.ai.cancel('j1');
    await api.ai.pickup('j1');
    const dismissed = stub(() => new Response(null, { status: 204 }));
    await expect(api.ai.dismiss('j1')).resolves.toBeUndefined();
    expect([...calls, ...dismissed].map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'POST /api/v1/ai/jobs/j1/cancel',
      'POST /api/v1/ai/jobs/j1/pickup',
      'DELETE /api/v1/ai/jobs/j1',
    ]);
  });

  it('turns the error a job failed with into the ApiError its request would have thrown', () => {
    const err = jobError({ code: 'validation_failed', message: 'count: must be between 1 and 30', fields: { count: 'must be between 1 and 30' } });
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'validation_failed', message: 'count: must be between 1 and 30', fields: { count: 'must be between 1 and 30' } });
    // A job the server stopped by restarting has a code of its own, and no fields.
    expect(jobError({ code: 'interrupted', message: 'the server restarted' })).toMatchObject({ code: 'interrupted', fields: {} });
    expect(jobError({ code: 'conflict', message: 'changed', fields: { revision: 4 } }).currentRevision).toBe(4);
  });

  it('updates a draft with the revision it was based on, and reads a refusal as a revision conflict', async () => {
    const calls = stub(() => json({ error: { code: 'conflict', message: 'revision mismatch', fields: { revision: 5 } } }, 409));
    const err = await failure(api.drafts.update('d1', { content: { v: 1 }, edited: true, expectedRevision: 4 }));
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ content: { v: 1 }, edited: true, expectedRevision: 4 });
    expect(err.isRevisionConflict).toBe(true);
    expect(err.currentRevision).toBe(5);
  });

  it('fetches specific items with a repeated id filter', async () => {
    const calls = stub(() => json({ items: [], total: 0 }));
    await api.items.list({ id: ['a', 'b'], limit: 2 });
    expect(calls[0]?.url).toBe('/api/v1/items?id=a&id=b&limit=2');
  });

  it('reads a collection’s ordered membership', async () => {
    const calls = stub(() => json({ itemIds: ['a', 'b'] }));
    expect(await api.collections.itemIds('c 1')).toEqual({ itemIds: ['a', 'b'] });
    expect(calls[0]?.url).toBe('/api/v1/collections/c%201/items');
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('carries expectedRevision when test cases are saved with a reference solution', async () => {
    const calls = stub(() => json({ error: { code: 'conflict', message: 'revision mismatch', fields: { revision: 4 } } }, 409));
    const err = await failure(api.testCases.bulk('i1', { cases: [], referenceSolution: { language: 'python', source: 'print(1)' }, expectedRevision: 3 }));
    expect(JSON.parse(calls[0]?.init.body as string).expectedRevision).toBe(3);
    expect(err.isRevisionConflict).toBe(true);
    expect(err.currentRevision).toBe(4);
  });

  it('exposes the low-level request for endpoints without a wrapper', async () => {
    const calls = stub(() => json({ ok: true }));
    await request('GET', '/meta', { query: { a: 1 } });
    expect(calls[0]?.url).toBe('/api/v1/meta?a=1');
  });
});
