# HTTP API

This is the contract between the server and the web UI. All endpoints live
under `/api/v1`.

## Conventions

- Request and response bodies are JSON (`application/json`) unless stated
  otherwise. Field names are `camelCase`.
- Ids are UUID strings. Timestamps are RFC 3339 in UTC
  (`2026-01-31T12:00:00Z`).
- Optional scalar fields that have no value are returned as `null`, never
  omitted. Arrays and maps are returned empty (`[]`, `{}`), never `null`.
- `PATCH` uses merge semantics: omitted fields are left unchanged; arrays and
  maps that are present replace the stored value entirely; an explicit `null`
  clears a nullable field.
- List endpoints that paginate take `limit` (default 50, max 200) and `offset`
  and return `{ "items": [...], "total": <count before pagination> }`. A
  `limit` outside 1–200 or a negative `offset` is `400 bad_request`.
- In every text field the server normalises `\r\n` and lone `\r` to `\n`
  before validating and storing, except in test-case `stdin` and
  `expectedStdout`, which are stored byte for byte.
- Successful creation returns `201` with the created resource. Successful
  deletion returns `204` with no body.

### Errors

Any non-2xx response has this body:

```json
{ "error": { "code": "validation_failed", "message": "title is required", "fields": { "title": "is required" } } }
```

`fields` is present only for `validation_failed`, and for a `conflict` that
reports the current state (the item revision conflict described under
`PATCH /items/{id}`, where `fields.revision` is a number).

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | Malformed JSON, bad query parameter, unreadable upload |
| 403 | `forbidden` | A state-changing request sent from a web page on another origin (see below) |
| 404 | `not_found` | Resource does not exist |
| 405 | `bad_request` | The path exists but does not support this method; the `Allow` header lists the ones it does |
| 409 | `conflict` | Request conflicts with current state (e.g. a collection cycle) |
| 413 | `too_large` | Body or upload exceeds a limit |
| 422 | `validation_failed` | Well-formed but invalid |
| 502 | `upstream_error` | The AI provider or judge engine returned an error; `message` carries a safe summary |
| 503 | `ai_unavailable` | No AI provider is configured |
| 503 | `judge_unavailable` | No judge engine is configured, or it is unreachable |
| 500 | `internal` | Unexpected server error |

Requests other than `GET`, `HEAD` and `OPTIONS` that carry an `Origin` header
are accepted only from the server's own origin, a loopback origin (such as the
UI dev server on `http://localhost:5173`), or an origin listed in
`CODEATHROPY_ALLOWED_ORIGINS`. This blocks cross-site request forgery against
an instance that has no authentication.

## Enumerations

| Name | Values |
| --- | --- |
| `ItemType` | `problem`, `reading` |
| `Difficulty` | `easy`, `medium`, `hard` |
| `ItemStatus` | `todo`, `in_progress`, `done` |
| `CompareMode` | `tokens` (whitespace-insensitive token comparison), `exact` (byte comparison after stripping trailing whitespace on each line and trailing blank lines) |
| `TestOrigin` | `manual`, `ai`, `import` |
| `SubmissionMode` | `run`, `submit` |
| `SubmissionStatus` | `queued`, `running`, `completed` |
| `Verdict` | `accepted`, `wrong_answer`, `time_limit_exceeded`, `memory_limit_exceeded`, `runtime_error`, `compile_error`, `internal_error`, `executed` |

`executed` is the verdict of a run that had no expected output to compare
against (custom stdin).

Language ids are canonical lower-case strings owned by the app: `c`, `cpp`,
`csharp`, `go`, `java`, `javascript`, `kotlin`, `python`, `ruby`, `rust`,
`typescript`. The set actually available is reported by `GET /meta`.

## Meta

### `GET /meta`

Instance capabilities. The UI calls this at startup to decide which features
to show.

