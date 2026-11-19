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
{ "error": { "code": "validation_failed", "message": "title: is required", "fields": { "title": "is required" } } }
```

`message` is a human-readable sentence for display. For `validation_failed`
it names the first offending field (in sorted order) and its problem, as
`<field>: <problem>`, followed by "(and N more problems)" when there are
several; `fields` maps every offending field to its problem and is the part
to use programmatically.

`fields` is present only for `validation_failed`, and for a `conflict` that
reports the current state (the item revision conflict described under
`PATCH /items/{id}`, where `fields.revision` is a number).

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | Malformed JSON, bad query parameter, unreadable upload |
| 403 | `forbidden` | The `Host` header is not an accepted name for this server, or a state-changing request was sent from a web page on another origin (see [Host and origin checks](#host-and-origin-checks)) |
| 404 | `not_found` | Resource does not exist |
| 405 | `bad_request` | The path exists but does not support this method; the `Allow` header lists the ones it does |
| 409 | `conflict` | Request conflicts with current state (e.g. a collection cycle) |
| 413 | `too_large` | Body or upload exceeds a limit |
| 422 | `validation_failed` | Well-formed but invalid |
| 502 | `upstream_error` | The AI provider or judge engine returned an error; `message` carries a safe summary |
| 503 | `ai_unavailable` | No default AI provider is chosen, or it is not ready |
| 503 | `judge_unavailable` | No judge engine is configured, or it is unreachable |
| 500 | `internal` | Unexpected server error |

### Host and origin checks

Two checks protect an instance that has no authentication. Both apply to
every request under `/api/` and to the MCP endpoint; the UI's static files
are served for any host.

1. **Host allow-list** (against DNS rebinding, applied first). The `Host`
   header must name the server: a loopback name or address (`localhost`,
   `*.localhost`, `127.0.0.0/8`, `::1`) with any port, the host of
   `CODEATROPHY_PUBLIC_URL`, the host of any origin in
   `CODEATROPHY_ALLOWED_ORIGINS` or `CODEATROPHY_MCP_ALLOWED_ORIGINS`, or a
   host listed in `CODEATROPHY_ALLOWED_HOSTS` (comma-separated host names or
   addresses; ports are ignored; `*` accepts any host and turns the check
   off). Anything else — including a LAN address such as `192.168.1.20` that
   is not listed — is `403 forbidden`, whatever the method, with a message
   naming `CODEATROPHY_PUBLIC_URL` and `CODEATROPHY_ALLOWED_HOSTS`.
2. **Origin check** (against cross-site request forgery). Requests other
   than `GET`, `HEAD` and `OPTIONS` that carry an `Origin` header are
   accepted only from a loopback origin (such as the UI dev server on
   `http://localhost:5173`), an origin listed in
   `CODEATROPHY_ALLOWED_ORIGINS` (which includes `CODEATROPHY_PUBLIC_URL`),
   or an origin whose host is listed in `CODEATROPHY_ALLOWED_HOSTS`. The
   origin is compared with this configured set, never with the request's
   own `Host` header. `Origin: null` is rejected.

### Single-line fields

Item `title`, tags, collection `name`, style preset `name` and solution
`name` are single-line fields: besides their length limits they reject every
control character (newline, tab and U+0085 included) and the Unicode line
and paragraph separators U+2028 and U+2029 (`422 validation_failed`). `\r\n`
and `\r` count as newlines.

## Enumerations

