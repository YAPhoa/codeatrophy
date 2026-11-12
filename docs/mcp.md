# MCP server

Codeathropy exposes a [Model Context Protocol](https://modelcontextprotocol.io)
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
claude mcp add --transport http codeathropy http://localhost:8080/mcp
```

Clients that only speak stdio can bridge with
`npx mcp-remote http://localhost:8080/mcp`.

| Variable | Default | Effect |
| --- | --- | --- |
| `CODEATHROPY_MCP_ENABLED` | `true` | Set `false` to remove the endpoint |
| `CODEATHROPY_MCP_TOKEN` | unset | When set, requests must send `Authorization: Bearer <token>` |
| `CODEATHROPY_MCP_ALLOWED_ORIGINS` | unset | Extra `Origin` values to accept, comma-separated |

Requests carrying an `Origin` header are accepted only if the origin is the
server's own, a loopback origin, or listed in
`CODEATHROPY_MCP_ALLOWED_ORIGINS` (or `CODEATHROPY_ALLOWED_ORIGINS`, or the
origin of `CODEATHROPY_PUBLIC_URL`). `GET /api/v1/meta` reports the full
endpoint URL as `mcp.url` when `CODEATHROPY_PUBLIC_URL` is set. Set a token
before making the endpoint reachable from anywhere but the local machine.

## Conventions

- Tools return JSON in the same shapes as the HTTP API (`docs/api.md`), as
  both structured content and text.
- Listing tools return summaries, not bodies; fetch one item to read it.
- Every tool that changes an item's own content accepts `expectedRevision`:
  `update_item`, `edit_item_text`, and `add_test_cases` when it sets the
  reference solution. Pass the `revision` you last read; if the item has
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
| `get_item` | One item in full. `include` selects optional parts: `testCases`, `submissions` (the 10 most recent) |
| `list_test_cases` | Test cases of a problem |
| `get_submission` | A submission with per-case results |
| `list_style_presets` | The user's style presets and which is the default |

### Writing items

| Tool | Purpose |
| --- | --- |
| `create_item` | Create a problem or reading; may include test cases, collections, tags and `variantOf` in the same call |
| `update_item` | Partial update of any item field (merge semantics) |
| `edit_item_text` | Exact-match text replacements inside `body` or `notes`, for small changes to long text |
| `delete_item` | Delete an item with its test cases and submissions |
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
| `verify_test_cases` | Run the reference solution on every case and report mismatches; with `updateExpected` the actual output becomes the expected output |
| `run_code` | Execute code for a problem — against sample cases, all cases, or custom stdin — and wait for the verdict (`timeoutSeconds`, default 120, at most 600; on timeout the submission is returned as it stands) |

The execution tools need a judge engine and return `judge_unavailable`
without one.

The intended way to write tests is: provide inputs and a reference solution
with `add_test_cases`, then call `verify_test_cases` with
`updateExpected: true` so that expected outputs come from actually running the
solution rather than from the model's own arithmetic.

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
`codeathropy://authoring-guide`.

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
