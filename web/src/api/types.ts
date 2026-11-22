// Types for the HTTP API described in docs/api.md. Keep this file in step
// with that document: it is the contract between the server and the UI.

export type ItemType = 'problem' | 'reading';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type ItemStatus = 'todo' | 'in_progress' | 'done';
/**
 * What the person solving a problem writes. `program`: a complete program
 * reading stdin and writing stdout. `function`: only the solution — a
 * function or a class — which a hidden per-language harness turns into such
 * a program.
 */
export type ProblemInterface = 'program' | 'function';
export type CompareMode = 'tokens' | 'exact';
export type TestOrigin = 'manual' | 'ai' | 'import';
export type SubmissionMode = 'run' | 'submit';
export type SubmissionStatus = 'queued' | 'running' | 'completed';
export type Verdict =
  | 'accepted'
  | 'wrong_answer'
  | 'time_limit_exceeded'
  | 'memory_limit_exceeded'
  | 'runtime_error'
  | 'compile_error'
  | 'internal_error'
  | 'executed';

export const ITEM_STATUSES: readonly ItemStatus[] = ['todo', 'in_progress', 'done'];

export type ErrorCode =
  | 'bad_request'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'validation_failed'
  | 'upstream_error'
  | 'ai_unavailable'
  | 'judge_unavailable'
  | 'internal'
  | 'unauthorized'
  | 'rate_limited';

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Per-field messages for `validation_failed`; `{ revision }` for a revision conflict. */
    fields?: Record<string, string | number>;
  };
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface List<T> {
  items: T[];
}

// ---- Meta -----------------------------------------------------------------

export interface JudgeLanguage {
  id: string;
  name: string;
  version: string;
}

export type AiProviderKind = 'anthropic' | 'gemini' | 'openai_compatible';

export interface Meta {
  version: string;
  /** The default AI provider when AI features are switched on and it is ready; otherwise `enabled` is `false` and the rest is `null`. `model` is the one in effect. */
  ai: { enabled: boolean; providerId: string | null; providerName: string | null; kind: AiProviderKind | null; model: string | null };
  judge: { enabled: boolean; engine: string; healthy: boolean; languages: JudgeLanguage[] };
  /** `url` is the public MCP URL when the operator configured one; otherwise derive it from the page origin and `path`. */
  mcp: { enabled: boolean; path: string; url: string | null; authRequired: boolean };
  limits: Limits;
}

/** `GET /health/ready`: `503` with `status: 'unavailable'` while the database is down. The judge never makes it unavailable. */
export interface Readiness {
  status: 'ok' | 'unavailable';
  database: 'ok' | 'down';
  judge: 'ok' | 'down' | 'none';
}

export interface Range {
  min: number;
  max: number;
}

/** Every bound the server enforces on user input. Forms validate against these, never against copies. */
export interface Limits {
  maxImportBytes: number;
  /** Bounds on the contents of an uploaded bundle; beyond them the server answers `413`. */
  maxImportUncompressedBytes: number;
  maxImportEntries: number;
  maxImportCollections: number;
  /** Largest JSON request body. */
  maxRequestBytes: number;
  /** Largest `limit` of a paginated list. */
  maxPageSize: number;
  maxSourceBytes: number;
  maxTitleChars: number;
  maxSummaryChars: number;
  /** Applies to each of an item's `body`, `notes` and `rawInput`. */
  maxTextBytes: number;
  maxSourceUrlChars: number;
  maxSourceNoteChars: number;
  maxTags: number;
  maxTagChars: number;
  maxCollectionNameChars: number;
  maxCollectionDescriptionChars: number;
  timeLimitMs: Range;
  memoryLimitKb: Range;
  maxTestCasesPerItem: number;
  /** Applies to each of a test case's `stdin` and `expectedStdout`, and to the custom stdin of a run. */
  maxTestDataBytes: number;
  maxTestCaseNameChars: number;
  maxDraftTextChars: number;
  /** Cap on the free-form `instruction` of every AI request. */
  maxInstructionChars: number;
  /** Size of the `previousDraft` sent with a revision, as JSON. */
  maxPreviousDraftBytes: number;
  /** Upper bound of `count` when asking for generated test cases. */
  maxGeneratedTestCases: number;
  /** The largest input a generated large test case may have. */
  maxLargeInputBytes: number;
  /** Upper bound of `largeTestCases` in a generation. */
  maxLargeTestCases: number;
  maxStylePresets: number;
  maxStyleNameChars: number;
  maxStyleInstructionsChars: number;
  /** Length of a custom system prompt, in code points after trimming. */
  maxSystemPromptChars: number;
  maxModelIdChars: number;
  maxApiKeyChars: number;
  /** Saved AI providers per instance; environment providers do not count. */
  maxAiProviders: number;
  maxAiProviderNameChars: number;
  /** Bounds of the AI request timeout (`AiSettings.timeoutSeconds`) when it is set. */
  minAiTimeoutSeconds: number;
  maxAiTimeoutSeconds: number;
  /** Applies to an export's `name` and `author`. */
  maxBundleNameChars: number;
  maxBundleDescriptionChars: number;
  maxSolutionsPerItem: number;
  maxSolutionNameChars: number;
  maxSolutionNotesChars: number;
  /**
   * An item's `notes`, in code points after line endings are normalised. Set by
   * the operator; checked only when the notes change, so longer notes saved
   * under a higher limit still load.
   */
  maxNotesChars: number;
  /** How many items one item can be linked to, unavailable ones included. */
  maxLinksPerItem: number;
}

