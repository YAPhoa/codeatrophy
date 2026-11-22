# Contributing to Codeatrophy

These rules apply to every change, whoever makes it: the maintainer, another
person, or an AI assistant working in the repository. The first part holds for
any project; the second is what this one adds.

## Rules for every change

### Size

1. **A commit changes at most 1000 lines, and most should stay under 400.**
   Added plus deleted, counting code, tests and documents. Not counted: lock
   files (`go.sum`, `package-lock.json`), generated files, test fixtures,
   binary assets, and files that only moved.

   ```sh
   git diff --cached --shortstat -- . ':!go.sum' ':!web/package-lock.json' ':!**/testdata/**'
   ```

2. **A larger piece of work is a series of commits**, each within the limit,
   each of which builds, passes the checks and leaves the app working. Lay
   the ground first (schema, then service, then API, then UI); never a
   "part 1" that is broken until "part 3" lands.
3. **A new source file starts under 600 lines.** A file past 1000 lines is
   due for a split: do not give it a new responsibility, start a new file.
   Tests and stylesheets are exempt.

### Scope

4. **One change per commit.** If the subject needs "and" to join two things,
   it is two commits.
5. **Reshaping and behaviour do not share a commit.** A rename, a move, a
   reformat or a refactor goes in on its own, changing no behaviour, before
   or after the commit that does.
6. **No drive-by edits.** A commit touches only the lines its purpose needs.
   Something else you noticed on the way is another commit, or an issue.
7. **Nothing speculative.** No option, abstraction, flag or setting for a
   need nobody has yet. No dead code and no commented-out code; git keeps
   what was removed.
8. **A new dependency arrives in its own commit**, with the reason the
   existing code could not do the job in the message, and a licence the
   project can carry.

### Quality

9. **The checks pass at every commit**, not only at the last one of a
   series. A check that was failing before your change is fixed first, in
   its own commit.
10. **A change in behaviour comes with a test**, and a bug fix with a test
    that failed before the fix.
11. **No test is skipped, loosened or deleted to make a change pass**, and
    none is rerun until it goes green. A test that fails some of the time is
    a bug.
12. **A suppression states its reason on the spot**: a lint or type-check
    exemption, a skipped test, a `TODO`. A `TODO` names an issue, or the
    work is done now.
13. **No new fixed sleeps in tests.** Wait for the condition.
14. **Documents change with the behaviour they describe**, in the same
    commit.

### History

15. **The subject says what is now true**, in plain words, as a user or
    operator would put it, usually after the area it concerns:

    ```
    MCP: the session cap counts only initialized sessions
    Grader: a compile error on a later case is that case's result
    Secret key: written so a power cut cannot leave it empty
    ```

    No type prefix (`fix:`, `feat:`), no full stop, 72 characters at most.
16. **The body says why.** First what was wrong or missing and whom it
    affected, then what changed. Wrap at 72 columns. Refer to an earlier
    commit by its short hash. No line crediting a tool (`Co-Authored-By`,
    "Generated with").
17. **Pushed history is not rewritten.** A pushed mistake is fixed, or
    reverted, with a new commit. If `main` is broken, mending it comes
    before any other work.
18. **Nothing secret, personal or local is committed**: no `.env`, key,
    database file, real library content, private address, build output,
    editor or assistant settings, plans, task lists or notes.

### Branches and pull requests

19. **`main` is the only long-lived branch, and its history is a straight
    line.** GitHub refuses a force-push, a deletion or a merge commit on it,
    for everyone.
20. **A branch is short-lived and does one thing.** Cut it from `main`, name
    it for what it does (`session-cap-count`), bring it up to date by
    rebasing, never by merging `main` into it, and delete it once merged.
21. **A pull request is one change, or a series that builds one thing.** One
    change is squashed into a single commit when merged, so the whole pull
    request stays within rule 1. A series is merged by rebase, each commit
    as it is, so each one follows these rules by itself.
22. **The title and description are the commit message** (rules 15 and 16):
    a squash uses them as written. The description also says which checks
    you ran.
23. **Only the maintainer merges**, and only with CI green. Expect to be
    asked to split a pull request that does more than one thing.

### Exceptions

