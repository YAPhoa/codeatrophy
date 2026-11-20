// AI jobs: every generation runs in the background, two at a time, and keeps
// its outcome until the client collects it (docs/api.md, "AI jobs").

import type { AiJob, AiJobDetail, AiJobError, AiJobKind } from '../api/types';
import type { MockDb } from './db';
import { prepareCode, prepareDraft, prepareTestCases, prepareVariant, type Prepared } from './handlers/ai';
import type { Handler } from './http';
import { badRequest, boolParam, conflict, enumParam, HttpError, noContent, notFound, ok } from './http';
import { uuid } from './util';

/** How many jobs run at once (`CODEATROPHY_AI_WORKERS`, default 2). */
export const AI_WORKERS = 2;
/** How many jobs may be active at once; one more is a `409`. */
export const MAX_ACTIVE_JOBS = 20;
/** How many jobs are kept at most; beyond it the oldest finished ones go. */
export const MAX_KEPT_JOBS = 200;
/** How long a finished job is kept. */
export const KEEP_FINISHED_MS = 3 * 86_400_000;

export const JOB_KINDS: readonly AiJobKind[] = ['draft', 'variant', 'testcases', 'code'];

/** A job as stored: what the API reports, plus the request, the result and the order it was started in. */
export interface StoredJob extends AiJob {
  request: Record<string, unknown>;
  result: unknown;
  order: number;
  /** How long its generation takes once it runs, in ms. */
  delay: number;
  /** The provider it was started with, for the activity log's record of a cancellation. */
  providerId: string | null;
}

export interface JobSpec {
  kind: AiJobKind;
  request: Record<string, unknown>;
  itemId: string | null;
  draftId: string | null;
  origin: string | null;
}

export const isActive = (job: Pick<AiJob, 'status'>): boolean => job.status === 'queued' || job.status === 'running';

/** The generation a job runs, prepared again when it runs: the item or the provider may have gone meanwhile. */
function prepareFor(db: MockDb, job: StoredJob): Prepared<unknown> {
  switch (job.kind) {
    case 'draft':
      return prepareDraft(db, job.request);
    case 'variant':
      return prepareVariant(db, job.itemId ?? '', job.request);
    case 'testcases':
      return prepareTestCases(db, job.itemId ?? '', job.request);
    case 'code':
      return prepareCode(db, job.request);
  }
}

const errorOf = (err: HttpError): AiJobError => (err.fields ? { code: err.code, message: err.message, fields: err.fields } : { code: err.code, message: err.message });

export class JobRunner {
  readonly jobs: StoredJob[] = [];
  /** Called when a job reaches a finished state, before anything else sees it. */
  onFinish: (job: StoredJob) => void = () => undefined;
  /** Called after every change, to keep a copy (see `installMock`). */
  onChange: () => void = () => undefined;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private order = 0;
  private readonly db: MockDb;

  constructor(db: MockDb) {
    this.db = db;
  }

  get(id: string): StoredJob {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw notFound('job');
    return job;
  }

  /** Queue a validated generation; a `409` when too many are active already. */
  start(spec: JobSpec, prepared: Prepared<unknown>): StoredJob {
    if (this.jobs.filter(isActive).length >= MAX_ACTIVE_JOBS) {
      throw conflict(`at most ${MAX_ACTIVE_JOBS} AI jobs may be active at once; wait for one to finish or cancel one`);
    }
    const job: StoredJob = {
      id: uuid(),
      kind: spec.kind,
      itemId: prepared.itemId ?? spec.itemId,
      draftId: spec.draftId,
      title: prepared.title,
      status: 'queued',
      origin: spec.origin,
      error: null,
      pickedUp: false,
      createdAt: this.db.now(),
      startedAt: null,
      finishedAt: null,
      request: spec.request,
      result: null,
      order: ++this.order,
      delay: prepared.delay,
      providerId: prepared.provider.id,
    };
    this.jobs.push(job);
    this.prune();
    this.pump();
    this.onChange();
    return job;
  }

  /** Start queued jobs, oldest first, while a worker is free. */
  private pump(): void {
    let running = this.jobs.filter((j) => j.status === 'running').length;
    for (const job of [...this.jobs].sort((a, b) => a.order - b.order)) {
      if (running >= AI_WORKERS) break;
      if (job.status !== 'queued') continue;
      job.status = 'running';
      job.startedAt = this.db.now();
      this.schedule(job);
      running++;
    }
  }

  private schedule(job: StoredJob): void {
    this.timers.set(
      job.id,
      setTimeout(() => this.complete(job), job.delay),
    );
  }

  private complete(job: StoredJob): void {
    this.timers.delete(job.id);
    if (job.status !== 'running') return;
    try {
      job.result = prepareFor(this.db, job).run();
      job.status = 'succeeded';
    } catch (err) {
      if (!(err instanceof HttpError)) console.error('[mock] a job failed unexpectedly', err);
      job.status = 'failed';
      job.error = err instanceof HttpError ? errorOf(err) : { code: 'internal', message: 'unexpected error in the API mock' };
    }
    this.settle(job);
  }

