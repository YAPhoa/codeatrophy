# Codeatrophy web UI

The single-page app served by the Codeatrophy server. It talks to the server
only through the HTTP API described in [`docs/api.md`](../docs/api.md), which
is the contract between the two: change a request or response shape there,
in the server handlers, and in `src/api/types.ts` together.

Stack: Vite, React, TypeScript (strict), React Router, TanStack Query,
CodeMirror 6, `react-markdown` with KaTeX and highlight.js. Styling is plain
CSS driven by custom properties (`src/styles/tokens.css`). Everything is
bundled; the app makes no request to any third-party origin at runtime, so it
works offline on a LAN.

## Scripts

Requires Node 22 and npm 10.

| Command | What it does |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run dev` | Dev server on <http://localhost:5173>, proxying `/api` and `/mcp` to a running backend |
| `npm run dev:mock` | Dev server against an in-memory mock of the whole API — no backend needed |
| `npm run build` | Type-check, then build for production into `dist/` |
| `npm run typecheck` | TypeScript only |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (Vitest); `npm run test:watch` to keep them running |
| `npm run test:e2e` | Browser smoke tests (Playwright) against the mock — see below |

`npm run dev` expects the backend at `http://localhost:8080`. Point it
elsewhere with an environment variable:

```sh
CODEATROPHY_BACKEND_URL=http://localhost:9090 npm run dev
```

In production the Go server serves `dist/` from `/`, the API from `/api/v1`
on the same origin, and falls back to `index.html` for client-side routes.

## Working without a backend: the mock

`npm run dev:mock` replaces the network layer with `src/mock`, an in-memory
implementation of every endpoint in `docs/api.md` — shapes, status codes,
validation, the asynchronous submission lifecycle, AI endpoints with realistic
delays — seeded with a believable library. Keep it faithful to the contract
when the contract changes; its own tests are in `src/mock/mock.test.ts`.

State lives in memory only: **reloading the page resets it** to the seed.

The mock server forwards nothing to a backend: a request that bypasses the
mock's client, such as a plain `fetch('/api/…')` from a script, gets
`503 mock_only` instead of reaching a real instance. Scripts call
`window.__codeatrophyMock.fetch` to reach the mock.

### Scenarios

Add `?mock=` with comma-separated flags to any URL. The flags stick for the
browser tab (they are kept in `sessionStorage`); `?mock=default` clears them.

| Flag | Effect |
| --- | --- |
| `no-ai` | No AI provider at all, so no default: AI endpoints answer `503 ai_unavailable` |
| `no-judge` | No judge engine: no languages, execution endpoints answer `503 judge_unavailable` |
| `judge-down` | Judge configured but unreachable: runs end in `internal_error`, verification answers `503`, generated test cases come back unverified |
| `mcp-token` / `mcp-off` | MCP endpoint requires a token / is disabled |
| `mcp-url` | The server reports a public MCP URL (`meta.mcp.url`) instead of leaving it to the page origin |
| `ai-env` | The Anthropic provider is the read-only one the server's environment supplies (`env-anthropic`) rather than a saved one; with `no-ai` it is there but not the default |
| `forbidden` | Every request, reads included, answers `403 forbidden`: the server does not recognise the host it is addressed by, so the app cannot even start |
| `forbidden-writes` | Only state-changing requests answer `403 forbidden`, as when a reverse proxy hides the page's origin |
| `show-tests` | The "Hide test cases by default" preference starts switched off |
| `empty` | Start with an empty library and no style presets |
| `no-styles` | Seed library, but no style presets |
| `fast` / `instant` | Short / no artificial delays |
| `slow` | Every plain request takes a second, to see what a screen shows while it waits |
| `slow-<path>` | Reads under one path (`slow-stats`, `slow-collections`, `slow-items`, …) take a second longer |

Example: <http://localhost:5173/?mock=no-ai,fast>

### Steering outcomes

Code cannot really be executed in the browser, so the mock judge decides
verdicts from markers anywhere in the submitted source:

