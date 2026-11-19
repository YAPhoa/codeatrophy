// The mock's in-memory state and the derived views the API returns.

import type {
  AiLogDetail,
  AiLogEntry,
  AiProvider,
  AiProviderKind,
  AiProviderUsage,
  AiSettings,
  Collection,
  Difficulty,
  Item,
  ItemSource,
  ItemStatus,
  ItemSummary,
  ItemType,
  JudgeLanguage,
  Limits,
  Meta,
  Preferences,
  ProblemSpec,
  Solution,
  SourceCode,
  StylePreset,
  Submission,
  TestCase,
  Verdict,
} from '../api/types';
import { conflict, notFound } from './http';
import { uuid } from './util';

export interface MockOptions {
  /** Whether an AI provider is configured at start. Default `true`. */
  ai?: boolean;
  /** `ok`: a healthy engine; `none`: no engine; `down`: configured but unreachable. */
  judge?: 'ok' | 'none' | 'down';
  /** `open`: enabled without a token; `token`: bearer token required; `off`: disabled. */
  mcp?: 'open' | 'token' | 'off';
  /** `seed`: a realistic library; `empty`: a brand-new instance. */
  library?: 'seed' | 'empty';
  /** `normal`: realistic latency; `fast`: short delays; `slow`: a second for every plain request; `instant`: none at all. */
  speed?: 'normal' | 'fast' | 'slow' | 'instant';
  /** Reads whose path starts with one of these segments (`stats`, `items`, …) take a second longer. */
  slowPaths?: string[];
  /** `seed`: the seed library's style presets; `none`: start with no presets. */
  styles?: 'seed' | 'none';
  /** Whether the operator configured a public URL, reported as `mcp.url`. Default `false`. */
  publicUrl?: boolean;
  /**
   * Where the Anthropic provider comes from at start: `settings`, one saved
   * through the API; `environment`, the read-only one the server's
   * environment variables supply.
   */
  aiSource?: 'settings' | 'environment';
  /**
   * Refuse requests with `403 forbidden`. `host`: every request, as when the
   * server is reached under a host name it does not accept; `origin`: only
   * state-changing requests, as for a web page on another origin.
   */
  forbidden?: false | 'host' | 'origin';
  /** The `hideTestCases` preference at start. Default `true`, as on a new instance. */
  hideTestCases?: boolean;
}

/**
 * A problem's settings as stored. The reference solution is not among them:
 * it is one of the item's saved solutions, and `problem.referenceSolution`
 * in a response is a view of it.
 */
export type StoredProblem = Omit<ProblemSpec, 'referenceSolution'>;

export interface StoredItem {
  id: string;
  type: ItemType;
  title: string;
  summary: string;
  body: string;
  difficulty: Difficulty | null;
  tags: string[];
  status: ItemStatus;
  favorite: boolean;
  notes: string;
  rawInput: string | null;
  source: ItemSource;
  problem: StoredProblem | null;
  variantOf: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Monotonic counter that breaks ties between equal timestamps. */
  seq: number;
}

export interface StoredSolution extends Solution {
  /** Monotonic counter that breaks ties between equal creation times. */
  seq: number;
}

/** The fields of a solution a client can set. */
export interface SolutionFields {
  name: string;
  language: string;
  source: string;
  notes: string;
  isReference: boolean;
}

/** The name given to a solution created by writing `problem.referenceSolution`. */
export const REFERENCE_SOLUTION_NAME = 'Reference solution';