export interface Stats {
  items: {
    total: number;
    byType: Record<ItemType, number>;
    byStatus: Record<ItemStatus, number>;
    byDifficulty: Record<Difficulty | 'none', number>;
    /** What the Favorites view lists: `GET /items?favorite=true`. */
    favorites: number;
    /** Items in no collection: `GET /items?uncollected=true`. */
    uncollected: number;
  };
  collections: number;
  tags: number;
  submissions: { total: number; accepted: number };
}

/**
 * `GET /items/facets`: how many items with each value a filtered list shows
 * once the value is picked. Types, statuses and difficulties are counted
 * without their own filter; tags with every filter (they combine with AND), and only
 * the tags the counted items carry are present.
 */
export interface ItemFacets {
  byType: Record<ItemType, number>;
  byStatus: Record<ItemStatus, number>;
  byDifficulty: Record<Difficulty | 'none', number>;
  byTag: Record<string, number>;
}

// ---- Items ----------------------------------------------------------------

export interface SourceCode {
  language: string;
  source: string;
}

/** The hidden code around a submitted solution: the program that runs is `prefix`, the source and `suffix`, each starting on a new line. */
export interface HarnessCode {
  prefix: string;
  suffix: string;
}

export interface ProblemSpec {
  interface: ProblemInterface;
  timeLimitMs: number;
  memoryLimitKb: number;
  compare: CompareMode;
  /** Keyed by language id. For a `function` problem, the stub the solver starts from. */
  starterCode: Record<string, string>;
  /**
   * Keyed by language id; `{}` for a `program` problem. A `function` problem
   * can be run in exactly the languages that have an entry.
   */
  harness: Record<string, HarnessCode>;
  /**
   * A view of the saved solution marked as the reference, or `null`. When
   * read it carries that solution's `id`; when written only `language` and
   * `source` count (the reference solution is updated in place, or created),
   * and `null` removes the mark without deleting the solution.
   */
  referenceSolution: (SourceCode & { id?: string }) | null;
}

export interface ItemSource {
  url: string | null;
  note: string | null;
}

