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
  | 'internal';

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

export type AiProviderKind = 'anthropic' | 'openai_compatible';

export interface Meta {
  version: string;
  /** The default AI provider when it is ready; otherwise `enabled` is `false` and the rest is `null`. `model` is the one in effect. */
  ai: { enabled: boolean; providerId: string | null; providerName: string | null; kind: AiProviderKind | null; model: string | null };
  judge: { enabled: boolean; engine: string; healthy: boolean; languages: JudgeLanguage[] };
  /** `url` is the public MCP URL when the operator configured one; otherwise derive it from the page origin and `path`. */
  mcp: { enabled: boolean; path: string; url: string | null; authRequired: boolean };
  limits: Limits;
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
  maxStylePresets: number;
  maxStyleNameChars: number;
  maxStyleInstructionsChars: number;
  maxModelIdChars: number;
  maxApiKeyChars: number;
  /** Saved AI providers per instance; environment providers do not count. */
  maxAiProviders: number;
  maxAiProviderNameChars: number;
  /** Applies to an export's `name` and `author`. */
  maxBundleNameChars: number;
  maxBundleDescriptionChars: number;
  maxSolutionsPerItem: number;
  maxSolutionNameChars: number;
  maxSolutionNotesChars: number;
}

export interface Stats {
  items: {
    total: number;
    byType: Record<ItemType, number>;
    byStatus: Record<ItemStatus, number>;
    byDifficulty: Record<Difficulty | 'none', number>;
  };
  collections: number;
  tags: number;
  submissions: { total: number; accepted: number };
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
}

export interface TestCaseInput {
  name?: string;
  stdin?: string;
  expectedStdout: string;
  isSample?: boolean;
  origin?: TestOrigin;
  verified?: boolean;
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
  timeMs: number;
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
}

export type SolutionPatch = Partial<SolutionInput>;

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

/** Response of `POST /ai/draft` and `POST /items/{id}/ai/variant`. */
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
}

export interface AiTestCasesRequest {
  count?: number;
  /** Language of the reference solution. For a `function` problem it must have a harness. */
  language?: string;
  instruction?: string | null;
}

export interface ProposedTestCase {
  name: string;
  rationale: string;
  stdin: string;
  expectedStdout: string;
  predictedStdout: string;
  isSample: boolean;
  verified: boolean;
  predictionMatched: boolean | null;
  error: string | null;
}

export interface AiTestCasesResponse {
  referenceSolution: SourceCode;
  verification: { attempted: boolean; engine: string | null; error: string | null };
  /** Proposed cases left out because their input repeated an existing or an earlier proposed one. */
  duplicatesDropped: number;
  usage: GenerationUsage;
  cases: ProposedTestCase[];
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

// ---- AI settings ----------------------------------------------------------

/** A named connection to an AI service. Keys are write-only: only `apiKeySet` and `apiKeyHint` describe one. */
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

export type AiOperation = 'draft' | 'variant' | 'testcases' | 'test';

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
  /** The `next` of the page before. */
  before?: string;
}

/** A batch of the log, newest first. */
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
  /** The provider the AI endpoints use; `null` means AI features are off. */
  defaultProviderId: string | null;
  /** The default first, then saved providers by name, then environment providers. */
  providers: AiProvider[];
  kinds: Record<AiProviderKind, AiKindInfo>;
}

export interface AiSettingsUpdate {
  defaultProviderId: string | null;
}

export interface AiProviderInput {
  name: string;
  kind: AiProviderKind;
  model?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
}

export interface AiProviderPatch {
  name?: string;
  /** `null` clears the saved value, so the kind's default applies. */
  model?: string | null;
  baseUrl?: string | null;
  /** Omit (or send an empty string) to keep the stored key, `null` to delete it, a string to replace it. */
  apiKey?: string | null;
}

/** Exactly one of `providerId` (a saved or environment provider) and `kind` (a configuration not saved yet). */
export interface AiTestRequest {
  providerId?: string | null;
  kind?: AiProviderKind | null;
  /** With `providerId`, these override the provider's values for this test. */
  model?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
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
  editor: EditorPreferences;
}

/** Body of `PUT /settings/preferences`: any subset, at any depth. */
export interface PreferencesUpdate {
  hideTestCases?: boolean;
  generatedTestCases?: number;
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
