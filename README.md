# Codeatrophy

Codeatrophy is a self-hosted library for coding challenges and technical
readings. Keep the problems you want to practise and the notes you want to
keep in one place, organise them with collections and tags, and solve problems
in the browser against your own test cases.

![Drafting a problem with AI from a one-line note, reviewing the draft, and saving it to the library](docs/images/drafting-demo.gif)

- **Problems and readings** in Markdown (with math and Mermaid diagrams), with
  tags, collections, difficulty and personal progress.
- **A judge built in.** Problems carry stdin/stdout test cases; "Run" and
  "Submit" execute your code in a sandbox ([Judge0](https://github.com/judge0/judge0))
  in C, C++, C#, Go, Java, JavaScript, Kotlin, Python, Ruby, Rust and TypeScript.
  A problem is either a full program or *solution only*, as on interview
  sites: you write just the function or class, and hidden per-language
  runner code turns it into a program; error messages point at your own
  lines.
- **AI drafting (optional).** Paste a half-remembered description and get a
  complete, reviewable item with the assumptions listed — solution-only or a
  full program, whichever fits — whose examples have already been checked by
  running the model's own reference solution; generate test cases whose
  expected outputs come from actually running a reference solution, and
  optionally one large case built by a generator program, so that a solution
  of the wrong complexity fails; derive
  easier, harder or twisted variants. Works with Anthropic or any
  OpenAI-compatible endpoint, including local models. Every request's
  tokens are counted per provider, and an activity log keeps what was sent
  and what came back.
- **An MCP server** so an AI assistant (Claude Code, Claude Desktop, ...) can
  read, write and test items in your library directly.
- **Portable bundles.** Export any part of the library as a zip of plain
  JSON, Markdown and source files, and import it elsewhere without
  duplicates.

It runs as a Docker Compose stack: one Go server (web UI, HTTP API and MCP
endpoint), its PostgreSQL database, and the Judge0 containers. The server
can keep the library in a single SQLite file instead.

## Quick start

Requirements: Docker with Compose v2.24 or later. The judge needs a
privileged container (see [Security](docs/security.md)).

```sh
git clone https://github.com/YAPhoa/codeatrophy.git
cd codeatrophy
cp .env.example .env      # adjust if you like; the defaults work
docker compose up -d --build
```

Open <http://localhost:8484>. The first start takes a minute while Judge0
initialises its database; the judge shows as unavailable until then.

The first visit asks you to create your account: choose the email and
password you want to sign in with. A sign-in lasts 30 days from the last time you used the app in that browser. See
[Signing in](docs/signing-in.md) to turn sign-in off or manage accounts.

To stop: `docker compose down` (your data stays in the `codeatrophy-db` and
`codeatrophy-data` volumes).

### Without the judge

Set `CODEATROPHY_JUDGE_ENGINE=none` and remove `judge0` from
`COMPOSE_PROFILES` in `.env`. The Judge0 containers are then not started and
the UI hides run and submit; the library, AI drafting, bundles and MCP keep
working.

## Configuration

Everything is configured with environment variables, all documented in
[`.env.example`](.env.example). [`docs/configuration.md`](docs/configuration.md)
lists the ones most installations set and covers AI providers and style
presets.

## Documentation

Running an instance:

| Document | Contents |
| --- | --- |
| [Configuration](docs/configuration.md) | The common environment variables, AI providers, style presets |
| [Signing in](docs/signing-in.md) | Accounts, sessions, turning sign-in off, tokens for MCP |
| [Storage](docs/storage.md) | PostgreSQL or SQLite, upgrading, database commands, backup and restore |
| [Security](docs/security.md) | Exposing an instance, host and origin checks, AI provider addresses, the judge |
| [MCP server](docs/mcp.md) | Connecting an AI assistant, its tools and prompts |

Working on the code:

| Document | Contents |
| --- | --- |
| [Architecture](docs/architecture.md) | The components and how they fit together |
| [HTTP API](docs/api.md) | The API reference; the contract between server and UI |
| [Bundle format](docs/bundle-format.md) | The import and export format |
| [Web UI](web/README.md) | The UI's scripts, API mock, structure and conventions |
| [Contributing](CONTRIBUTING.md) | The rules for every change |

## Development

Layout: `cmd/` and `internal/` hold the Go server, `web/` the React UI,
`docs/` the documents listed above. Start with
[`docs/architecture.md`](docs/architecture.md); the HTTP API in
[`docs/api.md`](docs/api.md) is the contract between server and UI.

```sh
make help          # all targets
make test          # Go tests (SQLite)
make test-postgres # Go tests on PostgreSQL, against a throwaway server in Docker
make lint          # go vet, gofmt check, UI lint and type check
make web-dev-mock  # UI dev server with an in-memory API mock
make run           # server on 127.0.0.1:8484 with data in ./data
make build         # UI + server binary with the UI embedded (bin/codeatrophy)
make up            # the whole Compose stack, the app built from this checkout
```

The Makefile uses Go and npm from your machine when they are installed and
otherwise runs them in the official Docker images, so Docker alone is enough.
A server binary built without the UI (`make build-server`, or plain
`go build ./...`) serves a placeholder page; the Docker image always
contains the UI.

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the rules for a change: how large a
commit may be, the checks to run, and what must change together.

## License

Copyright (C) 2026 YAPhoa

Codeatrophy is licensed under the GNU Affero General Public License v3.0 only
(SPDX: `AGPL-3.0-only`); see [`LICENSE`](LICENSE). In plain terms: if you run a
modified version as a network service, you must offer its source code to that
service's users.

Judge0 is separate software under its own license (GPL-3.0). Codeatrophy runs
it as an independent service, reached over HTTP; none of its code is included
in this project.

The web UI bundles two fonts under the SIL Open Font License 1.1: IBM Plex Sans
(Copyright 2019 IBM Corp.), installed from the `@fontsource-variable/ibm-plex-sans`
package, and JetBrains Mono (Copyright 2020 The JetBrains Mono Project Authors),
cut down to ASCII for the wordmark, with its license in
[`web/src/assets/fonts/JetBrainsMono-OFL.txt`](web/src/assets/fonts/JetBrainsMono-OFL.txt).