A rule may be broken only out loud. When a commit cannot follow one (a
mechanical rename across the tree is over the size limit however it is cut),
it does nothing else, and its message has a line saying which rule and why:

```
Over the size limit: renames the package in every import, nothing else.
```

An exception that keeps coming back means the rule is wrong. Change it here.

## This project

### Before you start

- **A small fix** (a bug, wording, a test) needs no discussion. Make it.
- **Propose first** anything that adds or changes a schema migration, an API
  route, an MCP tool, a bundle field, a configuration variable, a dependency,
  or a part of the UI that every screen shares. Open an issue that says what
  the user will see, and wait for an answer before writing the code.
- **Pull requests are welcome**, from a branch of your fork. For anything on
  the list above, the issue comes first.
- **Terms for a contribution.** By opening a pull request you state that you
  wrote the change or have the right to submit it, that it is licensed under
  `AGPL-3.0-only` like the rest, and that you grant the copyright holder
  named in `README.md` a perpetual, worldwide, royalty-free, irrevocable
  licence to use it and to license it under other terms as well. That grant
  keeps the whole project under one owner who can offer it under another
  licence; a change that comes without it cannot be merged. On your first
  pull request you are asked to confirm these terms in a comment.
- **Security problems are reported privately**, through "Report a
  vulnerability" on the repository's Security tab, not in a public issue.

### Setting up and checking

`make help` lists every target. The Makefile uses Go and npm from your machine
when they are installed and runs them in Docker otherwise. Read
[`docs/architecture.md`](docs/architecture.md) first, then the document for
the part you are changing.

CI (`.github/workflows/ci.yml`) runs all of these on every push and every
pull request, builds the Docker image and starts it, and looks for known
vulnerabilities in the Go dependencies. Run them yourself first all the same:
a red run on `main` is a broken `main`, and rule 17 puts mending it before
any other work.

| When | Run |
| --- | --- |
| Before every commit | `make check`: `go vet`, `gofmt`, ESLint, the type check, the Go tests on SQLite and on PostgreSQL, the UI unit tests |
| The change touches `web/` | also `npm run test:e2e` in `web/` (Playwright, against the mock) |
| The change touches goroutines, locks or shared state | also `make test-race` |

### What must change together

| When you change | The same commit also changes |
| --- | --- |
| A route, or the shape of a request or response | `docs/api.md`, the handler in `internal/httpapi`, `web/src/api/types.ts` and `client.ts`, and the mock in `web/src/mock`. `web/src/api/contract.test.ts` fails when they disagree. |
| A business rule | `internal/app`, never a handler or a tool: `httpapi` and `mcpserver` are thin adapters over the same services. |
| An MCP tool, prompt or resource | `docs/mcp.md` (a test compares the tool list), and `skills/codeatrophy/` when the workflow around the tools changes. |
| The database schema | One migration per backend with the same new number, `store.SchemaVersion`, and `store.Tables`. Migrations are forward-only: never edit a pushed one. |
| The `store` interface | Both implementations, and a case in `internal/store/storetest` so that both run the same test. |
| The bundle format | `docs/bundle-format.md` and a fixture in `internal/bundle/testdata`. A field never changes meaning within a format version. |
| A configuration variable | `internal/config`, `.env.example`, and the table in `README.md` when most installations will want it. |
| A bound on user input | The server, `limits` of `GET /meta`, and `Limits` in `web/src/api/types.ts`. The UI keeps no copies. |
| An AI provider or judge engine | A new implementation of `ai.Provider` or `judge.Engine` in its own package, never a special case in a caller. |

### Code

- **Go:** `gofmt` and `go vet` clean; the standard library first (`net/http`,
  `log/slog`, `testing`); dependencies point inward as "Server packages" in
  `docs/architecture.md` describes; no dependency that needs cgo.
- **TypeScript:** strict, ESLint clean, and the conventions in
  [`web/README.md`](web/README.md). Colours and motion come from the tokens
  and are checked in light and dark. Text in the UI is short: a hint is one
  sentence.
- **Security**, where a change that loosens anything is proposed first: item
  text is untrusted and no raw HTML is rendered from it; stored credentials
  are never logged, exported or exposed over MCP; pasted text reaches a model
  as data, not instructions; the host, origin and AI provider address checks
  stay on by default; the UI makes no request to a third-party origin.
