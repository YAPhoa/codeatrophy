// Typed client for the HTTP API in docs/api.md.
//
// Every call goes through `request`, which builds the URL, encodes the body,
// and turns any non-2xx response (or transport failure) into an `ApiError`.

import type {
  AiProvider,
  AiProviderInput,
  AiProviderPatch,
  AiLogDetail,
  AiLogPage,
  AiLogParams,
  AiModelsRequest,
  AiModelsResponse,
  AiSettings,
  AiSettingsUpdate,
  AiTestCasesRequest,
  AiTestCasesResponse,
  AiTestRequest,
  AiTestResponse,
  BulkRequest,
  BulkTestCasesRequest,
  Collection,
  CollectionCreate,
  CollectionPatch,
  DraftRequest,
  DraftResponse,
  ErrorBody,
  ErrorCode,
  ExportRequest,
  ImportPreview,
  ImportResult,
  ImportStrategy,
  Item,
  ItemCheckRequest,
  ItemCheckResponse,
  ItemInput,
  ItemListParams,
  ItemPatch,
  ItemSummary,
  List,
  Meta,
  Page,
  Preferences,
  PreferencesUpdate,
  Solution,
  SolutionInput,
  SolutionPatch,
  Stats,
  StylePreset,
  StylePresetInput,
  StylePresetPatch,
  Submission,
  SubmissionMode,
  SubmissionRequest,
  SubmissionSummary,
  Tag,
  TestCase,
  TestCaseInput,
  TextEditsRequest,
  VariantRequest,
  VerifyResult,
} from './types';

export const API_BASE = '/api/v1';

/** Codes produced by the client itself, in addition to the server's. */
export type ClientErrorCode = ErrorCode | 'network' | 'aborted' | 'unknown';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly fields: Record<string, string | number>;

  constructor(status: number, code: ClientErrorCode, message: string, fields: Record<string, string | number> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }

  /** True for a `409` caused by an `expectedRevision` mismatch. */
  get isRevisionConflict(): boolean {
    return this.code === 'conflict' && this.fields.revision !== undefined;
  }

  /** The item's current revision reported by a revision conflict. */
  get currentRevision(): number | null {
    const value = Number(this.fields.revision);
    return this.isRevisionConflict && Number.isFinite(value) ? value : null;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export function isAbort(err: unknown): boolean {
  return isApiError(err) && err.code === 'aborted';
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let transport: FetchLike = (input, init) => globalThis.fetch(input, init);

/** Replace the function used to perform requests (the API mock and tests use this). */
export function setTransport(fn: FetchLike): void {
  transport = fn;
}

type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[];
export type Query = Record<string, QueryValue>;

/** Serialise query parameters; arrays become repeated keys, empty values are dropped. */
export function buildQuery(query: Query | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value as readonly (string | number)[]) params.append(key, String(v));
    } else {
      params.append(key, String(value));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

interface RequestOptions {
  query?: Query;
  /** JSON body. */
  body?: unknown;
  /** Multipart body; mutually exclusive with `body`. */
  form?: FormData;
  signal?: AbortSignal;
  /**
   * Let the request outlive the page, for a last save as the tab closes.
   * Browsers cap the body of such a request at 64 KiB and drop larger ones.
   */
  keepalive?: boolean;
  /** How to read a successful response. Defaults to JSON (or nothing for 204). */
  as?: 'json' | 'blob';
}

const KNOWN_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'bad_request',
  'forbidden',
  'not_found',
  'conflict',
  'too_large',
  'validation_failed',
  'upstream_error',
  'ai_unavailable',
  'judge_unavailable',
  'internal',
]);

async function toApiError(res: Response): Promise<ApiError> {
  let parsed: Partial<ErrorBody> | null = null;
  try {
    parsed = (await res.json()) as Partial<ErrorBody>;
  } catch {
    // Not JSON: a proxy error page, or the server is down behind the dev proxy.
  }
  const e = parsed?.error;
  if (e && typeof e.code === 'string' && KNOWN_CODES.has(e.code)) {
    return new ApiError(res.status, e.code, e.message || res.statusText, e.fields ?? {});
  }
  // The server always answers errors with the JSON body above. A 5xx without
  // one comes from something in between (a reverse proxy, the dev proxy) that
  // could not reach it.
  if (res.status >= 500) {
    return new ApiError(res.status, 'network', 'The Codeatrophy server is not reachable.');
  }
  return new ApiError(res.status, 'unknown', `Unexpected response (HTTP ${res.status}).`);
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const url = API_BASE + path + buildQuery(opts.query);
  const init: RequestInit = { method, signal: opts.signal, headers: { Accept: 'application/json' } };
  if (opts.keepalive) init.keepalive = true;
  if (opts.form) {
    init.body = opts.form;
  } else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
  }
  if (opts.as === 'blob') init.headers = { ...init.headers, Accept: 'application/zip, application/json' };

  let res: Response;
  try {
    res = await transport(url, init);
  } catch (err) {
    if (opts.signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      throw new ApiError(0, 'aborted', 'The request was cancelled.');
    }
    throw new ApiError(0, 'network', 'The Codeatrophy server is not reachable.');
  }
  if (!res.ok) throw await toApiError(res);
  if (opts.as === 'blob') return { blob: await res.blob(), filename: filenameOf(res) } as T;
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    if (opts.signal?.aborted) throw new ApiError(0, 'aborted', 'The request was cancelled.');
    throw new ApiError(res.status, 'unknown', 'The server sent a response that could not be read.');
  }
}

