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
- AI provider settings and credentials are not reachable through MCP.

## Tools

### Reading

| Tool | Purpose |
| --- | --- |
| `get_overview` | Library statistics, the collection tree, the tag list, and which languages the judge offers. A good first call |
| `search_items` | Filter and full-text search; same filters as `GET /items`. Returns summaries |
| `get_item` | One item in full. `include` selects optional parts: `testCases`, `solutions`, `submissions` (the 10 most recent) |
| `list_test_cases` | Test cases of a problem |
| `list_solutions` | Saved solutions of a problem, the reference solution first |
| `get_submission` | A submission with per-case results |
| `list_style_presets` | The user's style presets and which is the default |

### Writing items

| Tool | Purpose |
| --- | --- |
| `create_item` | Create a problem or reading; may include test cases, collections, tags and `variantOf` in the same call |
| `update_item` | Partial update of any item field (merge semantics) |
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
| `add_test_cases` | Append (or replace all) test cases; may set the reference solution in the same call |
| `update_test_case` | Change one test case |
| `delete_test_case` | Delete one test case |
| `verify_test_cases` | Run a solution on every case and report mismatches. With the reference solution (the default) each case's `verified` is set from the result, and with `updateExpected` the actual output becomes the expected output; `solutionId` of any other solution only checks it and changes nothing |
| `save_solution` | Create a saved solution (`itemId`) or change one (`id`; omitted fields are kept): `name`, `language`, `source`, `notes`, `isReference`, `expectedRevision` |
| `delete_solution` | Delete one saved solution; deleting the reference leaves the problem without one |
| `run_code` | Execute code for a problem — against sample cases, all cases, or custom stdin — and wait for the verdict (`timeoutSeconds`, default 120, at most 600; on timeout the submission is returned as it stands) |

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

## Prompts

| Prompt | Arguments | Purpose |
| --- | --- | --- |
| `draft_item` | `text`, `type?`, `style?` | Turn a rough or incomplete snippet into a complete item and save it |
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
the app's settings.
