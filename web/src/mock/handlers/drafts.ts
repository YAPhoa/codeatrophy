// Drafts: new items in progress, kept on the server until they are saved to
// the library or deleted (docs/api.md, "Drafts").

import type { AiJobError, Draft, DraftKind, DraftResponse, DraftState, DraftSummary } from '../../api/types';
import type { MockDb } from '../db';
import { BY_HTTP, atMostChars, charCount, LIMITS } from '../db';
import type { Handler, Req } from '../http';
import { accepted, conflict, created, enumParam, invalid, isRecord, noContent, notFound, objectBody, ok, Validator } from '../http';
import { isActive, type JobRunner, type StoredJob } from '../jobs';
import { uuid } from '../util';
import { prepareDraft, prepareVariant, shortTitle } from './ai';
import { createItem } from './items';

/** How many drafts may be kept; one more is a `409`. */
export const MAX_DRAFTS = 500;

const KINDS: readonly DraftKind[] = ['capture', 'variant'];
// eslint-disable-next-line no-control-regex -- control characters are what is refused
const NOT_SINGLE_LINE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

export interface StoredDraft {
  id: string;
  kind: DraftKind;
  variantOf: string | null;
  /** The title the client set, or `null` for the server's label. */
  title: string | null;
  revision: number;
  edited: boolean;
  request: Record<string, unknown> | null;
  jobId: string | null;
  error: AiJobError | null;
  generation: DraftResponse | null;
  generationSeq: number;
  content: Record<string, unknown> | null;
  basedOn: number;
  createdAt: string;
  updatedAt: string;
  order: number;
}

export class DraftStore {
  readonly drafts: StoredDraft[] = [];
  private order = 0;
  private readonly db: MockDb;
  private readonly jobs: JobRunner;

  constructor(db: MockDb, jobs: JobRunner) {
    this.db = db;
    this.jobs = jobs;
  }

  get(id: string): StoredDraft {
    const draft = this.drafts.find((d) => d.id === id);
    if (!draft) throw notFound('draft');
    return draft;
  }

  jobOf(draft: StoredDraft): StoredJob | null {
    return draft.jobId === null ? null : (this.jobs.jobs.find((j) => j.id === draft.jobId) ?? null);
  }

  /** Every change moves the revision, the server's own included. */
  touch(draft: StoredDraft): void {
    draft.revision++;
    draft.updatedAt = this.db.now();
    draft.order = ++this.order;
  }

  /** A draft's job has finished: its outcome goes into the draft. */
  finished(job: StoredJob): void {
    const draft = job.draftId === null ? undefined : this.drafts.find((d) => d.id === job.draftId);
    if (!draft || draft.jobId !== job.id) return;
    if (job.status === 'succeeded') {
      const result = job.result as DraftResponse;
      draft.generation = result;
      draft.generationSeq++;
      draft.error = null;
      // A draft job is listed under the title of what it drafted.
      if (result.draft.title) job.title = result.draft.title;
    } else if (job.status === 'failed') {
      draft.error = job.error;
    }
    this.touch(draft);
  }

  restore(saved: readonly StoredDraft[]): void {
    for (const draft of saved) {
      this.drafts.push(draft);
      this.order = Math.max(this.order, draft.order);
    }
  }

  stateOf(draft: StoredDraft): DraftState {
    const job = this.jobOf(draft);
    if (job && isActive(job)) return 'drafting';
    if (draft.error) return 'failed';
    if (draft.generationSeq > draft.basedOn || (draft.generationSeq > 0 && !draft.edited)) return 'ready';
    if (draft.content !== null) return 'edited';
    return 'new';
  }

  titleOf(draft: StoredDraft): string {
    if (draft.title) return draft.title;
    if (draft.generation?.draft.title) return draft.generation.draft.title;
    if (draft.kind === 'capture' && typeof draft.request?.text === 'string' && draft.request.text.trim() !== '') return shortTitle(draft.request.text);
    if (draft.kind === 'variant') {
      const original = draft.variantOf === null ? undefined : this.db.items.get(draft.variantOf);
      if (original) return `Variant of ${original.title}`;
    }
    return 'Untitled draft';
  }

  summary(draft: StoredDraft): DraftSummary {
    const job = this.jobOf(draft);
    return {
      id: draft.id,
      kind: draft.kind,
      variantOf: draft.variantOf,
      title: this.titleOf(draft),
      state: this.stateOf(draft),
      revision: draft.revision,
      edited: draft.edited,
      job: job ? this.jobs.view(job) : null,
      error: draft.error ? structuredClone(draft.error) : null,
      generationSeq: draft.generationSeq,
      basedOn: draft.basedOn,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    };
  }

