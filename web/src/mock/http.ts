// Request/response plumbing shared by the mock's handlers.

import type { ErrorCode } from '../api/types';

/** Thrown by handlers; the server turns it into the contract's error body. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly fields: Record<string, string | number> | undefined;

  constructor(status: number, code: ErrorCode, message: string, fields?: Record<string, string | number>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
export const forbidden = () =>
  new HttpError(403, 'forbidden', 'cross-origin requests are not allowed; set CODEATHROPY_ALLOWED_ORIGINS to allow this origin');
/** The server answers an unsupported method on a known path with a JSON `405` whose code is `bad_request`. */
export const methodNotAllowed = (method: string) =>
  new HttpError(405, 'bad_request', `method ${method} is not allowed for this path`);
export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, fields?: Record<string, string | number>) =>
  new HttpError(409, 'conflict', message, fields);
export const tooLarge = (message: string) => new HttpError(413, 'too_large', message);
export const upstream = (message: string) => new HttpError(502, 'upstream_error', message);
export const aiUnavailable = () =>
  new HttpError(503, 'ai_unavailable', 'no AI provider is configured');
export const judgeUnavailable = (message = 'no judge engine is configured') =>
  new HttpError(503, 'judge_unavailable', message);

/** A `422` for a single field, e.g. `invalid('title', 'is required')` → "title is required". */
export function invalid(field: string, problem: string): HttpError {
  return new HttpError(422, 'validation_failed', `${field} ${problem}`, { [field]: problem });
}

/** Collects per-field problems so one response can report all of them. */
export class Validator {
  readonly errors: Record<string, string> = {};

  add(field: string, problem: string): void {
    if (!(field in this.errors)) this.errors[field] = problem;
  }

  get failed(): boolean {
    return Object.keys(this.errors).length > 0;
  }

  /** Throw a `422 validation_failed` if anything was recorded. */
  check(): void {
    const first = Object.entries(this.errors)[0];
    if (first) throw new HttpError(422, 'validation_failed', `${first[0]} ${first[1]}`, { ...this.errors });
  }
}

export interface Req {
  method: string;
  /** Path below `/api/v1`, e.g. `/items/123`. */
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body, or `undefined` when there was none. */
  body: unknown;
  form: FormData | null;
}

export interface Reply {
  status: number;
  body?: unknown;
  /** A non-JSON payload (the export zip). */
  raw?: { bytes: Uint8Array<ArrayBuffer>; headers: Record<string, string> };
}

export const ok = (body: unknown): Reply => ({ status: 200, body });
export const created = (body: unknown): Reply => ({ status: 201, body });
export const accepted = (body: unknown): Reply => ({ status: 202, body });
export const noContent = (): Reply => ({ status: 204 });

export type Handler = (req: Req) => Reply | Promise<Reply>;

/** The request body as a JSON object; anything else is a `400`. */
export function objectBody(req: Req): Record<string, unknown> {
  const body = req.body;
  if (body === undefined) return {};
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Read a query parameter that must be one of `allowed`. */
export function enumParam<T extends string>(query: URLSearchParams, key: string, allowed: readonly T[]): T | undefined {
  const value = query.get(key);
  if (value === null || value === '') return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw badRequest(`invalid ${key} "${value}"; expected one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/** Read a repeatable query parameter whose values must all be in `allowed`. */
export function enumListParam<T extends string>(query: URLSearchParams, key: string, allowed: readonly T[]): T[] {
  const values = query.getAll(key).filter((v) => v !== '');
  for (const value of values) {
    if (!(allowed as readonly string[]).includes(value)) {
      throw badRequest(`invalid ${key} "${value}"; expected one of ${allowed.join(', ')}`);
    }
  }
  return values as T[];
}

export function boolParam(query: URLSearchParams, key: string): boolean | undefined {
  const value = query.get(key);
  if (value === null || value === '') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw badRequest(`invalid ${key} "${value}"; expected true or false`);
}

function intParam(query: URLSearchParams, key: string, fallback: number): number {
  const value = query.get(key);
  if (value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest(`${key} must be an integer`);
  return n;
}

/**
 * `limit` / `offset` as the contract defines them (default 50, max 200). A
 * value out of range is a `400`, never clamped.
 */
export function pagination(query: URLSearchParams, maxPageSize = 200): { limit: number; offset: number } {
  const limit = intParam(query, 'limit', 50);
  const offset = intParam(query, 'offset', 0);
  if (limit < 1 || limit > maxPageSize) throw badRequest(`limit must be between 1 and ${maxPageSize}`);
  if (offset < 0) throw badRequest('offset must not be negative');
  return { limit, offset };
}
