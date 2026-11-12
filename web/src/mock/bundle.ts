// Reading and writing bundles (docs/bundle-format.md), independent of the
// mock's state. `buildBundleZip` is also handy for tests and scripts that
// need a bundle file to upload.

import type {
  CompareMode,
  Difficulty,
  ItemSource,
  ItemType,
  SourceCode,
  TestOrigin,
} from '../api/types';
import { sha256Hex } from './sha256';
import { isLanguage, LANGUAGE_EXTENSIONS, slugify } from './util';
import type { ZipEntry } from './zip';
import { readZip, writeZip, ZipError } from './zip';

export const BUNDLE_FORMAT = 'codeathropy.bundle';
export const BUNDLE_FORMAT_VERSION = 1;

export interface BundleTestCase {
  name: string;
  stdin: string;
  expectedStdout: string;
  isSample: boolean;
  origin?: TestOrigin;
  verified?: boolean;
}

export interface BundleProblem {
  timeLimitMs: number;
  memoryLimitKb: number;
  compare: CompareMode;
  starterCode: Record<string, string>;
  referenceSolution: SourceCode | null;
}

export interface BundleItem {
  id: string;
  type: ItemType;
  title: string;
  summary: string;
  difficulty: Difficulty | null;
  tags: string[];
  source: ItemSource;
  variantOf: string | null;
  body: string;
  /** `null` for a reading. */
  problem: BundleProblem | null;
  testCases: BundleTestCase[];
  createdAt?: string;
  updatedAt?: string;
}

export interface BundleCollection {
  id: string;
  name: string;
  description: string;
  parentId: string | null;
  position: number;
  itemIds: string[];
}

export interface BundleData {
  name: string;
  description?: string;
  author?: string;
  createdAt?: string;
  formatVersion?: number;
  items: BundleItem[];
  collections?: BundleCollection[];
}

/** Thrown when an archive is not an acceptable bundle; the message is safe to show. */
export class BundleError extends Error {}

/** JSON with object keys sorted and no insignificant whitespace. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The content hash of an item's shareable content (docs/bundle-format.md, "Content hash"). */
export function contentHash(item: Omit<BundleItem, 'id' | 'createdAt' | 'updatedAt'>): string {
  const doc: Record<string, unknown> = {
    type: item.type,
    title: item.title,
    summary: item.summary,
    difficulty: item.difficulty,
    tags: [...item.tags].sort(),
    source: { url: item.source.url, note: item.source.note },
    variantOf: item.variantOf,
    body: item.body,
  };
  if (item.type === 'problem' && item.problem) {
    doc.problem = {
      timeLimitMs: item.problem.timeLimitMs,
      memoryLimitKb: item.problem.memoryLimitKb,
      compare: item.problem.compare,
      starterCode: item.problem.starterCode,
      referenceSolution: item.problem.referenceSolution
        ? { language: item.problem.referenceSolution.language, source: item.problem.referenceSolution.source }
        : null,
    };
    doc.testCases = item.testCases.map((c) => ({
      name: c.name,
      stdin: c.stdin,
      expectedStdout: c.expectedStdout,
      isSample: c.isSample,
    }));
  }
  return `sha256:${sha256Hex(canonicalJson(doc))}`;
}

const extensionOf = (language: string) => LANGUAGE_EXTENSIONS[language] ?? 'txt';

/** Serialise bundle data into a zip laid out as the format document describes. */
export function buildBundleZip(data: BundleData): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];
  const add = (path: string, text: string) => entries.push({ path, data: encoder.encode(text) });
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const createdAt = data.createdAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const used = new Set<string>();
  const index = data.items.map((item) => {
    // Directory names are for humans; keep them unique even if a title and id prefix repeat.
    const stem = `items/${slugify(item.title)}-${item.id.replace(/-/g, '').slice(0, 8)}`;
    let dir = stem;
    for (let n = 2; used.has(dir); n++) dir = `${stem}-${n}`;
    used.add(dir);
    const meta: Record<string, unknown> = {
      id: item.id,
      type: item.type,
      title: item.title,
      summary: item.summary,
      difficulty: item.difficulty,
      tags: item.tags,
      source: item.source,
      variantOf: item.variantOf,
      createdAt: item.createdAt ?? createdAt,
      updatedAt: item.updatedAt ?? createdAt,
    };
    if (item.type === 'problem' && item.problem) {
      const starter: Record<string, string> = {};
      for (const [language, source] of Object.entries(item.problem.starterCode)) {
        starter[language] = `starter/${language}.${extensionOf(language)}`;
        add(`${dir}/${starter[language]}`, source);
      }
      const ref = item.problem.referenceSolution;
      if (ref) add(`${dir}/solution/reference.${extensionOf(ref.language)}`, ref.source);
      meta.problem = {
        timeLimitMs: item.problem.timeLimitMs,
        memoryLimitKb: item.problem.memoryLimitKb,
        compare: item.problem.compare,
        starter,
        referenceSolution: ref
          ? { language: ref.language, path: `solution/reference.${extensionOf(ref.language)}` }
          : null,
      };
      if (item.testCases.length > 0) {
        const cases = item.testCases.map((c, i) => {
          const stem = String(i + 1).padStart(2, '0');
          add(`${dir}/tests/${stem}.in`, c.stdin);
          add(`${dir}/tests/${stem}.out`, c.expectedStdout);
          return {
            name: c.name,
            input: `${stem}.in`,
            output: `${stem}.out`,
            sample: c.isSample,
            origin: c.origin ?? 'manual',
            verified: c.verified ?? false,
          };
        });
        add(`${dir}/tests/tests.json`, json({ cases }));
      }
    }
    add(`${dir}/item.json`, json(meta));
    add(`${dir}/body.md`, item.body);
    return { id: item.id, path: dir, type: item.type, title: item.title, contentHash: contentHash(item) };
  });

  const manifest = {
    format: BUNDLE_FORMAT,
    formatVersion: data.formatVersion ?? BUNDLE_FORMAT_VERSION,
    name: data.name,
    description: data.description ?? '',
    author: data.author ?? '',
    createdAt,
    generator: { name: 'codeathropy', version: '0.1.0-mock' },
    items: index,
    collections: data.collections ?? [],
  };
  return writeZip([{ path: 'bundle.json', data: encoder.encode(json(manifest)) }, ...entries]);
}

