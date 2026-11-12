// Types for the HTTP API described in docs/api.md. Keep this file in step
// with that document: it is the contract between the server and the UI.

export type ItemType = 'problem' | 'reading';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type ItemStatus = 'todo' | 'in_progress' | 'done';
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

export type AiProviderId = 'anthropic' | 'openai_compatible';

export interface Meta {
  version: string;
  ai: { enabled: boolean; provider: AiProviderId | null; model: string | null };
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
  /** Applies to an export's `name` and `author`. */
  maxBundleNameChars: number;
  maxBundleDescriptionChars: number;
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

export interface ProblemSpec {
  timeLimitMs: number;
  memoryLimitKb: number;
  compare: CompareMode;
  starterCode: Record<string, string>;
  referenceSolution: SourceCode | null;
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
}

export interface DraftProblemSpec {
  timeLimitMs: number;
  memoryLimitKb: number;
  compare: CompareMode;
  starterCode: Record<string, string>;
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

export interface DraftRequest {
  text: string;
  typeHint?: 'auto' | ItemType;
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

/** Response of `POST /ai/draft` and `POST /items/{id}/ai/variant`. */
export interface DraftResponse {
  draft: ItemDraft;
  style: AppliedStyle | null;
}

export type VariantMode = 'similar' | 'easier' | 'harder' | 'twist';

export interface VariantRequest {
  mode?: VariantMode;
  instruction?: string | null;
  /** A draft returned by an earlier variant call; with `instruction` this asks for a revision of it. */
  previousDraft?: ItemDraft | null;
  styleId?: string | null;
}

export interface AiTestCasesRequest {
  count?: number;
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

/** Where an effective setting comes from; `null` means the built-in default applies. */
export type SettingSource = 'settings' | 'environment' | null;

export interface AiProviderState {
  /** Effective values: saved, else from the environment, else `null` (the default applies). */
  model: string | null;
  baseUrl: string | null;
  modelSource: SettingSource;
  baseUrlSource: SettingSource;
  apiKeySet: boolean;
  apiKeyHint: string | null;
  apiKeySource: SettingSource;
  ready: boolean;
}

export interface AiSettings {
  activeProvider: AiProviderId | null;
  providers: Record<AiProviderId, AiProviderState>;
  defaults: Record<AiProviderId, { model: string | null; baseUrl: string | null }>;
}

export interface AiProviderUpdate {
  model?: string | null;
  baseUrl?: string | null;
  /** Omit (or send an empty string) to keep the stored key, `null` to delete it, a string to replace it. */
  apiKey?: string | null;
}

export interface AiSettingsUpdate {
  activeProvider?: AiProviderId | null;
  providers?: Partial<Record<AiProviderId, AiProviderUpdate>>;
}

export interface AiTestRequest {
  provider: AiProviderId;
  model?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
}

export interface AiTestResponse {
  ok: boolean;
  model: string | null;
  latencyMs: number | null;
  error: string | null;
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
  | 'referenceSolution'
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