```json
{
  "version": "0.1.0",
  "ai": { "enabled": true, "provider": "anthropic", "model": "claude-opus-5-5" },
  "judge": {
    "enabled": true,
    "engine": "judge0",
    "healthy": true,
    "languages": [ { "id": "python", "name": "Python", "version": "3.8.1" } ]
  },
  "mcp": { "enabled": true, "path": "/mcp", "url": null, "authRequired": false },
  "limits": {
    "maxImportBytes": 52428800,
    "maxImportUncompressedBytes": 209715200,
    "maxImportEntries": 20000,
    "maxRequestBytes": 33554432,
    "maxPageSize": 200,
    "maxSourceBytes": 65536,
    "maxTitleChars": 200,
    "maxSummaryChars": 5000,
    "maxTextBytes": 1048576,
    "maxSourceUrlChars": 2048,
    "maxSourceNoteChars": 2000,
    "maxTags": 30,
    "maxTagChars": 40,
    "maxCollectionNameChars": 200,
    "maxCollectionDescriptionChars": 5000,
    "timeLimitMs": { "min": 100, "max": 30000 },
    "memoryLimitKb": { "min": 16384, "max": 2097152 },
    "maxTestCasesPerItem": 1000,
    "maxTestDataBytes": 8388608,
    "maxTestCaseNameChars": 200,
    "maxDraftTextChars": 50000,
    "maxInstructionChars": 2000,
    "maxPreviousDraftBytes": 2097152,
    "maxGeneratedTestCases": 30,
    "maxStylePresets": 20,
    "maxStyleNameChars": 60,
    "maxStyleInstructionsChars": 2000,
    "maxModelIdChars": 200,
    "maxApiKeyChars": 1000,
    "maxBundleNameChars": 200,
    "maxBundleDescriptionChars": 5000
  }
}
```

- `limits` publishes every bound the server enforces on user input, so
  clients validate against the server's values rather than copies of them.
  `maxTextBytes` applies to each of an item's `body`, `notes` and `rawInput`;
  `maxTestDataBytes` to each of a test case's `stdin` and `expectedStdout`;
  `maxGeneratedTestCases` is the upper bound of `count` in
  `POST /items/{id}/ai/testcases`. A source URL must be `http` or `https`.
  `maxTestDataBytes` also bounds the custom `stdin` of a run.
  `maxRequestBytes` bounds any JSON request body (`413` beyond it);
  `maxPageSize` is the largest `limit`. `maxPreviousDraftBytes` bounds the
  re-encoded `previousDraft` of a draft or variant revision.
  `maxModelIdChars` and `maxApiKeyChars` bound `PUT /settings/ai` values.
  `maxBundleNameChars` applies to an export's `name` and `author`,
  `maxBundleDescriptionChars` to its `description`. `maxImportUncompressedBytes`
  and `maxImportEntries` bound the contents of an uploaded bundle
  (`413` beyond them).
- `mcp.url` is the full public URL of the MCP endpoint when the operator has
  set `CODEATHROPY_PUBLIC_URL`, otherwise `null`; a client then derives it
  from its own origin plus `mcp.path`.
