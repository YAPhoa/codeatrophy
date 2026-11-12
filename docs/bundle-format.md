# Bundle format

A bundle is a portable snapshot of part of a library: items, their test
cases, and the collections that organise them. It is the unit of import,
export and sharing.

Format name `codeathropy.bundle`, **format version 1**.

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

A zip archive, conventionally named `<name>.codeathropy.zip`. Paths use `/`,
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
    solution/
      reference.py
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
  "format": "codeathropy.bundle",
  "formatVersion": 1,
  "name": "DP study plan",
  "description": "",
  "author": "",
  "createdAt": "2026-01-31T12:00:00Z",
  "generator": { "name": "codeathropy", "version": "0.1.0" },
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
  `formatVersion` is greater than it supports.
- `items[].path` is the item's directory. `type` and `title` duplicate
  `item.json` so a bundle can be listed without opening every item.
- `collections[].itemIds` is ordered and refers only to items in this bundle.
  `parentId` refers to another collection in this bundle or is `null`; a
  collection whose parent was not exported is written with `parentId: null`.
- `collections` is `[]` for an item-selection export.

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
    "starter": { "python": "starter/python.py", "cpp": "starter/cpp.cpp" },
    "referenceSolution": { "language": "python", "path": "solution/reference.py" }
  }
}
```

- The Markdown body is always in `body.md` next to `item.json`.
- `problem` is present only when `type` is `problem`. Paths inside it are
  relative to the item directory.
- `referenceSolution` is `null` or absent when the bundle was exported without
  solutions.
- `variantOf` may name an item that is not in the bundle. On import the link
  is kept if that item exists in the target library and dropped otherwise.
- Field values follow the same rules as the HTTP API (`docs/api.md`).

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
           starterCode: { <language>: <source> },
           referenceSolution: { language, source } | null },
testCases: [ { name, stdin, expectedStdout, isSample } ]   (in order)
```

Ids, timestamps, `origin`, `verified` and everything personal are excluded.
`problem` and `testCases` are omitted for readings. The hash always describes
what is *in the bundle*: if solutions or hidden tests were left out of the
export, they are left out of the hash too.

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
hash over the same fields the bundle contains. If the bundle carries no
reference solution or only sample tests, the local solution and hidden tests
are ignored for the comparison — and preserved by an overwrite.

Strategies for `changed` items:

- `skip` — keep the local item.
- `overwrite` — replace content with the bundle's. Personal state and
  submissions are kept. Test cases are replaced, except that local hidden
  cases survive when the bundle has samples only.
- `duplicate` — create a separate item with a new id, leaving the local one
  alone.

Collections are matched by id and created when missing, preserving the
bundle's nesting. For a collection that already exists, its name, description
and place in the tree are left as they are locally, and bundle members that
are not yet members are appended in bundle order. Items imported under the
`duplicate` strategy take the place of their originals in bundle collections.

New items start with default personal state (`todo`, not favorite, no notes).

An import is atomic: it is applied completely or not at all.

## Validation and limits

A reader rejects the whole bundle if `bundle.json` is missing or malformed,
the format name or version is unsupported, any path escapes the archive root,
or the archive exceeds the size limits (compressed size, total uncompressed
size, entry count). Problems confined to one item — a missing file, an
unknown language id in starter code, an invalid field value — skip that item
or field and are reported as warnings.

## Versioning

`formatVersion` increases only for changes an existing reader could
misinterpret. Adding optional fields or files does not change the version;
readers ignore what they do not understand. The meaning of an existing field
never changes within a version.

Reserved for future versions: an `assets/` directory inside an item directory
for attachments referenced from `body.md`.