  private settle(job: StoredJob): void {
    job.finishedAt = this.db.now();
    this.db.registerTags();
    this.onFinish(job);
    this.pump();
    this.onChange();
  }

  /** Cancel an active job; a finished one is left as it is. */
  cancel(job: StoredJob): void {
    if (!isActive(job)) return;
    const timer = this.timers.get(job.id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(job.id);
    if (job.status === 'running') {
      // The provider request is aborted, and the activity log says so.
      const provider = this.db.ai.providers.find((p) => p.id === job.providerId);
      if (provider) {
        const started = Date.parse(job.startedAt ?? job.createdAt);
        this.db.logRequest(provider, {
          operation: job.kind,
          itemId: job.itemId,
          title: job.title,
          status: 'cancelled',
          error: null,
          durationMs: Math.max(0, Date.now() - started),
          usage: { inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
          request: job.request,
          response: null,
        });
      }
    }
    job.status = 'cancelled';
    this.settle(job);
  }

  /** Dismiss: cancel it if it is active, then remove it. */
  remove(job: StoredJob): void {
    this.cancel(job);
    this.jobs.splice(this.jobs.indexOf(job), 1);
    this.onChange();
  }

  /** As a server restart leaves them: running jobs fail as interrupted, queued ones wait again. */
  restart(): void {
    for (const job of this.jobs.filter((j) => j.status === 'running')) {
      const timer = this.timers.get(job.id);
      if (timer !== undefined) clearTimeout(timer);
      this.timers.delete(job.id);
      job.status = 'failed';
      job.error = { code: 'interrupted', message: 'the server restarted before this job finished; start it again' };
      this.settle(job);
    }
  }

  /**
   * Take back the jobs kept from before a reload of the page. Nothing was
   * lost: a job that was running starts its generation over, as if the
   * provider were slow, and queued ones wait their turn.
   */
  restore(saved: readonly StoredJob[]): void {
    for (const job of saved) {
      this.jobs.push(job);
      this.order = Math.max(this.order, job.order);
    }
    for (const job of this.jobs) if (job.status === 'running') this.schedule(job);
    this.pump();
  }

  /** Finished jobs older than three days go, and the oldest finished ones beyond the bound. */
  private prune(): void {
    const now = Date.now();
    const old = (j: StoredJob) => !isActive(j) && j.finishedAt !== null && now - Date.parse(j.finishedAt) > KEEP_FINISHED_MS;
    for (const job of this.jobs.filter(old)) this.jobs.splice(this.jobs.indexOf(job), 1);
    const finished = this.jobs.filter((j) => !isActive(j)).sort((a, b) => a.order - b.order);
    while (this.jobs.length > MAX_KEPT_JOBS && finished.length > 0) this.jobs.splice(this.jobs.indexOf(finished.shift()!), 1);
  }

  view(job: StoredJob): AiJob {
    const { request: _request, result: _result, order: _order, delay: _delay, providerId: _provider, ...rest } = job;
    return structuredClone(rest);
  }

  detail(job: StoredJob): AiJobDetail {
    return { ...this.view(job), request: structuredClone(job.request), result: job.status === 'succeeded' ? structuredClone(job.result) : null };
  }
}

export function jobRoutes(jobs: JobRunner): [string, string, Handler][] {
  return [
    [
      'GET',
      '/ai/jobs',
      (req) => {
        const q = req.query;
        const active = boolParam(q, 'active');
        const kind = enumParam(q, 'kind', JOB_KINDS);
        const pickedUp = boolParam(q, 'pickedUp') ?? false;
        const itemId = q.get('itemId') || null;
        const draftId = q.get('draftId') || null;
        const rawLimit = q.get('limit');
        const limit = rawLimit === null || rawLimit === '' ? 50 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw badRequest('limit must be between 1 and 200');
        const items = jobs.jobs
          .filter((j) => (active === undefined || isActive(j) === active) && (kind === undefined || j.kind === kind) && j.pickedUp === pickedUp)
          .filter((j) => (itemId === null || j.itemId === itemId) && (draftId === null || j.draftId === draftId))
          .sort((a, b) => b.order - a.order)
          .slice(0, limit)
          .map((j) => jobs.view(j));
        return ok({ items });
      },
    ],
    ['GET', '/ai/jobs/:id', (req) => ok(jobs.detail(jobs.get(req.params.id!)))],
    [
      'POST',
      '/ai/jobs/:id/cancel',
      (req) => {
        const job = jobs.get(req.params.id!);
        jobs.cancel(job);
        return ok(jobs.view(job));
      },
    ],
    [
      'POST',
      '/ai/jobs/:id/pickup',
      (req) => {
        const job = jobs.get(req.params.id!);
        if (isActive(job)) throw conflict('the job has not finished yet');
        if (!job.pickedUp) {
          job.pickedUp = true;
          jobs.onChange();
        }
        return ok(jobs.detail(job));
      },
    ],
    [
      'DELETE',
      '/ai/jobs/:id',
      (req) => {
        jobs.remove(jobs.get(req.params.id!));
        return noContent();
      },
    ],
  ];
}
