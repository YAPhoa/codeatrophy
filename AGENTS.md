# Codeatrophy

Codeatrophy is a self-hosted web app for keeping a personal library of coding
challenges and technical readings. Items can be written by hand or drafted by
an AI provider from a rough or incomplete snippet. Coding problems carry test
cases and are run against a pluggable judge engine. Any part of the library
can be exported as a portable bundle and imported into another instance. An
MCP server lets AI assistants read and edit the library directly.

It ships as a Docker Compose stack: one Go server (which serves the web UI,
the HTTP API and the MCP endpoint), a PostgreSQL database and the judge
engine's containers. The server also runs on its own with an embedded SQLite
database.

## Repository layout

| Path | Contents |
| --- | --- |
| `cmd/codeatrophy/` | Server entry point |
| `internal/` | Go packages: application services, HTTP API, MCP server, storage, AI providers, judge engines, grading, bundles |
| `web/` | Web UI (TypeScript, React, Vite) |
| `docs/` | Architecture, HTTP API reference, MCP server, bundle format |
| `skills/` | Companion skill for AI assistants that work on a library over MCP |
| `compose.yaml` | Deployment stack |

## Documentation

- `CONTRIBUTING.md` — the rules for every change
- `docs/architecture.md` — components and how they fit together
- `docs/api.md` — HTTP API reference; the contract between server and UI
- `docs/mcp.md` — MCP server: connecting a client, tools, prompts
- `docs/bundle-format.md` — the import/export bundle format
- `docs/configuration.md` — environment variables, AI providers, style presets
- `docs/signing-in.md` — accounts, sessions, turning sign-in off, MCP tokens
- `docs/storage.md` — PostgreSQL or SQLite, upgrading, database commands, backups
- `docs/security.md` — exposing an instance and what protects it
- `web/README.md` — the UI: scripts, the API mock, structure, conventions

## Working on the code

[`CONTRIBUTING.md`](CONTRIBUTING.md) binds an assistant as it binds a person.
Read it before the first change in a session, and the document for the part
you are changing before changing behaviour it describes. In short:

- The server is Go; the UI is TypeScript. `make help` lists the build, test
  and lint targets for both; they run Go and npm in Docker when those are not
  installed.
- Server and UI communicate only through the HTTP API in `docs/api.md`.
  Business rules live in the application services (`internal/app`), which the
  HTTP API and the MCP server both adapt.
- Whatever describes a behaviour changes in the same commit as the behaviour:
  documents, client types, the API mock, both databases' migrations, tests.
  "What must change together" in `CONTRIBUTING.md` has the full list.

For assistants in particular:

- **Say when a request breaks a rule.** If what you are asked to do would
  go against `CONTRIBUTING.md` (a commit over the size limit, two changes in
  one commit, a behaviour change with no test, a check failing, a document
  left behind), name the rule by its number and what following it would take
  before you do the work. This holds whoever is asking, the maintainer
  included. Then do as they decide, and record the exception in the commit
  message as the guideline asks.
- **Measure before committing.** Run the size command of rule 1 on what is
  staged, and split the work if it is over.
- **A change is done when the checks pass.** Run `make check`, and the
  browser tests for a change in `web/`, before reporting it finished. Report
  a failure as it is, with its output; do not describe unverified work as
  working.
- **Commit and push only when asked**, with the repository's configured git
  identity, in the message style of `CONTRIBUTING.md`, and with no line that
  credits a tool.
- **Leave out of the repository** anything about your own session: plans,
  notes, scratch files, tool settings.