export interface ItemSummary {
  id: string;
  type: ItemType;
  title: string;
  summary: string;
  difficulty: Difficulty | null;
  tags: string[];
  status: ItemStatus;
  favorite: boolean;
  collectionIds: string[];
  variantOf: string | null;
  variantCount: number;
  /** How many items this one is linked to, dead links included. */
  linkCount: number;
  testCaseCount: number;
  /** How many solutions are saved for the item; `0` for readings. */
  solutionCount: number;
  lastVerdict: Verdict | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface Item extends ItemSummary {
  body: string;
  notes: string;
  rawInput: string | null;
  source: ItemSource;
  problem: ProblemSpec | null;
  /** What `variantOf` points at, alive or not; `null` exactly when `variantOf` is. */
  variantOrigin: LinkedItem | null;
  /** Who created the item; `null` (or missing) for items older than the record. Never sent by the client. */
  createdBy?: ChangeSource | null;
  /** Who last changed its content; `null` (or missing) as for `createdBy`. Never sent by the client. */
  lastUpdatedBy?: ChangeSource | null;
}

/** How a change reached the server. */
export type ChangeVia = 'http' | 'mcp' | 'import';

/**
 * Who made a change to an item. `client` and `model` are reported by the
 * client (at most 200 characters): plain text, never markup.
 */
export interface ChangeSource {
  via: ChangeVia;
  /** The MCP client's name; `null` for `http` and `import`. */
  client: string | null;
  /** The model that made the change, when known (an AI draft saved in the UI is `http` with its model). */
  model: string | null;
}

/**
 * Another item as a link shows it. A dead one (`available: false`) is no
 * longer in the library: `title` and `type` are the last known ones, or
 * `null` when it was never here (it came with an import), and `status` and
 * `difficulty` are `null`.
 */
export interface LinkedItem {
  id: string;
  available: boolean;
  title: string | null;
  type: ItemType | null;
  status: ItemStatus | null;
  difficulty: Difficulty | null;
  /** When the link was made; `null` in a `variantOrigin`. */
  linkedAt: string | null;
}

/** `GET /items/{id}/links`: live links first, then dead ones; oldest first within each. */
export interface ItemLinks {
  links: LinkedItem[];
}

export interface TestCaseInput {
  name?: string;
  /**
   * On create, sent with `generator` both are stored as given; `generator`
   * alone is run for it. On PATCH, set without `generator` on a case that
   * has one, it drops the generator; with a non-null one it is a `422`.
   */
  stdin?: string;
  expectedStdout: string;
  isSample?: boolean;
  origin?: TestOrigin;
  verified?: boolean;
  /**
   * The program that prints the case's `stdin`, up to
   * `limits.maxLargeInputBytes`. Given without `stdin` it is run (on PATCH,
   * replacing `stdin`); `null` drops it and keeps `stdin`.
   */
  generator?: SourceCode | null;
}

/** Body of `POST /items`. Only `type` and `title` are required. */
export interface ItemInput {
  type: ItemType;
  title: string;
  summary?: string;
  body?: string;
  difficulty?: Difficulty | null;
  tags?: string[];
  status?: ItemStatus;
  favorite?: boolean;
  notes?: string;
  rawInput?: string | null;
  source?: Partial<ItemSource>;
  problem?: Partial<ProblemSpec> | null;
  collectionIds?: string[];
  variantOf?: string | null;
  testCases?: TestCaseInput[];
}

/**
 * Body of `POST /items/check`: the problem and test cases of an item not
 * saved yet. Other keys of an `ItemInput` are accepted and ignored.
 */
export interface ItemCheckRequest {
  problem: Partial<ProblemSpec>;
  testCases: TestCaseInput[];
}

/**
 * What became of one test case in `POST /items/check`. `passed`: verified.
 * `wrong`: it ran and printed something else. `failed`: the reference
 * solution did not compile, crashed or exceeded a limit on it. `not_run`:
 * the check did not get to it.
 */
export type CheckOutcome = 'passed' | 'wrong' | 'failed' | 'not_run';

export interface CheckedCase {
  outcome: CheckOutcome;
  /** Why, for `failed` and `not_run`; `null` otherwise. */
  error: string | null;
}

/** What running the reference solution of an unsaved problem on its test cases found. */
export interface ItemCheckResponse {
  /** As for a draft; every case is run, and `largeCases` is always `[]`. */
  check: DraftCheck;
  /** One entry per test case, in order. */
  cases: CheckedCase[];
}

/** Body of `PATCH /items/{id}`. */
export type ItemPatch = Partial<Omit<ItemInput, 'type' | 'testCases'>> & {
  expectedRevision?: number;
};

export type ItemSort = 'updated' | 'created' | 'title' | 'difficulty' | 'position' | 'relevance';
export type SortOrder = 'asc' | 'desc';

export interface ItemListParams {
  q?: string;
  type?: ItemType;
  status?: ItemStatus[];
  difficulty?: (Difficulty | 'none')[];
  tag?: string[];
  /** Fetch specific items; unknown ids are ignored. */
  id?: string[];
  collectionId?: string;
  recursive?: boolean;
  uncollected?: boolean;
  variantOf?: string;
  favorite?: boolean;
  sort?: ItemSort;
  order?: SortOrder;
  limit?: number;
  offset?: number;
}

export interface TextEditsRequest {
  field: 'body' | 'notes';
  expectedRevision?: number;
  edits: { oldText: string; newText: string }[];
}

export type BulkAction =
  | { action: 'delete' }
  | { action: 'addTags' | 'removeTags'; tags: string[] }
  | { action: 'setStatus'; status: ItemStatus }
  | { action: 'setFavorite'; favorite: boolean }
  | { action: 'addToCollection' | 'removeFromCollection'; collectionId: string };

export type BulkRequest = { ids: string[] } & BulkAction;

// ---- Test cases -----------------------------------------------------------

export interface TestCase {
  id: string;
  itemId: string;
  position: number;
  name: string;
  stdin: string;
  expectedStdout: string;
  isSample: boolean;
  origin: TestOrigin;
  verified: boolean;
  /** The program that printed `stdin`, for a large case; `null` otherwise. */
  generator: SourceCode | null;
  createdAt: string;
  updatedAt: string;
}

export interface BulkTestCasesRequest {
  cases: TestCaseInput[];
  replace?: boolean;
  referenceSolution?: SourceCode | null;
  /** Checked like on `PATCH /items/{id}`; relevant when a reference solution is stored. */
  expectedRevision?: number;
}

export interface VerifyResult {
  testCaseId: string;
  ok: boolean;
  matches: boolean;
  actualStdout: string;
  verdict: Verdict;
  stderr: string;
  /** What the engine measured for the case; `null` when it measured nothing (a compile error). */
  timeMs: number | null;
  memoryKb: number | null;
}

// ---- Solutions --------------------------------------------------------------

/** A saved solution to a problem. At most one per item is the reference solution. */
export interface Solution {
  id: string;
  itemId: string;
  name: string;
  language: string;
  source: string;
  /** Markdown. */
  notes: string;
  isReference: boolean;
  createdAt: string;
  updatedAt: string;
  /** The latest run of this code on the test cases; `null` until it runs after its code last changed. */
  lastRun: SolutionRun | null;
}

/** A run of a saved solution on the test cases, as the server measured it. */
export interface SolutionRun {
  passed: number;
  total: number;
  /** The slowest case; `null` when the judge measured nothing. */
  timeMs: number | null;
  /** The peak over the cases; `null` when the judge measured nothing. */
  memoryKb: number | null;
  ranAt: string;
}

export interface SolutionInput {
  name: string;
  language: string;
  source: string;
  notes?: string;
  isReference?: boolean;
  /**
   * Checked like on `PATCH /items/{id}`. Relevant when the write changes the
   * reference solution (its language or source, or which solution it is),
   * because that is item content.
   */
  expectedRevision?: number;
  /**
   * Create only: the submission the code comes from. When it judged exactly
   * this code, its figures become the new solution's `lastRun`; otherwise it
   * is ignored.
   */
  submissionId?: string;
}

export type SolutionPatch = Partial<Omit<SolutionInput, 'submissionId'>>;

// ---- Working copies -----------------------------------------------------------

/**
 * The code being written on a problem in one language, kept on the server.
 * Personal work in progress: not a solution, never exported, and writing it
 * changes neither the item's revision nor its `updatedAt`.
 */
export interface WorkingCopy {
  language: string;
  source: string;
  updatedAt: string;
}

/** `PUT /items/{id}/workspace/{language}`. `source` may be empty. */
export interface WorkingCopyInput {
  source: string;
}

// ---- Collections and tags -------------------------------------------------

export interface Collection {
  id: string;
  name: string;
  description: string;
  parentId: string | null;
  position: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionCreate {
  name: string;
  description?: string;
  parentId?: string | null;
}

export interface CollectionPatch {
  name?: string;
  description?: string;
  parentId?: string | null;
  position?: number;
}

export interface Tag {
  name: string;
  count: number;
}

// ---- Submissions ----------------------------------------------------------

export interface SubmissionResult {
  testCaseId: string | null;
  name: string;
  isSample: boolean;
  verdict: Verdict;
  stdin: string;
  expectedStdout: string | null;
  stdout: string;
  stderr: string;
  timeMs: number;
  memoryKb: number;
}

export interface SubmissionSummary {
  id: string;
  itemId: string;
  mode: SubmissionMode;
  language: string;
  status: SubmissionStatus;
  verdict: Verdict | null;
  passedCount: number;
  totalCount: number;
  timeMs: number | null;
  memoryKb: number | null;
  error: string | null;
  /**
   * How many lines the harness placed before the submitted source in the
   * program that ran; `0` for a `program` problem. The server rewrites line
   * numbers in compiler and error output to the source's own lines where it
   * can, and this explains one it could not.
   */
  lineOffset: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface Submission extends SubmissionSummary {
  source: string;
  compileOutput: string;
  results: SubmissionResult[];
}

export interface SubmissionRequest {
  language: string;
  source: string;
  mode: SubmissionMode;
  stdin: string | null;
}

// ---- AI -------------------------------------------------------------------

export interface DraftTestCase {
  name: string;
  stdin: string;
  expectedStdout: string;
  isSample: boolean;
  /** The draft's reference solution was run on this case and printed the expected output. */
  verified: boolean;
  /** The program that printed `stdin`, for a large case; `null` otherwise. */
  generator: SourceCode | null;
}

export interface DraftProblemSpec {
  interface: ProblemInterface;
  timeLimitMs: number;
  memoryLimitKb: number;
  compare: CompareMode;
  starterCode: Record<string, string>;
  harness: Record<string, HarnessCode>;
  /** The model's own solution, or `null` if it gave none. For a `function` problem, the solution part only. */
  referenceSolution: SourceCode | null;
}

export interface ItemDraft {
  type: ItemType;
  title: string;
  summary: string;
  body: string;
  difficulty: Difficulty | null;
  tags: string[];
  problem: DraftProblemSpec | null;
  testCases: DraftTestCase[];
  assumptions: string[];
}

/** Which interface a drafted problem should have; with `auto` the model chooses. */
export type InterfaceHint = 'auto' | ProblemInterface;

export interface DraftRequest {
  text: string;
  typeHint?: 'auto' | ItemType;
  interfaceHint?: InterfaceHint;
  /** At most `limits.maxInstructionChars` characters. */
  instruction?: string | null;
  previousDraft?: ItemDraft | null;
  /** Omitted → the default preset; `null` → built-in conventions only; an id → that preset. */
  styleId?: string | null;
  /** Also build that many large test cases, 0 to `limits.maxLargeTestCases`. Ignored for a reading. */
  largeTestCases?: number;
  /**
   * How many ordinary test cases the draft has at least, 0 to `limits.maxGeneratedTestCases`:
   * hidden ones fill up to this after the samples of its examples, and none is ever removed,
   * on a revision either. Omitted or 0 → the samples only. Large test cases come on top.
   * Ignored for a reading.
   */
  testCaseCount?: number;
  /** The provider to use instead of the default; it must be `ready`. Omitted or `null` → the default. */
  providerId?: string | null;
}

/** The style preset a generation was actually written in. */
export interface AppliedStyle {
  id: string;
  name: string;
}

/** What running a draft's reference solution on its test cases found. */
export interface DraftCheck {
  /** `false` when there was no engine, no reference solution or no test case; nothing is verified then. */
  attempted: boolean;
  engine: string | null;
  passed: number;
  total: number;
  /** The first failure in plain words, or why the engine could not be used. */
  error: string | null;
  /** One entry per harness language of a `function` problem, in language order; `[]` otherwise and when nothing was attempted. */
  runners: RunnerCheck[];
  /** What became of each large test case asked for, in order; `[]` when none was. */
  largeCases: LargeCaseReport[];
}

/**
 * One large test case of a generation: its input printed by a generator
 * program the model wrote, its expected output by the reference solution.
 * `failed` and `skipped` add nothing; `error` then says why.
 */
export interface LargeCaseReport {
  status: 'added' | 'failed' | 'skipped';
  error: string | null;
  /** Where the case is in `draft.testCases` or `cases`; `null` unless `added`. */
  index: number | null;
  /** `null` for a generator the model did not write. */
  name: string | null;
  /** `null` when that point was not reached. */
  inputBytes: number | null;
  /** How long the reference solution took on the input. */
  timeMs: number | null;
  /** The program the model wrote; an added case carries it too. */
  generator: SourceCode | null;
}

/**
 * Whether a language's harness ran its starter code on the first test case:
 * `failed` when it did not compile or crashed, `skipped` when it was not tried.
 */
export interface RunnerCheck {
  language: string;
  status: 'ok' | 'failed' | 'skipped';
  error: string | null;
}

/** Token counts of one request; each is `null` when the provider does not report it. */
export interface TokenUsage {
  inputTokens: number | null;
  /** Everything generated, reasoning included. */
  outputTokens: number | null;
  reasoningTokens: number | null;
  /** Input tokens served from, and written to, the provider's prompt cache, on top of `inputTokens`. */
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

/** What one generation cost, as the provider reported it. */
export interface GenerationUsage extends TokenUsage {
  /** Its entry in the AI activity log, or `null` if none could be written. */
  logId: string | null;
  model: string;
  durationMs: number;
}

/** The result of a draft or variant generation, also written into its draft. */
export interface DraftResponse {
  draft: ItemDraft;
  style: AppliedStyle | null;
  /** `null` for a reading. */
  check: DraftCheck | null;
  usage: GenerationUsage;
}

export type VariantMode = 'similar' | 'easier' | 'harder' | 'twist';

export interface VariantRequest {
  mode?: VariantMode;
  instruction?: string | null;
  /** A draft returned by an earlier variant call; with `instruction` this asks for a revision of it. */
  previousDraft?: ItemDraft | null;
  styleId?: string | null;
  /** Omitted → the variant keeps the original's interface. */
  interfaceHint?: ProblemInterface;
  largeTestCases?: number;
  /** As in `DraftRequest`. */
  testCaseCount?: number;
  /** The provider to use instead of the default; it must be `ready`. Omitted or `null` → the default. */
  providerId?: string | null;
}

export interface AiTestCasesRequest {
  count?: number;
  /** Language of the reference solution. For a `function` problem it must have a harness. */
  language?: string;
  instruction?: string | null;
  /** Also build that many large test cases, in addition to the `count` cases. */
  largeTestCases?: number;
  /** The provider to use instead of the default; it must be `ready`. Omitted or `null` → the default. */
  providerId?: string | null;
  /** Kept on the job as it is: the screen to go back to for the result. */
  origin?: string | null;
}

export interface ProposedTestCase {
  name: string;
  rationale: string;
  stdin: string;
  expectedStdout: string;
  /** `null` for a large test case, whose input the model has not seen. */
  predictedStdout: string | null;
  isSample: boolean;
  verified: boolean;
  predictionMatched: boolean | null;
  error: string | null;
  /** The program that printed `stdin`, for a large case; `null` otherwise. */
  generator: SourceCode | null;
}

export interface AiTestCasesResponse {
  referenceSolution: SourceCode;
  verification: { attempted: boolean; engine: string | null; error: string | null };
  /** Proposed cases left out because their input repeated an existing or an earlier proposed one. */
  duplicatesDropped: number;
  /** One entry per large test case asked for, in order; `[]` when none was. */
  largeCases: LargeCaseReport[];
  usage: GenerationUsage;
  cases: ProposedTestCase[];
}

/** A sample test case of a problem whose code is generated. */
export interface CodeSample {
  stdin: string;
  expectedStdout: string;
}

/** Body of `POST /ai/code`: a problem as it stands in an editor, saved or not. */
export interface AiCodeRequest {
  /** The saved item the problem is, if any; it only labels the request in the AI log. */
  itemId?: string | null;
  title: string;
  body: string;
  interface: ProblemInterface;
  /** Code is written for these languages and no others. */
  languages: string[];
  /** The first is what a "solution only" problem's runners are checked on. */
  samples?: CodeSample[];
  /** Omitted → the default preset; `null` → built-in conventions only; an id → that preset. */
  styleId?: string | null;
  providerId?: string | null;
  /** Kept on the job as it is: the screen to go back to for the result. */
  origin?: string | null;
}

/** Whether each generated runner ran its stub on the first sample. */
export interface CodeCheck {
  /** `false` without a judge engine or a sample. */
  attempted: boolean;
  engine: string | null;
  runners: RunnerCheck[];
}

export interface AiCodeResponse {
  /** Only languages that were asked for; one the model wrote nothing usable for is missing. */
  starterCode: Record<string, string>;
  /** The same languages for a `function` problem, `{}` for a `program` problem. */
  harness: Record<string, HarnessCode>;
  /** `null` for a `program` problem. */
  check: CodeCheck | null;
  style: AppliedStyle | null;
  usage: GenerationUsage;
}

// ---- AI jobs -------------------------------------------------------------

export type AiJobKind = 'draft' | 'variant' | 'testcases' | 'code';
export type AiJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Why a job failed: an error body's `error`. `interrupted`: the server restarted while it ran. */
export interface AiJobError {
  code: ErrorCode | 'interrupted';
  message: string;
  fields?: Record<string, string | number>;
}

/** One AI generation running on the server, or finished there. */
export interface AiJob {
  id: string;
  kind: AiJobKind;
  /** The problem of `testcases`, the original of `variant`, the `itemId` of a `code` request; else `null`. */
  itemId: string | null;
  /** The draft a `draft` or `variant` job generates for; `null` for the other kinds. */
  draftId: string | null;
  /** A short label for lists, fixed by the server. */
  title: string;
  status: AiJobStatus;
  /** The `origin` the starting request gave, unchanged. */
  origin: string | null;
  /** Set for `failed` only. */
  error: AiJobError | null;
  /** Whether the client has collected the outcome. */
  pickedUp: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** A job with the body it was started with and, once `succeeded`, its result. */
export interface AiJobDetail<R = unknown> extends AiJob {
  request: unknown;
  result: R | null;
}

export interface AiJobListParams {
  /** `true`: only queued and running jobs. */
  active?: boolean;
  kind?: AiJobKind;
  itemId?: string;
  draftId?: string;
  /** `false` by default: only jobs whose outcome has not been collected. */
  pickedUp?: boolean;
  /** Default 50, at most 200. */
  limit?: number;
}

// ---- Drafts ---------------------------------------------------------------

export type DraftKind = 'capture' | 'variant';
export type DraftState = 'new' | 'drafting' | 'ready' | 'edited' | 'failed';

/** A new item in progress, kept on the server until it is saved or deleted. */
export interface Draft<C = Record<string, unknown>> {
  id: string;
  kind: DraftKind;
  /** The original of a `variant` draft (which may have been deleted since); `null` for `capture`. */
  variantOf: string | null;
  /** A label for lists, derived by the server. */
  title: string;
  state: DraftState;
  /** Increases by one on every change, the server's included. */
  revision: number;
  /** Whether the user has changed `content` since it was built from a generation. */
  edited: boolean;
  /** The body of the latest generation request, as sent. */
  request: DraftRequest | VariantRequest | null;
  /** The latest generation's job; `null` when there was none or the server no longer has it. */
  job: AiJob | null;
  /** Why the latest generation failed. */
  error: AiJobError | null;
  /** The result of the latest generation that succeeded. */
  generation: DraftResponse | null;
  /** How many generations have succeeded. */
  generationSeq: number;
  /** The client's own document, stored as it is. */
  content: C | null;
  /** The `generationSeq` the content was built from (0 for content written by hand). */
  basedOn: number;
  createdAt: string;
  updatedAt: string;
}

export type DraftSummary = Omit<Draft, 'request' | 'generation' | 'content'>;

export interface DraftCreate {
  kind: DraftKind;
  /** Required for a `variant` draft. */
  variantOf?: string | null;
  content?: Record<string, unknown> | null;
  title?: string | null;
  /** Start a generation at once: a draft request for `capture`, a variant request for `variant`. */
  generate?: DraftRequest | VariantRequest;
}

/** A merge update: every field is optional. */
export interface DraftPatch {
  content?: Record<string, unknown> | null;
  basedOn?: number;
  edited?: boolean;
  title?: string | null;
  expectedRevision?: number;
}

export interface DraftSaveRequest {
  item: ItemInput;
  expectedRevision?: number;
}

// ---- Style presets ---------------------------------------------------------

/** The user's own standing instructions for how generated items are written. */
export interface StylePreset {
  id: string;
  name: string;
  instructions: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StylePresetInput {
  name: string;
  instructions: string;
  isDefault?: boolean;
}

export type StylePresetPatch = Partial<StylePresetInput>;

// ---- System prompt ---------------------------------------------------------

/**
 * The authoring conventions at the start of a draft's or variant's system
 * prompt: the editable part (`builtIn`, or the user's `custom` text in its
 * place) and the rules the app depends on, which always apply.
 */
export interface SystemPrompt {
  builtIn: string;
  custom: string | null;
  isCustom: boolean;
  /** The fixed rules, sent after the conventions. */
  fixed: string;
  /** The rules that end a draft's and a variant's system prompt. */
  draftRules: string;
  variantRules: string;
}

/**
 * The rules of a test-case generation's system prompt, separate from the
 * authoring conventions: the editable test-design guidance (`builtIn`, or
 * the user's `custom` text in its place) and the rules the app depends on.
 */
export interface TestCasePrompt {
  builtIn: string;
  custom: string | null;
  isCustom: boolean;
  /** The fixed rules, sent after a custom text, ending with the JSON-only answer. */
  fixed: string;
}

// ---- AI settings ----------------------------------------------------------

/** A named connection to an AI service. Keys are write-only: only `apiKeySet` and `apiKeyHint` describe one. */
/** How much effort the model is asked to spend; `null` is the model's own default, and none is asked for. */
export type AiEffort = 'low' | 'medium' | 'high';

export interface AiProvider {
  id: string;
  name: string;
  kind: AiProviderKind;
  /** Saved values; `null` means the kind's default applies. */
  model: string | null;
  baseUrl: string | null;
  apiKeySet: boolean;
  /** `…` plus the last four characters, or `null` without a key. */
  apiKeyHint: string | null;
  effort: AiEffort | null;
  /** `environment`: supplied by the server's environment variables; it cannot be changed or deleted through the API. */
  source: 'settings' | 'environment';
  isDefault: boolean;
  /** Has everything it needs, counting the kind's defaults. Only a ready provider can be the default. */
  ready: boolean;
  /** What this instance has spent through the provider. */
  usage: AiProviderUsage;
  /** `null` for an environment provider. */
  createdAt: string | null;
  updatedAt: string | null;
}

export interface UsageTotals {
  requests: number;
  /** The part of `requests` that returned no usable answer. */
  failed: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AiProviderUsage {
  /** Today and the 29 days before it, in UTC. */
  last30Days: UsageTotals;
  allTime: UsageTotals;
  /** `null` before the first request. */
  lastUsedAt: string | null;
}

export type AiOperation = 'draft' | 'variant' | 'testcases' | 'code' | 'test';

/** One request the server sent to an AI provider. */
export interface AiLogEntry {
  id: string;
  createdAt: string;
  /** `test` is a connection test. */
  operation: AiOperation;
  /** The item the request was about; an entry outlives its item. */
  itemId: string | null;
  /** A short label fixed when the entry was written, or `null`. */
  title: string | null;
  /** Provider, kind and model as they were at the time. */
  providerId: string;
  providerName: string;
  kind: AiProviderKind;
  model: string;
  /** `cancelled`: the client went away. */
  status: 'ok' | 'failed' | 'cancelled';
  error: string | null;
  durationMs: number;
  usage: TokenUsage;
}

/** An entry with what was sent and what came back; for reading, not for programs. */
export interface AiLogDetail extends AiLogEntry {
  request: unknown;
  /** `null` if none arrived. */
  response: string | null;
  /** Either was cut off at the size the server keeps. */
  truncated: boolean;
}

export type AiLogStatus = AiLogEntry['status'];

/** Filters of the log; they are applied by the server. */
export interface AiLogFilters {
  providerId?: string;
  operation?: AiOperation;
  status?: AiLogStatus;
}

export interface AiLogParams extends AiLogFilters {
  limit?: number;
  /** How many matching entries to skip from the newest; not with `before`. */
  offset?: number;
  /** The `next` of the page before; not with `offset`. */
  before?: string;
}

/** A page of the log, newest first. */
export interface AiLogPage {
  items: AiLogEntry[];
  /** The cursor of the following batch, or `null` at the end. */
  next: string | null;
  /** The entries matching the filters. */
  total: number;
}

export interface AiKindInfo {
  defaultModel: string | null;
  defaultBaseUrl: string;
  /** Whether a key is always required. `openai_compatible` needs one only on the default base URL. */
  keyRequired: boolean;
}

export interface AiSettings {
  /** The AI features switch as saved, `true` until it is first saved. AI features are on when it is and the default provider is ready (`Meta.ai.enabled`). */
  enabled: boolean;
  /** The provider the AI endpoints use; `null` means there is none, and AI features are off. */
  defaultProviderId: string | null;
  /**
   * How long one request to a provider may take, in seconds: the saved value,
   * or `defaultTimeoutSeconds` when none is saved. A server from before the
   * setting existed sends neither field.
   */
  timeoutSeconds?: number;
  /** The environment's value (`CODEATROPHY_AI_TIMEOUT`), which applies when none is saved. */
  defaultTimeoutSeconds?: number;
  /** The default first, then saved providers by name, then environment providers. */
  providers: AiProvider[];
  kinds: Record<AiProviderKind, AiKindInfo>;
}

/** A merge update: a field left out keeps its value. */
export interface AiSettingsUpdate {
  /** Switches AI features on or off. `false` keeps the default provider; `true` with no default makes the first ready provider the default (`422` when none is). */
  enabled?: boolean;
  /** `null` leaves no default, which turns AI features off. Does not change `enabled`. */
  defaultProviderId?: string | null;
  /** `null` removes the saved value, so `defaultTimeoutSeconds` applies. */
  timeoutSeconds?: number | null;
}

export interface AiProviderInput {
  name: string;
  kind: AiProviderKind;
  model?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
  /** Omitted or `null`: the model's default. */
  effort?: AiEffort | null;
}

export interface AiProviderPatch {
  name?: string;
  /** `null` clears the saved value, so the kind's default applies. */
  model?: string | null;
  baseUrl?: string | null;
  /** Omit (or send an empty string) to keep the stored key, `null` to delete it, a string to replace it. */
  apiKey?: string | null;
  /** `null` is the model's default. */
  effort?: AiEffort | null;
}

/** Exactly one of `providerId` (a saved or environment provider) and `kind` (a configuration not saved yet). */
export interface AiTestRequest {
  providerId?: string | null;
  kind?: AiProviderKind | null;
  /** With `providerId`, these override the provider's values for this test. */
  model?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
  /** Unlike the others, an override whenever present: `null` tests the model's default. */
  effort?: AiEffort | null;
}

export interface AiTestResponse {
  ok: boolean;
  /** The model the generation request used, or `null` when there was none to test. */
  model: string | null;
  latencyMs: number | null;
  error: string | null;
  /** The service's model ids, or `null` when the list could not be fetched; `modelsError` then says why. */
  models: string[] | null;
  modelsError: string | null;
}

/** The provider is named as for a test; listing makes no generation request, so there is no model. */
export type AiModelsRequest = Omit<AiTestRequest, 'model' | 'effort'>;

export interface AiModelsResponse {
  /** The service's model ids, or `null` when the list could not be fetched; `error` then says why. */
  models: string[] | null;
  error: string | null;
}

// ---- Preferences ------------------------------------------------------------

export interface EditorPreferences {
  autocomplete: boolean;
  closeBrackets: boolean;
  matchBrackets: boolean;
  lineWrapping: boolean;
  tabSize: 2 | 4 | 8;
  /** Pixels, 10–24. */
  fontSize: number;
}

/** How the user likes the app to behave; stored on the server so it follows them across browsers. */
export interface Preferences {
  /** Keep the content of non-sample test cases out of sight until the user asks to see it. */
  hideTestCases: boolean;
  /** How many test cases to ask for by default when generating them: 1 to `limits.maxGeneratedTestCases`. */
  generatedTestCases: number;
  /** Whether to ask for large test cases by default when generating. */
  largeTestCase: boolean;
  /** How many large test cases to ask for when they are asked for: 1 to `limits.maxLargeTestCases`. */
  largeTestCaseCount: number;
  editor: EditorPreferences;
}

/** Body of `PUT /settings/preferences`: any subset, at any depth. */
export interface PreferencesUpdate {
  hideTestCases?: boolean;
  generatedTestCases?: number;
  largeTestCase?: boolean;
  largeTestCaseCount?: number;
  editor?: Partial<EditorPreferences>;
}

// ---- Import and export ----------------------------------------------------

export type ExportScope = 'all' | 'collection' | 'items';

export interface ExportRequest {
  scope: ExportScope;
  collectionId?: string | null;
  itemIds?: string[];
  name?: string;
  description?: string;
  author?: string;
  includeSolutions: boolean;
  includeHiddenTests: boolean;
}

export type ImportItemState = 'new' | 'changed' | 'unchanged';
export type ImportStrategy = 'skip' | 'overwrite' | 'duplicate';

/** Content fields that can differ between a bundled item and the local one, in display order. */
export type ImportChange =
  | 'type'
  | 'title'
  | 'summary'
  | 'body'
  | 'difficulty'
  | 'tags'
  | 'source'
  | 'variantOf'
  | 'limits'
  | 'compare'
  | 'starterCode'
  | 'interface'
  | 'harness'
  | 'solutions'
  | 'testCases';

export interface ImportPreviewItem {
  id: string;
  title: string;
  type: ItemType;
  state: ImportItemState;
  testCaseCount: number;
  /** What differs from the local item when `state` is `changed`; empty otherwise. */
  changes: (ImportChange | (string & {}))[];
}

export interface ImportPreview {
  bundle: {
    name: string;
    description: string;
    author: string;
    formatVersion: number;
    createdAt: string;
  };
  items: ImportPreviewItem[];
  collections: { id: string; name: string; state: 'new' | 'existing'; itemCount: number }[];
  counts: Record<ImportItemState, number>;
  warnings: string[];
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  duplicated: number;
  unchanged: number;
  collectionsCreated: number;
  warnings: string[];
}

// --- Sign-in ---------------------------------------------------------------

/** An account that may sign in. Accounts share the library and keep their own progress, collections, code, drafts, AI history and preferences. */
export interface AuthUser {
  id: string;
  email: string;
  createdAt: string;
}

/** `GET /auth/session`: whether sign-in is on, and who is signed in. */
export interface AuthSession {
  /** False when the server runs with `CODEATROPHY_AUTH=off`: nobody needs to sign in. */
  enabled: boolean;
  /** True while no account exists; the sign-in page then creates the first one. */
  setupRequired: boolean;
  user: AuthUser | null;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export type SetupRequest = LoginRequest;

/** `POST /auth/password`: the signed-in session is enough, so only the new password is sent. */
export interface PasswordChangeRequest {
  newPassword: string;
}

/** `GET /auth/sessions`: a browser signed in to the account. */
export interface BrowserSession {
  /** Names the session in the API; it is not the cookie. */
  id: string;
  /** A short description from the User-Agent, such as "Firefox on Linux" or "Unknown browser". */
  browser: string;
  createdAt: string;
  /** Accurate to about an hour; the current session's is the time of the request. */
  lastUsedAt: string;
  /** The session of this browser. */
  current: boolean;
}

/** A token an account made for its MCP clients; the token itself is shown only when it is made. */
export interface McpToken {
  id: string;
  name: string;
  /** The token's last four characters, to tell tokens apart. */
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface McpTokenCreated extends McpToken {
  token: string;
}