export interface ParsedBundle {
  name: string;
  description: string;
  author: string;
  formatVersion: number;
  createdAt: string;
  items: BundleItem[];
  collections: BundleCollection[];
  warnings: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const nullableText = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * Read a bundle archive. Problems that sink the whole bundle throw a
 * `BundleError`; problems confined to one item or field become warnings.
 */
export async function parseBundleZip(bytes: Uint8Array): Promise<ParsedBundle> {
  let entries: ZipEntry[];
  try {
    entries = await readZip(bytes);
  } catch (err) {
    throw new BundleError(err instanceof ZipError ? `not a valid bundle: ${err.message}` : 'not a valid bundle');
  }
  for (const entry of entries) {
    if (entry.path.startsWith('/') || entry.path.split('/').includes('..')) {
      throw new BundleError(`not a valid bundle: path "${entry.path}" escapes the archive root`);
    }
  }

  // Tolerate one wrapping top-level directory, as produced by zipping a folder.
  let root = '';
  if (!entries.some((e) => e.path === 'bundle.json')) {
    const wrapped = entries.filter((e) => /^[^/]+\/bundle\.json$/.test(e.path));
    if (wrapped.length !== 1) throw new BundleError('not a valid bundle: bundle.json is missing');
    root = wrapped[0]!.path.slice(0, -'bundle.json'.length);
  }
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) if (entry.path.startsWith(root)) files.set(entry.path.slice(root.length), entry.data);
  const read = (path: string) => {
    const data = files.get(path);
    return data === undefined ? undefined : decoder.decode(data);
  };
  const readJson = (path: string): unknown => {
    const raw = read(path);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  };

