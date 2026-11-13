import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, buildQuery, isAbort, request, setTransport } from './client';

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

describe('request', () => {
  it('marks a last-chance save as a request that outlives the page', async () => {
    const calls = stub(() => json({ id: '1' }));
    await api.items.update('1', { notes: 'n' }, { keepalive: true });
    await api.items.update('1', { notes: 'n' });
    expect(calls[0]?.init.keepalive).toBe(true);
    expect(calls[1]?.init.keepalive).toBeUndefined();
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

  it('keeps the two 503 codes apart', async () => {
    stub(() => json({ error: { code: 'ai_unavailable', message: 'no provider' } }, 503));
    expect((await failure(api.ai.draft({ text: 'x' }))).code).toBe('ai_unavailable');
    stub(() => json({ error: { code: 'judge_unavailable', message: 'no engine' } }, 503));
    expect((await failure(api.testCases.verify('x', false))).code).toBe('judge_unavailable');
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
    const pending = failure(api.ai.draft({ text: 'x' }, controller.signal));
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

  it('turns an error response to an export into an ApiError', async () => {
    stub(() => json({ error: { code: 'not_found', message: 'collection not found' } }, 404));
    const err = await failure(api.bundle.export({ scope: 'collection', collectionId: 'gone', includeSolutions: true, includeHiddenTests: true }));
    expect(err.code).toBe('not_found');
  });

  it('sends an explicit null styleId rather than omitting it', async () => {
    const calls = stub(() => json({ draft: {}, style: null }));
    await api.ai.draft({ text: 'x', styleId: null });
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ text: 'x', styleId: null });
  });

  it('revises a variant through the variant endpoint, with the draft under review', async () => {
    const calls = stub(() => json({ draft: {}, style: null }));
    const previousDraft = { type: 'problem' as const, title: 'T', summary: '', body: '', difficulty: null, tags: [], problem: null, testCases: [], assumptions: [] };
    await api.ai.variant('i1', { mode: 'harder', instruction: 'on a grid', previousDraft, styleId: 's1' });
    expect(calls[0]?.url).toBe('/api/v1/items/i1/ai/variant');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ mode: 'harder', instruction: 'on a grid', previousDraft, styleId: 's1' });
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

  it('recognises a refused cross-origin change', async () => {
    stub(() => json({ error: { code: 'forbidden', message: 'cross-origin requests are not allowed' } }, 403));
    const err = await failure(api.collections.create({ name: 'x' }));
    expect(err.status).toBe(403);
    expect(err.code).toBe('forbidden');
  });

  it('exposes the low-level request for endpoints without a wrapper', async () => {
    const calls = stub(() => json({ ok: true }));
    await request('GET', '/meta', { query: { a: 1 } });
    expect(calls[0]?.url).toBe('/api/v1/meta?a=1');
  });
});
