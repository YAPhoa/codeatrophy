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
| 401 | `unauthorized` | Sign-in is on and the request carries no valid session (see [Sign-in](#sign-in)), or a sign-in failed |
| 403 | `forbidden` | The `Host` header is not an accepted name for this server, or a state-changing request was sent from a web page on another origin (see [Host and origin checks](#host-and-origin-checks)) |
| 404 | `not_found` | Resource does not exist |
| 405 | `bad_request` | The path exists but does not support this method; the `Allow` header lists the ones it does |
| 409 | `conflict` | Request conflicts with current state (e.g. a collection cycle) |
| 413 | `too_large` | Body or upload exceeds a limit |
| 422 | `validation_failed` | Well-formed but invalid |
| 429 | `rate_limited` | Too many failed sign-in attempts from this address; the `Retry-After` header gives the seconds to wait |
| 502 | `upstream_error` | The AI provider or judge engine returned an error; `message` carries a safe summary |
| 503 | `ai_unavailable` | AI features are switched off, or no default AI provider is chosen, or it is not ready |
| 503 | `judge_unavailable` | No judge engine is configured, or it is unreachable |
| 500 | `internal` | Unexpected server error |

### Host and origin checks

Two checks protect every instance, with sign-in on or off. Both apply to
every request under `/api/` and to the MCP endpoint; the UI's static files
are served for any host. With sign-in on, the stricter cross-origin check of
[Sign-in](#sign-in) applies as well.

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

### Sign-in

Sign-in is on unless the server runs with `CODEATROPHY_AUTH=off`. While it
is on, every endpoint under `/api/v1` answers `401 unauthorized` to a
request without a valid session, except `GET /health` and the endpoints
under `/auth/` that the sign-in page needs (`GET /auth/session`,
`POST /auth/login`, `POST /auth/setup`, `POST /auth/logout`). The UI's static
files are public. The MCP endpoint takes a bearer token instead, which it then
requires: an account's own MCP token (see [MCP tokens](#mcp-tokens)) or
`CODEATROPHY_MCP_TOKEN`.

A session is a random token in the `codeatrophy_session` cookie
(`HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure` when the request
came over HTTPS directly or with `X-Forwarded-Proto: https`). The server
keeps only its SHA-256 hash. It lasts `CODEATROPHY_SESSION_TTL` (30 days by
default) from its last use: a request made more than an hour after the
expiry was last pushed back pushes it back again and renews the cookie.

With sign-in on, requests other than `GET`, `HEAD` and `OPTIONS` also pass
a cross-origin check against request forgery (Go's
`http.CrossOriginProtection`): a browser request is refused with
`403 forbidden` unless `Sec-Fetch-Site` is `same-origin` or `none`, or its
`Origin` is listed in `CODEATROPHY_ALLOWED_ORIGINS` (which includes
`CODEATROPHY_PUBLIC_URL`). Without `Sec-Fetch-Site` the `Origin` host must
match the `Host` header. Requests with neither header (not from a browser)
pass. This check applies to `POST /auth/login` too.

### Personal data

Accounts share one library: items, test cases, solutions, tags, AI
providers, style presets and settings. What a person does with the library
is their account's own:

- an item's `status`, `favorite` and `notes` (and the `lastVerdict`, the
  status filters and counts of `GET /items`, `GET /items/facets` and
  `GET /stats`, which follow from them),
- [collections](#collections), and so an item's `collectionIds`, the
  `collection` and `uncollected` filters, the collection counts of
  `GET /stats` and what an export of scope `collection` can name,
- [working copies](#working-copies) and [submissions](#submissions),
- [drafts](#drafts), [AI jobs](#ai-jobs) and the [AI activity log](#ai-activity-log),
- [preferences](#preferences).

A request acts for the signed-in account; over MCP, for the account whose
token it sends. With sign-in off, or with `CODEATROPHY_MCP_TOKEN`, it acts
for the oldest account, or, while there is none, for no account: what is
kept then goes to the first account created. Another account's collection,
submission, draft, AI job or AI log entry answers `404 not_found`, as one
that does not exist (and `422` where it is named in a field, such as
`collectionIds`). Deleting an account (`codeatrophy user delete`) deletes its personal
data.

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
| `AiJobKind` | `draft`, `variant`, `testcases`, `code` (see [AI jobs](#ai-jobs)) |
| `AiJobStatus` | `queued`, `running`, `succeeded`, `failed`, `cancelled` |
| `DraftKind` | `capture`, `variant` |
| `DraftState` | `new`, `drafting`, `ready`, `edited`, `failed` (see [Drafts](#drafts)) |

`executed` is the verdict of a run that had no expected output to compare
against (custom stdin).

Language ids are canonical lower-case strings owned by the app: `c`, `cpp`,
`csharp`, `go`, `java`, `javascript`, `kotlin`, `python`, `ruby`, `rust`,
`typescript`. The set actually available is reported by `GET /meta`.

## Health and sign-in

### `GET /health`

`200` with `{ "status": "ok" }` while the server is up. It needs no session
and reads nothing; the container health check uses it.

### `GET /auth/session`

Whether sign-in is on and who is signed in, from the session cookie. Needs
no session. An unknown or expired cookie is no error: `user` is `null` (and
the cookie is cleared).

```json
{ "enabled": true, "setupRequired": false, "user": { "id": "...", "email": "me@example.com", "createdAt": "2026-11-22T04:00:00Z" } }
```

`enabled` is `false` when the server runs with `CODEATROPHY_AUTH=off`; then
`setupRequired` is `false` and `user` is `null`, and the UI shows the app
without asking anyone to sign in. `setupRequired` is `true` while no account
exists.

### `POST /auth/login`

`{ "email": "...", "password": "..." }`. On success `200` with the
`GET /auth/session` body and a new session cookie. The email is compared
without regard to case. A wrong email or password is `401 unauthorized`,
the same for both. Each address may fail 10 times in 15 minutes; past that
every attempt, right or wrong, is `429 rate_limited` with `Retry-After`
until the oldest failure is 15 minutes old. Behind a reverse proxy every
client shares the proxy's address, and so the limit. With sign-in off it is
`400 bad_request`.

### `POST /auth/setup`

Creates the first account and signs it in:
`{ "email": "...", "password": "..." }`. Once any account exists it is
`409 conflict`. The email
must be an address (at most 254 characters, stored in lower case); the
password 8 characters to 72 bytes (`422 validation_failed` on `email` or
`password`). Response as for `POST /auth/login`.

### `POST /auth/logout`

Ends the cookie's session, if any, and clears the cookie. `204`.

### `POST /auth/password`

Changes the signed-in account's password:
`{ "currentPassword": "...", "newPassword": "..." }`. `204`, and every other
session of the account ends. A wrong current password is
`422 validation_failed` on `currentPassword` and counts as a failed attempt;
a new password outside 8 characters to 72 bytes is `422` on `newPassword`.

Other accounts are managed on the server with `codeatrophy user`
(`list`, `add`, `password`, `delete`); accounts share one library and keep
their own [personal data](#personal-data).

### MCP tokens

Each account makes its own bearer tokens for its MCP clients. A token is
`cat_` followed by 43 URL-safe characters; the server keeps only its SHA-256
hash, so it is in a response only once, when it is made. While sign-in is on
the MCP endpoint accepts these tokens (and `CODEATROPHY_MCP_TOKEN`, when
set). A token stops working when it is revoked or its account is deleted.

```json
{ "id": "3f2a9c...", "name": "Laptop – Claude Code", "hint": "Xy3Q", "createdAt": "2026-11-22T04:00:00Z", "lastUsedAt": null }
```

`id` identifies the token in this API (it is not the token), `hint` is the
token's last four characters, and `lastUsedAt` is when an MCP request last
used it, updated at most once an hour (`null` if never). All three endpoints
need a session and act on the signed-in account's tokens only.

- `GET /auth/mcp-tokens` — `{ "items": [...] }`, newest first.
- `POST /auth/mcp-tokens` — `{ "name": "..." }` (1–60 characters, one
  line; `422 validation_failed` on `name`). `201` with the token above plus
  `"token": "cat_..."`. An account holds at most 20 tokens; one more is
  `409 conflict`.
- `DELETE /auth/mcp-tokens/{id}` — revokes the token. `204`; `404` when the
  account has no token with that id.

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
    "maxSolutionNotesChars": 5000,
    "maxNotesChars": 4000,
    "maxLinksPerItem": 30
  }
}
```

- `limits` publishes every bound the server enforces on user input, so
  clients validate against the server's values rather than copies of them.
  `maxTextBytes` applies to each of an item's `body`, `notes` and `rawInput`;
  `maxNotesChars` bounds an item's `notes` in characters (Unicode code
  points, counted after line endings are normalised to `\n`). The operator
  sets it with `CODEATROPHY_MAX_NOTES_CHARS` (default 4000, at most 100000);
  notes are checked against it only when they change, so notes saved under a
  higher limit still load and the item's other fields still save;
  `maxTestDataBytes` to each of a test case's `stdin` and `expectedStdout`;
  `maxGeneratedTestCases` is the upper bound of `count` in
  `POST /items/{id}/ai/testcases` and of `testCaseCount` in
  [draft](#draft-requests) and [variant](#variant-requests) requests;
  `maxLargeInputBytes` is the largest input a
  [large test case](#large-test-cases) may have and `maxLargeTestCases` the
  most of them one generation may ask for. The operator sets the two maxima
  with `CODEATROPHY_MAX_GENERATED_TEST_CASES` (default 30, from 1 to 100) and
  `CODEATROPHY_MAX_LARGE_TEST_CASES` (default 5, from 1 to 20). The defaults
  suit most uses. Raising them makes each generation slower and costlier,
  makes a reply cut off by the model's output limit more likely (the whole
  generation then fails and is retried from scratch), and tends to lower
  quality: more near-duplicate cases and more wrong expected outputs for the
  check to catch, and cases past what the 50-second draft check reaches stay
  unverified. Each large test case is also a generator program the judge
  runs, so more of them lengthen the check too. A source URL must be `http`
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
  bound [solutions](#solutions); `maxLinksPerItem` bounds an item's
  [links](#links). The operator sets it with
  `CODEATROPHY_MAX_LINKS_PER_ITEM` (default 30, from 1 to 50, the most a
  bundle item's `related` holds); it is checked only when links are added,
  so an item linked under a higher limit keeps its links and still loads
  and saves. `maxSystemPromptChars` bounds a
  [custom system prompt](#system-prompt) and a
  [custom test case prompt](#test-case-prompt).
- `mcp.url` is the full public URL of the MCP endpoint when the operator has
  set `CODEATROPHY_PUBLIC_URL`, otherwise `null`; a client then derives it
  from its own origin plus `mcp.path`. `mcp.authRequired` is `true` when
  the endpoint asks for a bearer token: when `CODEATROPHY_MCP_TOKEN` is set,
  and always while sign-in is on (an account's [MCP token](#mcp-tokens) or
  `CODEATROPHY_MCP_TOKEN`).
- `ai.enabled` is `true` when AI features are switched on and a default
  provider is chosen and `ready` (see [AI settings](#ai-settings)); `providerId`, `providerName`, `kind` and
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
`items.byStatus`, `items.favorites` and `submissions` count the account's own
status, favorites and submissions (see [Personal data](#personal-data)).
`items.favorites` is the count the library's Favorites view shows, and
`items.uncollected` the number of items in no collection: each equals the
`total` of `GET /items` with only `favorite=true`, or only
`uncollected=true`, as the filter.
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
  "linkCount": 2,
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
  Deleting an item keeps `variantOf` on its variants: it then names an
  unavailable item (see `variantOrigin` on `Item`). A `PATCH` may keep such
  a value but not set one anew: a new `variantOf` must name an existing
  item.
- `linkCount` is the number of the item's [links](#links), links to
  unavailable items included.
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
  },
  "variantOrigin": null,
  "createdBy": { "via": "mcp", "client": "claude-code", "model": "claude-opus-5-5" },
  "lastUpdatedBy": { "via": "http", "client": null, "model": null }
}
```

- `variantOrigin` is `null` when `variantOf` is, and otherwise the
  `LinkedItem` (see [Links](#links)) of the item `variantOf` names, with
  `linkedAt` `null`. It is computed on read; a client sends `variantOf`.
- `createdBy` and `lastUpdatedBy` (on `Item` only, not `ItemSummary`) say
  who created the item and who made the change that last moved `updatedAt`,
  for tracking only. Each is a `ChangeSource` or `null` when unknown (items
  from before the record existed); a record is the whole object or `null`.
  They are set by the server and never taken from a request body.
  - `via` — `"http"` (this API), `"mcp"` (the [MCP server](mcp.md)) or
    `"import"` (a [bundle import](#import-and-export)).
  - `client` — over MCP, the client name from the MCP handshake; otherwise
    `null`.
  - `model` — over MCP, the tool call's optional `model` argument; for an
    item saved from a [draft](#post-draftsidsave), the model of the draft's
    latest generation when the form was built from it (`basedOn` > 0);
    otherwise `null`.
  - `client` and `model` are reported, not verified. The server makes them
    one line (control characters and runs of white space become one space),
    trims them, cuts them to 200 characters and reads an empty one as `null`;
    they never make a request fail.
  - `createdBy` is set on create and never changes; `lastUpdatedBy` starts
    equal to it and changes whenever `updatedAt` moves, with one exception:
    a `testcases/verify` run that only changes `verified` flags moves
    `updatedAt` but leaves `lastUpdatedBy` (one that rewrites an expected
    output sets it). Personal state, collection membership and links change
    neither.
  - An import sets both to `{ "via": "import" }` on a new item; overwriting a
    changed item sets `lastUpdatedBy` to it and keeps `createdBy`.

- `problem.referenceSolution` is a view of the item's saved
  [solution](#solutions) that is marked as the reference, or `null` when none
  is. Writing `{ "language", "source" }` to it (through `PATCH /items/{id}` or
  `testcases/bulk`) updates that solution in place, or creates one named
  "Reference solution" if there is none; an `id` in the written value is
  ignored. Writing `null` only removes the reference mark — the solution
  itself stays saved.
- `body` is Markdown (GitHub-flavoured, with `$...$` / `$$...$$` math). A
  display equation goes between `$$` lines of their own; the UI also draws a
  paragraph holding only a one-line `$$...$$` as one. The UI draws a ```` ```mermaid ```` fenced block as a diagram (its source when it
  does not parse) and shows images given as `data:image/` URLs (PNG, JPEG,
  GIF, WebP, SVG); raw HTML is never rendered, except a collapsible block:
  `<details>` (or `<details open>`), an optional `<summary>…</summary>` of
  plain text, and `</details>` around Markdown, with no other attributes.
  Two or more fenced code blocks marked `tab` after their language
  (```` ```cpp tab ````), one right after another, are drawn as one block
  with a tab per language; a lone one is an ordinary code block.
- `notes` is the user's private Markdown notes, at most
  `limits.maxNotesChars` characters. A write that changes them to anything
  longer is refused with `422` on `notes`; notes already longer (saved under
  a higher limit) are kept as they are. `rawInput` is the original text an
  AI draft was generated from, or `null`. Neither is ever exported.
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
atomically with its sample cases. A case there may carry a `generator`
(see [Test cases](#test-cases)): with no `stdin`, the server runs it before
anything is stored, as `POST /items/{id}/testcases` does (`422` on
`testCases.<i>.generator` if it fails, `503 judge_unavailable` without an
engine); with a `stdin` as well, both are stored as given, without running
it — that is how a draft's large cases are saved with their generators.
Validation: `title` 1–200 chars, a
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

Counts the items of a filtered list by type, status, difficulty and tag, for
the library's filter menus. Takes the filters of `GET /items`; `sort`, `order`,
`limit` and `offset` are ignored, and an invalid filter is `400` as there.

```json
{
  "byType": { "problem": 30, "reading": 12 },
  "byStatus": { "todo": 14, "in_progress": 5, "done": 23 },
  "byDifficulty": { "easy": 10, "medium": 15, "hard": 5, "none": 12 },
  "byTag": { "array": 7, "graph": 2 }
}
```

Each count is how many items with that value the list shows once the value
is picked as well:

- `byType` is counted with every filter except `type`, since picking a type
  replaces the one in the filter.
- `byStatus` is counted with every filter except `status`, and
  `byDifficulty` with every filter except `difficulty`, since values within
  one parameter combine with OR.
- `byTag` is counted with every filter, `tag` included, since tags combine
  with AND.

`byType`, `byStatus` and `byDifficulty` have every key, with `0` when
empty; `byTag` has only the tags the counted items carry.

### `POST /items`

Body `ItemInput`. Returns `201` `Item`.

### `POST /items/check`

Check a problem that is not saved yet: run its reference solution on its test
cases. This is the [check a draft gets](#draft-requests) when it arrives, made
available for the problem as it stands after editing. Nothing is stored and
no AI provider is involved.

```json
{ "problem": { "...": "as in ItemInput" }, "testCases": [ { "stdin": "...", "expectedStdout": "..." } ] }
```

`problem` and `testCases` are validated as in `ItemInput` (`422`); other keys
of an `ItemInput` are accepted and ignored, so a client can send the item it
is about to save. A case's `generator` is not run: the check uses the
`stdin` sent.

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
`error.fields`. Edited `notes` longer than `limits.maxNotesChars` are refused
with `422` on `notes`. `expectedRevision` is optional, as for `PATCH`.
Returns `Item`.

### `DELETE /items/{id}`

Deletes the item, its test cases, its solutions, its submissions and its
[working copies](#working-copies). Its
[links](#links) and the `variantOf` of items that were variants of it are
kept, and the server keeps the item's id, title and type, so that those
can still show what they name: the other items list it as unavailable, and
nothing about them changes (no `revision`, no `updatedAt`). If an item with
that id is created again (by an import, say), they name it again. The same
holds for the `delete` action of `POST /items/bulk`.

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

### Links

Any two items, problems or readings, can be linked by hand. A link has no
direction and no label. It is made between two existing items and stays
when either of them is deleted: the other item then lists it as
unavailable (a client can show it as a dead link) until an item with that
id exists again. An [import](#import-and-export) can also bring a link to
an item this library never had. Linking and unlinking are not content
changes: neither `revision` nor `updatedAt` moves. An item has at most
`limits.maxLinksPerItem` links, unavailable ones included: 30 by default,
set by the operator with `CODEATROPHY_MAX_LINKS_PER_ITEM` (1 to 50). An item
that has more, linked under a higher limit, keeps them; only adding a link to
it is refused.

`LinkedItem` — the other item of a link:

```json
{
  "id": "0193b2f0-...",
  "available": true,
  "title": "Two Sum",
  "type": "problem",
  "status": "todo",
  "difficulty": "easy",
  "linkedAt": "2026-01-31T12:00:00Z"
}
```

- `available` is `false` when no item with this id exists. `title` and
  `type` are then the ones it had when it was deleted, or `null` when this
  library never had it; `status` and `difficulty` are `null`.
- `linkedAt` is when the link was made. In a `variantOrigin` it is `null`.

### `GET /items/{id}/links`

Returns `{ "links": [LinkedItem] }`: available items first, each group
oldest link first. `404` if the item does not exist.

### `POST /items/{id}/links`

```json
{ "itemId": "0193b2f1-..." }
```

Links the item to `itemId`. Returns `200` with `{ "links": [LinkedItem] }`,
the item's links after the change. Linking a pair that is already linked
(either way round) changes nothing and succeeds. `404` if the item does not
exist; `422` on `itemId` when it is missing, names the item itself or an item
that does not exist, or when either item would have more than
`limits.maxLinksPerItem` links.

### `DELETE /items/{id}/links/{otherId}`

Removes the link between the item and `otherId`, whether or not `otherId`
still exists. `204`, also when there was no such link; `404` if the item
does not exist.

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
  "generator": null,
  "createdAt": "...",
  "updatedAt": "..."
}
```

`generator` is `null`, or `{ "language": "python", "source": "..." }` for a
large test case: the program that printed its `stdin` (see
[Large test cases](#large-test-cases)). `stdin` is stored either way, so
nothing needs to run the generator again.

`TestCaseInput`: `name` (default `""`), `stdin` (default `""`),
`expectedStdout` (required, may be empty, unless a generator is given:
then default `""`), `isSample` (default `false`), `origin` (default
`manual`), `verified` (default `false`), `generator` (default `null`).

Editing `stdin` or `expectedStdout` through `PATCH` resets `verified` to
`false` unless the same request sets it.

#### Generators

A case may be given a `generator` instead of its `stdin` — on every path
that creates test cases (`POST /items`, `POST /drafts/{id}/save`,
`POST /items/{id}/testcases`, `POST /items/{id}/testcases/bulk`) and on
`PATCH /testcases/{id}`: a complete, deterministic program in one of the
judge's languages that reads nothing and prints one test input. The server
checks it (a known language the judge offers, a source of at most
`limits.maxSourceBytes`), runs it as a plain program with limits of its own
(10 seconds, 512 MiB), and stores what it printed as the case's `stdin`,
with the generator. What it prints must be non-empty, at most
`limits.maxLargeInputBytes`, valid UTF-8, and not the input of another case
of the problem or of an earlier case of the same request (ignoring trailing
whitespace). The expected output is computed as for any case:
`POST /items/{id}/testcases/verify` with `updateExpected: true`.

- On create, a case that gives both `stdin` and a `generator` is stored as
  given, and nothing runs, as in a bundle import: the server checks the
  generator's language and size but does not check that the input came from
  it, nor that it repeats no other case. This is how a client saves a case
  the server built earlier with its generator (a draft's large cases, or the
  large cases of test generation), without running it again and without
  needing the judge. `stdin: null` is not a stdin (`422` on `stdin`).
- On `PATCH`, giving both `stdin` (even `null`) and a non-null `generator`
  is `422` on `generator`.
- A generator that cannot be used or fails is `422` on `generator`
  (`cases.<i>.generator` in a bulk request, `testCases.<i>.generator` on
  item create), with the reason in plain
  words — the same messages as in [`largeCases`](#large-test-cases), such as
  "the generator does not compile: …" or "the generator printed more than
  1048576 bytes". No judge engine, or one that cannot be reached, is
  `503 judge_unavailable`.
- A request is atomic: its generators all run before anything is stored, in
  parallel, and if one fails nothing is.
- `PATCH`: a non-null `generator` runs and replaces `stdin` (and so resets
  `verified` unless the request sets it, when the input changed);
  `generator: null` drops the generator and keeps `stdin`; a new `stdin`
  without a `generator` drops the generator, since the input is no longer
  what it printed.

| Endpoint | Behaviour |
| --- | --- |
| `GET /items/{id}/testcases` | `{ "items": [TestCase] }` ordered by `position`; not paginated |
| `POST /items/{id}/testcases` | Body `TestCaseInput`; appended. A [generator](#generators) without `stdin` runs; with `stdin` it is stored as given. `201` `TestCase` |
| `POST /items/{id}/testcases/bulk` | Body `{ "cases": [TestCaseInput], "replace": false, "referenceSolution": null }`. Appends, or with `replace: true` replaces every existing case except the samples, which keep their order and come first. A non-null `referenceSolution` (`{language, source}`) is stored on the item in the same transaction. Cases may be given [generators](#generators), run when a case has no `stdin` and stored as given when it has one; with `replace: true` a generated input is compared with the samples that stay. Returns `{ "items": [TestCase] }` — the full list after the change |
| `PATCH /testcases/{id}` | Partial `TestCaseInput`; `stdin` together with a non-null [generator](#generators) is `422`. Returns `TestCase` |
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
      "timeMs": 31,
      "memoryKb": 9120
    }
  ]
}
```

- `timeMs` and `memoryKb` are what the engine measured for the case (`null`
  when it measured nothing, as on a compile error); `timeMs` is read as for
  submissions.
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
  the test cases are left as they are. `updateExpected: true` with a
  non-reference solution is `422`.
- Whichever solution ran, the run becomes its [`lastRun`](#solutions):
  `passed` counts the cases that are `ok && matches`, `total` is the number
  of cases, `timeMs` and `memoryKb` are the maximum over the results. It is
  not recorded when there are no test cases, when any result is
  `internal_error` (a run the engine cut short says nothing about the
  solution, so the previous `lastRun` stays), or when the solution's
  language or source was changed, or the solution deleted, while it ran.
  Recording it moves neither the solution's `updatedAt` nor the item's
  `updatedAt` or `revision`.

Synchronous; may take as long as the cases take to run. `503
judge_unavailable` if no engine is configured, the engine cannot be reached,
or the engine fails on every case (an internal error of its own, such as
Judge0's status 13); nothing is changed in that case. If the engine fails part-way through, the
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
  "updatedAt": "...",
  "lastRun": { "passed": 11, "total": 13, "timeMs": 48, "memoryKb": 9120, "ranAt": "..." }
}
```

`lastRun` sums up the latest run of this code on the problem's test cases,
or is `null` when it has not run since its code last changed: `passed` of
`total` cases, the slowest case's `timeMs` and the peak `memoryKb` (each
`null` when the engine measured nothing), and when it ran. It is set by
[`testcases/verify`](#post-itemsidtestcasesverify) and by saving a solution
from a submission (below), never from figures a client sends, and cleared
when the solution's `language` or `source` changes, through `PATCH` or by
writing `problem.referenceSolution`; a new name, notes or reference mark
keep it. Like submissions it is local to the instance: bundles do not carry
it, and imported solutions start without one.

`SolutionInput`: `name` (required, single line, 1–`limits.maxSolutionNameChars`),
`language` (required; any canonical language id, whether or not the judge
currently offers it), `source` (required, non-empty, at most
`limits.maxSourceBytes`), `notes` (Markdown, default `""`, at most
`limits.maxSolutionNotesChars`), `isReference` (default `false`).

`submissionId` (create only) names the submission the code comes from. When
it is a completed submission of this item over its test cases (not a run on
custom input, and not ended by `internal_error`) whose `language` equals the
solution's and whose `source` equals it once line endings are normalised,
the new solution's `lastRun` is that submission's `passedCount`,
`totalCount`, `timeMs`, `memoryKb` and `finishedAt`; a run of the samples
gives its figures over the samples. Otherwise, including a submission that
does not exist, it is ignored and the solution is saved without a
`lastRun`.

Setting `isReference: true` on one solution clears it on the item's others in
the same transaction. An item holds at most `limits.maxSolutionsPerItem`
solutions (`409 conflict` beyond that).

| Endpoint | Behaviour |
| --- | --- |
| `GET /items/{id}/solutions` | `{ "items": [Solution] }`, the reference solution first, then oldest first. Not paginated |
| `POST /items/{id}/solutions` | Body `SolutionInput`, optionally with `submissionId` (below). `201` `Solution` |
| `PATCH /solutions/{id}` | Partial `SolutionInput`. Returns `Solution`. `submissionId` is `422` here |
| `DELETE /solutions/{id}` | `204`. Deleting the reference solution leaves the item without one |

All of these return `422` for a reading. Changing the reference solution's
language or source, or which solution is the reference, changes
`problem.referenceSolution` and therefore the item's `revision`; `POST` and
`PATCH` accept an optional `expectedRevision` for that case, checked as for
`PATCH /items/{id}`. Other solution changes leave `revision` alone. Changing a
reference solution does not reset `verified` on test cases; run
`testcases/verify` again to re-check them.

## Working copies

The code the user is writing on a problem, kept on the server so that it
follows them across browsers and devices: one working copy per account,
problem and language, so switching to another language and back finds the earlier code
again. A working copy is not a solution and not a submission. It is personal
work in progress: never exported in bundles, not shown over MCP, and
writing it changes neither the item's `revision` nor its `updatedAt`. It is
deleted with its item, and kept when an import overwrites the problem (a
bundle item of another type never replaces it: it is imported as a copy).

`WorkingCopy`:

```json
{ "language": "python", "source": "def two_sum(nums, target):\n    ...", "updatedAt": "2026-11-22T09:30:00Z" }
```

| Endpoint | Behaviour |
| --- | --- |
| `GET /items/{id}/workspace` | `{ "items": [WorkingCopy] }`, most recently written first (in the order the writes happened, also within one second of `updatedAt`), so the first names the language last written in. Empty when there are none. Not paginated |
| `PUT /items/{id}/workspace/{language}` | Body `{ "source": "..." }`. Creates or replaces that language's working copy and returns it. `200` either way |
| `DELETE /items/{id}/workspace/{language}` | `204`, also when there was none: the client goes back to the starter code |

`{language}` is any canonical language id, whether or not the judge
currently offers it; another value is `422`. `source` is required and may
be empty (the user cleared the editor), at most `limits.maxSourceBytes`
(`422` beyond that); line endings are normalised as in every text field.
Each write is atomic: a working copy is always the whole of one write,
never a mix of two. Writes are last-write-wins: two tabs on the same
problem overwrite each other, and `updatedAt` tells a client which copy is
newer. All of these are `404` for an item that does not exist and `422`
for a reading.

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

Collections are [personal](#personal-data): each account has its own tree,
and puts shared items into it. Another account's collection is not found,
and is never listed.

| Endpoint | Behaviour |
| --- | --- |
| `GET /collections` | `{ "items": [Collection] }` — every collection of the account, flat, ordered by `parentId` then `position`; the client builds the tree. Not paginated |
| `POST /collections` | Body `{ "name", "description"?, "parentId"? }`; appended after its siblings. `201` `Collection` |
| `GET /collections/{id}` | `Collection` |
| `PATCH /collections/{id}` | Body: any of `name`, `description`, `parentId`, `position`. Moving under itself or a descendant is `409 conflict`. Setting `position` inserts at that index among the (new) siblings and renumbers them. Returns `Collection` |
| `DELETE /collections/{id}` | Child collections move up to the deleted collection's parent. Items are not deleted. `204` |
| `GET /collections/{id}/items` | `{ "itemIds": [...] }` — the full ordered membership, ids only. Not paginated |
| `PUT /collections/{id}/items` | Body `{ "itemIds": [...] }` — replaces membership and order with exactly this list; `[]` empties the collection, and an id listed twice is `422`. `itemIds` is required: missing or `null` is `422` (`fields.itemIds`). Returns `{ "itemIds": [...] }` |
| `POST /collections/{id}/items` | Body `{ "itemIds": [...] }` — appends those not already members, in order; an id listed twice is added once, and `[]` adds nothing. `itemIds` is required: missing or `null` is `422` (`fields.itemIds`). Returns `{ "itemIds": [...] }` (full ordered membership) |
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
  empty. The exception is a compile error that the engine reports on a later
  case only (a compiler that timed out under load, say): that case gets a
  `compile_error` result with the compiler output in its `stderr`, the other
  results stay, and when it is the first non-accepted result `compileOutput`
  holds its compiler output.
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
- On a compile error with empty `results`, `passedCount` is `0`, `totalCount`
  keeps its value, and `timeMs` / `memoryKb` are `null`.
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

Generating with an AI provider takes from a few seconds to a few minutes, so
every generation runs on the server as an [AI job](#ai-jobs): the request is
checked and answered at once, the job runs in the background, and its result
is kept until the client collects it. A job keeps running when the page that
started it is left or closed; only cancelling it (or dismissing it) stops it.
Four kinds of generation exist:

| Kind | Started by | Result |
| --- | --- | --- |
| `draft` | [`POST /drafts`](#post-drafts) or [`POST /drafts/{id}/generate`](#post-draftsidgenerate) on a `capture` draft, with a [draft request](#draft-requests) | `DraftResponse`, also written into the [draft](#drafts) |
| `variant` | The same on a `variant` draft, with a [variant request](#variant-requests) | `DraftResponse`, also written into the draft |
| `testcases` | [`POST /items/{id}/ai/testcases`](#post-itemsidaitestcases) | `TestCasesResponse` |
| `code` | [`POST /ai/code`](#post-aicode) | `CodeResponse` |

Generations never write to the library; the client saves results through the
item and test-case endpoints (or [saves the draft](#post-draftsidsave)) after
the user has reviewed them.

Every request that starts a generation is validated before anything is
queued, and the answers that used to come back synchronously still do:
`400`/`422` for a bad request, `404` for an unknown item, `503
ai_unavailable` when AI features are off or there is no usable provider,
`409 conflict` when [too many jobs](#limits-and-retention) are active.
Anything that can only go wrong while generating — the provider failing or
returning output that does not validate (`upstream_error`), the item being
deleted meanwhile (`not_found`), AI features being switched off before the
job started (`ai_unavailable`) — ends the job as `failed` with that error.

Each request that starts a generation takes an optional `providerId`: the
provider to use for this request, with the model saved on it. It must name a
provider that is `ready` (`422` on `providerId` otherwise), and it does not
change the default. Without it, or with `null`, the default provider is used,
and the answer is `503 ai_unavailable` when no default is chosen and ready. A
request that names a provider works whether or not there is a default. While
AI features are switched off (`enabled: false` in
[AI settings](#get-settingsai)) every request is `503 ai_unavailable`, one
that names a provider too. The provider is checked again when the job
starts.

None of these requests holds the connection open for the generation, so a
reverse proxy needs no special timeout for them, and like the
[AI job](#ai-jobs) routes they get the server's default two-minute deadline.
The requests that still wait on something slow get a six-minute deadline
instead, and a proxy in front of the server must allow them as long:
`POST /items/check`, `POST /items/{id}/testcases/verify`, `POST /export`,
`POST /import`, `POST /import/preview`, and the provider's
[connection test](#post-settingsaitest) and
[model list](#post-settingsaimodels).

### AI jobs

`AiJob`:

```json
{
  "id": "...",
  "kind": "testcases",
  "itemId": "...",
  "draftId": null,
  "title": "Two Sum",
  "status": "running",
  "origin": "/items/.../tests/generate",
  "error": null,
  "pickedUp": false,
  "createdAt": "...",
  "startedAt": "...",
  "finishedAt": null
}
```

- `kind` — `draft`, `variant`, `testcases` or `code` (see the table above).
- `itemId` — the item the job is about: the problem for `testcases`, the
  original for `variant`, the `itemId` of a `code` request; `null` otherwise.
- `draftId` — the [draft](#drafts) a `draft` or `variant` job generates
  for, `null` for the other kinds. The job's result is written into that
  draft, so a client goes to the draft, not to the job, for it.
- `title` — a short label for lists, fixed by the server: the item's title;
  for a `code` request its `title` (or the start of its `body`); for a
  `draft` job the start of the input text, replaced by the drafted item's
  title once it succeeds. A start of text that is cut ends with "…".
- `status`:

  | `status` | Meaning |
  | --- | --- |
  | `queued` | Waiting for a free worker (see `CODEATROPHY_AI_WORKERS`) |
  | `running` | The provider request (and then the checks that follow it) is under way |
  | `succeeded` | Finished; `result` holds the response body |
  | `failed` | Finished with `error` |
  | `cancelled` | Cancelled or dismissed before it finished; no result, `error` is `null` |

  `queued` and `running` are *active*; the others are *finished*. A job only
  moves forward: `queued` → `running` → one of the finished states, or
  straight from `queued` to `cancelled`.
- `origin` — the `origin` the starting request gave, unchanged: an opaque
  string for the client, meant as the screen to go back to for the result
  (`null` if none was given). It is a single line of at most 2000
  characters (`422` on `origin` otherwise). Requests that start a draft's
  generation take no `origin`; the draft is the place to go back to.
- `error` — for `failed`, the error the request would have answered with,
  in the shape of an error body's `error` (`{ "code", "message", "fields"? }`,
  see [Errors](#errors)); otherwise `null`. One code appears only here:
  `interrupted`, for a job that was running when the server stopped.
- `pickedUp` — whether the client has collected the outcome (see
  `POST /ai/jobs/{id}/pickup`).
- `startedAt` and `finishedAt` are `null` until the job starts and
  finishes. Elapsed time for a running job is the current time minus
  `startedAt` (or `createdAt` while queued).

`AiJobDetail` is `AiJob` plus:

```json
{
  "request": { "count": 8, "language": "python", "origin": "/items/.../tests/generate" },
  "result": { "referenceSolution": { "language": "python", "source": "..." }, "cases": [ ... ] }
}
```

`request` is the body the job was started with, as it was sent (for a
draft's job, the [draft request](#draft-requests) or
[variant request](#variant-requests)). `result` is, for a `succeeded` job,
exactly the body the request's synchronous endpoint used to answer with
(`DraftResponse`, `TestCasesResponse` or `CodeResponse`); `null` otherwise.

| Endpoint | Behaviour |
| --- | --- |
| `GET /ai/jobs` | Query: `active` (`true`: only queued and running jobs), `kind`, `itemId`, `draftId`, `pickedUp` (`false` by default: only jobs whose outcome has not been collected; `true`: only those that have), `limit` (default 50, max 200). Newest first. `{ "items": [AiJob] }` |
| `GET /ai/jobs/{id}` | `AiJobDetail` |
| `POST /ai/jobs/{id}/cancel` | Cancels a `queued` or `running` job: it becomes `cancelled` at once and its provider request is aborted (the [AI activity log](#ai-activity-log) records it as `cancelled`). A finished job is left as it is. Returns `AiJob` |
| `POST /ai/jobs/{id}/pickup` | Marks a finished job's outcome as collected, so it leaves the default list, and returns `AiJobDetail`. `409` while the job is active. Picking up twice is harmless |
| `DELETE /ai/jobs/{id}` | Dismisses a job: cancels it first if it is active, then removes it. `204` |

An unknown or removed job is `404` on every endpoint. A bad query value is
`400`.

#### How a client follows a job

- Starting a generation answers `202` with the `AiJob` (`queued`), or with
  the draft that carries it. Poll `GET /ai/jobs/{id}` (or the draft) every
  one to two seconds while the job is active, and stop once it is finished.
  There is no push channel.
- A screen that is left keeps nothing running in the browser. A client that
  wants to come back to a result remembers the job's id (or uses `origin`
  and the job list), and on return reads the job, applies `result` once if
  it `succeeded` (or shows `error` if it `failed`), and then calls
  `POST /ai/jobs/{id}/pickup`, so that the outcome is not offered again.
- An overview of jobs (a notification area) polls `GET /ai/jobs` every few
  seconds while one of them is active, and otherwise only on demand; the
  default list is what has not been collected yet.
- The server never needs the client to collect anything: an uncollected job
  is just listed until it is dismissed or [pruned](#limits-and-retention).

#### Limits and retention

- At most `CODEATROPHY_AI_WORKERS` jobs (default 2) run at once; the others
  wait `queued`, in the order they were started.
- At most 20 jobs may be active at once, counting every account's, since
  they share the workers. A request that would start a 21st is
  `409 conflict`, and nothing is queued.
- Jobs are listed, read, cancelled and dismissed by the account that started
  them only; another account's job is `404`.
- A finished job is kept for 3 days after it finished, and only while it is
  among the 200 newest jobs of the server. Active jobs are never removed. A removed job is `404`; the [AI activity
  log](#ai-activity-log) keeps its request either way, and a draft keeps what
  its job produced.
- When the server starts, jobs a previous process left `running` become
  `failed` with code `interrupted` ("the server restarted before this job
  finished; start it again"), and jobs left `queued` are queued again.

### Draft requests

The body of a `capture` draft's generation ([`POST /drafts`](#post-drafts)
with `generate`, or [`POST /drafts/{id}/generate`](#post-draftsidgenerate)):
turn rough input into a complete item draft.

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
- `previousDraft` — optional `ItemDraft` from an earlier generation; with
  `instruction` this asks for a revision rather than a fresh draft.
- `styleId` — optional; which [style preset](#style-presets) to write in.
- `instruction` — at most 2000 characters.
- `largeTestCases` — integer 0–`limits.maxLargeTestCases`, default `0`: also
  build that many [large test cases](#large-test-cases). Ignored for a
  reading.
- `testCaseCount` — integer 0–`limits.maxGeneratedTestCases`, default `0`:
  how many test cases the draft has at least, not counting large ones. The
  sample cases matching the body's examples come first, then hidden
  (non-sample) cases until there are `testCaseCount`; if the examples alone
  are that many or more, all of them are kept as samples and no hidden case
  is added. A revision keeps the cases of its `previousDraft` (unless the
  `instruction` asks to change them) and only adds hidden cases up to
  `testCaseCount`: it never removes cases to reach it. The hidden cases follow the same test-design guidance as
  [test-case generation](#post-itemsidaitestcases) (the built-in rules, or
  the [custom test case prompt](#test-case-prompt) that replaces them). `0`
  asks for the sample cases only. Applies to a revision too. Ignored for a
  reading.
- `providerId` — optional; the [provider](#ai) to use instead of the default.

The result, `DraftResponse`:

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
      { "name": "Example 1", "stdin": "...", "expectedStdout": "...", "isSample": true, "verified": true, "generator": null }
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
Every generation's result (draft, variant, test cases, code) carries
`usage`, and the server's own log gets the same figures, never the content.

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
- the check is bounded: it runs every test case (a draft has at most
  `limits.maxGeneratedTestCases`, besides large ones), hidden ones as well as
  samples, within 50 seconds. Cases it did not reach in time stay
  unverified, and `check.error` says how far it got.

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
and sets each test case's `origin` to `ai`). Each draft test case has a
`generator`: `null`, or for a [large test case](#large-test-cases) the
program that printed its `stdin`; saving the draft with the case's `stdin`
and `generator` stores both, so the generator is kept with the case. `problem` is `null` and
`testCases` is `[]` for a reading. A test case the model wrote whose `stdin`
equals that of an earlier one (ignoring trailing whitespace) is left out, as
in test-case generation, and at most `limits.maxGeneratedTestCases` are kept;
a draft can therefore have fewer than `testCaseCount` cases. `assumptions` lists everything the model
inferred or invented that was not in the input; it is for display during
review and is not stored. `tags` are the model's suggestions, normalised like
item tags and with whitespace inside a tag replaced by `-`, so they match
tags typed in the UI; ones that are not valid tags are left out.

### Variant requests

The body of a `variant` draft's generation ([`POST /drafts`](#post-drafts)
with `generate`, or [`POST /drafts/{id}/generate`](#post-draftsidgenerate)):
draft a new item derived from the draft's `variantOf` item — a fresh
problem to practise the same idea on, or a reading reworked for a different
angle.

```json
{ "mode": "similar", "instruction": null, "previousDraft": null, "styleId": "..." }
```

`styleId` is optional and selects a [style preset](#style-presets).
`providerId` is optional and names the [provider](#ai) to use instead of the
default.
`largeTestCases` (integer 0–`limits.maxLargeTestCases`, default `0`) asks
for [large test cases](#large-test-cases), as for a draft.
`testCaseCount` (integer 0–`limits.maxGeneratedTestCases`, default `0`) is
how many test cases the variant has at least, samples first and then hidden
ones, as for a draft (a revision never removes cases to reach it); it is ignored when the original is a reading.
`instruction` is at most 2000 characters. `previousDraft` is an optional
`ItemDraft` from an earlier variant generation; with `instruction` it asks
for a revision of that variant rather than a fresh one.

| `mode` | Result |
| --- | --- |
| `similar` (default) | Same underlying technique and difficulty, different story, data and surface details |
| `easier` | A simplified version: smaller constraints or a relaxed requirement |
| `harder` | A stronger version: tighter constraints or an added requirement |
| `twist` | One rule changed so that the original approach no longer works as is |

`instruction` is optional free-form guidance and may be combined with any
mode. For readings only `similar` (with an `instruction`) is meaningful; the
other modes are `422`.

The result is a `DraftResponse`, as for a [draft request](#draft-requests),
with the same reference solution and check. A
variant keeps the original's [interface](#problem-interface) unless the
request gives an `interfaceHint` of `program` or `function` (`auto` or
omitted keeps it; any value is `422` for a reading). Here
`assumptions` describes how the variant differs from the original. Saving
the draft creates the item with `variantOf` set to the original's id; the
original's tags and collections are a sensible default for the new item. Test
cases of the original are never copied, since they do not apply. An original
that has been deleted is `404` when a generation is requested, and fails a
job that was waiting with `not_found`.

### `POST /items/{id}/ai/testcases`

Propose test cases for an existing problem.

```json
{ "count": 8, "language": "python", "instruction": null, "largeTestCases": 0 }
```

- `count` — 1–`limits.maxGeneratedTestCases`, default 8 (or the limit, if lower).
- `largeTestCases` — integer 0–`limits.maxLargeTestCases`, default `0`: also
  build that many [large test cases](#large-test-cases), in addition to the
  `count` cases.
- `language` — language for the reference solution; default `python`. If the
  item already has a reference solution it is given to the model as context.
  For a `function` problem the language must have a harness (`422`), and the
  reference solution is the solution part only.
- `instruction` — optional, at most 2000 characters.
- `providerId` — optional; the [provider](#ai) to use instead of the default.
- `origin` — optional; kept on the [job](#ai-jobs) as it is.
- `422` for a reading.

Answers `202` with the `AiJob`. The result of the job, `TestCasesResponse`:

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
      "error": null,
      "generator": null
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
`count`, and empty when every proposal was a repeat. `usage` is as for a [draft request](#draft-requests).

When no engine is available, `verification.attempted` is `false`, and every
case has `expectedStdout = predictedStdout`, `verified: false`,
`predictionMatched: null`. When an engine is configured but cannot be
reached, the proposal is still returned: `verification.attempted` is `true`,
`verification.error` says why, and the cases are unverified as above.

The client saves accepted cases with `POST /items/{id}/testcases/bulk`,
passing `origin: "ai"`, each case's `verified` flag, and the
`referenceSolution`. A large case is saved with its `stdin`, `generator`,
`expectedStdout` and `verified` as the response gave them: the server stores
the generator with the case without running it again.

`largeCases` reports on the [large test cases](#large-test-cases): one entry
for each the request asked for, `[]` when it asked for none. When the
reference solution did not compile, cannot run, or failed on a proposed
input, none is built: each is `skipped` with the error `the reference
solution did not pass the other test cases`, as in a draft.

### `POST /ai/code`

Write the code of a problem's languages: for a `program` problem the starter
code, and for a `function` problem the stub and the harness of each. The
problem is given in the request, as it stands in an editor, so it need not
be saved, and the request reads nothing from the library.

```json
{
  "itemId": "...",
  "title": "Coin Change",
  "body": "## Problem\n\n...\n\n## Input\n\n...",
  "interface": "program",
  "languages": ["python", "cpp", "java"],
  "samples": [ { "stdin": "3 11\n1 2 5\n", "expectedStdout": "3\n" } ],
  "styleId": "...",
  "providerId": null
}
```

- `languages` — required, at least one known language id; repeats are
  ignored. Code is written for these and no others.
- `interface` — `program` (default) or `function`.
- `title` and `body` — the problem's title (at most
  `limits.maxTitleChars`) and statement (at most `limits.maxTextBytes`); at
  least one of them must not be blank. The statement's input and output
  format is what the code follows.
- `samples` — optional sample test cases (at most
  `limits.maxTestCasesPerItem`, each `stdin` and `expectedStdout` at most
  `limits.maxTestDataBytes`). The model is shown the first five, one larger
  than a few kilobytes by its size only. For a `function` problem they show
  the input the harness reads, and the first one is what the runners are
  checked on.
- `itemId` — optional: the saved item the problem is, which only labels the
  request in the [AI activity log](#ai-activity-log); it must exist (`422`).
  Its stored content is not used.
- `styleId` — optional; the [style preset](#choosing-a-preset-for-a-generation)
  to write in, as for a draft.
- `providerId` — optional; the [provider](#ai) to use instead of the default.
- `origin` — optional; kept on the [job](#ai-jobs) as it is.

The prompt carries the authoring conventions (or a
[custom system prompt](#system-prompt) with the fixed rules) as a draft's
does: the stdin/stdout contract, the folded input region of a program's
starter code, the stub, prefix and suffix of a function problem, and the
judge's language versions.

Answers `202` with the `AiJob`. The result of the job, `CodeResponse`:

```json
{
  "starterCode": { "python": "import sys\n\n\ndef main() -> None:\n    # region input\n    ..." },
  "harness": {},
  "check": null,
  "style": null,
  "usage": { "logId": "...", "model": "claude-haiku-5-5", "durationMs": 14200, "inputTokens": 3100, "outputTokens": 2400, "reasoningTokens": null, "cacheReadTokens": 0, "cacheWriteTokens": 0 }
}
```

- `starterCode` has an entry for each language the model wrote usable code
  for, and only for languages that were asked for: one it left out, or wrote
  without starter code or over `limits.maxSourceBytes`, is missing. With no
  usable entry at all the answer is `502 upstream_error`.
- `harness` has the same languages for a `function` problem, `{}` for a
  `program` problem. A Python prefix without
  `from __future__ import annotations` gets it added, as in a draft.
- `check` is `null` for a `program` problem. For a `function` problem it
  proves the runners as a [draft's check](#draft-requests) does:
  `{ "attempted": true, "engine": "judge0", "runners": [RunnerCheck] }`, one
  entry per language in language order, each language's stub run unchanged
  in its harness on the first sample. `attempted` is `false` (with
  `engine: null` without an engine, and `runners: []`) when there is no
  judge engine or no sample. The check stops after 50 seconds.
- `style` and `usage` are as for a [draft request](#draft-requests).

Nothing is stored: the client puts the code into its form, and saves it with
the item.

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
`cases` (for test generation), never a sample, with `verified: true` and
their `generator`. In `cases` their `predictedStdout` and
`predictionMatched` are `null`; the model has not seen the input. Only the reference solution vouches for the expected
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
    "error": "the generator failed: runtime error: IndexError: list index out of range",
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
  run, the request was cancelled, the reference solution did not pass the
  other test cases (in test generation: it did not compile, cannot run, or
  failed on a proposed input), or — in a draft — the check was not attempted
  or the check's time ran out. `error` gives the reason in plain words for `failed`
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
- `generator` — the program; `null` if the model gave none. An added case
  carries the same generator, which is stored with it when the case is
  saved (see [Generators](#generators)).

Generators the model wrote beyond the number asked for are ignored.

In a draft the large cases are part of the [check](#draft-requests): they run
after the other test cases and before the runners, within the same time
bound, and each one added counts in `check.passed` and `check.total`.

A case can also be given a generator directly, without an AI generation
(see [Generators](#generators)), which is how an MCP client adds large
cases: it runs the same way and has the same output checks, and the
expected output then comes from verifying the case.

Large test data is never sent to a model. Wherever a prompt lists test cases
— the existing cases in test generation, the cases of a `previousDraft` in a
revision — a case whose input or expected output is larger than a few
kilobytes is described by its name and size only, and in a `previousDraft`
so is a case that has a `generator`, whatever its size. A revision therefore
does not carry such a case over: with `largeTestCases` it builds new ones, and
without it the revised draft has none. A client should leave the large cases
of the earlier response out of the `previousDraft` it sends, whatever their
size, which also keeps that request within `limits.maxPreviousDraftBytes`;
a case of more than a few kilobytes that is sent anyway is dropped before
that limit is applied, not refused.

## Drafts

A **draft** is a new item in progress, kept on the server for the account
that made it: one being captured
(`kind: "capture"`) or a variant of an existing item (`kind: "variant"`),
written by the AI or by hand. It holds what the generation produced and the
client's review form with the user's edits, so the work survives leaving the
page, a reload, another browser and a restart. Drafts never expire: a draft
goes away only when it is [saved to the library](#post-draftsidsave) or
deleted. Drafts are local work: they are not part of bundles and are not
offered over MCP.

A draft's AI generation is an [AI job](#ai-jobs) of kind `draft` (for a
`capture` draft) or `variant`. When the job finishes, the server writes its
outcome into the draft itself — the result into `generation`, or the error
into `error` — whether or not any client is watching. A revision ("make it
harder") is another generation of the same draft, with `previousDraft` and
`instruction` in its request; its result replaces the previous one.

`Draft`:

```json
{
  "id": "...",
  "kind": "capture",
  "variantOf": null,
  "title": "Two Sum",
  "state": "ready",
  "revision": 4,
  "edited": false,
  "request": { "text": "that problem with an array and a target...", "typeHint": "auto", "largeTestCases": 0 },
  "job": AiJob,
  "error": null,
  "generation": DraftResponse,
  "generationSeq": 1,
  "content": { ... },
  "basedOn": 1,
  "createdAt": "...",
  "updatedAt": "..."
}
```

- `kind` — `capture` or `variant`. `variantOf` is the original's id for a
  `variant` draft (it may name an item that has since been deleted), `null`
  for a `capture` draft.
- `title` — a label for lists: the `title` the client last set, else the
  title of the latest generation's draft, else the start of the request's
  `text` (for a `capture` draft, ending with "…" when cut) or "Variant of
  …" with the original's title, else "Untitled draft".
- `state` — what the draft is waiting for, derived from the fields below in
  this order:

  | `state` | When |
  | --- | --- |
  | `drafting` | `job` is queued or running |
  | `failed` | The latest generation failed: `error` is set |
  | `ready` | A generation has not been taken into `content` yet (`generationSeq` > `basedOn`), or the content is a generation's, unedited (`generationSeq` > 0 and `edited` is `false`) |
  | `edited` | Otherwise, when there is `content`: the user edited the draft, or wrote it by hand |
  | `new` | Nothing yet: no content and no generation (for example the first generation was cancelled) |

- `revision` — increases by one on every change to the draft, the
  server's included (a generation starting or finishing). Updates may state
  the revision they were based on (`expectedRevision`).
- `request` — the body of the latest generation request, as sent, or `null`
  if there was none. It is what [`retry`](#post-draftsidretry) sends again.
- `job` — the latest generation's job (`AiJob`), or `null` when there was
  none or the server no longer has it (jobs are [pruned](#limits-and-retention);
  the draft keeps their outcome).
- `error` — why the latest generation failed (`{ "code", "message",
  "fields"? }`, as a job's), or `null`. Starting a generation clears it, and
  so does an update that sets `content`.
- `generation` — the `DraftResponse` of the latest generation that
  succeeded, or `null`. `generationSeq` counts the generations that
  succeeded (0 before the first).
- `content` — the client's own document, a JSON object, stored and returned
  as it is: the review form, with whatever the client needs to show it
  (assumptions, the applied style, check results, …), or `null`. The server
  never reads it. With the rest of the request it is bounded by
  `limits.maxRequestBytes`.
- `basedOn` — the `generationSeq` the `content` was built from (0 for content
  written by hand). A client that finds `generationSeq` > `basedOn` builds
  its form from `generation` (keeping what a generation does not produce,
  such as the collections and the source, from the old content), and saves
  it with `basedOn: generationSeq`.
- `edited` — whether the user has changed `content` since it was built from
  a generation; `true` for a draft written by hand.

`DraftSummary` is `Draft` without `request`, `generation` and `content`.

Limits: at most 500 drafts per account (`409 conflict` beyond).

### `GET /drafts`

Query: `kind`, `variantOf` (optional filters). Returns `{ "items":
[DraftSummary] }`, most recently changed first (`updatedAt`). Not
paginated.

### `POST /drafts`

```json
{
  "kind": "capture",
  "variantOf": null,
  "content": null,
  "title": null,
  "generate": { "text": "that problem where...", "typeHint": "auto", "styleId": "..." }
}
```

- `kind` — required, `capture` or `variant`. `variantOf` is required for a
  `variant` draft (an existing item, `422` otherwise) and must be absent or
  `null` for a `capture` draft.
- `generate` — optional: a [draft request](#draft-requests) for a `capture`
  draft, a [variant request](#variant-requests) for a `variant` draft. It is
  validated exactly as that request is, with the same errors and field names
  (`text`, `styleId`, `providerId`, …), and nothing is created when it fails.
  When valid, the draft is created in state `drafting` with its job, and the
  answer is `202`.
- `content`, `title` — optional, as for `PATCH`. A draft created with
  `content` and without `generate` is written by hand: `edited` is `true`.

Returns `201` (`202` with `generate`) with the `Draft`.

### `GET /drafts/{id}`

Returns `Draft`. While `state` is `drafting`, poll it (or its job) every
one to two seconds.

### `PATCH /drafts/{id}`

```json
{ "content": { ... }, "basedOn": 1, "edited": true, "title": "Two Sum", "expectedRevision": 4 }
```

A merge update; every field is optional.

- `content` — a JSON object, or `null`; replaces the stored content and
  clears `error`.
- `basedOn` — an integer from 0 to `generationSeq` (`422` otherwise). Setting
  it to `generationSeq` also marks the latest generation's job
  [picked up](#ai-jobs).
- `edited` — a boolean. A client sets it to `true` when the user changes the
  form, and to `false` when it saves content just built from a generation.
- `title` — the item's title as the form has it: a [single line](#single-line-fields)
  of at most `limits.maxTitleChars`, or `null`/empty to fall back to the
  server's label.
- `expectedRevision` — optional. When it is not the draft's `revision`, the
  update is refused with `409 conflict` and `fields.revision` set to the
  current revision, as for [`PATCH /items/{id}`](#patch-itemsid); nothing is
  changed. A client then reads the draft again.

Returns the `Draft`. Updating a draft whose generation is running is
allowed; the generation's result then arrives in `generation` as usual.

### `POST /drafts/{id}/generate`

Starts a generation of the draft. The body is a [draft
request](#draft-requests) for a `capture` draft or a [variant
request](#variant-requests) for a `variant` draft, validated as there; for a
revision it carries `previousDraft` (the form as it stands, as an
`ItemDraft`) and `instruction`. It becomes the draft's `request`, the
draft's `error` is cleared, and the previous job, if finished, is marked
picked up. `409 conflict` while the draft's job is active. Returns `202`
with the `Draft` (`state: "drafting"`).

### `POST /drafts/{id}/retry`

Starts a generation with the draft's `request` again, as
`POST /drafts/{id}/generate` would. `409` while the draft's job is active,
`422` when the draft has no `request`. Returns `202` with the `Draft`.

To cancel a draft's generation, cancel its job
([`POST /ai/jobs/{id}/cancel`](#ai-jobs)); the draft keeps what it had.

### `POST /drafts/{id}/save`

```json
{ "item": ItemInput, "expectedRevision": 7 }
```

Creates the item exactly as [`POST /items`](#post-items) does from `item` —
its test cases, with their generators, and reference solution included —
and deletes the draft, in
one transaction: either both happen or neither does. For a `variant` draft,
`item.variantOf` defaults to the draft's `variantOf`. A generation still
running is cancelled. `expectedRevision` is optional and checked as for
`PATCH`. Validation errors are those of `POST /items`, field names
unchanged. Returns `201` with the `Item`, whose `createdBy` carries the
model of the draft's latest generation when `basedOn` > 0 (see
[`Item`](#shapes)).

### `DELETE /drafts/{id}`

Discards the draft, cancelling its generation if one is running. `204`.

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
  "effort": "high",
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
  generation, code generation, and the generation step of a connection
  test — counted when it ends. `failed` is the part of `requests` that returned no usable answer,
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
- `effort` is how much effort the model is asked to spend on each request:
  `low`, `medium` or `high`, or `null` for the model's own default, in
  which case none is asked for. For `anthropic` it is sent as
  `output_config.effort`, and only where the service reports that the model
  accepts that level; a connection test asks for `low` whatever is set. For
  `openai_compatible` and `gemini` it is sent as `reasoning_effort`, on a
  connection test too, so a server that does not take it fails the test.
  Environment providers have `high` for `anthropic` and `null` otherwise.
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
| `effort` | `low`, `medium`, `high` or `null` |
| Saved providers per instance | 20 |

Violations are `422 validation_failed`; a 21st provider is `409 conflict`.

Providers are local configuration: they are never written to or read from
bundles and are not available over MCP.

### `GET /settings/ai`

```json
{
  "enabled": true,
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
- `enabled` is the AI features switch as saved; `true` until it is first
  saved. AI features are on (`ai.enabled` in [`GET /meta`](#get-meta)) when
  it is `true` and the default provider is `ready`. Switching off keeps the
  default provider.
- `defaultProviderId` is the provider the AI endpoints use; `null` means
  there is none, and AI features are off. It always names a provider in
  `providers`.
  `CODEATROPHY_AI_PROVIDER` gives its initial value only (the environment
  provider of that kind): once a default has been saved through `PUT` —
  including `null` — the saved value applies.
- A default that is no longer `ready` (its key was deleted, say) stays
  selected, and AI features are off until it is fixed or another is chosen,
  whatever `enabled` says.
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
{ "enabled": true, "defaultProviderId": "...", "timeoutSeconds": 120 }
```

A merge update: a field left out keeps its value. Returns the same body as
`GET /settings/ai`.

- `enabled` switches AI features on or off (a boolean, `422` otherwise).
  `false` keeps the default provider and every provider. `true` when there
  is no default (after applying a `defaultProviderId` in the same request)
  makes the first `ready` provider, in the order `providers` lists them, the
  default; with none ready it is `422` on `enabled`.
- `defaultProviderId` chooses the default provider; `null` leaves none,
  which turns AI features off, and keeps every provider. An unknown id, or a
  provider that is not `ready`, is `422`. Choosing a default does not change
  `enabled`.
- `timeoutSeconds` sets the request timeout: an integer from
  `limits.minAiTimeoutSeconds` to `limits.maxAiTimeoutSeconds`, `422`
  otherwise. `null` removes the saved value, so `defaultTimeoutSeconds`
  applies again. The new value applies from the next request; a request
  already under way keeps the timeout it started with.

### Providers

| Endpoint | Behaviour |
| --- | --- |
| `POST /settings/ai/providers` | Body `{ "name", "kind", "model"?, "baseUrl"?, "apiKey"?, "effort"? }`. `201` `AiProvider` |
| `PATCH /settings/ai/providers/{id}` | Merge update of `name`, `model`, `baseUrl`, `apiKey`, `effort`. Returns `AiProvider` |
| `DELETE /settings/ai/providers/{id}` | `204`. Deleting the default leaves no default: AI features are off until another is chosen, or until they are switched on again (which picks one) |

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
- `effort` omitted on create, or `null`, is the model's default. Any value
  other than `low`, `medium`, `high` or `null` is `422` on `effort`.
- A provider need not be `ready` to be saved, so a key can be stored before a
  model is chosen.

### `POST /settings/ai/test`

Checks a provider configuration against the service and lists the models it
offers. Nothing is saved, so a key can be tried before it is stored.

```json
{ "providerId": "...", "kind": null, "model": null, "baseUrl": null, "apiKey": null, "effort": "high" }
```

Give `providerId` to test a saved or environment provider; any of `model`,
`baseUrl`, `apiKey` given with it override its values for this test, and so
does `effort` whenever it is present, `null` (the model's default) included.
An `effort` that is not a [provider's](#ai-settings) is `422`. Give
`kind` instead (and no `providerId`) to test a configuration that has not
been saved yet. Exactly one of the two is required (`422` otherwise); an
unknown `providerId` is `422` too.

When `baseUrl` points at a different origin from the one the provider's key
belongs to, that key is not used: only an `apiKey` given in the same request
is sent, and with none the test is made without a key.

The server does not connect to an address the egress policy refuses (cloud
metadata and link-local addresses always; loopback and private ones with
`CODEATROPHY_AI_BLOCK_PRIVATE`; see the README's Security section), and does
not follow a redirect to another origin. Either is reported like an
unreachable service, in `error` or `modelsError`, for example
`could not reach the AI provider: 169.254.169.254 is a cloud metadata
address, which AI providers may not connect to`. The same applies to every
request a provider makes.

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
same requests that [`AiProvider.usage`](#ai-settings) counts — for the
account it was made for, so that what a generation cost, and exactly what was sent and what came back, can be looked
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

- `operation` — `draft`, `variant`, `testcases`, `code` or `test` (a
  connection test).
- `itemId` is the item the request was about (`null` for a new draft, for a
  test, and for code generation without an `itemId`); `title` is a short
  label fixed when the entry is written — the item's title (for a variant,
  the original's; for code generation, the title in the request), or the
  title of the draft that came back — or `null`. An entry outlives its item.
- `providerName`, `kind` and `model` are as they were at the time.
- `status` — `ok`, `failed` (with `error`) or `cancelled` (its
  [job](#ai-jobs) was cancelled or dismissed, or a connection test's client
  went away).
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
`effort` are `null` where the provider's default applies; `effort` is the
provider's level, or `low` for a connection test of an `anthropic`
provider) and `response` the
text the model returned (`null` if none arrived). They are for reading, not for
programs: the fields of `request` may change between versions. They never
contain an API key or any request header. Either is cut off at 256 KiB, and
`truncated` says so.

| Endpoint | Behaviour |
| --- | --- |
| `GET /settings/ai/log` | Query: `providerId`, `operation`, `status` (optional filters), `limit` (default 50, max 200), and either `offset` (default 0) or `before` (a cursor). Newest first. `{ "items": [AiLogEntry], "next": "<cursor>", "total": n }` |
| `GET /settings/ai/log/{id}` | `AiLogDetail`. `404` for an unknown or removed entry |
| `DELETE /settings/ai/log` | Query: `before` (optional timestamp). `204`. Removes every entry, or those created before the timestamp |

The log is append-only: an entry is written once and never changed, and
nothing is removed unless the user asks. It can be listed in two ways:

- **Numbered pages**, like the other lists: `offset` skips that many
  entries (matching the filters) from the newest, as the
  [conventions](#conventions) describe (`limit` outside 1–200 or a negative
  `offset` is `400`). Page *n* of size `limit` starts at `offset =
  (n − 1) × limit`; `total` gives the number of pages. A page can shift
  when entries arrive or are removed between two requests.
- **A cursor**, for loading as the user scrolls: `next` is the cursor to
  pass as `before` for the following page, `null` at the end; a cursor
  stays valid while new entries arrive, so a page never repeats or skips
  entries.

`offset` and `before` together are `400 bad_request`. Every page carries
`next`, whichever way it was asked for. `total` counts the entries matching
the filters. The list carries no request or response text; that is fetched
per entry.

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
count towards the limit, and are not recreated once changed or deleted. An
app update may refresh the text of a built-in preset that was never edited.

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

[Draft requests](#draft-requests), [variant requests](#variant-requests) and
`POST /ai/code` accept a `styleId` field:

| `styleId` | Style applied |
| --- | --- |
| omitted | The default preset, if there is one |
| `null` | None — built-in conventions only |
| a preset id | That preset; unknown id is `422` |

Their results carry the preset that was actually applied:
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
language ids and versions, expected outputs coming from a reference
solution, the one HTML block that renders (`<details>`, for answers and
hints) and code blocks marked as language tabs. So do the rules each request
adds after the conventions and the style preset (sample test cases with
correct outputs, the reference solution, assumptions, large test cases, the
JSON-only answer), and the judge's languages in the user turn.

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
- A custom text applies to draft and variant generations, `POST /ai/code`
  and the MCP server's authoring guide (`get_authoring_guide`, resource and prompts),
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

How the user likes the app to behave. Preferences are stored on the server,
per account, so they follow the user across browsers; they are personal and never exported.
Over MCP, `get_overview` reports the test case preferences (`hideTestCases`,
`generatedTestCases`, `largeTestCase`, `largeTestCaseCount`) for the
assistant to follow; no MCP tool changes them. The server stores and
validates them but does not act on them — they are for clients to honour.

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
| `generatedTestCases` | integer 1–`limits.maxGeneratedTestCases` | How many test cases to ask for by default when generating them: the initial value of the count a client sends as `count` to `POST /items/{id}/ai/testcases`, and the count it sends as `testCaseCount` in draft and variant requests. A value saved under a higher `limits.maxGeneratedTestCases` reads as the limit, and writing one above it is `422`; the default never exceeds it |
| `largeTestCase` | boolean | Whether to ask for [large test cases](#large-test-cases) by default: whether a client sends a non-zero `largeTestCases` in draft and variant requests, and the initial value of that choice for `POST /items/{id}/ai/testcases` |
| `largeTestCaseCount` | integer 1–`limits.maxLargeTestCases` | How many large test cases to ask for when they are asked for: the value a client sends as `largeTestCases`. A value saved under a higher `limits.maxLargeTestCases` reads as the limit, and writing one above it is `422`; the default never exceeds it |
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
- Each exported item carries the ids of all its [links](#links), also to
  items left out of the bundle or deleted.

Returns `200` `application/zip` with
`Content-Disposition: attachment; filename=<slug>.codeatrophy.zip`. The slug
has only lowercase letters, digits and `-`, so the filename is a token and is
sent unquoted; a client should accept a quoted one too.

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
neither the bundle nor the library is kept, naming an unavailable item until
that item is imported. Under `duplicate`, a bundle item whose `variantOf`
names another item duplicated in the same import points at the new copy.

The bundle's [links](#links) are added for every bundle item, whatever its
state and the strategy (a skipped item gets them on the local item, a
duplicated one on its copy); an import never removes a link. A link to an
item duplicated in the same import points at the copy; one to an item in
neither the bundle nor the library is kept as a link to an unavailable item.
Links are not content: they never make an item `changed`. A link that would
give an item more than `limits.maxLinksPerItem` links is left out with a
warning.
Collections are created if missing; bundle membership is merged into existing
collections (items not already members are appended in bundle order). The
whole import is one transaction.

```json
{ "created": 10, "updated": 2, "skipped": 0, "duplicated": 0, "unchanged": 5, "collectionsCreated": 1, "warnings": [] }
```