function filenameOf(res: Response): string | null {
  const header = res.headers.get('Content-Disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

const enc = encodeURIComponent;

export interface Download {
  blob: Blob;
  filename: string | null;
}

export const api = {
  meta: (signal?: AbortSignal) => request<Meta>('GET', '/meta', { signal }),
  stats: (signal?: AbortSignal) => request<Stats>('GET', '/stats', { signal }),

  items: {
    list: (params: ItemListParams = {}, signal?: AbortSignal) =>
      request<Page<ItemSummary>>('GET', '/items', { query: { ...params }, signal }),
    get: (id: string, signal?: AbortSignal) => request<Item>('GET', `/items/${enc(id)}`, { signal }),
    create: (input: ItemInput) => request<Item>('POST', '/items', { body: input }),
    update: (id: string, patch: ItemPatch, opts: { keepalive?: boolean } = {}) => request<Item>('PATCH', `/items/${enc(id)}`, { body: patch, keepalive: opts.keepalive }),
    edits: (id: string, body: TextEditsRequest) => request<Item>('POST', `/items/${enc(id)}/edits`, { body }),
    remove: (id: string) => request<void>('DELETE', `/items/${enc(id)}`),
    bulk: (body: BulkRequest) => request<{ affected: number }>('POST', '/items/bulk', { body }),
    /** Runs the reference solution of a problem not saved yet on its test cases; nothing is stored. */
    check: (body: ItemCheckRequest, signal?: AbortSignal) => request<ItemCheckResponse>('POST', '/items/check', { body, signal }),
  },

  testCases: {
    list: (itemId: string, signal?: AbortSignal) =>
      request<List<TestCase>>('GET', `/items/${enc(itemId)}/testcases`, { signal }),
    create: (itemId: string, input: TestCaseInput) =>
      request<TestCase>('POST', `/items/${enc(itemId)}/testcases`, { body: input }),
    bulk: (itemId: string, body: BulkTestCasesRequest) =>
      request<List<TestCase>>('POST', `/items/${enc(itemId)}/testcases/bulk`, { body }),
    update: (id: string, patch: Partial<TestCaseInput>) =>
      request<TestCase>('PATCH', `/testcases/${enc(id)}`, { body: patch }),
    remove: (id: string) => request<void>('DELETE', `/testcases/${enc(id)}`),
    reorder: (itemId: string, ids: string[]) =>
      request<List<TestCase>>('PUT', `/items/${enc(itemId)}/testcases/order`, { body: { ids } }),
    /** Runs the reference solution, or the solution named by `solutionId`, on every case. */
    verify: (itemId: string, updateExpected: boolean, solutionId: string | null = null, signal?: AbortSignal) =>
      request<{ results: VerifyResult[] }>('POST', `/items/${enc(itemId)}/testcases/verify`, {
        body: { updateExpected, solutionId },
        signal,
      }),
  },

  solutions: {
    list: (itemId: string, signal?: AbortSignal) =>
      request<List<Solution>>('GET', `/items/${enc(itemId)}/solutions`, { signal }),
    create: (itemId: string, body: SolutionInput) =>
      request<Solution>('POST', `/items/${enc(itemId)}/solutions`, { body }),
    update: (id: string, body: SolutionPatch) => request<Solution>('PATCH', `/solutions/${enc(id)}`, { body }),
    remove: (id: string) => request<void>('DELETE', `/solutions/${enc(id)}`),
  },

  collections: {
    list: (signal?: AbortSignal) => request<List<Collection>>('GET', '/collections', { signal }),
    get: (id: string, signal?: AbortSignal) => request<Collection>('GET', `/collections/${enc(id)}`, { signal }),
    create: (body: CollectionCreate) => request<Collection>('POST', '/collections', { body }),
    update: (id: string, body: CollectionPatch) => request<Collection>('PATCH', `/collections/${enc(id)}`, { body }),
    remove: (id: string) => request<void>('DELETE', `/collections/${enc(id)}`),
    setItems: (id: string, itemIds: string[]) =>
      request<{ itemIds: string[] }>('PUT', `/collections/${enc(id)}/items`, { body: { itemIds } }),
    addItems: (id: string, itemIds: string[]) =>
      request<{ itemIds: string[] }>('POST', `/collections/${enc(id)}/items`, { body: { itemIds } }),
    itemIds: (id: string, signal?: AbortSignal) =>
      request<{ itemIds: string[] }>('GET', `/collections/${enc(id)}/items`, { signal }),
    removeItem: (id: string, itemId: string) =>
      request<void>('DELETE', `/collections/${enc(id)}/items/${enc(itemId)}`),
  },

  tags: {
    list: (signal?: AbortSignal) => request<List<Tag>>('GET', '/tags', { signal }),
    rename: (name: string, newName: string) => request<Tag>('PATCH', `/tags/${enc(name)}`, { body: { name: newName } }),
    remove: (name: string) => request<void>('DELETE', `/tags/${enc(name)}`),
  },

  submissions: {
    create: (itemId: string, body: SubmissionRequest) =>
      request<Submission>('POST', `/items/${enc(itemId)}/submissions`, { body }),
    get: (id: string, signal?: AbortSignal) => request<Submission>('GET', `/submissions/${enc(id)}`, { signal }),
    list: (
      itemId: string,
      params: { mode?: SubmissionMode; limit?: number; offset?: number } = {},
      signal?: AbortSignal,
    ) => request<Page<SubmissionSummary>>('GET', `/items/${enc(itemId)}/submissions`, { query: params, signal }),
  },

  ai: {
    draft: (body: DraftRequest, signal?: AbortSignal) =>
      request<DraftResponse>('POST', '/ai/draft', { body, signal }),
    variant: (itemId: string, body: VariantRequest, signal?: AbortSignal) =>
      request<DraftResponse>('POST', `/items/${enc(itemId)}/ai/variant`, { body, signal }),
    testCases: (itemId: string, body: AiTestCasesRequest, signal?: AbortSignal) =>
      request<AiTestCasesResponse>('POST', `/items/${enc(itemId)}/ai/testcases`, { body, signal }),
  },

  styles: {
    list: (signal?: AbortSignal) => request<List<StylePreset>>('GET', '/styles', { signal }),
    create: (body: StylePresetInput) => request<StylePreset>('POST', '/styles', { body }),
    update: (id: string, body: StylePresetPatch) => request<StylePreset>('PATCH', `/styles/${enc(id)}`, { body }),
    remove: (id: string) => request<void>('DELETE', `/styles/${enc(id)}`),
  },

  preferences: {
    get: (signal?: AbortSignal) => request<Preferences>('GET', '/settings/preferences', { signal }),
    put: (body: PreferencesUpdate) => request<Preferences>('PUT', '/settings/preferences', { body }),
  },

  settings: {
    getAi: (signal?: AbortSignal) => request<AiSettings>('GET', '/settings/ai', { signal }),
    putAi: (body: AiSettingsUpdate) => request<AiSettings>('PUT', '/settings/ai', { body }),
    createProvider: (body: AiProviderInput) => request<AiProvider>('POST', '/settings/ai/providers', { body }),
    updateProvider: (id: string, body: AiProviderPatch) =>
      request<AiProvider>('PATCH', `/settings/ai/providers/${enc(id)}`, { body }),
    removeProvider: (id: string) => request<void>('DELETE', `/settings/ai/providers/${enc(id)}`),
    testAi: (body: AiTestRequest, signal?: AbortSignal) =>
      request<AiTestResponse>('POST', '/settings/ai/test', { body, signal }),
    /** The models a configuration offers, without a generation request. */
    listModels: (body: AiModelsRequest, signal?: AbortSignal) =>
      request<AiModelsResponse>('POST', '/settings/ai/models', { body, signal }),
    log: (params: AiLogParams = {}, signal?: AbortSignal) => request<AiLogPage>('GET', '/settings/ai/log', { query: { ...params }, signal }),
    logEntry: (id: string, signal?: AbortSignal) => request<AiLogDetail>('GET', `/settings/ai/log/${enc(id)}`, { signal }),
    /** Everything, or with `before` the entries created before that moment. */
    clearLog: (before?: string) => request<void>('DELETE', '/settings/ai/log', { query: { before } }),
  },

  bundle: {
    export: (body: ExportRequest) => request<Download>('POST', '/export', { body, as: 'blob' }),
    preview: (file: File, signal?: AbortSignal) => {
      const form = new FormData();
      form.append('file', file);
      return request<ImportPreview>('POST', '/import/preview', { form, signal });
    },
    import: (file: File, strategy: ImportStrategy) => {
      const form = new FormData();
      form.append('file', file);
      form.append('strategy', strategy);
      return request<ImportResult>('POST', '/import', { form });
    },
  },
};