  const manifest = readJson('bundle.json');
  if (!isRecord(manifest)) throw new BundleError('not a valid bundle: bundle.json is malformed');
  if (manifest.format !== BUNDLE_FORMAT) throw new BundleError('not a valid bundle: unknown format name');
  const formatVersion = manifest.formatVersion;
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new BundleError('not a valid bundle: formatVersion is missing');
  }
  if (formatVersion > BUNDLE_FORMAT_VERSION) {
    throw new BundleError(
      `bundle format version ${formatVersion} is newer than this server supports (${BUNDLE_FORMAT_VERSION})`,
    );
  }

  const warnings: string[] = [];
  const items: BundleItem[] = [];
  for (const ref of Array.isArray(manifest.items) ? manifest.items : []) {
    if (!isRecord(ref) || typeof ref.path !== 'string' || typeof ref.id !== 'string') {
      warnings.push('bundle.json: an item entry is malformed; skipped');
      continue;
    }
    const dir = ref.path.replace(/\/+$/, '');
    const meta = readJson(`${dir}/item.json`);
    const body = read(`${dir}/body.md`);
    if (!isRecord(meta)) {
      warnings.push(`${dir}/item.json: missing or malformed; item skipped`);
      continue;
    }
    if (body === undefined) {
      warnings.push(`${dir}/body.md: missing; item skipped`);
      continue;
    }
    const type = meta.type;
    const title = text(meta.title).trim();
    if ((type !== 'problem' && type !== 'reading') || title === '' || title.length > 200) {
      warnings.push(`${dir}/item.json: invalid type or title; item skipped`);
      continue;
    }
    const difficulty = meta.difficulty;
    if (difficulty != null && difficulty !== 'easy' && difficulty !== 'medium' && difficulty !== 'hard') {
      warnings.push(`${dir}/item.json: unknown difficulty ${JSON.stringify(difficulty)}; ignored`);
    }
    const source = isRecord(meta.source) ? meta.source : {};
    const item: BundleItem = {
      id: ref.id,
      type,
      title,
      summary: text(meta.summary),
      difficulty: difficulty === 'easy' || difficulty === 'medium' || difficulty === 'hard' ? difficulty : null,
      tags: Array.isArray(meta.tags) ? meta.tags.filter((t): t is string => typeof t === 'string') : [],
      source: { url: nullableText(source.url), note: nullableText(source.note) },
      variantOf: nullableText(meta.variantOf),
      body,
      problem: null,
      testCases: [],
      createdAt: nullableText(meta.createdAt) ?? undefined,
      updatedAt: nullableText(meta.updatedAt) ?? undefined,
    };

    if (type === 'problem') {
      const problem = isRecord(meta.problem) ? meta.problem : {};
      const starterCode: Record<string, string> = {};
      for (const [language, path] of Object.entries(isRecord(problem.starter) ? problem.starter : {})) {
        if (!isLanguage(language)) {
          warnings.push(`${dir}/item.json: unknown language "${language}" in starter code; ignored`);
          continue;
        }
        const src = typeof path === 'string' ? read(`${dir}/${path}`) : undefined;
        if (src === undefined) warnings.push(`${dir}/${String(path)}: starter file is missing; ignored`);
        else starterCode[language] = src;
      }
      let referenceSolution: SourceCode | null = null;
      if (isRecord(problem.referenceSolution)) {
        const { language, path } = problem.referenceSolution;
        const src = typeof path === 'string' ? read(`${dir}/${path}`) : undefined;
        if (!isLanguage(language)) {
          warnings.push(`${dir}/item.json: unknown language "${String(language)}" for the reference solution; ignored`);
        } else if (src === undefined) {
          warnings.push(`${dir}/${String(path)}: reference solution file is missing; ignored`);
        } else referenceSolution = { language, source: src };
      }
      item.problem = {
        timeLimitMs: typeof problem.timeLimitMs === 'number' ? problem.timeLimitMs : 2000,
        memoryLimitKb: typeof problem.memoryLimitKb === 'number' ? problem.memoryLimitKb : 262144,
        compare: problem.compare === 'exact' ? 'exact' : 'tokens',
        starterCode,
        referenceSolution,
      };
      const tests = readJson(`${dir}/tests/tests.json`);
      if (tests === null) warnings.push(`${dir}/tests/tests.json: malformed; test cases ignored`);
      for (const c of isRecord(tests) && Array.isArray(tests.cases) ? tests.cases : []) {
        if (!isRecord(c)) continue;
        const stdin = read(`${dir}/tests/${text(c.input)}`);
        const expectedStdout = read(`${dir}/tests/${text(c.output)}`);
        if (stdin === undefined || expectedStdout === undefined) {
          warnings.push(`${dir}/tests/tests.json: files for case "${text(c.name)}" are missing; case skipped`);
          continue;
        }
        item.testCases.push({
          name: text(c.name),
          stdin,
          expectedStdout,
          isSample: c.sample === true,
          origin: c.origin === 'ai' || c.origin === 'manual' || c.origin === 'import' ? c.origin : 'import',
          verified: c.verified === true,
        });
      }
    }
    // The stored hash is only an integrity check; the recomputed one is what counts.
    if (typeof ref.contentHash === 'string' && ref.contentHash !== contentHash(item)) {
      warnings.push(`${dir}: contentHash does not match the files; the bundle may have been edited by hand`);
    }
    items.push(item);
  }

  const present = new Set(items.map((i) => i.id));
  const collections: BundleCollection[] = [];
  for (const c of Array.isArray(manifest.collections) ? manifest.collections : []) {
    if (!isRecord(c) || typeof c.id !== 'string' || text(c.name).trim() === '') {
      warnings.push('bundle.json: a collection entry is malformed; skipped');
      continue;
    }
    collections.push({
      id: c.id,
      name: text(c.name).trim(),
      description: text(c.description),
      parentId: nullableText(c.parentId),
      position: typeof c.position === 'number' ? c.position : 0,
      itemIds: Array.isArray(c.itemIds)
        ? c.itemIds.filter((id): id is string => typeof id === 'string' && present.has(id))
        : [],
    });
  }
  // A parent that is not in the bundle cannot be honoured.
  const collectionIds = new Set(collections.map((c) => c.id));
  for (const c of collections) if (c.parentId !== null && !collectionIds.has(c.parentId)) c.parentId = null;

  return {
    name: text(manifest.name, 'Untitled bundle'),
    description: text(manifest.description),
    author: text(manifest.author),
    formatVersion,
    createdAt: text(manifest.createdAt),
    items,
    collections,
    warnings,
  };
}