| Marker | Verdict |
| --- | --- |
| `MOCK:WA` | Wrong answer on some cases |
| `MOCK:TLE`, `MOCK:MLE` | Time / memory limit exceeded on the last case |
| `MOCK:RE` | Runtime error with a stack trace |
| `MOCK:CE` | Compile error with compiler output |
| `MOCK:IE` | Internal (judge) error |
| *unchanged starter code* | Wrong answer with empty output |
| *anything else* | Accepted |

For a "solution only" problem the markers are looked for in the whole program
that runs, the runner included. The seed has one such problem, "Merge k Sorted
Lists".

The mock's starter code, in the seed and in drafts, marks the lines that read
the input as a [folded region](../docs/api.md#folded-regions); "Number of
Islands" has starter code of its own with a larger one in Python and C++.

For the AI endpoints, `MOCK:FAIL` in the input text or instruction produces a
`502 upstream_error`, `MOCK:MISMATCH` a draft whose reference solution
disagrees with its last example, and `MOCK:RUNNER` a "solution only" draft
with one runner that does not compile. `MOCK:REPEAT` in the instruction of a
test generation leaves two proposals out as repeats, `MOCK:REPEAT-ALL` all of
them. A request with `largeTestCases: n` gets `n` large test cases of about
300 KB on one line each, each a different input with a name of its own, the
same every time; `MOCK:LARGE-FAIL` in the input text or instruction reports
every one as failed (the generator crashed), `MOCK:LARGE-SKIP` as skipped, and
`MOCK:LARGE-SHORT` adds all but the last, which is reported as failed with no
name or generator (the model wrote one generator fewer than asked for).
Without a judge, with `judge-down`, or in a draft whose reference solution
fails its other cases (`MOCK:MISMATCH`), they are skipped as well.
Results of a run cut each stream at 64 KiB, as the server does.
"Verify all" on a draft (`POST /items/check`) reports a case as `wrong` when
its input or expected output contains `MOCK:WA` and as `failed` when it
contains `MOCK:RE`; `MOCK:CE` in the reference solution fails every case, and
`MOCK:TIMEOUT` there leaves the second half `not_run`. Every generation adds to
the usage counts of the default provider. In Settings, an API key containing `bad` or a base URL
containing `unreachable` makes the model list and the connection test of a
provider fail, and a base URL containing `no-models` stands for a server that
does not list its models (the test of a model typed by hand still succeeds).
A model the pretend service does not list fails the test as unknown. The
pretend Gemini service lists only text models, by bare id
(`gemini-3.5-flash`), as the server passes them on. Listing the models is not
logged or counted in a provider's usage.

The running mock is exposed as `window.__codeatrophyMock`; its `requests`
lists every request it has answered (`GET /items/…`), for checking what a
screen asks for. To exercise the
"changed elsewhere" flow, open an item's edit page, run

```js
__codeatrophyMock.externalEdit('<item id>')
```

in the console (it edits the item and bumps its revision, as an assistant
connected over MCP would), then save.

## Browser smoke tests

`npm run test:e2e` runs a short Playwright suite (`e2e/smoke.spec.ts`) over
the flows the product stands on: capture → draft → revise → save; the coding
workspace with a judged submission, a hidden failing case and its panes; the
submission history, which leaves runs out; the custom input kept across a
reload; the runner rows and folded regions of the solve editor;
keeping an accepted submission as a solution and making it the reference;
preferences taking effect; large test cases, from their preferences to the
Test cases page; "Verify all" on a draft and on a saved problem; the pages of Settings; adding an AI provider
(key → Refresh models → model → connection test → add → default; adding waits for a passed test of its server and key), a Google Gemini one among them;
editing one (its models offered without a test, a test asked for only for a new server or key, a typed name kept when the server lists no models); the AI request timeout; choosing the model a draft, revision or test-case generation uses; a problem's Variants tab; filing selected items
into a collection; the library's views, row verdicts and sort menu; and Import and Export as pages of Settings, reached from their old addresses too.
It also holds the loading rules (`e2e/loading.spec.ts`), choosing the
default writing style (`e2e/styles.spec.ts`), and the system prompt and
test case prompt, each edited only after a confirm, reset, and guarded when
left unsaved (`e2e/system-prompt.spec.ts`). It starts its own
`dev:mock` server (port 5174, or `E2E_PORT`), so it needs no backend, AI
provider or judge, and it fails on any page error or request to a third-party
origin. The tests in `e2e/built` check how a reload paints and that a load at
the mock's normal speed shows nothing as loading, which depend on the
production build: they run as a second project against a build made with
the mock and served by `vite preview` (port 5175, or `E2E_BUILT_PORT`), built
afresh each run. It is separate from `npm test`.

The first time, download the browser Playwright drives:

```sh
npx playwright install chromium
```

Keep the suite small and deterministic. It checks that the flows hold
together; logic belongs in unit tests. Because the mock's state lives in the
page, every test starts from the seed library, and navigation inside a test
has to stay client-side (a reload resets the mock).

## Structure

```
src/
  api/        types.ts (the contract), client.ts (fetch wrapper, ApiError),
              queries.ts (TanStack Query keys, hooks, cache updates)
  app/        application frame: shell, sidebar, command palette, shortcuts
  features/   one folder per area of the product
    library/      browse, search, filter, sort, select, bulk actions, reorder
    collections/  create / rename / move / delete dialogs
    capture/      paste → AI draft → review → save; variants; "what next"
    item/         item page dispatch, shared header and controls, editor form,
                  edit page with revision-conflict handling, notes, variants
    solve/        problem workspace: editor, run / submit, the tests and
                  results drawer, history
    solutions/    saved solutions of a problem, the reference solution
    tests/        test-case management, verification, AI generation
    reader/       long-form reading view
    tags/ share/ settings/
  lib/        framework-free logic: filters ⇄ URL, form ⇄ API mapping and
              three-way merge, output diff, collection tree, code storage, …
  ui/         small shared components (buttons, menus, dialogs, toasts,
              CodeMirror and Markdown wrappers, diff view, split pane)
  styles/     design tokens and stylesheets
  mock/       the in-memory API
e2e/          Playwright smoke tests (run against the mock)
```

A few conventions worth knowing:

- **Capabilities come from `GET /meta`.** Features that need an AI provider or
  a judge engine check it and degrade to an explanation, never to an error.
- **So do limits.** Every bound on user input (title length, tag count, time
  and memory ranges, upload size, style preset sizes, …) is read from
  `meta.limits`; forms validate against those values and the client keeps no
  copies. Add a bound to the server and to `Limits` in `src/api/types.ts`,
  then use it from `useLimits()`.
- **The judge's toolchains are old** (for example Python 3.8, GCC 9, Go 1.13,
  Java 13, Node 12). The language picker shows the version the judge reports;
  starter code and reference solutions — including the mock's — must not rely
  on newer language features.
