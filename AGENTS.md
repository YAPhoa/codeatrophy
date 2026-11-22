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

- `docs/architecture.md` — components and how they fit together
- `docs/api.md` — HTTP API reference; the contract between server and UI
- `docs/mcp.md` — MCP server: connecting a client, tools, prompts
- `docs/bundle-format.md` — the import/export bundle format

Read the relevant document before changing behaviour it describes, and update
it in the same change.

## Working on the code

- The server is Go; the UI is TypeScript. `make help` lists the build, test and
  lint targets for both; they run Go and npm in Docker when those are not
  installed.
- Server and UI communicate only through the HTTP API in `docs/api.md`. A
  change to a request or response shape must update that document, the server
  handlers, and the UI client types together.
- The HTTP API and the MCP server are thin adapters over the same application
  services. Put business rules in the services so both transports share them,
  and keep `docs/mcp.md` in step with the tool definitions.
- AI providers and judge engines sit behind small interfaces. Add a new one as
  a new implementation of the interface, not as a special case in callers.
- Storage has a SQLite and a PostgreSQL implementation behind one interface.
  A schema change needs a migration for each, at the same schema version.
- The bundle format is versioned. Do not change the meaning of an existing
  field within a format version.
- Add or update tests alongside behaviour changes.