- `ai.enabled` is `true` when an active provider is fully configured (see
  [AI settings](#ai-settings)). When `false`, `provider` and `model` are `null`.
- `judge.enabled: false` (engine `none`) → `healthy` is `false`, `languages` is `[]`.
- `judge.healthy` reflects a recent health probe; it may lag by a few seconds.

### `GET /stats`

```json
{
  "items": {
    "total": 42,
    "byType": { "problem": 30, "reading": 12 },
    "byStatus": { "todo": 20, "in_progress": 5, "done": 17 },
    "byDifficulty": { "easy": 10, "medium": 15, "hard": 5, "none": 12 }
  },
  "collections": 6,
  "tags": 18,
  "submissions": { "total": 120, "accepted": 31 }
}
```

All enum keys are always present, with `0` when empty.

## Items

### Shapes

`ItemSummary` — returned by list endpoints:

```json
{
  "id": "0193b2f0-...",
  "type": "problem",
  "title": "Two Sum",
  "summary": "Find two indices whose values add up to a target.",
  "difficulty": "easy",
  "tags": ["array", "hash-map"],
  "status": "todo",
  "favorite": false,
  "collectionIds": ["0193b2f1-..."],
  "variantOf": null,
  "variantCount": 0,
  "testCaseCount": 6,
  "lastVerdict": "accepted",
  "revision": 3,
  "createdAt": "2026-01-31T12:00:00Z",
  "updatedAt": "2026-01-31T12:00:00Z"
}
```

- `revision` starts at 1 and increases by one each time a request actually
  changes one of the item's own content fields: `title`, `summary`, `body`,
  `difficulty`, `tags`, `source`, `variantOf` or anything under `problem`
  (including a reference solution stored through `testcases/bulk`). It does
  not change for personal state (`status`, `favorite`, `notes`), collection
  membership, test-case changes, or a request that leaves every field as it
  was.
- `updatedAt` is the time of the last content change: whenever `revision`
  increases, and whenever the item's test cases change. Personal state and
  collection membership do not move it, so sorting by `updated` is stable
  under starring and status changes.
- `variantOf` is the id of the item this one was derived from, or `null`.
  `variantCount` is the number of items whose `variantOf` is this item.
  Deleting an item clears `variantOf` on its variants.
- `difficulty` is nullable for both types.
- `testCaseCount` is `0` and `lastVerdict` is `null` for readings.
- `lastVerdict` is the verdict of the most recent *completed* `submit`-mode
  submission, or `null` if there is none. A submission still being judged
  does not affect it.
- `tags` are lower-cased, trimmed, de-duplicated and sorted by the server. A
  tag may not contain `/` or control characters (`422`).

`Item` — everything in `ItemSummary` plus:

```json
{
  "body": "## Problem\n\nGiven an array ...",
  "notes": "",
  "rawInput": "two sum, array + target, return indices, O(n)?",
  "source": { "url": null, "note": null },
  "problem": {
    "timeLimitMs": 2000,
    "memoryLimitKb": 262144,
    "compare": "tokens",
    "starterCode": { "python": "import sys\n..." },
    "referenceSolution": { "language": "python", "source": "..." }
  }
}
```

- `body` is Markdown (GitHub-flavoured, with `$...$` / `$$...$$` math).
- `notes` is the user's private Markdown notes. `rawInput` is the original
  text an AI draft was generated from, or `null`. Neither is ever exported.
- `problem` is `null` for readings and always an object for problems.
  `referenceSolution` is nullable. `starterCode` is keyed by language id.

`ItemInput` — body of create and (partially) update:

```json
{
  "type": "problem",
  "title": "Two Sum",
  "summary": "",
  "body": "",
  "difficulty": null,
  "tags": [],
  "status": "todo",
  "favorite": false,
  "notes": "",
  "rawInput": null,
  "source": { "url": null, "note": null },
  "problem": { "timeLimitMs": 2000, "memoryLimitKb": 262144, "compare": "tokens", "starterCode": {}, "referenceSolution": null },
  "collectionIds": [],
  "variantOf": null,
  "testCases": []
}
```

Only `type` and `title` are required on create; everything else defaults as
shown. `type` cannot be changed after creation. `testCases` (an array of
`TestCaseInput`) is accepted on create only, so a reviewed AI draft is saved
atomically with its sample cases. Validation: `title` 1–200 chars;
`timeLimitMs` 100–30000; `memoryLimitKb` 16384–2097152; at most 30 tags of 1–40
chars each.

### `GET /items`

Query parameters, all optional and combined with AND:

| Parameter | Meaning |
| --- | --- |
| `q` | Full-text search over title, summary, body and tags |
| `id` | Item id; repeatable (OR) — fetch specific items. Unknown ids are ignored |
| `type` | `ItemType` |
| `status` | `ItemStatus`; repeatable (OR within the parameter) |
| `difficulty` | `Difficulty` or `none`; repeatable (OR) |
| `tag` | Tag name; repeatable (AND — item must have all) |
| `collectionId` | Members of this collection; add `recursive=true` to include descendants |
| `uncollected` | `true` → items in no collection |
| `variantOf` | Items derived from this item id |
| `favorite` | `true` / `false` |
| `sort` | `updated` (default), `created`, `title`, `difficulty`, `position`, `relevance` |
| `order` | `asc` / `desc`; default depends on `sort`: `desc` for `updated`, `created` and `relevance` (best match first), `asc` otherwise |
| `limit`, `offset` | Pagination |

`sort=position` is valid only with a non-recursive `collectionId` and returns
the collection's own order. `sort=relevance` is valid only with `q`.

Returns `{ "items": [ItemSummary], "total": n }`.

### `POST /items`

Body `ItemInput`. Returns `201` `Item`.

### `GET /items/{id}`

Returns `Item`.

### `PATCH /items/{id}`

Body: any subset of `ItemInput` except `type` and `testCases`. `problem` is
merged field by field; `source` is merged field by field. Returns `Item`.

The body may also carry `"expectedRevision": <n>`. If present and the item's
current `revision` differs, nothing is written and the response is
`409 conflict`, with the current revision in `error.fields.revision`. Clients
that show an editor should send it so that a concurrent edit (from another
tab, or from an assistant connected over MCP) is not silently overwritten.

### `POST /items/{id}/edits`

Targeted text replacement inside a long text field, without resending it.

```json
{
  "field": "body",
  "expectedRevision": 3,
  "edits": [ { "oldText": "1 ≤ n ≤ 100", "newText": "1 ≤ n ≤ 10^5" } ]
}
```

`field` is `body` or `notes`. Edits apply in order; each `oldText` must occur
exactly once in the text as it stands at that point, otherwise nothing is
written and the response is `422` naming the failing edit index in
`error.fields`. `expectedRevision` is optional, as for `PATCH`. Returns `Item`.

### `DELETE /items/{id}`

Deletes the item, its test cases and its submissions.

### `POST /items/bulk`

Apply one action to many items.

```json
{ "ids": ["..."], "action": "addTags", "tags": ["dp"] }
```

| `action` | Extra fields |
| --- | --- |
| `delete` | — |
| `addTags`, `removeTags` | `tags: string[]` |
| `setStatus` | `status: ItemStatus` |
| `setFavorite` | `favorite: boolean` |
| `addToCollection`, `removeFromCollection` | `collectionId: string` |

Returns `{ "affected": n }`, the number of the given ids that exist (whether
or not the action changed them). Unknown ids are ignored.

## Test cases

`TestCase`:

```json
{
  "id": "...",
  "itemId": "...",
  "position": 0,
  "name": "Example 1",
  "stdin": "4\n2 7 11 15\n9\n",
  "expectedStdout": "0 1\n",
  "isSample": true,
  "origin": "manual",
  "verified": false,
  "createdAt": "...",
  "updatedAt": "..."
}
```

`TestCaseInput`: `name` (default `""`), `stdin` (default `""`),
`expectedStdout` (required, may be empty), `isSample` (default `false`),
`origin` (default `manual`), `verified` (default `false`).

Editing `stdin` or `expectedStdout` through `PATCH` resets `verified` to
`false` unless the same request sets it.

| Endpoint | Behaviour |
| --- | --- |
| `GET /items/{id}/testcases` | `{ "items": [TestCase] }` ordered by `position`; not paginated |
| `POST /items/{id}/testcases` | Body `TestCaseInput`; appended. `201` `TestCase` |
| `POST /items/{id}/testcases/bulk` | Body `{ "cases": [TestCaseInput], "replace": false, "referenceSolution": null }`. Appends, or replaces all existing cases when `replace` is `true`. A non-null `referenceSolution` (`{language, source}`) is stored on the item in the same transaction. Returns `{ "items": [TestCase] }` — the full list after the change |
| `PATCH /testcases/{id}` | Partial `TestCaseInput`. Returns `TestCase` |
| `DELETE /testcases/{id}` | `204` |
| `PUT /items/{id}/testcases/order` | Body `{ "ids": [...] }` — must be exactly the item's case ids. Returns `{ "items": [TestCase] }` |
| `POST /items/{id}/testcases/verify` | See below |

All of these return `422` for a reading. `POST /items/{id}/testcases/bulk`
also accepts an optional `expectedRevision`, checked as for `PATCH /items/{id}`;
it matters when the request stores a reference solution, which is item
content.

### `POST /items/{id}/testcases/verify`

Executes the item's reference solution against every test case. Requires a
judge engine and a reference solution (`422` if the item has none).

Body: `{ "updateExpected": false }`

```json
{
  "results": [
    {
      "testCaseId": "...",
      "ok": true,
      "matches": true,
      "actualStdout": "0 1\n",
      "verdict": "executed",
      "stderr": "",
      "timeMs": 31
    }
  ]
}
```

- `ok` — the solution ran to completion within limits. When `false`, `verdict`
  says why (`runtime_error`, `time_limit_exceeded`, `compile_error`, …).
- `matches` — `actualStdout` equals the stored expected output under the item's
  compare mode.
- Cases that are `ok && matches` are marked `verified`. With
  `updateExpected: true`, cases that are `ok && !matches` have their expected
  output replaced by `actualStdout` and are marked `verified` too.

Synchronous; may take as long as the cases take to run. `503
judge_unavailable` if no engine is configured or the engine cannot be reached;
nothing is changed in that case.

## Collections

`Collection`:

```json
{
  "id": "...",
  "name": "Dynamic Programming",
  "description": "",
  "parentId": null,
  "position": 0,
  "itemCount": 12,
  "createdAt": "...",
  "updatedAt": "..."
}
```

`position` orders a collection among its siblings. `itemCount` counts direct
members only.

| Endpoint | Behaviour |
| --- | --- |
| `GET /collections` | `{ "items": [Collection] }` — every collection, flat, ordered by `parentId` then `position`; the client builds the tree. Not paginated |
| `POST /collections` | Body `{ "name", "description"?, "parentId"? }`; appended after its siblings. `201` `Collection` |
| `GET /collections/{id}` | `Collection` |
| `PATCH /collections/{id}` | Body: any of `name`, `description`, `parentId`, `position`. Moving under itself or a descendant is `409 conflict`. Setting `position` inserts at that index among the (new) siblings and renumbers them. Returns `Collection` |
| `DELETE /collections/{id}` | Child collections move up to the deleted collection's parent. Items are not deleted. `204` |
| `GET /collections/{id}/items` | `{ "itemIds": [...] }` — the full ordered membership, ids only. Not paginated |
| `PUT /collections/{id}/items` | Body `{ "itemIds": [...] }` — replaces membership and order with exactly this list. Returns `{ "itemIds": [...] }` |
| `POST /collections/{id}/items` | Body `{ "itemIds": [...] }` — appends those not already members. Returns `{ "itemIds": [...] }` (full ordered membership) |
| `DELETE /collections/{id}/items/{itemId}` | `204` |

To list a collection's items use `GET /items?collectionId={id}&sort=position`.

## Tags

| Endpoint | Behaviour |
| --- | --- |
| `GET /tags` | `{ "items": [ { "name": "array", "count": 7 } ] }` sorted by name |
| `PATCH /tags/{name}` | Body `{ "name": "new-name" }`. Renames across all items; if the new name already exists the two are merged. Returns `{ "name": "new-name", "count": n }` |
| `DELETE /tags/{name}` | Removes the tag from all items. `204` |

`{name}` is URL-encoded. Both endpoints are `404` for a tag no item carries.

## Submissions

`Submission`:

```json
{
  "id": "...",
  "itemId": "...",
  "mode": "submit",
  "language": "python",
  "source": "...",
  "status": "completed",
  "verdict": "wrong_answer",
  "passedCount": 4,
  "totalCount": 6,
  "timeMs": 48,
  "memoryKb": 9120,
  "compileOutput": "",
  "error": null,
  "results": [
    {
      "testCaseId": "...",
      "name": "Example 1",
      "isSample": true,
      "verdict": "accepted",
      "stdin": "4\n2 7 11 15\n9\n",
      "expectedStdout": "0 1\n",
      "stdout": "0 1\n",
      "stderr": "",
      "timeMs": 22,
      "memoryKb": 9120
    }
  ],
  "createdAt": "...",
  "finishedAt": "..."
}
```

- `verdict`, `finishedAt`, `timeMs`, `memoryKb` are `null` until `status` is
  `completed`. `timeMs` / `memoryKb` are the maximum over results.
- `timeMs` is what the engine measured. For a `time_limit_exceeded` result it
  is the time at which the program was stopped, which is later than the limit
  by the engine's grace period (a second or more); it is not a measurement of
  how long the program would have run.
- The overall `verdict` is `accepted` if every result is accepted, otherwise
  the verdict of the first non-accepted result in order. A compile error yields
  a single overall `compile_error` with `compileOutput` set and `results`
  empty.
- `results` fills in as cases finish; while `running`, cases not yet finished
  are absent. `stdin`, `expectedStdout`, `stdout` and `stderr` are each
  truncated to 64 KiB.
- `testCaseId` and `expectedStdout` are `null` for a custom-stdin run.
- `totalCount` is fixed when the submission is created — the number of cases
  it will run, or `1` for a custom-stdin run — so progress can be shown from
  the first poll. `passedCount` counts results whose verdict is `accepted` or
  `executed`.
- On a compile error `passedCount` is `0`, `totalCount` keeps its value, and
  `timeMs` / `memoryKb` are `null`.
- `error` is a human-readable message when `verdict` is `internal_error`
  (engine unreachable, etc.), otherwise `null`.

`SubmissionSummary` is `Submission` without `source`, `results`,
`compileOutput`.

### `POST /items/{id}/submissions`

```json
{ "language": "python", "source": "...", "mode": "run", "stdin": null }
```

- `mode: "run"` with `stdin: null` runs the sample test cases. With a string
  `stdin` it executes once with that input and reports verdict `executed` (or a
  failure verdict).
- `mode: "submit"` runs every test case. `stdin` must be `null`.
- `422` if the item is a reading, the language is not offered by the engine,
  `source` is empty or over `limits.maxSourceBytes`, or there are no test cases
  to run. `503 judge_unavailable` only if no engine is configured. If an
  engine is configured but turns out to be unreachable, the submission is
  still accepted and completes with verdict `internal_error` and `error` set.

Returns `202` with the `Submission` in status `queued`. Judging is
asynchronous; poll `GET /submissions/{id}` until `status` is `completed`.

Side effects on the item's status: any submission moves `todo` →
`in_progress`; an `accepted` verdict in `submit` mode moves it to `done`.

### `GET /submissions/{id}`

Returns `Submission`.

### `GET /items/{id}/submissions`

Query: `mode` (optional filter), `limit`, `offset`. Newest first. Returns
`{ "items": [SubmissionSummary], "total": n }`.

## AI

These endpoints call the active AI provider (see [AI settings](#ai-settings))
synchronously and can take from a few seconds to a couple of minutes. They
never write to the library; the client saves results through the item and
test-case endpoints after the user has reviewed them. All return
`503 ai_unavailable` when no provider is configured and `502 upstream_error`
when the provider fails or returns output that does not validate.

If the client disconnects, the server cancels the provider request. Operators
who put a reverse proxy in front of the server must raise its read timeout for
`/api/v1/ai/` and `/api/v1/items/*/ai/` to at least five minutes.

### `POST /ai/draft`

Turn rough input into a complete item draft.

```json
{
  "text": "that problem where you have an array and a target and need two indices...",
  "typeHint": "auto",
  "instruction": null,
  "previousDraft": null,
  "styleId": "..."
}
```

- `text` — required, 1–50000 chars. Whatever the user has.
- `typeHint` — `auto` (default), `problem` or `reading`.
- `instruction` — optional extra guidance ("make it harder", "use 1-based
  indices").
- `previousDraft` — optional `ItemDraft` from an earlier call; with
  `instruction` this asks for a revision rather than a fresh draft.
- `styleId` — optional; which [style preset](#style-presets) to write in.
- `instruction` — at most 2000 characters.

Response:

```json
{
  "draft": {
    "type": "problem",
    "title": "Two Sum",
    "summary": "Find two indices whose values add up to a target.",
    "body": "## Problem\n\n...",
    "difficulty": "easy",
    "tags": ["array", "hash-map"],
    "problem": {
      "timeLimitMs": 2000,
      "memoryLimitKb": 262144,
      "compare": "tokens",
      "starterCode": { "python": "..." }
    },
    "testCases": [
      { "name": "Example 1", "stdin": "...", "expectedStdout": "...", "isSample": true }
    ],
    "assumptions": [
      "The original text did not give constraints; assumed 2 ≤ n ≤ 10^5.",
      "Assumed exactly one valid answer exists."
    ]
  },
  "style": { "id": "...", "name": "LeetCode style" }
}
```

`style` is the preset that was applied, or `null`.

`ItemDraft` maps directly onto `ItemInput` (the client adds `rawInput: text`
and sets each test case's `origin` to `ai`). `problem` is `null` and
`testCases` is `[]` for a reading. `assumptions` lists everything the model
inferred or invented that was not in the input; it is for display during
review and is not stored.

### `POST /items/{id}/ai/variant`

Draft a new item derived from an existing one — a fresh problem to practise
the same idea on, or a reading reworked for a different angle.

```json
{ "mode": "similar", "instruction": null, "previousDraft": null, "styleId": "..." }
```

`styleId` is optional and selects a [style preset](#style-presets).
`instruction` is at most 2000 characters. `previousDraft` is an optional
`ItemDraft` returned by an earlier call to this endpoint; with `instruction`
it asks for a revision of that variant rather than a fresh one.

| `mode` | Result |
| --- | --- |
| `similar` (default) | Same underlying technique and difficulty, different story, data and surface details |
| `easier` | A simplified version: smaller constraints or a relaxed requirement |
| `harder` | A stronger version: tighter constraints or an added requirement |
| `twist` | One rule changed so that the original approach no longer works as is |

`instruction` is optional free-form guidance and may be combined with any
mode. For readings only `similar` (with an `instruction`) is meaningful; the
other modes are `422`.

Returns `{ "draft": ItemDraft, "style": ... }` in the same shape as
`POST /ai/draft`. Here
`assumptions` describes how the variant differs from the original. The client
saves it with `POST /items`, setting `variantOf` to the original's id; the
original's tags and collections are a sensible default for the new item. Test
cases of the original are never copied, since they do not apply.

### `POST /items/{id}/ai/testcases`

Propose test cases for an existing problem.

```json
{ "count": 8, "language": "python", "instruction": null }
```

- `count` — 1–30, default 8.
- `language` — language for the reference solution; default `python`. If the
  item already has a reference solution it is given to the model as context.
- `instruction` — optional, at most 2000 characters.
- `422` for a reading.

Response:

```json
{
  "referenceSolution": { "language": "python", "source": "..." },
  "verification": { "attempted": true, "engine": "judge0", "error": null },
  "cases": [
    {
      "name": "Minimum size",
      "rationale": "Smallest allowed n.",
      "stdin": "2\n1 2\n3\n",
      "expectedStdout": "0 1\n",
      "predictedStdout": "0 1\n",
      "isSample": false,
      "verified": true,
      "predictionMatched": true,
      "error": null
    }
  ]
}
```

When a judge engine is available the server runs the reference solution on
each proposed input:

- Run succeeded → `expectedStdout` is the actual output, `verified` is `true`,
  and `predictionMatched` says whether the model's `predictedStdout` agreed
  with it under the item's compare mode.
- Run failed → `expectedStdout` is the model's prediction, `verified` is
  `false`, `predictionMatched` is `null`, and `error` describes the failure.

When no engine is available, `verification.attempted` is `false`, and every
case has `expectedStdout = predictedStdout`, `verified: false`,
`predictionMatched: null`. When an engine is configured but cannot be
reached, the proposal is still returned: `verification.attempted` is `true`,
`verification.error` says why, and the cases are unverified as above.

The client saves accepted cases with `POST /items/{id}/testcases/bulk`,
passing `origin: "ai"`, each case's `verified` flag, and the
`referenceSolution`.

## AI settings

Which provider the AI endpoints use, and its credentials. Settings saved here
are stored in the database; API keys are encrypted at rest and are never
returned by any endpoint. Environment variables (see `.env.example`) supply
values for anything not saved here, so an instance can also be configured
without the UI.

Providers:

| Id | Covers |
| --- | --- |
| `anthropic` | The Anthropic API |
| `openai_compatible` | Any endpoint speaking the OpenAI chat-completions API: OpenAI, OpenRouter, Ollama, LM Studio, vLLM, … |

### `GET /settings/ai`

```json
{
  "activeProvider": "anthropic",
  "providers": {
    "anthropic": {
      "model": "claude-opus-5-5",
      "baseUrl": null,
      "modelSource": "settings",
      "baseUrlSource": null,
      "apiKeySet": true,
      "apiKeyHint": "…x7Qa",
      "apiKeySource": "settings",
      "ready": true
    },
    "openai_compatible": {
      "model": null,
      "baseUrl": null,
      "modelSource": null,
      "baseUrlSource": null,
      "apiKeySet": false,
      "apiKeyHint": null,
      "apiKeySource": null,
      "ready": false
    }
  },
  "defaults": {
    "anthropic": { "model": "claude-opus-5-5", "baseUrl": "https://api.anthropic.com" },
    "openai_compatible": { "model": null, "baseUrl": "https://api.openai.com/v1" }
  }
}
```

- Every provider id is always present under `providers`.
- `model` and `baseUrl` are the effective values (saved, else environment,
  else `null`); `defaults` are what the server uses when they are `null`.
  `modelSource` and `baseUrlSource` say where each came from: `settings`,
  `environment`, or `null` when the default applies.
- `apiKeyHint` is `…` plus the last four characters. `apiKeySource` is
  `settings`, `environment` or `null`.
- `ready` — the provider has everything it needs, counting defaults: a model,
  plus an API key for `anthropic`. A key is optional for `openai_compatible`
  (local servers), which requires a model and a base URL.
- `activeProvider` is `null` when none is selected; AI features are then off.

### `PUT /settings/ai`

Merge update. Every field is optional.

```json
{
  "activeProvider": "anthropic",
  "providers": {
    "anthropic": { "model": "claude-opus-5-5", "baseUrl": null, "apiKey": "sk-ant-..." }
  }
}
```

- `apiKey` omitted → the stored key is unchanged. `apiKey: null` → the stored
  key is deleted (an environment key, if any, applies again). A string
  replaces it; an empty string is treated like an omitted key.
- `model: null` / `baseUrl: null` clear the saved value.
- `activeProvider: null` turns AI features off. Selecting a provider that is
  not `ready` after the update is `422`.

Returns the same body as `GET /settings/ai`.

### `POST /settings/ai/test`

Makes one minimal request to a provider to check that the configuration
works. Nothing is saved.

```json
{ "provider": "anthropic", "model": null, "baseUrl": null, "apiKey": null }
```

Only `provider` is required. Any of `model`, `baseUrl`, `apiKey` given here
override the saved values for this test, so the UI can test a key before
saving it.

```json
{ "ok": true, "model": "claude-opus-5-5", "latencyMs": 640, "error": null }
```

Always `200` when the request itself is valid; a provider failure is reported
as `ok: false` with a safe, human-readable `error` (never echoing the key).

## Style presets

A style preset is a short set of the user's own standing instructions for how
generated items should be written: layout of the statement, tone, which
starter languages to include. Users keep several and pick one per generation.

`StylePreset`:

```json
{
  "id": "...",
  "name": "LeetCode style",
  "instructions": "Short description, then Example blocks with Input / Output / Explanation, then a Constraints list. Starter code in Python and Go only.",
  "isDefault": true,
  "createdAt": "...",
  "updatedAt": "..."
}
```

Hard limits, enforced by the server for every caller and not configurable:

| Limit | Value |
| --- | --- |
| `name` | 1–60 characters, unique (case-insensitive) |
| `instructions` | 1–2000 characters |
| Presets per instance | 20 |

Lengths are counted in Unicode code points after trimming surrounding
whitespace. Control characters other than newline and tab are rejected; a
`name` must also be a single line, so newline and tab are rejected there too
(`\r\n` and `\r` count as newlines).
Violations are `422 validation_failed`; a 21st preset is `409 conflict`.
`instructions` is never truncated silently.

At most one preset has `isDefault: true`. Setting it on one preset clears it
on the others in the same transaction. With no default, generation uses the
built-in conventions alone unless a request names a preset.

| Endpoint | Behaviour |
| --- | --- |
| `GET /styles` | `{ "items": [StylePreset] }`, default first, then by name. Not paginated |
| `POST /styles` | Body `{ "name", "instructions", "isDefault"? }`. `201` `StylePreset` |
| `PATCH /styles/{id}` | Any of `name`, `instructions`, `isDefault`. Returns `StylePreset` |
| `DELETE /styles/{id}` | `204`. Deleting the default leaves no default |

A preset shapes prose and layout only. It is inserted into the prompt as a
clearly delimited block of *preferences* after the built-in authoring
conventions; it cannot change the response schema, and where it conflicts
with a rule the app depends on (the JSON structure, the stdin/stdout
convention) the built-in rule wins.

Presets are local configuration. They are never written to or read from
bundles and cannot be created or modified over MCP, so the only way
instructions get into this slot is the instance's own user typing them.
They are independent of the AI provider and remain when it changes.

### Choosing a preset for a generation

`POST /ai/draft` and `POST /items/{id}/ai/variant` accept a `styleId` field:

| `styleId` | Style applied |
| --- | --- |
| omitted | The default preset, if there is one |
| `null` | None — built-in conventions only |
| a preset id | That preset; unknown id is `422` |

Both responses carry, next to `draft`, the preset that was actually applied:
`"style": { "id": "...", "name": "LeetCode style" }`, or `"style": null`.
Presets do not apply to `POST /items/{id}/ai/testcases`.

## Import and export

Bundle layout and semantics are specified in `bundle-format.md`.

### `POST /export`

```json
{
  "scope": "collection",
  "collectionId": "...",
  "itemIds": [],
  "name": "DP study plan",
  "description": "",
  "author": "",
  "includeSolutions": true,
  "includeHiddenTests": true
}
```

- `scope` — `all`, `collection` (that collection and its descendants, with
  their items) or `items` (exactly `itemIds`; no collections are exported).
  A `collectionId` or an entry of `itemIds` that does not exist is `422`.
- `includeSolutions: false` omits reference solutions.
  `includeHiddenTests: false` exports sample test cases only.
- `name` defaults to the collection name or `"Codeathropy library"`.

Returns `200` `application/zip` with
`Content-Disposition: attachment; filename="<slug>.codeathropy.zip"`.

### `POST /import/preview`

`multipart/form-data` with a single `file` part (the bundle zip). Writes
nothing.

```json
{
  "bundle": { "name": "DP study plan", "description": "", "author": "", "formatVersion": 1, "createdAt": "..." },
  "items": [
    { "id": "...", "title": "Two Sum", "type": "problem", "state": "new", "testCaseCount": 6, "changes": [] }
  ],
  "collections": [
    { "id": "...", "name": "Dynamic Programming", "state": "existing", "itemCount": 12 }
  ],
  "counts": { "new": 10, "changed": 2, "unchanged": 5 },
  "warnings": ["items/foo/item.json: unknown language \"brainfuck\" in starter code; ignored"]
}
```

Item `state`: `new` (id not in the library), `unchanged` (id present, content
identical), `changed` (id present, content differs). Collection `state`: `new`
or `existing`.

For a `changed` item, `changes` names what differs from the local item, so
the user can choose a strategy knowingly. Values are content field names —
`type`, `title`, `summary`, `body`, `difficulty`, `tags`, `source`, `variantOf`,
`limits`, `compare`, `starterCode`, `referenceSolution`, `testCases` — in
that order. It is `[]` for `new` and `unchanged` items.

`422 validation_failed` if the archive is not a valid bundle or its
`formatVersion` is newer than the server supports.

### `POST /import`

`multipart/form-data` with `file` and a `strategy` field:

| `strategy` | Effect on `changed` items |
| --- | --- |
| `skip` (default) | Keep the local item untouched |
| `overwrite` | Replace content and test cases with the bundle's; personal state and submissions are kept |
| `duplicate` | Import as a separate new item with a fresh id |

`new` items are always created; `unchanged` items are always left alone.
Collections are created if missing; bundle membership is merged into existing
collections (items not already members are appended in bundle order). The
whole import is one transaction.

```json
{ "created": 10, "updated": 2, "skipped": 0, "duplicated": 0, "unchanged": 5, "collectionsCreated": 1, "warnings": [] }
```
