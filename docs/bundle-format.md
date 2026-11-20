# Bundle format

A bundle is a portable snapshot of part of a library: items, their test
cases, and the collections that organise them. It is the unit of import,
export and sharing.

Format name `codeatrophy.bundle`, **format versions 1 and 2**. Version 2
adds solution-only problems (see [Versions](#versions)); everything else is
the same in both.

## Goals

- **Shareable by default.** A bundle holds content only. Personal state
  (status, favorites, notes), submissions, raw AI input and instance settings
  are never written to it.
- **Readable and hand-editable.** Plain JSON, Markdown and source files. A
  bundle can be unzipped, edited, kept in a git repository and zipped again.
- **Idempotent.** Items and collections keep their ids, so importing the same
  bundle twice changes nothing, and importing a newer copy updates in place.
- **Stable.** The format is versioned independently of the app.

## Container

A zip archive, conventionally named `<name>.codeatrophy.zip`. Paths use `/`,
are relative, and must not contain `..` segments or be absolute. Text files
are UTF-8 without a byte-order mark. Readers must ignore files and JSON fields
they do not recognise.

A single top-level directory wrapping everything (as produced by zipping a
folder, or by a git host's "download zip") is tolerated: if `bundle.json` is
not at the archive root but exactly one top-level directory contains it, that
directory is treated as the root.

```
bundle.json
items/
  two-sum-0193b2f0/
    item.json
    body.md
    starter/
      python.py
      cpp.cpp
    harness/                  (version 2, solution-only problems)
      python-prefix.py
      python-suffix.py
    solutions/
      solutions.json
      01-hash-map-one-pass.py
      02-brute-force.cpp
    tests/
      tests.json
      01.in
      01.out
      02.in
      02.out
  cap-theorem-notes-0193b2f4/
    item.json
    body.md
```

Item directory names are for humans. Writers use
`<slug-of-title>-<first 8 hex of id>`; readers must not derive meaning from
them and locate items through `bundle.json`.

## `bundle.json`

```json
{
  "format": "codeatrophy.bundle",
  "formatVersion": 1,
  "name": "DP study plan",
  "description": "",
  "author": "",
  "createdAt": "2026-01-31T12:00:00Z",
  "generator": { "name": "codeatrophy", "version": "0.1.0" },
  "includes": { "solutions": true, "hiddenTests": true },
  "items": [
    { "id": "0193b2f0-...", "path": "items/two-sum-0193b2f0", "type": "problem", "title": "Two Sum", "contentHash": "sha256:9f2c..." }
  ],
  "collections": [
    {
      "id": "0193b2f1-...",
      "name": "Dynamic Programming",
      "description": "",
      "parentId": null,
      "position": 0,
      "itemIds": ["0193b2f0-..."]
    }
  ]
}
```

- `format` and `formatVersion` are required. A reader rejects a bundle whose
  `formatVersion` is greater than it supports. Writers use the lowest
  version that can carry the bundle's content: 2 when it holds a
  solution-only problem, otherwise 1.
- `items[].path` is the item's directory. `type` and `title` duplicate
  `item.json` so a bundle can be listed without opening every item.
- `collections[].itemIds` is ordered and refers only to items in this bundle.
  `parentId` refers to another collection in this bundle or is `null`; a
  collection whose parent was not exported is written with `parentId: null`.
- `collections` is `[]` for an item-selection export.
- `includes` records what the export carried for every problem in it:
  `solutions` is `false` when solutions were left out, `hiddenTests` is
  `false` when only sample test cases were exported. Readers use it to tell
  "left out" from "absent": with `solutions: true`, a problem without
  `solutions/solutions.json` has no solutions; with `solutions: false`, its
  local solutions are kept on import. Solutions or non-sample cases found in
  a bundle whose `includes` says they were left out are ignored with a
  warning. When `includes` is absent (a hand-made bundle), readers infer it
  per problem: solutions are included if `solutions/solutions.json` exists,
  hidden tests if any case has `sample: false`.

## `item.json`

```json
{
  "id": "0193b2f0-...",
  "type": "problem",
  "title": "Two Sum",
  "summary": "Find two indices whose values add up to a target.",
  "difficulty": "easy",
  "tags": ["array", "hash-map"],
  "source": { "url": null, "note": null },
  "variantOf": null,
  "createdAt": "2026-01-31T12:00:00Z",
  "updatedAt": "2026-01-31T12:00:00Z",
  "problem": {
    "timeLimitMs": 2000,
    "memoryLimitKb": 262144,
    "compare": "tokens",
    "starter": { "python": "starter/python.py", "cpp": "starter/cpp.cpp" }
  }
}
```

- The Markdown body is always in `body.md` next to `item.json`.
- `problem` is present only when `type` is `problem`. Paths inside it are
  relative to the item directory.
- Version 2 only: `problem.interface` and `problem.harness` describe a
  solution-only problem (see the HTTP API's "Problem interface"):

  ```json
  "problem": {
    "timeLimitMs": 2000, "memoryLimitKb": 262144, "compare": "tokens",
    "starter": { "python": "starter/python.py" },
    "interface": "function",
    "harness": { "python": { "prefix": "harness/python-prefix.py", "suffix": "harness/python-suffix.py" } }
  }
  ```

  `interface` is `program` (the default when absent) or `function`. For a
  `function` problem `starter` holds the stubs the solver starts from, and
  `harness` names, per language, the files holding the runner code that
  goes before and after the solver's code (an empty or absent path is an
  empty part). Writers include both fields only for `function` problems.
  In a version 1 bundle neither field has a meaning: a reader ignores them
  (with a warning when `interface` is not `program`), and the problem is a
  full program.
- `variantOf` may name an item that is not in the bundle. On import the link
  is kept if that item exists in the target library and dropped otherwise;
  a dropped link is set to `null` before the content hash is compared, so
  importing the same bundle again finds the item `unchanged`.
- Field values follow the same rules as the HTTP API (`docs/api.md`).

## `solutions/solutions.json`

Written for every problem when solutions are included — with an empty
`solutions` list for a problem that has none — and absent when the bundle
was exported without solutions (`includes.solutions: false`), in which case
the whole `solutions/` directory is absent.

```json
{
  "solutions": [
    { "name": "Hash map, one pass", "language": "python", "file": "01-hash-map-one-pass.py", "notes": "O(n) time, O(n) space.", "reference": true },
    { "name": "Brute force", "language": "cpp", "file": "02-brute-force.cpp", "notes": "", "reference": false }
  ]
}
```

Order in `solutions` is the order they are listed in. `file` is a file name
inside `solutions/` holding the source; writers name it
`<two-digit index>-<slug-of-name>.<extension for the language>`, and readers
take the language from `language`, never from the extension. At most one
entry has `reference: true`; if several do, a reader keeps the first and
reports a warning.

A solution's `lastRun` (see the HTTP API) is a measurement local to the
instance, like submissions, and is not part of the format: writers leave it
out, readers ignore it, and an imported solution starts without one.

## `tests/tests.json`

Present for problems that have test cases.

```json
{
  "cases": [
    { "name": "Example 1", "input": "01.in", "output": "01.out", "sample": true, "origin": "manual", "verified": true }
  ]
}
```

Order in `cases` is the test order. `input` and `output` are file names inside
`tests/`; their bytes are the stdin and expected stdout exactly, with no
newline normalisation. (All other text — `body.md`, source files, JSON string
values — has `\r\n` and lone `\r` normalised to `\n` on import, as the HTTP
API does for every text field; the content hash is computed after that
normalisation.) `origin` records how the case came to exist in the
exporting library; an importer stores it as-is.

When a bundle is exported without hidden tests, only cases with
`sample: true` are written.

`.in` and `.out` files must be valid UTF-8 (test data is text). A case whose
file is missing, larger than `limits.maxTestDataBytes`, or not valid UTF-8 is
skipped with a warning naming the file and the reason; the rest of the item
is imported.

## Content hash

`contentHash` identifies an item's shareable content. It lets an importer
tell "unchanged" from "changed" without comparing field by field, and is what
makes re-import cheap.

It is `sha256:` followed by the lower-case hex SHA-256 of the item's
*canonical content document*: a JSON object serialised with keys sorted,
no insignificant whitespace, and UTF-8 output, with strings escaped as in
RFC 8785 (only `"`, `\` and control characters are escaped), containing

```
type, title, summary, difficulty, tags (sorted), source, variantOf, body,
problem: { timeLimitMs, memoryLimitKb, compare,
           starterCode: { <language>: <source> } },
solutions: [ { name, language, source, notes, isReference } ]   (in order)
testCases: [ { name, stdin, expectedStdout, isSample } ]       (in order)
```

For a solution-only problem (version 2), `problem` also contains
`interface: "function"` and `harness: { <language>: { prefix, suffix } }`
with the runner code itself. A full-program problem has neither, so its
hash is the same in both versions and the hashes of version 1 bundles stay
valid.

Ids, timestamps, `origin`, `verified`, a solution's `lastRun` and everything
personal are excluded.
`problem`, `solutions` and `testCases` are omitted for readings. The hash
always describes what is *in the bundle*: if solutions or hidden tests were
left out of the export, they are left out of the hash too (`solutions` is
then omitted entirely, as opposed to `[]` for a problem that has none).

A reader must not trust the stored `contentHash`; it recomputes the hash from
the files and uses the stored value only as an integrity check, reporting a
warning on mismatch.

## Import semantics

For each item in the bundle, compared with the target library by `id`:

| State | Condition | Result |
| --- | --- | --- |
| `new` | id not present | Created with the bundle's id |
| `unchanged` | id present, hash equal | Nothing happens |
| `changed` | id present, hash differs | Decided by the chosen strategy |

To decide `unchanged` vs `changed`, the importer computes the local item's
hash over the same fields the bundle contains. A local solution-only problem
therefore differs from a version 1 bundle's copy of it, which is a full
program. If the bundle carries no
solutions or only sample tests, the local solutions and hidden tests are
ignored for the comparison — and preserved by an overwrite.

Strategies for `changed` items:

- `skip` — keep the local item.
- `overwrite` — replace content with the bundle's. Personal state and
  submissions are kept. Test cases are replaced, except that local hidden
  cases survive when the bundle has samples only. Solutions are replaced by
  the bundle's, except that local solutions survive when the bundle was
  exported without solutions.
- `duplicate` — create a separate item with a new id, leaving the local one
  alone.

Collections are matched by id and created when missing, preserving the
bundle's nesting. For a collection that already exists, its name, description
and place in the tree are left as they are locally, and bundle members that
are not yet members are appended in bundle order. Items imported under the
`duplicate` strategy take the place of their originals in bundle collections,
and a bundle item whose `variantOf` names an item duplicated in the same
import points at the new copy.

An `overwrite` increases the local item's revision only when its content
other than test cases changes; replacing only test cases moves its
`updatedAt` and leaves the revision alone. For a `changed` item, an importer
reports which content fields differ, `type` first when the type differs;
`interface` and `harness` follow `starterCode`.

Collection parents that form a cycle are reported and broken by cutting the
edge that closes the cycle (the collection reached last on the walk keeps
its place; the one whose parent link closes the loop becomes a root).
Collections that merely descend from a cycle keep their parents.

New items start with default personal state (`todo`, not favorite, no notes).

An import is atomic: it is applied completely or not at all.

## Validation and limits

A reader rejects the whole bundle if `bundle.json` is missing or malformed,
the format name or version is unsupported, any path escapes the archive root,
or the archive exceeds the size limits (compressed size, total uncompressed
size, entry count, number of collections). The error says which: for a
malformed `bundle.json`, the field and the expected type, or the position of
the syntax error. This server publishes its limits in `GET /api/v1/meta`
(`maxImportBytes`, `maxImportUncompressedBytes`, `maxImportEntries`,
`maxImportCollections`). The entry and collection limits are high enough for
an export of any library the instance can hold, but the byte limits follow
the operator's `CODEATROPHY_MAX_IMPORT_BYTES`: restoring a large export into
another instance may need that raised.

Problems confined to one item are reported as warnings that name the file
and say what is wrong, and skip as little as possible:

| Problem | Effect |
| --- | --- |
| `item.json` missing, not JSON, or with a wrongly typed field | The item is skipped (and dropped from collections) |
| `id` in `item.json` differs from `bundle.json`, or `type` is not `problem`/`reading` | The item is skipped |
| `title` missing, too long or not a single line | The item is skipped |
| `body.md` missing, not valid UTF-8 or larger than `maxTextBytes` | The body is empty |
| Invalid optional field (`summary`, `difficulty`, a limit, `compare`, a tag, `source`, `variantOf`) | That field takes its default; extra tags beyond the limit are dropped |
| Unknown language, or missing/too large/non-UTF-8 source file, in `starter` | That language's starter code is skipped |
| Version 2: unknown `interface`, or `harness` that is not an object of `{prefix, suffix}` paths | The item is skipped (imported without its runner, it could not be solved) |
| Version 2: unknown language, or a missing/too large/non-UTF-8 file, in `harness` | That language's harness is skipped, so the problem cannot be run in it |
| Version 2: `harness` on a `program` problem | Ignored |
| A solution with an unknown language, invalid name, or missing/too large/non-UTF-8 file | That solution is skipped |
| `solutions.json` or `tests.json` not JSON or with a wrongly typed field | The item is skipped (importing it without them could replace the local ones with none) |
| A test case file missing, too large or non-UTF-8 | That case is skipped |
| Stored `contentHash` differs from the recomputed one | Warning only |

## Versioning

`formatVersion` increases only for changes an existing reader could
misinterpret. Adding optional fields or files does not change the version;
readers ignore what they do not understand. The meaning of an existing field
never changes within a version.

### Versions

| Version | Adds |
| --- | --- |
| 1 | Items, test cases, solutions, collections |
| 2 | Solution-only problems: `problem.interface`, `problem.harness` and the `harness/` directory, and the interface and harness in the content hash |

Version 2 is a version of its own rather than optional fields because a
version 1 reader, which ignores unknown fields, would import a
solution-only problem as a full program whose starter code is a stub that
cannot run on its own. Such a reader refuses a version 2 bundle instead
("bundle format version 2 is newer than this server supports (1)").

Reserved for future versions: an `assets/` directory inside an item directory
for attachments referenced from `body.md`.
