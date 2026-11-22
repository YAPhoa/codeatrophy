# Codeatrophy

Codeatrophy is a self-hosted, AI-assisted library for coding challenges and
technical readings. Instead of letting AI do all the coding while your skills
go rusty, work with it to stay sharp: turn notes or rough questions into
problems and readings, organise everything with collections and tags, and
solve challenges yourself in the browser.

![Drafting a problem with AI from a one-line note, reviewing the draft, and saving it to the library](docs/images/drafting-demo.gif)

## What it does

- **Problems and readings in one place.** Write entries in Markdown (with
  math and Mermaid diagrams), tag them, set difficulty, and track your status,
  personal notes, and favourites.
- **Run and submit in the browser.** Test your code directly on the platform
  as you work, then submit it for a verdict against the problem's test cases.
  Codeatrophy handles execution in a sandboxed runner powered by
  [Judge0](https://github.com/judge0/judge0), so you can practise end-to-end
  without switching to a separate editor or terminal.
- **Organise and share.** Group problems and readings into nested,
  reorderable collections for a course, topic, or interview plan. Export parts
  of your library to share with other people, or import problem sets and notes
  shared by others.
- **Consistent writing styles.** Fresh installs come with three presets
  (*Interview practice*, *Contest style*, and *Study notes*) that control how
  items are structured and worded. Edit them or add your own under
  **Settings → Styles**.

## Working with AI

Codeatrophy works with AI in two ways, both optional:

### 1. Connect your own coding agent via MCP

Codeatrophy includes an [MCP server](docs/mcp.md). Connect OpenCode, Claude
Code, Codex, Claude Desktop, or another MCP client with one command, with no
LLM API keys configured in the app.

From your agent, you can:

- Read, write, test, and organise items directly in your library.
- Point it at a chapter, article, lecture notes, or problem list to generate
  structured readings and coding problems.
- Check each problem's test cases by running a reference solution on the
  judge and file the finished items into a collection.

### 2. Draft directly in the app

Configure an Anthropic, Gemini, or OpenAI-compatible provider (including local
models) to use the built-in drafting tools in the web UI:

- **Turn rough prompts into full items.** Start from a half-remembered topic
  or incomplete interview question and get a complete, reviewable problem or
  reading you can practise with.
- **Generate test cases and variants.** Build test cases from a reference
  solution (with an optional large case to catch solutions of the wrong time
  complexity), or derive easier, harder, and modified variants of an existing
  problem.

Both the MCP tools and the in-app drafter follow the writing styles you have
configured.

## Quick start

Requirements: Docker with Compose v2.24 or later. The judge needs a privileged
container (see [Security](docs/security.md)).

```sh
git clone https://github.com/YAPhoa/codeatrophy.git
cd codeatrophy
cp .env.example .env      # adjust if you like; the defaults work
docker compose up -d
```

This pulls the published image, for amd64 or arm64, of the release the
checkout names (`main` is always the latest release); nothing is built.

Open <http://localhost:8484>. On the first start, Judge0 takes about a minute
to initialise its database; the judge shows as unavailable until that
finishes.

Your first visit asks you to create an account. Sessions stay active for 30
days from the last time you used the app in that browser. See
[Signing in](docs/signing-in.md) to manage accounts or turn sign-in off.

To stop:

```sh
docker compose down
```

Your data stays in the `codeatrophy-db` and `codeatrophy-data` volumes. To
move to a later release, see [Upgrading](docs/storage.md#upgrading).

### Without the judge

If you only want the library, notes, sharing, AI drafting, and MCP:

1. Set `CODEATROPHY_JUDGE_ENGINE=none` in `.env`.
2. Remove `judge0` from `COMPOSE_PROFILES` in `.env`.

The Judge0 containers will not start, and the UI will hide Run and Submit.

### Building from source

`docker compose up -d --build` builds the app image from the checkout
instead, inside Docker, and runs it; `make up` does the same and stamps the
build with its version from git (otherwise it reports `dev`). The build takes
the published image's name; `docker compose pull` puts the published one
back.

## Judge engine

When you Run or Submit code, Codeatrophy sends it to a sandboxed runner under
a time and memory limit. Choosing test cases, comparing outputs, and giving
verdicts all happen inside Codeatrophy, so the engine itself can be swapped
out.

This version uses [Judge0](https://github.com/judge0/judge0) in separate
containers. Two limits worth knowing before running it:

- Its toolchains are old (for example Python 3.8, GCC 9, Go 1.13, Java 13,
  Node 12).
- Its sandbox needs a privileged container (see
  [Security](docs/security.md)).

A future version may replace Judge0 with a judge built specifically for
Codeatrophy. Problems, test cases, and exported bundles do not depend on which
engine runs them. See "Judge engines" in
[`docs/architecture.md`](docs/architecture.md#judge-engines) for the
interface.

## Configuration

Everything is configured with environment variables, all documented in
[`.env.example`](.env.example). [`docs/configuration.md`](docs/configuration.md)
covers the common settings, AI providers, and style presets.

## Documentation

Running an instance:

| Document | Contents |
| --- | --- |
| [Configuration](docs/configuration.md) | Common environment variables, AI providers, style presets |
| [Signing in](docs/signing-in.md) | Accounts, sessions, turning sign-in off, tokens for MCP |
| [Storage](docs/storage.md) | PostgreSQL or SQLite, upgrading, database commands, backup and restore |
| [Security](docs/security.md) | Exposing an instance, host and origin checks, AI provider addresses, the judge |
| [MCP server](docs/mcp.md) | Connecting an AI assistant, its tools and prompts |

Working on the code:

| Document | Contents |
| --- | --- |
| [Architecture](docs/architecture.md) | Components and how they fit together |
| [HTTP API](docs/api.md) | API reference; the contract between server and UI |
| [Bundle format](docs/bundle-format.md) | Import and export format |
| [Web UI](web/README.md) | UI scripts, API mock, structure, and conventions |
| [Contributing](CONTRIBUTING.md) | Rules for every change |

## Development

`cmd/` and `internal/` hold the Go server, `web/` holds the React UI, and
`docs/` holds the documents listed above. Start with
[`docs/architecture.md`](docs/architecture.md); [`docs/api.md`](docs/api.md)
defines the contract between server and UI.

```sh
make help          # all targets
make test          # Go tests (SQLite)
make test-postgres # Go tests on PostgreSQL, against a throwaway server in Docker
make lint          # go vet, gofmt check, UI lint, and type check
make web-dev-mock  # UI dev server with an in-memory API mock
make run           # server on 127.0.0.1:8484 with data in ./data
make build         # UI + server binary with the UI embedded (bin/codeatrophy)
make up            # build the image from this checkout and start the Compose stack
```

The Makefile uses Go and npm from your machine when installed and otherwise
runs them in official Docker images, so Docker alone is enough. Building just
the server (`make build-server` or `go build ./...`) serves a placeholder page
instead of the UI; the Docker image always embeds the UI.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the rules every change must
follow.

## License

Copyright (C) 2026 YAPhoa

Codeatrophy is licensed under the GNU Affero General Public License v3.0 only
(`AGPL-3.0-only`); see [`LICENSE`](LICENSE). If you run a modified version as a
network service, you must offer its source code to that service's users.

Judge0 is separate software under its own license (GPL-3.0). Codeatrophy runs
it as an independent service over HTTP; none of its code is included in this
project.

The web UI bundles two fonts under the SIL Open Font License 1.1: IBM Plex Sans
(Copyright 2019 IBM Corp.), installed from `@fontsource-variable/ibm-plex-sans`,
and JetBrains Mono (Copyright 2020 The JetBrains Mono Project Authors), cut
down to ASCII for the wordmark, with its license in
[`web/src/assets/fonts/JetBrainsMono-OFL.txt`](web/src/assets/fonts/JetBrainsMono-OFL.txt).