- **Edits carry `expectedRevision`.** A `409` opens a dialog that shows what
  changed elsewhere and merges field by field; nothing is overwritten
  silently. Only content changes move an item's revision: personal state
  (status, favorite, notes), collection membership and test-case edits do
  not, and are saved without it. Whatever changes the reference solution does
  carry it, because that solution is content: saving test cases together with
  one, editing the solution that is the reference, or choosing another.
- **A problem keeps any number of solutions; one may be the reference.** Only
  the reference solution verifies test cases: running it sets and clears
  "verified" marks and can replace expected outputs. Any other solution can be
  run against the cases as a check that changes nothing. Solutions are
  spoilers, so their code is not rendered until asked for.
- **The editor is the primary surface of the workspace.** It fills the column
  beside the statement; test cases, results and custom input live in a drawer
  below it that is a slim bar until something is run. The statement, the
  drawer and the navigation can each be minimised (the shortcuts dialog, `?`,
  lists the keys); what is minimised and the pane sizes are remembered in
  `localStorage`, per browser.
- **The solve editor holds only the solver's code.** For a "solution only"
  problem the runner is shown as collapsed rows above and below that code
  (block widgets, `src/ui/editorRunner.ts`) that expand to it read-only; it is
  never part of the editor's text, so line numbers, selection, copying, undo,
  saved drafts and submissions cover the solver's code alone. Code put into
  the editor from outside (opening the problem, changing language, reset,
  loading a submission) opens with its
  [marked regions](../docs/api.md#folded-regions) folded; typing never folds.
  Every code editor can fold a marked region from the gutter, in any
  language.
- **Preferences live on the server** (`/settings/preferences`), so they follow
  the user between browsers; only the theme is local. `usePreferences()`
  returns them, with the defaults until they have loaded. Every CodeMirror
  editor goes through `src/ui/CodeEditor.tsx`, which applies the editor
  preferences itself — callers pass nothing.
- **Hidden test cases stay hidden.** With that preference on, the content of
  non-sample cases — and their names — is not rendered in the workspace, in
  results or on the test-management page until the user reveals it, and a
  reveal lasts for the visit. Counts, verdicts, time and memory are always
  shown. Anything new that displays test data has to honour this
  (`useReveal()` in `features/solve`).
- **Item bodies are untrusted.** They can come from imported bundles. The
  Markdown renderer never turns raw HTML into elements, drops unsafe URLs,
  and does not load remote images until asked. `src/ui/Markdown.test.tsx`
  guards this; do not add `rehype-raw`.
- **Work in progress is kept locally.** Solution code is stored per item and
  language in `localStorage`, and the custom input per item (up to 64 KB);
  capture input and drafts under review survive a reload the same way. The
  model names loaded for a provider, by Refresh models
  or a connection test, are remembered there too, per kind and base URL
  (`features/settings/modelCache.ts`): the Model field of the provider form
  offers the list remembered for the server in the form, and a saved provider
  with none loads its list as the form opens. A key is never stored.
- **Colours are tokens.** Use the custom properties in
  `src/styles/tokens.css` so both themes stay correct, and check contrast in
  light and dark when adding one.
- **Motion is tokens too.** Durations and easing come from the motion tokens
  in `src/styles/tokens.css`: things open in `--duration-fast` and close in
  `--duration-quick`. Overlays play their exit when React removes them:
  dialogs, popovers and the palette through `exitOnRemove`
  (`src/lib/motion.ts`), opening rows through `Collapse` (`src/ui`). Neither waits
  under reduced motion, where `base.css` also cuts every CSS duration and
  animation delay (the draft review's staggered entrance) to nil and turns
  smooth scrolling off.
  Keep list rows, menu items and other keyboard-driven highlights instant.
- **Animate a change, never an arrival.** A state that changes on screen may
  animate: an icon swapping (`IconSwap`), a label (`MorphText`), a count
  (`NumberChange`, all in `src/ui/Animated.tsx`), a fresh verdict, a toast.
  Opening a page on data that was already so (a favourite, a done item, a
  past submission) shows it at rest; `useChangeCount` tells the two apart.
  `e2e/motion.spec.ts` records every animation on load to hold this; the one
  arrival that moves is the screen itself fading in (see below).
- **A quick load shows nothing.** A reload keeps the app hidden until its
  first data, fonts and lazy parts are in, at most 300ms, then fades it in
  whole (`src/lib/boot.ts`); later, each screen fades in as it mounts, on
  opacity only (`styles/layout.css`). A loading indicator appears only once a
  load has taken 400ms: `PageLoading` does this, and anything else shown while
  loading uses `useLoadingShown` with the `loading-delay` class, keeping its
  size meanwhile. Navigating keeps the current screen until the next one has
  loaded, and resting the pointer on a library row (or focus) loads the item
  ahead of the click (`useIntent`, `prefetchItem`). The build preloads the
  fonts the first screen draws with (`vite.config.ts`).
- **Animate `transform` and `opacity`.** The sliding tab, segmented and
  outline indicators play their move as a transform (`useSlidingIndicator`),
  and the reader's text column eases aside for the notes as one (`slideFrom`).
  `Collapse` grows a row's height, which lays its content out on every frame:
  fine for a few rows, but pass `heavy` for code editors and diffs, which then
  fade in. The navigation rail does not tween its width: with a long library on
  screen that reflows the page on every frame.
- **Unit tests cover logic, not layout**: the API client, the mock, and the
  modules in `src/lib`. The Playwright suite covers the main flows end to end.