| Name | Values |
| --- | --- |
| `ItemType` | `problem`, `reading` |
| `Difficulty` | `easy`, `medium`, `hard` |
| `ItemStatus` | `todo`, `in_progress`, `done` |
| `ProblemInterface` | `program` (a submission is a complete program that reads stdin and writes stdout), `function` (a submission is only the solution — a function or class — and a hidden per-language harness turns it into such a program; see [Problem interface](#problem-interface)) |
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
  "ai": { "enabled": true, "providerId": "...", "providerName": "Personal key", "kind": "anthropic", "model": "claude-opus-5-5" },
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
    "maxImportEntries": 1000000,
    "maxImportCollections": 10000,
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
    "maxLargeInputBytes": 1048576,
    "maxLargeTestCases": 5,
    "maxStylePresets": 20,
    "maxStyleNameChars": 60,
    "maxStyleInstructionsChars": 2000,
    "maxSystemPromptChars": 20000,
    "maxModelIdChars": 200,
    "maxApiKeyChars": 1000,
    "maxAiProviders": 20,
    "maxAiProviderNameChars": 60,
    "minAiTimeoutSeconds": 10,
    "maxAiTimeoutSeconds": 300,
    "maxBundleNameChars": 200,
    "maxBundleDescriptionChars": 5000,
    "maxSolutionsPerItem": 50,
    "maxSolutionNameChars": 100,
    "maxSolutionNotesChars": 5000
  }
}
```

- `limits` publishes every bound the server enforces on user input, so
  clients validate against the server's values rather than copies of them.
  `maxTextBytes` applies to each of an item's `body`, `notes` and `rawInput`;
  `maxTestDataBytes` to each of a test case's `stdin` and `expectedStdout`;
  `maxGeneratedTestCases` is the upper bound of `count` in
  `POST /items/{id}/ai/testcases`; `maxLargeInputBytes` is the largest input
  a [large test case](#large-test-cases) may have and `maxLargeTestCases` the
  most of them one generation may ask for. A source URL must be `http`
  or `https`.
  `maxTestDataBytes` also bounds the custom `stdin` of a run.
  `maxRequestBytes` bounds any JSON request body (`413` beyond it);
  `maxPageSize` is the largest `limit`. `maxPreviousDraftBytes` bounds the
  re-encoded `previousDraft` of a draft or variant revision.
  `maxModelIdChars`, `maxApiKeyChars`, `maxAiProviders` and
  `maxAiProviderNameChars` bound [AI providers](#ai-settings);
  `minAiTimeoutSeconds` and `maxAiTimeoutSeconds` bound the request timeout
  set there.
  `maxBundleNameChars` applies to an export's `name` and `author`,
  `maxBundleDescriptionChars` to its `description`. `maxImportUncompressedBytes`
  and `maxImportEntries` bound the contents of an uploaded bundle
  (`413` beyond them); `maxImportCollections` bounds the number of
  collections in one bundle (`422` beyond it). The import limits are set so
  that an export of any library this instance holds can be read back, but
  restoring a large export may need a higher `CODEATROPHY_MAX_IMPORT_BYTES`
  (which sets `maxImportBytes` and, at four times that,
  `maxImportUncompressedBytes`).
  `maxSolutionsPerItem`, `maxSolutionNameChars` and `maxSolutionNotesChars`
  bound [solutions](#solutions). `maxSystemPromptChars` bounds a
  [custom system prompt](#system-prompt) and a
  [custom test case prompt](#test-case-prompt).
- `mcp.url` is the full public URL of the MCP endpoint when the operator has
  set `CODEATROPHY_PUBLIC_URL`, otherwise `null`; a client then derives it
  from its own origin plus `mcp.path`.
- `ai.enabled` is `true` when a default provider is chosen and `ready` (see
  [AI settings](#ai-settings)); `providerId`, `providerName`, `kind` and
  `model` then describe it, `model` being the one in effect. When `false`,
  all four are `null`.
- `judge.enabled: false` (engine `none`) → `healthy` is `false`, `languages` is `[]`.
- `judge.healthy` reflects a recent health probe; it may lag by a few seconds.

### `GET /stats`

```json
{
  "items": {
    "total": 42,
    "byType": { "problem": 30, "reading": 12 },
    "byStatus": { "todo": 20, "in_progress": 5, "done": 17 },
    "byDifficulty": { "easy": 10, "medium": 15, "hard": 5, "none": 12 },
    "favorites": 7,
    "uncollected": 9
  },
  "collections": 6,
  "tags": 18,
  "submissions": { "total": 120, "accepted": 31 }
}
```

All enum keys are always present, with `0` when empty.
`items.favorites` and `items.uncollected` are the counts the library's
Favorites and Uncollected views show: each equals the `total` of `GET /items`
with only `favorite=true`, or only `uncollected=true`, as the filter.
`submissions.total` counts `submit`-mode submissions only, and
`submissions.accepted` those of them whose verdict is `accepted`. Runs are
not counted: a `run` whose sample cases all pass adds to neither. `tags`
counts the tags at least one item carries; empty tags (see [Tags](#tags))
are left out.

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
  `difficulty`, `tags`, `source`, `variantOf` or anything under `problem`.
  That includes the reference solution: whenever the language or source that
  `problem.referenceSolution` reports changes, by whatever endpoint. It does
  not change for personal state (`status`, `favorite`, `notes`), collection
  membership, test-case changes, changes to other saved solutions, or a
  request that leaves every field as it was.
- `updatedAt` is the time of the last content change: whenever `revision`
  increases, and whenever the item's test cases or solutions change. Personal state and
  collection membership do not move it, so sorting by `updated` is stable
  under starring and status changes.
- `variantOf` is the id of the item this one was derived from, or `null`.
  `variantCount` is the number of items whose `variantOf` is this item.
  Deleting an item clears `variantOf` on its variants.
- `difficulty` is nullable for both types.
- `testCaseCount` is `0` and `lastVerdict` is `null` for readings.
- `solutionCount` (a number, next to `testCaseCount`) is how many
  [solutions](#solutions) are saved for the item; `0` for readings.
- `lastVerdict` is the verdict of the most recent *completed* `submit`-mode
  submission, or `null` if there is none. A submission still being judged
  does not affect it.
- `tags` are lower-cased, trimmed, de-duplicated and sorted by the server. A
  tag is a [single line](#single-line-fields) and may not contain `/` (`422`).

`Item` — everything in `ItemSummary` plus:

```json
{
  "body": "## Problem\n\nGiven an array ...",
  "notes": "",
  "rawInput": "two sum, array + target, return indices, O(n)?",
  "source": { "url": null, "note": null },
  "problem": {
    "interface": "program",
    "timeLimitMs": 2000,
    "memoryLimitKb": 262144,
    "compare": "tokens",
    "starterCode": { "python": "import sys\n..." },
    "harness": {},
    "referenceSolution": { "id": "...", "language": "python", "source": "..." }
  }
}
```

- `problem.referenceSolution` is a view of the item's saved
  [solution](#solutions) that is marked as the reference, or `null` when none
  is. Writing `{ "language", "source" }` to it (through `PATCH /items/{id}` or
  `testcases/bulk`) updates that solution in place, or creates one named
  "Reference solution" if there is none; an `id` in the written value is
  ignored. Writing `null` only removes the reference mark — the solution
  itself stays saved.
- `body` is Markdown (GitHub-flavoured, with `$...$` / `$$...$$` math).
- `notes` is the user's private Markdown notes. `rawInput` is the original
  text an AI draft was generated from, or `null`. Neither is ever exported.
- `problem` is `null` for readings and always an object for problems.
  `referenceSolution` is nullable. `starterCode` is keyed by language id.
- Starter code may mark lines the solver need not read, such as input
  parsing, as a [folded region](#folded-regions).
- `problem.interface` and `problem.harness` are described under
  [Problem interface](#problem-interface).

#### Problem interface

Every problem is judged the same way: a program is run with a test case's
`stdin` and its standard output is compared with `expectedStdout`. The
interface says what the person solving it writes.

- `program` (the default) — the whole program. `harness` is `{}`.
- `function` — only the solution: a function or a class, as on interview
  sites. `starterCode[language]` is the stub they start from (the signature,
  with any helper types described in comments), and `harness[language]` is
  code they do not have to look at:

  ```json
  "harness": {
    "python": {
      "prefix": "import json, sys\n\nclass ListNode: ...\n",
      "suffix": "\nif __name__ == \"__main__\":\n    ...\n"
    }
  }
  ```

  The program that runs is `prefix`, the submitted source and `suffix`, each
  starting on a new line. The prefix defines what the solution relies on
  (imports, helper types); the suffix reads the test case from stdin, calls
  the solution and prints the result.

Rules:

- A `function` problem can be run in exactly the languages that have a
  `harness` entry; any other language is `422`. It may be saved with no
  entries (it cannot be run until one is added). With `program`, a non-empty
  `harness` is `422`.
- `prefix` and `suffix` are each at most `limits.maxSourceBytes`; either may
  be empty. Keys are language ids.
- Wherever the server runs code for the item — submissions, `testcases/verify`
  and the verification step of AI test generation and drafts — it assembles
  the program this way. Saved [solutions](#solutions), including the
  reference solution, therefore hold only the solution part.
- `interface` may be changed later; saved solutions are not converted. A
  `PATCH` that sets `interface: "program"` on a problem with a stored harness
  must send `harness: {}` with it (`422` otherwise), so runner code is never
  discarded by accident.
- Test cases stay plain stdin/stdout. By convention (not enforced) the stdin
  of a `function` problem carries one JSON value per line, one line per
  argument in signature order, and the expected output is the return value
  as one JSON value. For a function that returns a value and also changes
  an argument in place, it is two lines, `k = 2` and `nums = [1,2]`.

#### Folded regions

A convention of the code text, not a field: the server stores and returns
starter code unchanged, and the UI's editor opens a marked region folded to
its first line, which the solver can expand.

- A region opens with a line that holds only a line comment (`#`, `//` or
  `--`) reading `region`, optionally followed by a label, and closes with the
  next such line reading `endregion`: `# region input` … `# endregion`,
  `// region input` … `// endregion`. Whitespace before the comment and
  between the comment marker and the word is allowed, and so is text after
  `endregion`.
- Regions may nest; the outermost one is folded. A marker without its partner
  is ordinary text.
