# MCP server

Codeatrophy exposes a [Model Context Protocol](https://modelcontextprotocol.io)
server so that an AI assistant can browse, write and edit the library on your
behalf — for example "add this problem I half remember to my DP collection and
write test cases for it".

Over MCP the assistant you connect *is* the model: these tools do not use the
AI provider configured in the app, and work without one.

## Connecting

The endpoint is `http://<host>:<port>/mcp`, using the Streamable HTTP
transport.

```sh
# Claude Code
claude mcp add --transport http codeatrophy http://localhost:8080/mcp
```

Clients that only speak stdio can bridge with
`npx mcp-remote http://localhost:8080/mcp`.

| Variable | Default | Effect |
| --- | --- | --- |
| `CODEATROPHY_MCP_ENABLED` | `true` | Set `false` to remove the endpoint |
| `CODEATROPHY_MCP_TOKEN` | unset | When set, requests must send `Authorization: Bearer <token>` (the scheme name in any case) |
| `CODEATROPHY_MCP_ALLOWED_ORIGINS` | unset | Extra `Origin` values to accept, comma-separated |
| `CODEATROPHY_MCP_MAX_SESSIONS` | `100` | Most sessions open at once |

The endpoint applies the same two checks as the HTTP API (see "Host and
origin checks" in `docs/api.md`), the Host check first:

- The `Host` header must be a loopback name or address, the host of
  `CODEATROPHY_PUBLIC_URL`, the host of an allowed origin, or listed in
  `CODEATROPHY_ALLOWED_HOSTS`; anything else is `403`. This stops a web page
  from reaching the endpoint through a DNS name rebound to your machine. To
  connect a client over the LAN, set `CODEATROPHY_PUBLIC_URL` or add the name
  or address it uses to `CODEATROPHY_ALLOWED_HOSTS`.
- Requests carrying an `Origin` header are accepted only from a loopback
  origin, an origin listed in `CODEATROPHY_MCP_ALLOWED_ORIGINS` (or
  `CODEATROPHY_ALLOWED_ORIGINS`, or the origin of `CODEATROPHY_PUBLIC_URL`),
  or an origin whose host is in `CODEATROPHY_ALLOWED_HOSTS`. The origin is
  compared with that configured set, never with the request's own `Host`.

`GET /api/v1/meta` reports the full endpoint URL as `mcp.url` when
`CODEATROPHY_PUBLIC_URL` is set. Set a token before making the endpoint
reachable from anywhere but the local machine.

Sessions that have been idle for 30 minutes are closed; a client then starts
a new one. When `CODEATROPHY_MCP_MAX_SESSIONS` sessions are open, a request
to start another is refused with `503` and `Retry-After` until one closes or
expires; open sessions are unaffected. A request body may be at most
`limits.maxRequestBytes` (32 MiB, see `GET /api/v1/meta`).

## Conventions

- Tools return JSON in the same shapes as the HTTP API (`docs/api.md`), as
  both structured content and text.
- **Large test data is elided** in every tool result: a `stdin`,
  `expectedStdout`, `actualStdout` (verify_test_cases) or `stdout` (the
  results of `run_code` and `get_submission`) string larger than 16 KiB is
  returned as `null`, followed by `<field>Bytes` (its size in bytes) and
  `<field>Head` (its first 200 bytes, cut back so as not to split a UTF-8
  character). Smaller values are returned as they are. This is
  presentation over MCP only: the data is stored, run and returned by the
  HTTP API in full. To see a large case's input, read its `generator`.
- Listing tools return summaries, not bodies; fetch one item to read it.
- Every tool that changes an item's own content accepts `expectedRevision`:
  `update_item`, `edit_item_text`, `add_test_cases` when it sets the
  reference solution, and `save_solution` when it changes which solution is
  the reference or the reference's language or source. Pass the `revision` you last read; if the item has
  changed since, the call fails with a conflict and the current revision, and
  nothing is written. Re-read and retry. Test-case changes do not change the
  item's revision (see `revision` in `docs/api.md`).
- Items record who created them and who made their last content change
  (`createdBy` and `lastUpdatedBy`; see `Item` in `docs/api.md`). A change
  made over MCP is recorded with `via: "mcp"`, the client's name from the
  initialize handshake, and the model the call reports. Every tool that can
  change an item's content takes an optional `model` string for this:
  `create_item`, `update_item`, `edit_item_text`, `bulk_update_items`,
  `rename_tag`, `delete_tag`, `add_test_cases`, `update_test_case`,
  `delete_test_case`, `verify_test_cases`, `save_solution` and
  `delete_solution`. Pass your model id (e.g. `claude-opus-5-5`). It is for
  tracking only, not verified, and never makes a call fail: a missing,
  empty or non-string value is recorded as unknown.
- Failures are reported as tool errors (`isError: true`) with the same `code`
  and `message` the HTTP API would return.
- Input schemas carry the bounds the server checks as `maxLength` (in
  characters) and `maxItems`: an item's `title`, `summary`, `tags` (and each
  tag), `source.url` and `source.note`; the names of test cases, solutions,
  collections and tags; a collection's description and a solution's notes. The configurable
  bounds, `notes` (`limits.maxNotesChars`) and `link_items`'s `otherIds`
  (`limits.maxLinksPerItem`), are those of the instance when the session
  starts. The server checks every argument itself whether or not a client
  honours the schema.
- Tools are annotated (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so
  clients can apply their own confirmation policy.
- AI provider settings and credentials, their usage counts, the AI
  activity log, AI jobs, drafts, the custom system prompt and the custom
  test case prompt are not reachable through MCP tools. MCP has no AI
  generation of its own: the connected assistant is the model.

## Tools

### Reading

| Tool | Purpose |
| --- | --- |
| `get_overview` | Library statistics, the collection tree, the tag list (with item counts; a tag no item carries any more has 0), which languages the judge offers, the user's test case preferences and the limits of items and test cases (below). A good first call |
| `search_items` | Filter and full-text search; same filters as `GET /items`. Returns summaries |
| `get_item` | One item in full, including a problem's `interface` and `harness`, its `createdBy` and `lastUpdatedBy` (see [Conventions](#conventions)), with its `links` and, for a variant, `item.variantOrigin` (see [Links](#links)). `include` selects optional parts: `testCases`, `solutions`, `submissions` (the 10 most recent submits; runs are not kept as history) |
| `list_test_cases` | Test cases of a problem |
| `list_solutions` | Saved solutions of a problem, the reference solution first |
| `get_submission` | A submission with per-case results |
| `list_style_presets` | The user's style presets and which is the default |

`get_overview` also returns:

```json
{
  "preferences": { "generatedTestCases": 8, "largeTestCase": false, "largeTestCaseCount": 3, "hideTestCases": true },
  "limits": {
    "maxTestDataBytes": 8388608, "maxLargeInputBytes": 1048576, "maxTestCasesPerItem": 1000, "maxSourceBytes": 65536,
    "timeLimitMs": { "min": 100, "max": 30000 }, "memoryLimitKb": { "min": 16384, "max": 2097152 },
    "maxTitleChars": 200, "maxSummaryChars": 5000, "maxTags": 30, "maxTagChars": 40,
    "maxNotesChars": 4000, "maxLinksPerItem": 30, "maxGeneratedTestCases": 30, "maxLargeTestCases": 5,
    "maxSolutionNameChars": 100, "maxSolutionNotesChars": 5000, "maxCollectionNameChars": 200
  }
}
```

`preferences` are the user's current values (see "Preferences" in
`docs/api.md`): how many test cases to write, whether to add large ones and
how many, and whether hidden test cases are kept out of sight. They are
read-only over MCP. `limits` are the bounds of test cases and of the item
fields an assistant writes, with the same names and values as in
`GET /api/v1/meta` (`maxSourceBytes` also bounds a generator).
`maxNotesChars` and `maxLinksPerItem` are set by the operator
(`CODEATROPHY_MAX_NOTES_CHARS`, `CODEATROPHY_MAX_LINKS_PER_ITEM`); notes or
links an item already has over them are kept. So are
`maxGeneratedTestCases` and `maxLargeTestCases`
(`CODEATROPHY_MAX_GENERATED_TEST_CASES`, `CODEATROPHY_MAX_LARGE_TEST_CASES`),
the most test cases and large test cases one generation asks for: the
preferences never exceed them, and `write_test_cases` ignores a `count`
above `maxGeneratedTestCases`.

### Writing items

| Tool | Purpose |
| --- | --- |
| `create_item` | Create a problem or reading; may include test cases, collections, tags and `variantOf` in the same call. A solution-only problem sets `problem.interface: "function"`, with `starterCode` (the stubs) and `harness` (`{ <language>: { prefix, suffix } }`) |
| `update_item` | Partial update of any item field (merge semantics; `problem.starterCode` and `problem.harness` replace all entries). Setting `problem.interface` to `program` on a problem with a harness requires `harness: {}` in the same call |
| `edit_item_text` | Exact-match text replacements inside `body` or `notes`, for small changes to long text |
| `delete_item` | Delete an item with its test cases, solutions and submissions. Links to it and its variants' `variantOf` are kept, naming an unavailable item |
| `bulk_update_items` | One action on many items: tag, untag, set status, favorite, add to or remove from a collection, delete |

### Links

| Tool | Purpose |
| --- | --- |
| `link_items` | Link an item (`itemId`) to closely related items (`otherIds`). Links go both ways, have no label and are not content (the revision stays); a pair already linked is left as it is. Every other id must name an existing item other than this one, or nothing is linked and the error names each bad one as `otherIds.<index>` (an id longer than 60 characters is repeated cut short, ending in `…`). An item has at most `limits.maxLinksPerItem` links (30 by default; the description gives the instance's value), and `otherIds` may list at most that many ids: a longer list is refused with one error on `otherIds`. Returns `{ "links": [LinkedItem] }` |
| `unlink_items` | Remove the links between an item and `otherIds`, also to items that have been deleted; an id that is not linked is ignored. `otherIds` may list at most 50 ids, the most links any item can have, so one call can clear an item linked under a higher limit. Returns the links that remain |

A link stays when either item is deleted. `get_item` returns the item's
links as `links`, each a `LinkedItem` as in `GET /items/{id}/links`
(`docs/api.md`): available items first, each group oldest link first. One
whose item no longer exists has `available: false`, with the title and type
it had when it was deleted (`null` when this library never had it, as after
an import), and comes alive again if an item with its id is created (by an
import, say). A variant's `item.variantOrigin` describes its origin the same
way.

### Organising

| Tool | Purpose |
| --- | --- |
| `create_collection` | Create a collection, optionally nested under a parent |
| `update_collection` | Rename, describe, move or reorder a collection |
| `delete_collection` | Delete a collection; its items are kept |
| `set_collection_items` | Set a collection's exact ordered membership |
| `add_items_to_collection` | Append items to a collection |
| `remove_item_from_collection` | Remove one item from a collection |
| `rename_tag` | Rename a tag everywhere (merging if the new name exists) |
| `delete_tag` | Remove a tag everywhere and delete it, so that it is no longer listed |

### Test cases and execution

| Tool | Purpose |
| --- | --- |
| `add_test_cases` | Append test cases, or replace all but the samples; may set the reference solution in the same call (for a function problem, the solution part only). A large case is given a `generator` instead of `stdin` (below); a case given both is stored as given |
| `update_test_case` | Change one test case. A `generator` runs and replaces `stdin`; `generator: null` drops it and keeps `stdin`; a new `stdin` alone drops it too; `stdin` and a non-null `generator` together are refused |
| `delete_test_case` | Delete one test case |
| `verify_test_cases` | Run a solution on every case and report mismatches. With the reference solution (the default) each case's `verified` is set from the result, and with `updateExpected` the actual output becomes the expected output; `solutionId` of any other solution only checks it and leaves the cases alone. Either way the run becomes the solution's `lastRun`, unless the engine failed on a case. For a function problem the solution runs inside its language's harness; a solution in a language without one is rejected |
| `save_solution` | Create a saved solution (`itemId`) or change one (`id`; omitted fields are kept): `name`, `language`, `source`, `notes`, `isReference`, `expectedRevision`. For a function problem, `source` is the solution part only. When creating, `submissionId` of a completed `run_code` submission of the same language and source makes its figures the solution's `lastRun`; a new language or source clears `lastRun` |
| `delete_solution` | Delete one saved solution; deleting the reference leaves the problem without one |
| `run_code` | Execute code for a problem — against sample cases, all cases, or custom stdin — and wait for the verdict (`timeoutSeconds`, default 120, at most 600; on timeout the submission is returned as it stands). A run replaces the problem's earlier completed runs; only submits are kept. For a function problem `source` is the solution part, run inside the language's harness; a language without one is rejected |

The execution tools need a judge engine and return `judge_unavailable`
without one.

The intended way to write tests is: provide inputs and a reference solution
with `add_test_cases`, then call `verify_test_cases` with
`updateExpected: true` so that expected outputs come from actually running the
solution rather than from the model's own arithmetic.

A large test case — an input near the statement's bounds, up to
`limits.maxLargeInputBytes` — is too big to pass as a tool argument. Give it
as a **generator** instead of `stdin`: `{ "language": ..., "source": ... }`,
a complete, deterministic program (a fixed seed, no clock) in one of the
judge's languages that reads nothing and prints the case's stdin. The
server runs it (10 seconds, 512 MiB), checks that it printed something, at
most `limits.maxLargeInputBytes`, valid UTF-8 and not the input of another
case, and stores the output as `stdin` with the generator; `expectedStdout`
may be omitted. When a case is created with both `stdin` and a `generator`,
both are stored as given and nothing runs: the server does not check that
the input came from the generator. `update_test_case` refuses `stdin`
together with a non-null `generator`. A generator that fails is an error on `generator`
(`cases.<i>.generator` in `add_test_cases`) in plain words, and nothing in
that call is stored: fix it and send the call again. Then verify as above.
See "Generators" in `docs/api.md`.

A problem can keep several saved solutions — other approaches, other
languages, a brute force — of which at most one is the reference solution
(see "Solutions" in `docs/api.md`). To check another one against the tests,
pass its id as `solutionId` to `verify_test_cases`. Each solution reports
its latest run on the test cases as `lastRun` (see "Solutions" in
`docs/api.md`).

### Solution-only problems

A problem whose `interface` is `function` asks only for a function or class
(see "Problem interface" in `docs/api.md`). The program that runs is the
language's harness prefix, the solution and the harness suffix; every tool
that runs code assembles it the same way, and saved solutions hold only the
solution part. In the results of `run_code` and `verify_test_cases`, line
numbers in compiler output and stderr refer to the solution's own lines; a
location inside the runner names `<runner prefix>` or `<runner suffix>` with
a line within that part, and a submission's `lineOffset` is how many lines
the prefix adds. To prove a runner, verify the sample cases with the
reference solution and run the unchanged stub with `run_code` in each
language: it should run and end in a wrong answer. The authoring guide describes how stubs
and runners are written.

## Prompts

| Prompt | Arguments | Purpose |
| --- | --- | --- |
| `draft_item` | `text`, `type?`, `style?` | Turn a rough or incomplete snippet into a complete item and save it, choosing a problem's interface |
| `write_test_cases` | `itemId`, `count?` | Write a reference solution and a verified test set for a problem. `count` defaults to the user's `generatedTestCases` preference |
| `create_variant` | `itemId`, `mode?`, `instruction?`, `style?` | Derive a related new item and save it linked to the original. `instruction` is at most 2000 characters |
| `link_related` | `itemId` | Search the library for the few problems and readings closely related to the item, suggest them, and link the ones the user agrees to with `link_items` |

The prompts that ask for test cases (the first three, for a problem) follow the
user's test case preferences: they ask for `generatedTestCases` cases
(`write_test_cases` takes `count` instead when given) and, when
`largeTestCase` is on, for `largeTestCaseCount` more as generators, each
aimed at a different way a solution of the wrong complexity fails at scale.
Each ends by fetching the item again with `get_item` and re-reading it end
to end before reporting.

The prompts that write items (the first three) carry the same authoring
conventions the app's built-in AI features use, so items come out
consistent whichever route created them; `link_related` writes no content
and carries only the item, with its current links. The
conventions are also sent as the server's `instructions` during
initialisation and are readable as the resource
`codeatrophy://authoring-guide`.

### Style presets

The user's style presets (see `docs/api.md`) are available read-only:

- `list_style_presets` (tool) returns every preset with its instructions and
  which one is the default.
- The default preset, if any, is included in the authoring guide — in the
  resource and prompts on each request, and in `instructions` on each new
  session — so it always reflects the current setting.
- The `draft_item` and `create_variant` prompts take an optional `style`
  argument, a preset name or id, to write in that preset instead of the
  default.

There is deliberately no tool that creates or edits presets: they are standing
instructions for a model, and may only be written by the instance's user in
the app's settings. The only exception is the built-in presets a new
instance starts with, which ship with the app and are then edited like any
other.

### System prompt

When the user has written a custom system prompt in the app's settings (see
"System prompt" in `docs/api.md`), the authoring guide carries it in place
of the editable conventions, followed by the fixed rules the app depends on
(among them that a `<details>` block, for answers and hints, is the only
HTML that renders), in `instructions`, the resource and every prompt, `write_test_cases`
included. No tool reads, creates or changes it. The custom test case
prompt, which only the app's own test generation uses, appears in none of
them.

## Companion skill

The tools say what an assistant *can* do; the companion skill in
`skills/codeatrophy/` tells it how to go about it: what to do with a rough
problem you paste, when to make a problem solution-only, how to write test
cases whose expected outputs come from running a reference solution, and to
keep solutions out of the conversation unless you ask to see them.

It is optional — everything works over MCP without it — and it is an ordinary
Agent Skill: a folder with a `SKILL.md`.

```sh
# Claude Code, for your user account
mkdir -p ~/.claude/skills && cp -r skills/codeatrophy ~/.claude/skills/
```

Other clients that support skills take the same folder, usually as a zip
uploaded in their skills settings. The skill describes workflow only; the
format rules still come from the server's authoring guide, so it does not go
stale when those change.