  full(draft: StoredDraft): Draft {
    return {
      ...this.summary(draft),
      request: structuredClone(draft.request) as Draft['request'],
      generation: structuredClone(draft.generation),
      content: structuredClone(draft.content),
    };
  }

  /** Start a generation of the draft with `request`, validated as its kind's request. */
  generate(draft: StoredDraft, request: Record<string, unknown>): void {
    const job = this.jobOf(draft);
    if (job && isActive(job)) throw conflict('the draft is being generated already');
    const prepared = draft.kind === 'capture' ? prepareDraft(this.db, request) : prepareVariant(this.db, draft.variantOf ?? '', request);
    const started = this.jobs.start({ kind: draft.kind === 'capture' ? 'draft' : 'variant', request, itemId: draft.variantOf, draftId: draft.id, origin: null }, prepared);
    if (job && !job.pickedUp) job.pickedUp = true;
    draft.request = request;
    draft.jobId = started.id;
    draft.error = null;
    this.touch(draft);
  }
}

/** Fail with the contract's revision conflict when `expectedRevision` is stale. */
function checkRevision(draft: StoredDraft, raw: Record<string, unknown>): void {
  const expected = raw.expectedRevision;
  if (expected === undefined || expected === null) return;
  if (typeof expected !== 'number' || !Number.isInteger(expected)) throw invalid('expectedRevision', 'must be an integer');
  if (expected !== draft.revision) {
    throw conflict(`the draft has changed since revision ${expected} (current revision is ${draft.revision})`, { revision: draft.revision });
  }
}

function parseContent(raw: Record<string, unknown>, v: Validator): Record<string, unknown> | null | undefined {
  if (!('content' in raw)) return undefined;
  const value = raw.content;
  if (value === null) return null;
  if (!isRecord(value)) {
    v.add('content', 'must be a JSON object or null');
    return undefined;
  }
  return value;
}

function parseTitle(raw: Record<string, unknown>, v: Validator): string | null | undefined {
  if (!('title' in raw)) return undefined;
  const value = raw.title;
  if (value === null) return null;
  if (typeof value !== 'string') {
    v.add('title', 'must be a string or null');
    return undefined;
  }
  const text = value.trim();
  if (charCount(text) > LIMITS.maxTitleChars) v.add('title', atMostChars(LIMITS.maxTitleChars));
  else if (NOT_SINGLE_LINE.test(text)) v.add('title', 'must be a single line without control characters');
  return text === '' ? null : text;
}

function listDrafts(store: DraftStore, req: Req) {
  const kind = enumParam(req.query, 'kind', KINDS);
  const variantOf = req.query.get('variantOf') || null;
  const items = store.drafts
    .filter((d) => (kind === undefined || d.kind === kind) && (variantOf === null || d.variantOf === variantOf))
    .sort((a, b) => b.order - a.order)
    .map((d) => store.summary(d));
  return ok({ items });
}

function createDraft(db: MockDb, store: DraftStore, req: Req) {
  const raw = objectBody(req);
  const v = new Validator();
  const kind = raw.kind as DraftKind;
  if (!KINDS.includes(kind)) v.add('kind', 'must be capture or variant');
  const variantOf = raw.variantOf ?? null;
  if (kind === 'variant') {
    if (typeof variantOf !== 'string' || !db.items.has(variantOf)) v.add('variantOf', variantOf === null ? 'is required for a variant' : 'item does not exist');
  } else if (variantOf !== null) v.add('variantOf', 'must be null for a capture draft');
  const content = parseContent(raw, v);
  const title = parseTitle(raw, v);
  const generate = raw.generate ?? null;
  if (generate !== null && !isRecord(generate)) v.add('generate', 'must be an object');
  v.check();
  // The generation's own request is validated as its endpoint's, with the same field names.
  if (isRecord(generate)) {
    if (kind === 'capture') prepareDraft(db, generate);
    else prepareVariant(db, variantOf as string, generate);
  }
  if (store.drafts.length >= MAX_DRAFTS) throw conflict(`at most ${MAX_DRAFTS} drafts may be kept; save or delete some first`);

  const now = db.now();
  const draft: StoredDraft = {
    id: uuid(),
    kind,
    variantOf: kind === 'variant' ? (variantOf as string) : null,
    title: title ?? null,
    revision: 0,
    edited: content != null && !isRecord(generate),
    request: null,
    jobId: null,
    error: null,
    generation: null,
    generationSeq: 0,
    content: content ?? null,
    basedOn: 0,
    createdAt: now,
    updatedAt: now,
    order: 0,
  };
  store.drafts.push(draft);
  store.touch(draft);
  if (isRecord(generate)) {
    try {
      store.generate(draft, generate);
    } catch (err) {
      // Too many jobs: nothing is created.
      store.drafts.splice(store.drafts.indexOf(draft), 1);
      throw err;
    }
    return accepted(store.full(draft));
  }
  return created(store.full(draft));
}

