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
| `CODEATROPHY_MCP_TOKEN` | unset | When set, requests must send `Authorization: Bearer <token>` |
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
- Listing tools return summaries, not bodies; fetch one item to read it.
- Every tool that changes an item's own content accepts `expectedRevision`:
  `update_item`, `edit_item_text`, `add_test_cases` when it sets the
  reference solution, and `save_solution` when it changes which solution is
  the reference or the reference's language or source. Pass the `revision` you last read; if the item has
  changed since, the call fails with a conflict and the current revision, and
  nothing is written. Re-read and retry. Test-case changes do not change the
  item's revision (see `revision` in `docs/api.md`).
- Failures are reported as tool errors (`isError: true`) with the same `code`
  and `message` the HTTP API would return.
- Tools are annotated (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so
  clients can apply their own confirmation policy.
- AI provider settings and credentials, their usage counts, the AI
  activity log, the custom system prompt and the custom test case prompt
  are not reachable through MCP tools. MCP has no AI generation of its
  own: the connected assistant is the model.

## Tools

### Reading

| Tool | Purpose |
| --- | --- |
| `get_overview` | Library statistics, the collection tree, the tag list, and which languages the judge offers. A good first call |
| `search_items` | Filter and full-text search; same filters as `GET /items`. Returns summaries |
| `get_item` | One item in full, including a problem's `interface` and `harness`. `include` selects optional parts: `testCases`, `solutions`, `submissions` (the 10 most recent submits; runs are not kept as history) |
| `list_test_cases` | Test cases of a problem |
| `list_solutions` | Saved solutions of a problem, the reference solution first |
| `get_submission` | A submission with per-case results |
| `list_style_presets` | The user's style presets and which is the default |

### Writing items

| Tool | Purpose |
| --- | --- |
| `create_item` | Create a problem or reading; may include test cases, collections, tags and `variantOf` in the same call. A solution-only problem sets `problem.interface: "function"`, with `starterCode` (the stubs) and `harness` (`{ <language>: { prefix, suffix } }`) |
| `update_item` | Partial update of any item field (merge semantics; `problem.starterCode` and `problem.harness` replace all entries). Setting `problem.interface` to `program` on a problem with a harness requires `harness: {}` in the same call |
| `edit_item_text` | Exact-match text replacements inside `body` or `notes`, for small changes to long text |
| `delete_item` | Delete an item with its test cases, solutions and submissions |
| `bulk_update_items` | One action on many items: tag, untag, set status, favorite, add to or remove from a collection, delete |

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
| `delete_tag` | Remove a tag everywhere |

### Test cases and execution

| Tool | Purpose |
| --- | --- |
| `add_test_cases` | Append test cases, or replace all but the samples; may set the reference solution in the same call (for a function problem, the solution part only) |
| `update_test_case` | Change one test case |
| `delete_test_case` | Delete one test case |
| `verify_test_cases` | Run a solution on every case and report mismatches. With the reference solution (the default) each case's `verified` is set from the result, and with `updateExpected` the actual output becomes the expected output; `solutionId` of any other solution only checks it and changes nothing. For a function problem the solution runs inside its language's harness; a solution in a language without one is rejected |
| `save_solution` | Create a saved solution (`itemId`) or change one (`id`; omitted fields are kept): `name`, `language`, `source`, `notes`, `isReference`, `expectedRevision`. For a function problem, `source` is the solution part only |
| `delete_solution` | Delete one saved solution; deleting the reference leaves the problem without one |
| `run_code` | Execute code for a problem — against sample cases, all cases, or custom stdin — and wait for the verdict (`timeoutSeconds`, default 120, at most 600; on timeout the submission is returned as it stands). A run replaces the problem's earlier completed runs; only submits are kept. For a function problem `source` is the solution part, run inside the language's harness; a language without one is rejected |

The execution tools need a judge engine and return `judge_unavailable`
without one.

The intended way to write tests is: provide inputs and a reference solution
with `add_test_cases`, then call `verify_test_cases` with
`updateExpected: true` so that expected outputs come from actually running the
solution rather than from the model's own arithmetic.

A problem can keep several saved solutions — other approaches, other
languages, a brute force — of which at most one is the reference solution
(see "Solutions" in `docs/api.md`). To check another one against the tests,
pass its id as `solutionId` to `verify_test_cases`.

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
| `write_test_cases` | `itemId`, `count?` | Write a reference solution and a verified test set for a problem |
| `create_variant` | `itemId`, `mode?`, `instruction?`, `style?` | Derive a related new item and save it linked to the original |

The prompts carry the same authoring conventions the app's built-in AI
features use, so items come out consistent whichever route created them. The
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
of the editable conventions, followed by the fixed rules the app depends on,
in `instructions`, the resource and every prompt, `write_test_cases`
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