export interface StoredCollection {
  id: string;
  name: string;
  description: string;
  parentId: string | null;
  position: number;
  /** Ordered membership. */
  itemIds: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * An AI provider as stored: what the API reports, plus the key itself, which
 * no response carries. The key always belongs to the origin of the base URL
 * in effect: an update that moves the provider to another origin drops it.
 */
export interface StoredAiProvider {
  id: string;
  name: string;
  kind: AiProviderKind;
  model: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  source: AiProvider['source'];
  /** Kept as the two sums the API reports; the mock does not age the last 30 days. */
  usage: AiProviderUsage;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A log entry as stored: `seq` orders the log and is what a list cursor points at. */
export interface StoredLogEntry extends AiLogDetail {
  seq: number;
}

/** The counts of a provider that has not been used. */
export function noUsage(): AiProviderUsage {
  const none = { requests: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
  return { last30Days: { ...none }, allTime: { ...none }, lastUsedAt: null };
}

export const AI_KIND_IDS: readonly AiProviderKind[] = ['anthropic', 'gemini', 'openai_compatible'];

export const AI_KINDS: AiSettings['kinds'] = {
  anthropic: { defaultModel: 'claude-opus-5-5', defaultBaseUrl: 'https://api.anthropic.com', keyRequired: true },
  gemini: { defaultModel: null, defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyRequired: true },
  openai_compatible: { defaultModel: null, defaultBaseUrl: 'https://api.openai.com/v1', keyRequired: false },
};

/** The fixed id of the provider the environment supplies for a kind. */
export const envProviderId = (kind: AiProviderKind): string => `env-${kind.replace(/_/g, '-')}`;

// The languages and toolchain versions of the Judge0 engine the server ships
// with. They are old: code shown or generated by the mock has to run on them.
export const JUDGE_LANGUAGES: readonly JudgeLanguage[] = [
  { id: 'c', name: 'C', version: 'GCC 9.2.0' },
  { id: 'cpp', name: 'C++', version: 'GCC 9.2.0' },
  { id: 'csharp', name: 'C#', version: 'Mono 6.6.0.161' },
  { id: 'go', name: 'Go', version: '1.13.5' },
  { id: 'java', name: 'Java', version: 'OpenJDK 13.0.1' },
  { id: 'javascript', name: 'JavaScript', version: 'Node.js 12.14.0' },
  { id: 'kotlin', name: 'Kotlin', version: '1.3.70' },
  { id: 'python', name: 'Python', version: '3.8.1' },
  { id: 'ruby', name: 'Ruby', version: '2.7.0' },
  { id: 'rust', name: 'Rust', version: '1.40.0' },
  { id: 'typescript', name: 'TypeScript', version: '3.7.4' },
];

/** Every bound the mock enforces, as published by `GET /meta`. Validation reads these, never a copy. */
export const LIMITS: Limits = {
  maxImportBytes: 52428800,
  maxImportUncompressedBytes: 209715200,
  maxImportEntries: 1000000,
  maxImportCollections: 10000,
  maxRequestBytes: 33554432,
  maxPageSize: 200,
  maxSourceBytes: 65536,
  maxTitleChars: 200,
  maxSummaryChars: 5000,
  maxTextBytes: 1048576,
  maxSourceUrlChars: 2048,
  maxSourceNoteChars: 2000,
  maxTags: 30,
  maxTagChars: 40,
  maxCollectionNameChars: 200,
  maxCollectionDescriptionChars: 5000,
  timeLimitMs: { min: 100, max: 30000 },
  memoryLimitKb: { min: 16384, max: 2097152 },
  maxTestCasesPerItem: 1000,
  maxTestDataBytes: 8388608,
  maxTestCaseNameChars: 200,
  maxSolutionsPerItem: 50,
  maxSolutionNameChars: 100,
  maxSolutionNotesChars: 5000,
  maxDraftTextChars: 50000,
  maxInstructionChars: 2000,
  maxPreviousDraftBytes: 2097152,
  maxGeneratedTestCases: 30,
  maxLargeInputBytes: 1048576,
  maxLargeTestCases: 5,
  maxStylePresets: 20,
  maxStyleNameChars: 60,
  maxStyleInstructionsChars: 2000,
  maxSystemPromptChars: 20000,
  maxModelIdChars: 200,
  maxApiKeyChars: 1000,
  maxAiProviders: 20,
  maxAiProviderNameChars: 60,
  minAiTimeoutSeconds: 10,
  maxAiTimeoutSeconds: 300,
  maxBundleNameChars: 200,
  maxBundleDescriptionChars: 5000,
};

/** The request timeout the server's environment gives (`CODEATROPHY_AI_TIMEOUT` unset). */
export const DEFAULT_AI_TIMEOUT_SECONDS = 300;

/** The server's wording for a text that is too long. */
export const atMostChars = (max: number): string => `must be at most ${max} characters`;

/** The address reported as `mcp.url` when the operator has set a public URL. */
export const PUBLIC_MCP_URL = 'https://library.example.org/mcp';

export const DEFAULT_PROBLEM: StoredProblem = {
  interface: 'program',
  timeLimitMs: 2000,
  memoryLimitKb: 262144,
  compare: 'tokens',
  starterCode: {},
  harness: {},
};

/** What `GET /settings/preferences` returns on a new instance. */
export const DEFAULT_PREFERENCES: Preferences = {
  hideTestCases: true,
  generatedTestCases: 8,
  largeTestCase: false,
  largeTestCaseCount: 3,
  editor: {
    autocomplete: true,
    closeBrackets: true,
    matchBrackets: true,
    lineWrapping: false,
    tabSize: 4,
    fontSize: 14,
  },
};

type DelayKind = 'default' | 'aiDraft' | 'aiTests' | 'aiTest' | 'bundle' | 'verifyCase' | 'judgeQueue' | 'judgeCase';

const NORMAL_DELAYS: Record<DelayKind, [number, number]> = {
  default: [80, 250],
  aiDraft: [2500, 4000],
  aiTests: [3000, 5000],
  aiTest: [500, 900],
  bundle: [300, 600],
  verifyCase: [150, 250],
  judgeQueue: [300, 300],
  judgeCase: [350, 350],
};

const DELAYS: Record<'normal' | 'fast' | 'slow', Record<DelayKind, [number, number]>> = {
  normal: NORMAL_DELAYS,
  // A slow server or network: what shows while a screen waits for its data.
  slow: { ...NORMAL_DELAYS, default: [1000, 1000] },
  fast: {
    default: [10, 30],
    aiDraft: [500, 700],
    aiTests: [600, 800],
    aiTest: [150, 250],
    bundle: [60, 120],
    verifyCase: [30, 50],
    judgeQueue: [80, 80],
    judgeCase: [120, 120],
  },
};

export class MockDb {
  readonly options: Required<MockOptions>;
  readonly items = new Map<string, StoredItem>();
  /**
   * Every tag, as the server records them: a tag stays, empty, when no item
   * carries it any more, until it is deleted. See `registerTags`.
   */
  readonly tags = new Set<string>();
  collections: StoredCollection[] = [];
  testCases: TestCase[] = [];
  solutions: StoredSolution[] = [];
  /** Oldest first. */
  submissions: Submission[] = [];
  /**
   * What a correct solution "really" prints for a test case, when that
   * differs from the stored expected output. Code is never executed here, so
   * this is how verification can report a mismatch.
   */
  readonly truth = new Map<string, string>();
  /** `timeoutSeconds` is the saved request timeout; `null` leaves the environment's value in effect. */
  ai: { defaultProviderId: string | null; timeoutSeconds: number | null; providers: StoredAiProvider[] } = { defaultProviderId: null, timeoutSeconds: null, providers: [] };
  /** The AI activity log, oldest first. Nothing is removed unless the user asks. */
  aiLog: StoredLogEntry[] = [];
  styles: StylePreset[] = [];
  /** The custom system prompt; `null` means the built-in conventions. */
  systemPrompt: string | null = null;
  /** The custom test case prompt; `null` means the built-in test-case rules. */
  testCasePrompt: string | null = null;
  preferences: Preferences;

  private seq = 0;

  constructor(options: MockOptions = {}) {
    this.options = {
      ai: options.ai ?? true,
      judge: options.judge ?? 'ok',
      mcp: options.mcp ?? 'open',
      library: options.library ?? 'seed',
      speed: options.speed ?? 'normal',
      slowPaths: options.slowPaths ?? [],
      styles: options.styles ?? 'seed',
      publicUrl: options.publicUrl ?? false,
      aiSource: options.aiSource ?? 'settings',
      forbidden: options.forbidden ?? false,
      hideTestCases: options.hideTestCases ?? true,
    };
    this.preferences = { ...structuredClone(DEFAULT_PREFERENCES), hideTestCases: this.options.hideTestCases };
    if (this.options.aiSource === 'environment') {
      // The operator configured the provider through environment variables.
      // It is there whether or not it is in use.
      this.ai.providers.push({
        id: envProviderId('anthropic'),
        name: 'Anthropic (environment)',
        kind: 'anthropic',
        model: 'claude-opus-5-5',
        baseUrl: 'https://llm-gateway.example.org/anthropic',
        apiKey: 'sk-ant-mock-env-000000000000k3Wd',
        source: 'environment',
        usage: {
          last30Days: { requests: 6, failed: 0, inputTokens: 27400, outputTokens: 19800 },
          allTime: { requests: 6, failed: 0, inputTokens: 27400, outputTokens: 19800 },
          lastUsedAt: this.ago(26 * 3600),
        },
        createdAt: null,
        updatedAt: null,
      });
      if (this.options.ai) this.ai.defaultProviderId = envProviderId('anthropic');
    } else if (this.options.ai) {
      const now = this.now();
      const saved: StoredAiProvider = {
        id: uuid(),
        name: 'Personal key',
        kind: 'anthropic',
        model: 'claude-opus-5-5',
        baseUrl: null,
        apiKey: 'sk-ant-mock-0000000000000000x7Qa',
        source: 'settings',
        usage: {
          last30Days: { requests: 14, failed: 1, inputTokens: 61200, outputTokens: 48100 },
          allTime: { requests: 52, failed: 3, inputTokens: 233000, outputTokens: 171500 },
          lastUsedAt: this.ago(2 * 3600),
        },
        createdAt: now,
        updatedAt: now,
      };
      this.ai.providers.push(saved);
      this.ai.defaultProviderId = saved.id;
      // Two more, to show a provider that has not been used lately and one never used.
      this.ai.providers.push(
        {
          id: uuid(),
          name: 'Local Ollama',
          kind: 'openai_compatible',
          model: 'qwen2.5-coder:14b',
          baseUrl: 'http://localhost:11434/v1',
          apiKey: null,
          source: 'settings',
          usage: {
            last30Days: { requests: 0, failed: 0, inputTokens: 0, outputTokens: 0 },
            allTime: { requests: 9, failed: 2, inputTokens: 18400, outputTokens: 12900 },
            lastUsedAt: this.ago(64 * 86400),
          },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: uuid(),
          name: 'Work gateway',
          kind: 'openai_compatible',
          model: 'llama3.1:70b',
          baseUrl: 'https://llm.example.org/v1',
          apiKey: 'sk-mock-00000000000000000000m4Rt',
          source: 'settings',
          usage: noUsage(),
          createdAt: now,
          updatedAt: now,
        },
      );
    }
  }

  // ---- Time and delays ----------------------------------------------------

  /** RFC 3339, UTC, whole seconds — the format the contract shows. */
  now(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** The moment `seconds` ago, in the same format. */
  ago(seconds: number): string {
    return new Date(Date.now() - seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  nextSeq(): number {
    return ++this.seq;
  }

  /** A simulated latency in milliseconds for the given kind of work. */
  delay(kind: DelayKind = 'default'): number {
    if (this.options.speed === 'instant') return 0;
    const [min, max] = DELAYS[this.options.speed][kind];
    return Math.round(min + Math.random() * (max - min));
  }

  // ---- Items --------------------------------------------------------------

  /**
   * Record every tag an item carries. Handlers set items' tags directly, so
   * this runs before and after each request: whichever one put a tag on an
   * item, the tag is kept when its last item drops it, as on the server.
   */
  registerTags(): void {
    for (const item of this.items.values()) for (const t of item.tags) this.tags.add(t);
  }

  getItem(id: string): StoredItem {
    const item = this.items.get(id);
    if (!item) throw notFound('item');
    return item;
  }

  /**
   * Record a change to the item's own content (title, text, tags, source,
   * variant link, anything under `problem`): the revision goes up by one and
   * the modification time moves.
   */
  touch(item: StoredItem): void {
    item.revision += 1;
    item.updatedAt = this.now();
    item.seq = this.nextSeq();
  }

  /**
   * Record a change to the item's test cases, or to its saved solutions
   * other than the reference. They are content for the purpose of
   * `updatedAt`, but they are outside the revision.
   */
  touchCases(item: StoredItem): void {
    item.updatedAt = this.now();
    item.seq = this.nextSeq();
  }

  // ---- Solutions ----------------------------------------------------------

  /** An item's solutions in listing order: the reference first, then oldest first. */
  solutionsOf(itemId: string): StoredSolution[] {
    return this.solutions
      .filter((s) => s.itemId === itemId)
      .sort((a, b) => {
        if (a.isReference !== b.isReference) return a.isReference ? -1 : 1;
        return a.createdAt === b.createdAt ? a.seq - b.seq : a.createdAt < b.createdAt ? -1 : 1;
      });
  }

  getSolution(id: string): StoredSolution {
    const solution = this.solutions.find((s) => s.id === id);
    if (!solution) throw notFound('solution');
    return solution;
  }

  referenceOf(itemId: string): StoredSolution | undefined {
    return this.solutions.find((s) => s.itemId === itemId && s.isReference);
  }

  /** What `problem.referenceSolution` reports for an item. */
  referenceView(itemId: string): (SourceCode & { id: string }) | null {
    const reference = this.referenceOf(itemId);
    return reference ? { id: reference.id, language: reference.language, source: reference.source } : null;
  }

  solutionView(solution: StoredSolution): Solution {
    const view: Solution & { seq?: number } = { ...solution };
    delete view.seq;
    return view;
  }

  /** Remove the reference mark from an item's solutions; the solutions stay. */
  clearReference(itemId: string): void {
    const now = this.now();
    for (const s of this.solutions) {
      if (s.itemId === itemId && s.isReference) {
        s.isReference = false;
        s.updatedAt = now;
      }
    }
  }

  /** Fail with `409 conflict` when the item already holds as many solutions as it may. */
  requireSolutionRoom(itemId: string): void {
    if (this.solutions.filter((s) => s.itemId === itemId).length >= LIMITS.maxSolutionsPerItem) {
      throw conflict(`a problem can keep at most ${LIMITS.maxSolutionsPerItem} solutions`);
    }
  }

  /**
   * Save a new solution. Marking it as the reference clears the mark on the
   * item's others. Does not touch the item; see `recordSolutionChange`.
   */
  insertSolution(itemId: string, fields: SolutionFields, createdAt = this.now()): StoredSolution {
    if (fields.isReference) this.clearReference(itemId);
    const solution: StoredSolution = {
      id: uuid(),
      itemId,
      ...fields,
      createdAt,
      updatedAt: createdAt,
      seq: this.nextSeq(),
    };
    this.solutions.push(solution);
    return solution;
  }

  /**
   * Apply a write to `problem.referenceSolution`: a value updates the
   * reference solution in place, or creates one named "Reference solution"
   * when the item has none (`409` if it cannot hold another); `null` only
   * removes the reference mark. Does not touch the item. Returns whether
   * anything was stored.
   */
  writeReference(itemId: string, value: SourceCode | null): boolean {
    const current = this.referenceOf(itemId);
    if (value === null) {
      if (current) this.clearReference(itemId);
      return current !== undefined;
    }
    if (!current) {
      this.requireSolutionRoom(itemId);
      this.insertSolution(itemId, { name: REFERENCE_SOLUTION_NAME, ...value, notes: '', isReference: true });
      return true;
    }
    if (current.language === value.language && current.source === value.source) return false;
    current.language = value.language;
    current.source = value.source;
    current.updatedAt = this.now();
    return true;
  }

  /**
   * Record a change to an item's solutions, given what
   * `problem.referenceSolution` reported before it. The modification time
   * always moves; the revision goes up only when that view changed — its
   * language or source, or which solution it is.
   */
  recordSolutionChange(item: StoredItem, before: (SourceCode & { id: string }) | null): void {
    if (JSON.stringify(before) !== JSON.stringify(this.referenceView(item.id))) this.touch(item);
    else this.touchCases(item);
  }

  casesOf(itemId: string): TestCase[] {
    return this.testCases.filter((c) => c.itemId === itemId).sort((a, b) => a.position - b.position);
  }

  renumberCases(itemId: string): void {
    this.casesOf(itemId).forEach((c, i) => {
      c.position = i;
    });
  }

  collectionIdsOf(itemId: string): string[] {
    return this.sortedCollections()
      .filter((c) => c.itemIds.includes(itemId))
      .map((c) => c.id);
  }

  /**
   * The verdict of the most recent completed `submit`-mode submission. One
   * that is still being judged does not count.
   */
  lastVerdict(itemId: string): Verdict | null {
    for (let i = this.submissions.length - 1; i >= 0; i--) {
      const s = this.submissions[i]!;
      if (s.itemId === itemId && s.mode === 'submit' && s.status === 'completed' && s.verdict !== null) return s.verdict;
    }
    return null;
  }

  summary(item: StoredItem): ItemSummary {
    let variantCount = 0;
    for (const other of this.items.values()) if (other.variantOf === item.id) variantCount++;
    return {
      id: item.id,
      type: item.type,
      title: item.title,
      summary: item.summary,
      difficulty: item.difficulty,
      tags: [...item.tags],
      status: item.status,
      favorite: item.favorite,
      collectionIds: this.collectionIdsOf(item.id),
      variantOf: item.variantOf,
      variantCount,
      testCaseCount: item.type === 'problem' ? this.testCases.filter((c) => c.itemId === item.id).length : 0,
      solutionCount: item.type === 'problem' ? this.solutions.filter((s) => s.itemId === item.id).length : 0,
      lastVerdict: item.type === 'problem' ? this.lastVerdict(item.id) : null,
      revision: item.revision,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  full(item: StoredItem): Item {
    return {
      ...this.summary(item),
      body: item.body,
      notes: item.notes,
      rawInput: item.rawInput,
      source: { ...item.source },
      problem: item.problem
        ? { ...structuredClone(item.problem), referenceSolution: this.referenceView(item.id) }
        : null,
    };
  }

  /**
   * Remove an item's completed runs. Only the latest run is kept; one still
   * being judged is left for the next run to remove.
   */
  deleteCompletedRuns(itemId: string): void {
    this.submissions = this.submissions.filter((s) => s.itemId !== itemId || s.mode !== 'run' || s.status !== 'completed');
  }

  deleteItem(id: string): void {
    if (!this.items.delete(id)) return;
    for (const c of this.testCases) if (c.itemId === id) this.truth.delete(c.id);
    this.testCases = this.testCases.filter((c) => c.itemId !== id);
    this.solutions = this.solutions.filter((s) => s.itemId !== id);
    this.submissions = this.submissions.filter((s) => s.itemId !== id);
    for (const c of this.collections) c.itemIds = c.itemIds.filter((x) => x !== id);
    for (const other of this.items.values()) {
      if (other.variantOf === id) {
        other.variantOf = null;
        this.touch(other);
      }
    }
  }

  // ---- Collections --------------------------------------------------------

  getCollection(id: string): StoredCollection {
    const c = this.collections.find((x) => x.id === id);
    if (!c) throw notFound('collection');
    return c;
  }

  siblings(parentId: string | null): StoredCollection[] {
    return this.collections.filter((c) => c.parentId === parentId).sort((a, b) => a.position - b.position);
  }

  renumberSiblings(parentId: string | null): void {
    this.siblings(parentId).forEach((c, i) => {
      c.position = i;
    });
  }

  /** Root collections first, then the rest grouped by parent; by position within a group. */
  sortedCollections(): StoredCollection[] {
    return [...this.collections].sort((a, b) => {
      if (a.parentId !== b.parentId) {
        if (a.parentId === null) return -1;
        if (b.parentId === null) return 1;
        return a.parentId < b.parentId ? -1 : 1;
      }
      return a.position - b.position;
    });
  }

  /** Ids of every collection below `id`, not including `id` itself. */
  descendants(id: string): string[] {
    const out: string[] = [];
    const walk = (parent: string) => {
      for (const child of this.siblings(parent)) {
        out.push(child.id);
        walk(child.id);
      }
    };
    walk(id);
    return out;
  }

  collectionView(c: StoredCollection): Collection {
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      parentId: c.parentId,
      position: c.position,
      itemCount: c.itemIds.length,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  // ---- AI settings and capabilities ---------------------------------------

  getProvider(id: string): StoredAiProvider {
    const provider = this.ai.providers.find((p) => p.id === id);
    if (!provider) throw notFound('AI provider');
    return provider;
  }

  /** The model a provider uses: its own, else the kind's default. */
  modelOf(p: StoredAiProvider): string | null {
    return p.model ?? AI_KINDS[p.kind].defaultModel;
  }

  baseUrlOf(p: StoredAiProvider): string {
    return p.baseUrl ?? AI_KINDS[p.kind].defaultBaseUrl;
  }

  /** Whether a provider has everything it needs, counting the kind's defaults. */
  isReady(p: StoredAiProvider): boolean {
    return this.modelOf(p) !== null && (p.apiKey !== null || !keyNeeded(p.kind, this.baseUrlOf(p)));
  }

  providerView(p: StoredAiProvider): AiProvider {
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      model: p.model,
      baseUrl: p.baseUrl,
      apiKeySet: p.apiKey !== null,
      apiKeyHint: p.apiKey !== null ? `…${p.apiKey.slice(-4)}` : null,
      source: p.source,
      isDefault: p.id === this.ai.defaultProviderId,
      ready: this.isReady(p),
      usage: structuredClone(p.usage),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  /** The default first, then saved providers by name ignoring case, then environment providers. */
  aiSettings(): AiSettings {
    const rank = (p: StoredAiProvider) => (p.id === this.ai.defaultProviderId ? 0 : p.source === 'settings' ? 1 : 2);
    const providers = [...this.ai.providers].sort(
      (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
    );
    return {
      defaultProviderId: this.ai.defaultProviderId,
      timeoutSeconds: this.ai.timeoutSeconds ?? DEFAULT_AI_TIMEOUT_SECONDS,
      defaultTimeoutSeconds: DEFAULT_AI_TIMEOUT_SECONDS,
      providers: providers.map((p) => this.providerView(p)),
      kinds: structuredClone(AI_KINDS),
    };
  }

  /** The provider the AI endpoints use: the default, when it is ready. */
  get activeProvider(): StoredAiProvider | null {
    const chosen = this.ai.providers.find((p) => p.id === this.ai.defaultProviderId);
    return chosen && this.isReady(chosen) ? chosen : null;
  }

  /**
   * Count one request sent to a provider's service. A failed one returned no
   * usable answer; a request without token figures adds nothing to the sums.
   */
  recordUsage(p: StoredAiProvider, request: { failed?: boolean; inputTokens?: number | null; outputTokens?: number | null }): void {
    for (const totals of [p.usage.last30Days, p.usage.allTime]) {
      totals.requests += 1;
      if (request.failed) totals.failed += 1;
      totals.inputTokens += request.inputTokens ?? 0;
      totals.outputTokens += request.outputTokens ?? 0;
    }
    p.usage.lastUsedAt = this.now();
  }

  /**
   * Write down one request sent to a provider's service: an entry in the
   * activity log, and its part in the provider's usage. Anything but `ok`
   * returned no usable answer. Returns the id of the entry.
   */
  logRequest(
    p: StoredAiProvider,
    request: Pick<AiLogDetail, 'operation' | 'itemId' | 'title' | 'status' | 'error' | 'durationMs' | 'usage' | 'request' | 'response'> & { model?: string | null },
  ): string {
    const { model, ...rest } = request;
    this.recordUsage(p, { failed: rest.status !== 'ok', inputTokens: rest.usage.inputTokens, outputTokens: rest.usage.outputTokens });
    const id = uuid();
    this.aiLog.push({ seq: this.nextSeq(), id, createdAt: this.now(), providerId: p.id, providerName: p.name, kind: p.kind, model: model ?? this.modelOf(p) ?? '', truncated: false, ...rest });
    return id;
  }

  /** An entry as the list shows it: without what was sent and what came back. */
  logEntryView(entry: StoredLogEntry): AiLogEntry {
    const { seq: _seq, request: _request, response: _response, truncated: _truncated, ...summary } = entry;
    return structuredClone(summary);
  }

  /** An entry with its raw request and response. */
  logDetailView(entry: StoredLogEntry): AiLogDetail {
    const { seq: _seq, ...detail } = entry;
    return structuredClone(detail);
  }

  get aiEnabled(): boolean {
    return this.activeProvider !== null;
  }

  get judgeLanguages(): JudgeLanguage[] {
    return this.options.judge === 'none' ? [] : JUDGE_LANGUAGES.map((l) => ({ ...l }));
  }

  meta(): Meta {
    const active = this.activeProvider;
    const judge = this.options.judge;
    return {
      version: '0.1.0-mock',
      ai: {
        enabled: active !== null,
        providerId: active?.id ?? null,
        providerName: active?.name ?? null,
        kind: active?.kind ?? null,
        model: active ? this.modelOf(active) : null,
      },
      judge: {
        enabled: judge !== 'none',
        engine: judge === 'none' ? 'none' : 'judge0',
        healthy: judge === 'ok',
        languages: this.judgeLanguages,
      },
      mcp: {
        enabled: this.options.mcp !== 'off',
        path: '/mcp',
        url: this.options.publicUrl ? PUBLIC_MCP_URL : null,
        authRequired: this.options.mcp === 'token',
      },
      limits: structuredClone(LIMITS),
    };
  }
}

/** The origin (scheme, host and port) of a URL, or `null` when it is not one. */
export function originOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export const sameOrigin = (a: string | null, b: string | null): boolean => originOf(a) === originOf(b);

/**
 * Whether a provider of this kind needs an API key at this base URL. A key
 * is optional for an OpenAI-compatible endpoint (local servers), but not for
 * the default one, which is OpenAI itself.
 */
export function keyNeeded(kind: AiProviderKind, baseUrl: string): boolean {
  return AI_KINDS[kind].keyRequired || sameOrigin(baseUrl, AI_KINDS[kind].defaultBaseUrl);
}

/** Line endings as the server stores them in every text field: `\r\n` and lone `\r` become `\n`. */
export function normaliseText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Length as the server counts it: in Unicode code points. */
export function charCount(text: string): number {
  return [...text].length;
}

const encoder = new TextEncoder();
export const byteLength = (text: string): number => encoder.encode(text).length;

// eslint-disable-next-line no-control-regex
const TAG_FORBIDDEN = /[/\u0000-\u001F\u007F-\u009F]/;

/** Why the server would reject a (normalised) tag, in its own words, or `null`. */
export function tagProblem(tag: string): string | null {
  if (TAG_FORBIDDEN.test(tag)) return 'must not contain / or control characters';
  if (charCount(tag) > LIMITS.maxTagChars) return `must be 1-${LIMITS.maxTagChars} characters`;
  return null;
}

/** Lower-case, trim, de-duplicate and sort, as the server does. */
export function normaliseTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t !== ''))].sort();
}

/** Whether two outputs are equal under a compare mode (docs/api.md, `CompareMode`). */
export function outputsMatch(a: string, b: string, mode: 'tokens' | 'exact'): boolean {
  if (mode === 'tokens') {
    const tokens = (s: string) => s.split(/\s+/).filter(Boolean).join(' ');
    return tokens(a) === tokens(b);
  }
  const strip = (s: string) =>
    s
      .split('\n')
      .map((line) => line.replace(/[ \t\r]+$/, ''))
      .join('\n')
      .replace(/\n+$/, '');
  return strip(a) === strip(b);
}