function patchDraft(store: DraftStore, req: Req) {
  const draft = store.get(req.params.id!);
  const raw = objectBody(req);
  checkRevision(draft, raw);
  const v = new Validator();
  const content = parseContent(raw, v);
  const title = parseTitle(raw, v);
  const basedOn = raw.basedOn;
  if (basedOn !== undefined && (typeof basedOn !== 'number' || !Number.isInteger(basedOn) || basedOn < 0 || basedOn > draft.generationSeq)) {
    v.add('basedOn', `must be between 0 and ${draft.generationSeq}`);
  }
  const edited = raw.edited;
  if (edited !== undefined && typeof edited !== 'boolean') v.add('edited', 'must be a boolean');
  v.check();

  if (content !== undefined) {
    draft.content = content;
    draft.error = null;
  }
  if (title !== undefined) draft.title = title;
  if (typeof edited === 'boolean') draft.edited = edited;
  if (typeof basedOn === 'number') {
    draft.basedOn = basedOn;
    // Taking the latest generation in collects its job's outcome.
    const job = store.jobOf(draft);
    if (basedOn === draft.generationSeq && job && !isActive(job)) job.pickedUp = true;
  }
  store.touch(draft);
  return ok(store.full(draft));
}

function saveDraft(db: MockDb, store: DraftStore, jobs: JobRunner, req: Req) {
  const draft = store.get(req.params.id!);
  const raw = objectBody(req);
  checkRevision(draft, raw);
  if (!isRecord(raw.item)) throw invalid('item', 'is required');
  const item = draft.kind === 'variant' && raw.item.variantOf == null ? { ...raw.item, variantOf: draft.variantOf } : raw.item;
  // Validated and created exactly as `POST /items` does; nothing changes when it fails.
  // An item saved from a generation is the model's, even if edited before saving.
  const model = draft.generation?.usage.model || null;
  const reply = createItem(db, { ...req, body: item }, { ...BY_HTTP, model });
  const job = store.jobOf(draft);
  if (job) jobs.cancel(job);
  store.drafts.splice(store.drafts.indexOf(draft), 1);
  return reply;
}

export function draftRoutes(db: MockDb, store: DraftStore, jobs: JobRunner): [string, string, Handler][] {
  const changed = <T,>(reply: T): T => {
    jobs.onChange();
    return reply;
  };
  return [
    ['GET', '/drafts', (req) => listDrafts(store, req)],
    ['POST', '/drafts', (req) => changed(createDraft(db, store, req))],
    ['GET', '/drafts/:id', (req) => ok(store.full(store.get(req.params.id!)))],
    ['PATCH', '/drafts/:id', (req) => changed(patchDraft(store, req))],
    [
      'POST',
      '/drafts/:id/generate',
      (req) => {
        const draft = store.get(req.params.id!);
        store.generate(draft, objectBody(req));
        return changed(accepted(store.full(draft)));
      },
    ],
    [
      'POST',
      '/drafts/:id/retry',
      (req) => {
        const draft = store.get(req.params.id!);
        const job = store.jobOf(draft);
        if (job && isActive(job)) throw conflict('the draft is being generated already');
        if (draft.request === null) throw invalid('request', 'the draft has no generation to retry');
        store.generate(draft, draft.request);
        return changed(accepted(store.full(draft)));
      },
    ],
    ['POST', '/drafts/:id/save', (req) => changed(saveDraft(db, store, jobs, req))],
    [
      'DELETE',
      '/drafts/:id',
      (req) => {
        const draft = store.get(req.params.id!);
        const job = store.jobOf(draft);
        if (job) jobs.cancel(job);
        store.drafts.splice(store.drafts.indexOf(draft), 1);
        return changed(noContent());
      },
    ],
  ];
}