- It is meant for the starter code of a `program` problem, where the lines
  that read the input sit in the solver's own code. A `function` problem
  keeps such code in the `harness` instead.

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
  "problem": { "interface": "program", "timeLimitMs": 2000, "memoryLimitKb": 262144, "compare": "tokens", "starterCode": {}, "harness": {}, "referenceSolution": null },
  "collectionIds": [],
  "variantOf": null,
  "testCases": []
}
```

Only `type` and `title` are required on create; everything else defaults as
shown. `type` cannot be changed after creation. `testCases` (an array of
`TestCaseInput`) is accepted on create only, so a reviewed AI draft is saved
atomically with its sample cases. Validation: `title` 1–200 chars, a
[single line](#single-line-fields); `timeLimitMs` 100–30000; `memoryLimitKb` 16384–2097152; at most 30 tags of 1–40
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

### `GET /items/facets`

Counts the items of a filtered list by status, difficulty and tag, for the
library's filter menus. Takes the filters of `GET /items`; `sort`, `order`,
`limit` and `offset` are ignored, and an invalid filter is `400` as there.

```json
{
  "byStatus": { "todo": 14, "in_progress": 5, "done": 23 },
  "byDifficulty": { "easy": 10, "medium": 15, "hard": 5, "none": 12 },
  "byTag": { "array": 7, "graph": 2 }
}
```

Each count is how many items with that value the list shows once the value
is picked as well:

- `byStatus` is counted with every filter except `status`, and
  `byDifficulty` with every filter except `difficulty`, since values within
  one parameter combine with OR.
- `byTag` is counted with every filter, `tag` included, since tags combine
  with AND.

`byStatus` and `byDifficulty` have every key, with `0` when empty; `byTag`
has only the tags the counted items carry.

### `POST /items`

Body `ItemInput`. Returns `201` `Item`.

### `POST /items/check`

Check a problem that is not saved yet: run its reference solution on its test
cases. This is the [check a draft gets](#post-aidraft) when it arrives, made
available for the problem as it stands after editing. Nothing is stored and
no AI provider is involved.

```json
{ "problem": { "...": "as in ItemInput" }, "testCases": [ { "stdin": "...", "expectedStdout": "..." } ] }
```

`problem` and `testCases` are validated as in `ItemInput` (`422`); other keys
of an `ItemInput` are accepted and ignored, so a client can send the item it
is about to save.

```json
{
  "check": { "attempted": true, "engine": "judge0", "passed": 6, "total": 6, "error": null, "runners": [], "largeCases": [] },
  "cases": [ { "outcome": "passed", "error": null } ]
}
```

`check` has the shape and meaning it has for a draft, with two differences:
every test case is run, not only the first ten, and the time bound is five
minutes. `cases` has one entry per test case, in order, with its `outcome`:

| `outcome` | Meaning |
| --- | --- |
| `passed` | The run finished and its output matched the expected output under the problem's compare mode: the case is verified |
| `wrong` | The run finished and its output differs from the expected output |
| `failed` | The reference solution did not compile, crashed or exceeded a limit on this case; `error` says which |
| `not_run` | The check did not get to it: its time ran out or the engine failed; `error` says which |

`error` is `null` for `passed` and `wrong`. A client can offer to drop the
`wrong` and `failed` cases; when every case has one of those outcomes the
reference solution or the runner is the likelier culprit. Expected outputs
are never changed. `largeCases` is always `[]`. Without a judge engine, a reference solution or a test case the
answer is `attempted: false`, as for a draft, not an error. A body with a
`type` other than `problem`, or without `problem`, is `422`.

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

Deletes the item, its test cases, its solutions and its submissions. Items
that were variants of it lose their `variantOf` link; for each of them that
is a content change, so its `revision` increases and its `updatedAt` moves.

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
| `POST /items/{id}/testcases/bulk` | Body `{ "cases": [TestCaseInput], "replace": false, "referenceSolution": null }`. Appends, or with `replace: true` replaces every existing case except the samples, which keep their order and come first. A non-null `referenceSolution` (`{language, source}`) is stored on the item in the same transaction. Returns `{ "items": [TestCase] }` — the full list after the change |
| `PATCH /testcases/{id}` | Partial `TestCaseInput`. Returns `TestCase` |
| `DELETE /testcases/{id}` | `204` |
| `PUT /items/{id}/testcases/order` | Body `{ "ids": [...] }` — must be exactly the item's case ids. Returns `{ "items": [TestCase] }` |
| `POST /items/{id}/testcases/verify` | See below |

All of these return `422` for a reading. `POST /items/{id}/testcases/bulk`
also accepts an optional `expectedRevision`, checked as for `PATCH /items/{id}`;
it matters when the request stores a reference solution, which is item
content.

### `POST /items/{id}/testcases/verify`

Executes a saved solution against every test case. Requires a judge engine.

Body: `{ "updateExpected": false, "solutionId": null }`

`solutionId` selects which of the item's [solutions](#solutions) to run; when
`null` or omitted, the reference solution is used (`422` if the item has
none, or if `solutionId` is not one of this item's solutions). For a
`function` problem the solution's language must have a harness, and the
assembled program must be of a size the engine accepts (`422` on
`solutionId`, or on `referenceSolution` when none was given); a solution in
another language can be saved but not run.

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
- With the reference solution (`solutionId` omitted, `null`, or the
  reference solution's id), every case's `verified` is set from the result:
  `true` when `ok && matches`, `false` otherwise. With
  `updateExpected: true`, cases that are `ok && !matches` instead have their
  expected output replaced by `actualStdout` and are marked `verified`
  (unless `actualStdout` is not valid UTF-8 or exceeds
  `limits.maxTestDataBytes`, in which case they are left unverified). A case
  whose run failed in the engine itself (`internal_error` because the engine
  failed, not because of the program) keeps its flag. A change to that item's
  test cases moves `updatedAt`, never `revision`.
- With any other solution, the run is a check only: results are returned and
  nothing is changed. `updateExpected: true` with a non-reference solution is
  `422`.

Synchronous; may take as long as the cases take to run. `503
judge_unavailable` if no engine is configured or the engine cannot be reached;
nothing is changed in that case. If the engine fails part-way through, the
results that finished are kept, no further cases are started, and the rest
are reported with verdict `internal_error`. If the reference solution or a
case is changed while the run is in progress, the changed cases (or, for a
changed reference, all cases) are left as they are.

## Solutions

A problem can keep any number of saved solutions: different approaches, the
same approach in several languages, a brute force next to the intended one.
They are part of the item's content — exported in bundles unless solutions
are left out — and are separate from submissions, which are the history of
what was submitted.

At most one solution per item is the **reference solution**: the one used to
compute and verify expected outputs. It is also what
`problem.referenceSolution` on the item reports.

`Solution`:

```json
{
  "id": "...",
  "itemId": "...",
  "name": "Hash map, one pass",
  "language": "python",
  "source": "...",
  "notes": "O(n) time, O(n) space.",
  "isReference": true,
  "createdAt": "...",
  "updatedAt": "..."
}
```

`SolutionInput`: `name` (required, single line, 1–`limits.maxSolutionNameChars`),
`language` (required; any canonical language id, whether or not the judge
currently offers it), `source` (required, non-empty, at most
`limits.maxSourceBytes`), `notes` (Markdown, default `""`, at most
`limits.maxSolutionNotesChars`), `isReference` (default `false`).

Setting `isReference: true` on one solution clears it on the item's others in
the same transaction. An item holds at most `limits.maxSolutionsPerItem`
solutions (`409 conflict` beyond that).

| Endpoint | Behaviour |
| --- | --- |
| `GET /items/{id}/solutions` | `{ "items": [Solution] }`, the reference solution first, then oldest first. Not paginated |
| `POST /items/{id}/solutions` | Body `SolutionInput`. `201` `Solution` |
| `PATCH /solutions/{id}` | Partial `SolutionInput`. Returns `Solution` |
| `DELETE /solutions/{id}` | `204`. Deleting the reference solution leaves the item without one |

All of these return `422` for a reading. Changing the reference solution's
language or source, or which solution is the reference, changes
`problem.referenceSolution` and therefore the item's `revision`; `POST` and
`PATCH` accept an optional `expectedRevision` for that case, checked as for
`PATCH /items/{id}`. Other solution changes leave `revision` alone. Changing a
reference solution does not reset `verified` on test cases; run
`testcases/verify` again to re-check them.

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
| `GET /tags` | `{ "items": [ { "name": "array", "count": 7 }, { "name": "graph", "count": 0 } ] }` sorted by name; every tag, empty ones included |
| `PATCH /tags/{name}` | Body `{ "name": "new-name" }`. Renames across all items; if the new name already exists the two are merged into one tag. Returns `{ "name": "new-name", "count": n }` |
| `DELETE /tags/{name}` | Removes the tag from all items and deletes it. `204` |

A tag exists from the first time an item carries it (however the item was
written: created, edited, bulk-tagged, imported or drafted) until it is
deleted. When its last item drops it, it stays as an *empty* tag with
`count: 0`, which can still be renamed, merged and deleted. Bundles carry
only the tags of their items, so empty tags are not exported.

`{name}` is URL-encoded. Both endpoints are `404` for a tag that does not
exist.

## Submissions

`Submission`:

```json
{
  "id": "...",
  "itemId": "...",
  "mode": "submit",
  "language": "python",
  "source": "...",
  "lineOffset": 0,
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
  are absent. Results may arrive in groups rather than one at a time (an
  engine that runs cases in batches reports a batch when it finishes), and
  not necessarily in case order; each result's position in `results` is its
  case order regardless. `stdin`, `expectedStdout`, `stdout` and `stderr` are each
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
- `source` is what was submitted: for a `function` problem, the solution part
  only. `lineOffset` is the number of lines the harness placed before it in
  the program that ran (`0` for a `program` problem). In `compileOutput` and
  `stderr` the server rewrites line numbers that refer to the assembled file
  to the corresponding line of `source` where it recognises the toolchain's
  message format. A location inside the harness is shown with the file name
  replaced by `<runner prefix>` or `<runner suffix>` and a line number
  relative to that part. This is best effort, and `lineOffset` lets a client
  explain any number that was not rewritten.
- If the engine fails part-way through, the results that finished are kept,
  no further cases are started, and the remaining cases are reported as
  `internal_error`.
- Submissions still `queued` or `running` when the server stops are not
  resumed: at the next start they are completed with verdict `internal_error`
  and an `error` saying judging was interrupted.

`SubmissionSummary` is `Submission` without `source`, `results`,
`compileOutput`; it keeps `lineOffset`.

### `POST /items/{id}/submissions`

```json
{ "language": "python", "source": "...", "mode": "run", "stdin": null }
```

- `mode: "run"` with `stdin: null` runs the sample test cases. With a string
  `stdin` it executes once with that input and reports verdict `executed` (or a
  failure verdict).
- `mode: "submit"` runs every test case. `stdin` must be `null`.
- `422` if the item is a reading, the language is not offered by the engine
  or, for a `function` problem, has no harness, `source` is empty or over `limits.maxSourceBytes`, or there are no test cases
  to run. Also `422` (on `source`) if the assembled program of a `function`
  problem is larger than the engine accepts for that language. `503 judge_unavailable` only if no engine is configured. If an
  engine is configured but turns out to be unreachable, the submission is
  still accepted and completes with verdict `internal_error` and `error` set.

Returns `202` with the `Submission` in status `queued`. Judging is
asynchronous; poll `GET /submissions/{id}` until `status` is `completed`.

Only submits are kept as history. A run is a submission too, so that it can
be judged and polled like one, but creating a run deletes the item's earlier
runs whose `status` is `completed`, with their results; runs still `queued`
or `running` are left for the next run to delete. A problem therefore keeps
its latest run (and any still being judged), and `GET /submissions/{id}` of
an earlier one is `404`.

Side effects on the item's status: any submission moves `todo` →
`in_progress`; an `accepted` verdict in `submit` mode moves it to `done`.

### `GET /submissions/{id}`

Returns `Submission`.

### `GET /items/{id}/submissions`

Query: `mode` (optional filter), `limit`, `offset`. Newest first. Returns
`{ "items": [SubmissionSummary], "total": n }`. With `mode=submit` it is the
problem's submission history; `mode=run` lists at most the latest run and
any still being judged.

## AI

These endpoints call an AI provider (see [AI settings](#ai-settings))
synchronously and can take from a few seconds to a couple of minutes. They
never write to the library; the client saves results through the item and
test-case endpoints after the user has reviewed them. All return
`502 upstream_error` when the provider fails or returns output that does not
validate.

Each of them takes an optional `providerId`: the provider to use for this
request, with the model saved on it. It must name a provider that is
`ready` (`422` on `providerId` otherwise), and it does not change the
default. Without it, or with `null`, the default provider is used, and the
answer is `503 ai_unavailable` when no default is chosen and ready. A
request that names a provider works whether or not there is a default.

If the client disconnects, the server cancels the provider request. Operators
who put a reverse proxy in front of the server must raise its read timeout for
`/api/v1/ai/`, `/api/v1/items/*/ai/` and `/api/v1/items/check` to at least six
minutes.

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
- `interfaceHint` — `auto` (default), `program` or `function`: the
  [interface](#problem-interface) a drafted problem should have. With `auto`
  the model chooses: `function` for an algorithmic problem whose natural form
  is a function or class, `program` when input and output handling is part of
  the task or the problem is not about one routine. An explicit value
  overrides the model's choice; with `program` any harness it wrote is
  dropped. `program` or `function` together with `typeHint: "reading"` is
  `422`.
- `instruction` — optional extra guidance ("make it harder", "use 1-based
  indices").
- `previousDraft` — optional `ItemDraft` from an earlier call; with
  `instruction` this asks for a revision rather than a fresh draft.
- `styleId` — optional; which [style preset](#style-presets) to write in.
- `instruction` — at most 2000 characters.
- `largeTestCases` — integer 0–`limits.maxLargeTestCases`, default `0`: also
  build that many [large test cases](#large-test-cases). Ignored for a
  reading.
- `providerId` — optional; the [provider](#ai) to use instead of the default.

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
      "interface": "function",
      "timeLimitMs": 2000,
      "memoryLimitKb": 262144,
      "compare": "tokens",
      "starterCode": { "python": "class Solution:\n    def twoSum(self, nums: list[int], target: int) -> list[int]:\n        " },
      "harness": { "python": { "prefix": "...", "suffix": "..." } },
      "referenceSolution": { "language": "python", "source": "..." }
    },
    "testCases": [
      { "name": "Example 1", "stdin": "...", "expectedStdout": "...", "isSample": true, "verified": true }
    ],
    "assumptions": [
      "The original text did not give constraints; assumed 2 ≤ n ≤ 10^5.",
      "Assumed exactly one valid answer exists."
    ]
  },
  "style": { "id": "...", "name": "LeetCode style" },
  "check": {
    "attempted": true, "engine": "judge0", "passed": 1, "total": 1, "error": null,
    "runners": [{ "language": "python", "status": "ok", "error": null }],
    "largeCases": []
  },
  "usage": {
    "logId": "...", "model": "claude-haiku-5-5", "durationMs": 48200,
    "inputTokens": 5210, "outputTokens": 4380,
    "reasoningTokens": null, "cacheReadTokens": 0, "cacheWriteTokens": 0
  }
}
```

`style` is the preset that was applied, or `null`.

`usage` is what the generation cost, as the provider reported it: the model
that answered, the time the provider took, and the token counts. Each count
is `null` when the provider does not report it. `outputTokens` is everything
generated, including reasoning; `reasoningTokens` is the part of it spent on
reasoning where the provider says so; `cacheReadTokens` and
`cacheWriteTokens` are input tokens served from or written to the provider's
prompt cache, counted in addition to `inputTokens`. `logId` is the entry in
the [AI activity log](#ai-activity-log) (`null` if it could not be written).
Every AI endpoint that generates (`/ai/draft`, `/items/{id}/ai/variant`,
`/items/{id}/ai/testcases`) returns `usage`, and the server's own log gets
the same figures, never the content.

For a problem the model also writes a reference solution
(`problem.referenceSolution`, `null` if it gave none; for a `function`
problem it is the solution part, and should be in a language that has a
harness; one that is not is kept, and `check.error` says so). When a
judge engine is available the server runs it on the draft's test cases —
through the harness for a `function` problem — so a wrong example or a
broken harness shows before anything is saved:

- each test case's `verified` is `true` when the run finished and its output
  matched `expectedStdout` under the draft's compare mode, else `false`;
- `check` summarises it: `passed` of `total` cases, and `error` with the
  first failure in plain words (a compile error, a mismatch, …). Nothing in
  the draft is corrected automatically, with one exception: a Python harness
  prefix that lacks `from __future__ import annotations` gets it added.
- the check is bounded: at most the first 10 test cases and 50 seconds. Cases
  it did not reach stay unverified, and `check.error` says how far it got.

`check.attempted` is `false` (with `engine: null`, `passed: 0`, `error: null`
and every `verified` `false`) when there is no engine, no reference solution
or no test case; `total` is still the number of test cases. `check` is `null`
for a reading. An engine that cannot be reached is not a failed request:
`attempted` is `true`, `passed` is `0` and `check.error` says why. A client
should keep the reference solution out of sight unless the user asks to see
it.

For a `function` problem the check also proves every harness, not only the
one the reference solution uses: `check.runners` has one entry per harness
language, in language order. The server runs that language's starter code,
unchanged, on the first test case; `status` is `ok` when the program compiled
and ran to an answer of any kind (a wrong answer is expected), `failed` with
`error` when it did not compile or crashed, and `skipped` — with the reason
in `error` — when the engine does not offer the language or could not run
it, there is no starter code for it, or the check's time ran out. The
reference solution's cases run first; the runners share what is left of the
check's time. Starter code is therefore written to run as it stands, with a
placeholder result. `runners` is `[]` for a `program` problem and whenever
`attempted` is `false`.

`check.largeCases` reports on the [large test cases](#large-test-cases): one
entry for each the request asked for, `[]` when it asked for none.

`ItemDraft` maps directly onto `ItemInput` (the client adds `rawInput: text`
and sets each test case's `origin` to `ai`). `problem` is `null` and
`testCases` is `[]` for a reading. `assumptions` lists everything the model
inferred or invented that was not in the input; it is for display during
review and is not stored. `tags` are the model's suggestions, normalised like
item tags and with whitespace inside a tag replaced by `-`, so they match
tags typed in the UI; ones that are not valid tags are left out.

### `POST /items/{id}/ai/variant`

Draft a new item derived from an existing one — a fresh problem to practise
the same idea on, or a reading reworked for a different angle.

```json
{ "mode": "similar", "instruction": null, "previousDraft": null, "styleId": "..." }
```

`styleId` is optional and selects a [style preset](#style-presets).
`providerId` is optional and names the [provider](#ai) to use instead of the
default.
`largeTestCases` (integer 0–`limits.maxLargeTestCases`, default `0`) asks
for [large test cases](#large-test-cases), as for a draft.
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

Returns `{ "draft": ItemDraft, "style": ..., "check": ... }` in the same
shape as `POST /ai/draft`, with the same reference solution and check. A
variant keeps the original's [interface](#problem-interface) unless the
request gives an `interfaceHint` of `program` or `function` (`auto` or
omitted keeps it; any value is `422` for a reading). Here
`assumptions` describes how the variant differs from the original. The client
saves it with `POST /items`, setting `variantOf` to the original's id; the
original's tags and collections are a sensible default for the new item. Test
cases of the original are never copied, since they do not apply.

### `POST /items/{id}/ai/testcases`

Propose test cases for an existing problem.

```json
{ "count": 8, "language": "python", "instruction": null, "largeTestCases": 0 }
```

- `count` — 1–30, default 8.
- `largeTestCases` — integer 0–`limits.maxLargeTestCases`, default `0`: also
  build that many [large test cases](#large-test-cases), in addition to the
  `count` cases.
- `language` — language for the reference solution; default `python`. If the
  item already has a reference solution it is given to the model as context.
  For a `function` problem the language must have a harness (`422`), and the
  reference solution is the solution part only.
- `instruction` — optional, at most 2000 characters.
- `providerId` — optional; the [provider](#ai) to use instead of the default.
- `422` for a reading.

Response:

```json
{
  "referenceSolution": { "language": "python", "source": "..." },
  "verification": { "attempted": true, "engine": "judge0", "error": null },
  "duplicatesDropped": 0,
  "largeCases": [],
  "usage": { "logId": "...", "model": "claude-haiku-5-5", "durationMs": 21800, "inputTokens": 3900, "outputTokens": 1650, "reasoningTokens": null, "cacheReadTokens": 0, "cacheWriteTokens": 0 },
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

The inputs the problem already has are given to the model so that it adds to
them. A proposed case whose `stdin` equals that of an existing test case or of
an earlier proposed case (ignoring trailing whitespace) is left out, and
`duplicatesDropped` counts those; `cases` can therefore be shorter than
`count`, and empty when every proposal was a repeat. `usage` is as for [`POST /ai/draft`](#post-aidraft).

When no engine is available, `verification.attempted` is `false`, and every
case has `expectedStdout = predictedStdout`, `verified: false`,
`predictionMatched: null`. When an engine is configured but cannot be
reached, the proposal is still returned: `verification.attempted` is `true`,
`verification.error` says why, and the cases are unverified as above.

The client saves accepted cases with `POST /items/{id}/testcases/bulk`,
passing `origin: "ai"`, each case's `verified` flag, and the
`referenceSolution`.

`largeCases` reports on the [large test cases](#large-test-cases): one entry
for each the request asked for, `[]` when it asked for none.

### Large test cases

A model can write small inputs by hand but not one near a problem's upper
bounds, and without such cases a solution of the wrong complexity passes.
With `largeTestCases: n` on a generation (`n` from 1 to
`limits.maxLargeTestCases`), the model also writes `n` **generators**: each a
complete program in one of the judge's languages that reads nothing and
prints the input of one test case — as large as the statement's constraints
allow, up to `limits.maxLargeInputBytes`. Each must be deterministic (a fixed
seed, no clock) and its output must satisfy every constraint in the
statement.

One large input catches one kind of slow solution, which is why several are
worth asking for. The generators are asked to differ in the shape of what
they print, not only in a seed: each aims at a different way a solution of
the wrong complexity, or one that is only correct on small values, fails at
scale — the largest size with arbitrary values, the structure that is the
worst case for the obvious slower approach, values at the extremes of their
range, a degenerate input (all equal, already sorted, one long run). A
problem whose input stays small however large its values are (a single
`n` up to 10^12) still gets `n` distinct inputs.

The server runs each generator in the judge engine, as a plain program with
limits of its own, takes what it printed as the case's `stdin`, and runs the
reference solution on that for the expected output. Each case is then an
ordinary test case: they are appended, in the order the model gave them, as
the last elements of `draft.testCases` (for a draft or a variant) or of
`cases` (for test generation), never a sample, with `verified: true`. In
`cases` their `predictedStdout` and `predictionMatched` are `null`; the model
has not seen the input. Only the reference solution vouches for the expected
output, so it is worth as much as the smaller, hand-checked cases make the
reference solution worth.

`largeCases` says what happened, with one entry for each large case asked
for, in the model's order:

```json
[
  {
    "status": "added",
    "error": null,
    "index": 8,
    "name": "30,000 values in runs of three",
    "inputBytes": 183412,
    "timeMs": 141,
    "generator": { "language": "python", "source": "..." }
  },
  {
    "status": "failed",
    "error": "the generator crashed: IndexError: list index out of range",
    "index": null,
    "name": "A single strictly decreasing run",
    "inputBytes": null,
    "timeMs": null,
    "generator": { "language": "python", "source": "..." }
  }
]
```

- `status` — `added`; `failed` when the model gave no usable generator (none
  at all, fewer than were asked for, or one in a language the judge does not
  run), the generator did not compile, crashed, ran out of time, printed
  nothing, printed more than `limits.maxLargeInputBytes` or something that is
  not UTF-8, when the reference solution failed or exceeded the problem's
  time or memory limit on the input or cannot run at all, or when the input
  repeats an existing case or the input an earlier generator of the same
  request printed; `skipped` when there is no judge engine or
  no reference solution, the engine could not be reached or failed during a
  run, the request was cancelled, or — in a draft — the check was not
  attempted, the reference solution did not pass the other test cases, or the
  check's time ran out. `error` gives the reason in plain words for `failed`
  and `skipped`, and that case is not added. A large case that fails never
  fails the request, the other test cases or the other large cases.
- `index` — where the case is in `draft.testCases` or `cases`; `null` unless
  `added`.
- `name` — the case's name, written by the model to say what the input is
  (`Large input` if it gave none; `null` for a generator the model did not
  write).
- `inputBytes`, `timeMs` — the size of the generated input and how long the
  reference solution took on it, to set against the problem's time limit;
  `null` when that point was not reached.
- `generator` — the program, for inspection; `null` if the model gave none.
  It is not stored with the test case.

Generators the model wrote beyond the number asked for are ignored.

In a draft the large cases are part of the [check](#post-aidraft): they run
after the other test cases and before the runners, within the same time
bound, and each one added counts in `check.passed` and `check.total`.

Large test data is never sent to a model. Wherever a prompt lists test cases
— the existing cases in test generation, the cases of a `previousDraft` in a
revision — a case whose input or expected output is larger than a few
kilobytes is described by its name and size only. A revision therefore does
not carry such a case over: with `largeTestCases` it builds new ones, and
without it the revised draft has none. A client should leave the large cases
of the earlier response out of the `previousDraft` it sends, whatever their
size, which also keeps that request within `limits.maxPreviousDraftBytes`;
a case of more than a few kilobytes that is sent anyway is dropped before
that limit is applied, not refused.

## AI settings

The AI endpoints use one of the instance's saved **providers**: a named
connection to an AI service, with its own API key, base URL and model. An
instance can keep several — a work key and a personal one, a hosted service
and a local server — and one of them is the default the AI endpoints use.
Providers are stored in the database; API keys are encrypted at rest and are
never returned by any endpoint.

A provider is of one of three kinds:

| `kind` | Covers |
| --- | --- |
| `anthropic` | The Anthropic API |
| `gemini` | The Google Gemini API |
| `openai_compatible` | Any endpoint speaking the OpenAI chat-completions API: OpenAI, OpenRouter, Ollama, LM Studio, vLLM, … |

`AiProvider`:

```json
{
  "id": "...",
  "name": "Personal key",
  "kind": "anthropic",
  "model": "claude-opus-5-5",
  "baseUrl": null,
  "apiKeySet": true,
  "apiKeyHint": "…x7Qa",
  "source": "settings",
  "isDefault": true,
  "ready": true,
  "usage": {
    "last30Days": { "requests": 14, "failed": 1, "inputTokens": 61200, "outputTokens": 48100 },
    "allTime": { "requests": 52, "failed": 3, "inputTokens": 233000, "outputTokens": 171500 },
    "lastUsedAt": "..."
  },
  "createdAt": "...",
  "updatedAt": "..."
}
```

- `usage` is what this instance has spent through the provider: every request
  the server sent to the service on its behalf — drafts, variants, test
  generation, and the generation step of a connection test — counted when it
  ends. `failed` is the part of `requests` that returned no usable answer,
  cancelled ones included; the token sums are the figures the service
  reported (a request without figures adds nothing to them), and
  `inputTokens` here is every input token it processed, cache reads and
  writes included. `last30Days` covers today and the 29 days
  before it, in UTC. `lastUsedAt` is `null` before the first request.
  The counts belong to the provider entry: they continue when its key, model
  or base URL changes, and go with it when it is deleted. An environment
  provider keeps its counts under its fixed id. A connection test of
  settings that are not saved (`kind` instead of `providerId`) is not
  counted.
- `model` and `baseUrl` are the saved values; `null` means the kind's default
  applies (see `kinds` below).
- `apiKeyHint` is `…` plus the last four characters, or `null` without a key.
- A key is only ever sent to the origin (scheme, host and port) it was stored
  for: it is stored together with the origin of the provider's effective base
  URL at the time it was saved, and `apiKeySet` / `apiKeyHint` describe the
  key that would actually be used with the current base URL.
- `ready` — the provider has everything it needs, counting the kind's
  defaults: a model, plus an API key for `anthropic` and `gemini`. `gemini`
  has no default model, so one has to be set. A key is optional for
  `openai_compatible` (local servers), which requires a model and a base URL
  — except that on the default OpenAI base URL (`https://api.openai.com`) a
  key is required too.
- `source` is `settings` for a provider saved through this API, and
  `environment` for one supplied by the server's environment variables (see
  `.env.example`), so an instance can also be configured without the UI. For
  each kind whose variables are set there is one such provider, with the
  fixed id `env-anthropic`, `env-gemini` or `env-openai-compatible`.
  Environment providers
  can be tested and chosen as the default, but not changed or deleted here
  (`409`); their `createdAt` and `updatedAt` are `null`.

Hard limits, enforced by the server:

| Limit | Value |
| --- | --- |
| `name` | 1–60 characters, a [single line](#single-line-fields), unique among saved providers (case-insensitive) |
| `model` | at most `maxModelIdChars`, a single line |
| `apiKey` | at most `maxApiKeyChars` |
| Saved providers per instance | 20 |

Violations are `422 validation_failed`; a 21st provider is `409 conflict`.

Providers are local configuration: they are never written to or read from
bundles and are not available over MCP.

### `GET /settings/ai`

```json
{
  "defaultProviderId": "...",
  "timeoutSeconds": 300,
  "defaultTimeoutSeconds": 300,
  "providers": [ AiProvider ],
  "kinds": {
    "anthropic": { "defaultModel": "claude-opus-5-5", "defaultBaseUrl": "https://api.anthropic.com", "keyRequired": true },
    "gemini": { "defaultModel": null, "defaultBaseUrl": "https://generativelanguage.googleapis.com/v1beta", "keyRequired": true },
    "openai_compatible": { "defaultModel": null, "defaultBaseUrl": "https://api.openai.com/v1", "keyRequired": false }
  }
}
```

- `providers` lists the default first, then saved providers by name, then
  environment providers. Not paginated.
- `defaultProviderId` is the provider the AI endpoints use; `null` means AI
  features are off. It always names a provider in `providers`.
  `CODEATROPHY_AI_PROVIDER` gives its initial value only (the environment
  provider of that kind): once a default has been saved through `PUT` —
  including `null` — the saved value applies.
- A default that is no longer `ready` (its key was deleted, say) stays
  selected, and AI features are off until it is fixed or another is chosen.
  A default that names an environment provider whose variables have since
  been removed is reported as `null`.
- `kinds[kind].keyRequired` is whether a key is always required for the kind;
  see `ready` for the conditional case.
- `timeoutSeconds` is the request timeout: how long one request to a
  provider may take before the server gives up with `502 upstream_error`. It
  applies to every provider and every AI endpoint. It is the saved value, or
  `defaultTimeoutSeconds` when none is saved.
- `defaultTimeoutSeconds` is the value of `CODEATROPHY_AI_TIMEOUT` in whole
  seconds (300 unless set). It is not clamped to the limits of the saved
  value.

### `PUT /settings/ai`

```json
{ "defaultProviderId": "...", "timeoutSeconds": 120 }
```

A merge update: a field left out keeps its value. Returns the same body as
`GET /settings/ai`.

- `defaultProviderId` chooses the default provider; `null` turns AI features
  off and keeps every provider. An unknown id, or a provider that is not
  `ready`, is `422`.
- `timeoutSeconds` sets the request timeout: an integer from
  `limits.minAiTimeoutSeconds` to `limits.maxAiTimeoutSeconds`, `422`
  otherwise. `null` removes the saved value, so `defaultTimeoutSeconds`
  applies again. The new value applies from the next request; a request
  already under way keeps the timeout it started with.

### Providers

| Endpoint | Behaviour |
| --- | --- |
| `POST /settings/ai/providers` | Body `{ "name", "kind", "model"?, "baseUrl"?, "apiKey"? }`. `201` `AiProvider` |
| `PATCH /settings/ai/providers/{id}` | Merge update of `name`, `model`, `baseUrl`, `apiKey`. Returns `AiProvider` |
| `DELETE /settings/ai/providers/{id}` | `204`. Deleting the default leaves no default: AI features are off until another is chosen |

- `kind` cannot be changed after creation (`422`). An unknown id is `404`.
- A new provider is not made the default; choose it with `PUT /settings/ai`.
- `apiKey` omitted → the stored key is unchanged. `apiKey: null` → the stored
  key is deleted. A string replaces it; an empty string is treated like an
  omitted key. A key given here is bound to the origin of the provider's
  effective base URL after the update.
- An update that changes the origin of the effective base URL without giving
  a new `apiKey` deletes the stored key, so it is never sent to the new
  origin. Changing only the path on the same origin keeps it.
- `model: null` / `baseUrl: null` clear the saved value, so the kind's
  default applies.
- A provider need not be `ready` to be saved, so a key can be stored before a
  model is chosen.

### `POST /settings/ai/test`

Checks a provider configuration against the service and lists the models it
offers. Nothing is saved, so a key can be tried before it is stored.

```json
{ "providerId": "...", "kind": null, "model": null, "baseUrl": null, "apiKey": null }
```

Give `providerId` to test a saved or environment provider; any of `model`,
`baseUrl`, `apiKey` given with it override its values for this test. Give
`kind` instead (and no `providerId`) to test a configuration that has not
been saved yet. Exactly one of the two is required (`422` otherwise); an
unknown `providerId` is `422` too.

When `baseUrl` points at a different origin from the one the provider's key
belongs to, that key is not used: only an `apiKey` given in the same request
is sent, and with none the test is made without a key.

The test does two things:

1. It asks the service for its model list.
2. If a model is configured — given here, saved on the provider, or the
   kind's default — it makes one minimal generation request with that model.
   The request is given up after 90 seconds, or after the
   [request timeout](#get-settingsai) when that is shorter.

```json
{
  "ok": true,
  "model": "claude-opus-5-5",
  "latencyMs": 640,
  "error": null,
  "models": ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"],
  "modelsError": null
}
```

- `model` is the model the generation request used, or `null` when there was
  none to test; `latencyMs` is that request's duration, or `null`.
- `ok` — with a model: the generation request succeeded. Without one: the
  model list was fetched, which shows that the base URL and key work.
- `error` is a safe, human-readable reason when `ok` is `false` (never
  echoing the key), else `null`.
- `models` is the service's model ids, de-duplicated and sorted, at most 500;
  ids that are not a single line of at most `maxModelIdChars` are left out.
  For `gemini` the list holds only the models that generate text (those the
  service reports as supporting `generateContent`), so embedding, speech,
  image and similar models are left out, and each id is given without its
  `models/` prefix (`gemini-3.5-flash`). The other kinds list what the
  service lists.
  It is `null` when the list could not be fetched, and `modelsError` then
  says why. A service that does not list its models does not fail the test
  of a configured model.
- When the configuration is incomplete in a way that rules out any request
  (a required key is missing), no request is made: `ok` is `false`, `models`
  is `null` and `error` says what is missing.

Always `200` when the request itself is valid; failures of the service are
reported in the body.

### `POST /settings/ai/models`

Lists the models a provider configuration offers, without making a
generation request: nothing is saved, counted in the provider's usage or
written to the activity log.

```json
{ "providerId": "...", "kind": null, "baseUrl": null, "apiKey": null }
```

The provider is named as for [the test](#post-settingsaitest): `providerId`
for a saved or environment provider, with `baseUrl` and `apiKey` as optional
overrides, or `kind` for a configuration that has not been saved. Exactly
one of the two is required, the same validation applies, and a saved key is
likewise never sent to another origin. A `model` in the body is ignored.

```json
{ "models": ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"], "error": null }
```

- `models` is the list as in the test's `models`, or `null` when it could
  not be fetched.
- `error` is a safe, human-readable reason when `models` is `null` (never
  echoing the key), else `null`. A missing required key is reported this
  way too, without a request to the service.

The request to the service is given up after 30 seconds, or after the
[request timeout](#get-settingsai) when that is shorter. Always `200` when
the request itself is valid.

### AI activity log

The server keeps a record of each request it sends to an AI provider — the
same requests that [`AiProvider.usage`](#ai-settings) counts — so that what a
generation cost, and exactly what was sent and what came back, can be looked
up afterwards.

`AiLogEntry`:

```json
{
  "id": "...",
  "createdAt": "...",
  "operation": "draft",
  "itemId": null,
  "title": "Remove Duplicates from Sorted Array II",
  "providerId": "...",
  "providerName": "Personal key",
  "kind": "anthropic",
  "model": "claude-haiku-5-5",
  "status": "ok",
  "error": null,
  "durationMs": 48200,
  "usage": {
    "inputTokens": 5210, "outputTokens": 4380,
    "reasoningTokens": null, "cacheReadTokens": 0, "cacheWriteTokens": 0
  }
}
```

- `operation` — `draft`, `variant`, `testcases` or `test` (a connection
  test).
- `itemId` is the item the request was about (`null` for a new draft and for
  a test); `title` is a short label fixed when the entry is written — the
  item's title (for a variant, the original's), or the title of the draft
  that came back — or `null`. An entry outlives its item.
- `providerName`, `kind` and `model` are as they were at the time.
- `status` — `ok`, `failed` (with `error`) or `cancelled` (the client went
  away).
- `usage` counts are `null` where the provider reported none.

`AiLogDetail` is `AiLogEntry` plus:

```json
{
  "request": { "system": "...", "messages": [{ "role": "user", "content": "..." }], "schema": "item_draft", "maxOutputTokens": 64000 },
  "response": "...",
  "truncated": false
}
```

`request` is what the server asked the provider for (`maxOutputTokens` and
`effort` are `null` where the provider's default applies) and `response` the
text the model returned (`null` if none arrived). They are for reading, not for
programs: the fields of `request` may change between versions. They never
contain an API key or any request header. Either is cut off at 256 KiB, and
`truncated` says so.

| Endpoint | Behaviour |
| --- | --- |
| `GET /settings/ai/log` | Query: `providerId`, `operation`, `status` (optional filters), `limit` (default 50, max 200), `before` (a cursor). Newest first. `{ "items": [AiLogEntry], "next": "<cursor>", "total": n }` |
| `GET /settings/ai/log/{id}` | `AiLogDetail`. `404` for an unknown or removed entry |
| `DELETE /settings/ai/log` | Query: `before` (optional timestamp). `204`. Removes every entry, or those created before the timestamp |

The log is append-only: an entry is written once and never changed, and
nothing is removed unless the user asks. Listing is meant for loading as the
user scrolls. `next` is the cursor to pass as `before` for the following
page, `null` at the end; a cursor stays valid while new entries arrive, so a
page never repeats or skips entries. `total` counts the entries matching the
filters. The list carries no request or response text; that is fetched per
entry.

The counts in `AiProvider.usage` are kept separately and are not reduced when
entries are removed. Deleting a provider keeps its entries. The log holds the
text the user gave the AI, so it is not part of bundles and is not offered
over MCP.

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
`name` must also be a [single line](#single-line-fields).
Violations are `422 validation_failed`; a 21st preset is `409 conflict`.
`instructions` is never truncated silently.

At most one preset has `isDefault: true`. Setting it on one preset clears it
on the others in the same transaction. With no default, generation uses the
authoring conventions alone unless a request names a preset.

A new instance starts with a few built-in presets, one of them the default.
They are ordinary presets: they can be edited or deleted like any other,
count towards the limit, and are not recreated once changed or deleted.

| Endpoint | Behaviour |
| --- | --- |
| `GET /styles` | `{ "items": [StylePreset] }`, default first, then by name. Not paginated |
| `POST /styles` | Body `{ "name", "instructions", "isDefault"? }`. `201` `StylePreset` |
| `PATCH /styles/{id}` | Any of `name`, `instructions`, `isDefault`. Returns `StylePreset` |
| `DELETE /styles/{id}` | `204`. Deleting the default leaves no default |

A preset shapes prose and layout only. It is inserted into the prompt as a
clearly delimited block of *preferences* after the authoring conventions
(the built-in ones or a [custom system prompt](#system-prompt) with the
fixed rules); it cannot change the response schema, and where it conflicts
with a rule the app depends on (the JSON structure, the stdin/stdout
convention) the built-in rule wins.

Presets are local configuration. They are never written to or read from
bundles and cannot be created or modified over MCP, so apart from the
built-in presets the app ships with, the only way instructions get into this
slot is the instance's own user typing them.
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

## System prompt

The system prompt of a draft or variant starts with the *authoring
conventions*: how a statement is laid out, how readings are structured,
what makes a good title, tag set or test set, and the rules the app depends
on. The user may replace the first kind, the **editable conventions**, with
a text of their own. The second kind, the **fixed rules**, always applies:
judging on stdin/stdout, the `program` and `function` interfaces and their
harness protocol, the folded input region, how output is compared, limits,
language ids and versions, and expected outputs coming from a reference
solution. So do the rules each request adds after the conventions and the
style preset (sample test cases with correct outputs, the reference
solution, assumptions, large test cases, the JSON-only answer), and the
judge's languages in the user turn.

| Endpoint | Behaviour |
| --- | --- |
| `GET /settings/ai/system-prompt` | `SystemPrompt` |
| `PUT /settings/ai/system-prompt` | Body `{ "custom": "..." }`. Saves a custom text. Returns `SystemPrompt` |
| `DELETE /settings/ai/system-prompt` | `204`. Removes the custom text, so the built-in conventions apply again. Succeeds without one too |

`SystemPrompt`:

```json
{
  "builtIn": "# Codeatrophy authoring conventions\n\nAn item is either ...",
  "custom": null,
  "isCustom": false,
  "fixed": "# Fixed rules\n\nThese rules are how the app works ...",
  "draftRules": "## Drafting rules\n\n- The user_input block is ...",
  "variantRules": "## Variant rules\n\n- The original block describes ..."
}
```

- `builtIn` is the editable part of the built-in conventions: the text a
  custom one replaces, and a starting point for writing it.
- `custom` is the saved text, or `null`; `isCustom` is whether there is one.
- `fixed` is the fixed rules, as sent after a custom text. `draftRules` and
  `variantRules` are the rules that end the system prompt of a draft and of
  a variant, after the style preset, as sent when no large test cases are
  asked for (asking for them adds rules). All four texts are for reading:
  they may change between versions.
- Without a custom text a prompt carries the built-in conventions exactly as
  they always were, with the editable and fixed parts interleaved. With one,
  it carries the custom text, then `fixed`, then the style preset's block.
- `custom` is required and must be a string (`422` otherwise; reset with
  `DELETE`). It is 1–`limits.maxSystemPromptChars` (20000) characters,
  counted in Unicode code points after trimming surrounding whitespace, and
  `\r\n` becomes `\n`. Control characters other than newline and tab are
  rejected. Violations are `422 validation_failed` and nothing is saved; the
  text is never truncated. Saving `builtIn` unchanged removes the custom
  text instead, as `DELETE` does.
- A custom text applies to `POST /ai/draft`, `POST /items/{id}/ai/variant`
  and the MCP server's authoring guide (instructions, resource and prompts),
  from the next request on. Test generation has rules of its own and does
  not use the conventions; their editable part is the separate
  [test case prompt](#test-case-prompt). A saved text stays as it is when a
  later version changes `builtIn`.

Like style presets, the system prompt is local configuration and the user's
own standing instructions to a model: it is never written to or read from
bundles, and no MCP tool reads or sets it, so the only way text gets into
it is the instance's own user typing it here. It is independent of the AI
provider.

## Test case prompt

The system prompt of `POST /items/{id}/ai/testcases` has rules of its own,
separate from the authoring conventions, and also comes in two kinds of
part. The **editable** part is the test-design guidance: writing a correct,
efficient reference solution and choosing and covering the inputs, each
with a name and a one-sentence rationale. The user may replace it with a
text of their own. The **fixed rules** always apply: the program and
function-harness contract, the judge's language versions, inputs following
the format and constraints within about 100 KB each, predicted outputs that
the server replaces by running the solution, which cases are samples, the
Java and Kotlin entry points, the large-case rules when large cases are
asked for, and the JSON-only answer.

| Endpoint | Behaviour |
| --- | --- |
| `GET /settings/ai/testcase-prompt` | `TestCasePrompt` |
| `PUT /settings/ai/testcase-prompt` | Body `{ "custom": "..." }`. Saves a custom text. Returns `TestCasePrompt` |
| `DELETE /settings/ai/testcase-prompt` | `204`. Removes the custom text, so the built-in rules apply again. Succeeds without one too |

`TestCasePrompt`:

```json
{
  "builtIn": "- For a program problem, write a correct, efficient reference solution ...",
  "custom": null,
  "isCustom": false,
  "fixed": "# Fixed rules\n\nThese rules are how the app works ..."
}
```

- `builtIn`, `custom` and `isCustom` are as for the
  [system prompt](#system-prompt). `fixed` is the fixed rules as sent after
  a custom text when no large test cases are asked for (asking for them adds
  rules), ending with the JSON-only answer. The texts are for reading: they
  may change between versions.
- Without a custom text a test generation carries the built-in rules
  exactly as they always were, with the editable and fixed parts
  interleaved. With one, it carries the custom text, then `fixed`. Where an
  editable part's built-in wording states a rule the app depends on (the
  program contract, the input-size cap), `fixed` restates it.
- `custom` is validated as for the system prompt, with the same limit
  (`limits.maxSystemPromptChars`), and saving `builtIn` unchanged removes
  the custom text. It applies from the next `POST /items/{id}/ai/testcases`
  on, and to nothing else: drafts, variants and the MCP server's authoring
  guide (`write_test_cases` included) do not use it, and the custom system
  prompt does not apply to test generation.

It is local configuration like the system prompt: never written to or read
from bundles, and no MCP tool reads or sets it.

## Preferences

How the user likes the app to behave. Preferences are stored on the server so
they follow the user across browsers; they are personal, never exported, and
not available over MCP. The server stores and validates them but does not act
on them — they are for clients to honour.

### `GET /settings/preferences`

```json
{
  "hideTestCases": true,
  "generatedTestCases": 8,
  "largeTestCase": false,
  "largeTestCaseCount": 3,
  "editor": {
    "autocomplete": true,
    "closeBrackets": true,
    "matchBrackets": true,
    "lineWrapping": false,
    "tabSize": 4,
    "fontSize": 14
  }
}
```

Every key is always present; the values above are the defaults.

| Key | Values | Meaning for a client |
| --- | --- | --- |
| `hideTestCases` | boolean | When `true`, show how many test cases a problem has and how many a run used, but keep the content of non-sample cases (in the test list and in submission results) out of sight until the user asks to reveal it. Sample cases are part of the statement and stay visible |
| `generatedTestCases` | integer 1–`limits.maxGeneratedTestCases` | How many test cases to ask for by default when generating them: the initial value of the count a client sends as `count` to `POST /items/{id}/ai/testcases` |
| `largeTestCase` | boolean | Whether to ask for [large test cases](#large-test-cases) by default: whether a client sends a non-zero `largeTestCases` to `POST /ai/draft` and `POST /items/{id}/ai/variant`, and the initial value of that choice for `POST /items/{id}/ai/testcases` |
| `largeTestCaseCount` | integer 1–`limits.maxLargeTestCases` | How many large test cases to ask for when they are asked for: the value a client sends as `largeTestCases` |
| `editor.autocomplete` | boolean | Offer code completion while typing |
| `editor.closeBrackets` | boolean | Insert the closing bracket or quote automatically |
| `editor.matchBrackets` | boolean | Highlight the bracket matching the one at the cursor |
| `editor.lineWrapping` | boolean | Wrap long lines instead of scrolling horizontally |
| `editor.tabSize` | `2`, `4` or `8` | Indentation width |
| `editor.fontSize` | integer 10–24 | Editor font size in pixels |

### `PUT /settings/preferences`

Merge update: send any subset, at any depth; omitted keys keep their value.
An unknown key or an out-of-range value is `422` and nothing is saved.
Returns the same body as `GET /settings/preferences`.

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
- `includeSolutions: false` omits saved solutions (the reference solution
  included). `includeHiddenTests: false` exports sample test cases only. The
  bundle records both choices in `bundle.json` (`includes`), so an importer
  knows that missing solutions or hidden cases were left out rather than
  absent.
- `name` defaults to the collection name or `"Codeatrophy library"`.

Returns `200` `application/zip` with
`Content-Disposition: attachment; filename="<slug>.codeatrophy.zip"`.

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
`limits`, `compare`, `starterCode`, `interface`, `harness`, `solutions`,
`testCases` — in that order. It is `[]` for `new` and `unchanged` items.

`422 validation_failed` if the archive is not a valid bundle or its
`formatVersion` is newer than the server supports.

### `POST /import`

`multipart/form-data` with `file` and a `strategy` field:

| `strategy` | Effect on `changed` items |
| --- | --- |
| `skip` (default) | Keep the local item untouched |
| `overwrite` | Replace content, test cases and solutions with the bundle's; personal state and submissions are kept. Local solutions and hidden cases survive when the bundle was exported without them |
| `duplicate` | Import as a separate new item with a fresh id |

`new` items are always created; `unchanged` items are always left alone. An
overwrite increases an item's `revision` only when its content (as for
`PATCH /items/{id}`) changes; one that changes only test cases moves
`updatedAt` and leaves `revision` alone. A `variantOf` that names an item in
neither the bundle nor the library is dropped (set to `null`) before the
comparison, so re-importing the same bundle stays `unchanged`. Under
`duplicate`, a bundle item whose `variantOf` names another item duplicated in
the same import points at the new copy.
Collections are created if missing; bundle membership is merged into existing
collections (items not already members are appended in bundle order). The
whole import is one transaction.

```json
{ "created": 10, "updated": 2, "skipped": 0, "duplicated": 0, "unchanged": 5, "collectionsCreated": 1, "warnings": [] }
```
