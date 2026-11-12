# Codeatrophy

Codeatrophy is a self-hosted library for coding challenges and technical
readings. Keep the problems you want to practise and the notes you want to
keep in one place, organise them with collections and tags, and solve problems
in the browser against your own test cases.

- **Problems and readings** in Markdown (with math), with tags, collections,
  difficulty and personal progress.
- **A judge built in.** Problems carry stdin/stdout test cases; "Run" and
  "Submit" execute your code in a sandbox ([Judge0](https://github.com/judge0/judge0))
  in C, C++, C#, Go, Java, JavaScript, Kotlin, Python, Ruby, Rust and TypeScript.
- **AI drafting (optional).** Paste a half-remembered description and get a
  complete, reviewable item with the assumptions listed; generate test cases
  whose expected outputs come from actually running a reference solution;
  derive easier, harder or twisted variants. Works with Anthropic or any
  OpenAI-compatible endpoint, including local models.
- **An MCP server** so an AI assistant (Claude Code, Claude Desktop, ...) can
  read, write and test items in your library directly.
- **Portable bundles.** Export any part of the library as a zip of plain
  JSON, Markdown and source files, and import it elsewhere without
  duplicates.

It runs as a Docker Compose stack: one Go server (web UI, HTTP API and MCP
endpoint, SQLite database) plus the Judge0 containers.

## Quick start

Requirements: Docker with Compose v2.20 or later. The judge needs a
privileged container (see [Security](#security)).

```sh
git clone <repository-url> codeatrophy
cd codeatrophy
cp .env.example .env      # adjust if you like; the defaults work
docker compose up -d --build
```

Open <http://localhost:8080>. The first start takes a minute while Judge0
initialises its database; the judge shows as unavailable until then.

To stop: `docker compose down` (your data stays in the `codeatrophy-data`
volume).

### Without the judge

Set `CODEATROPHY_JUDGE_ENGINE=none` and remove `judge0` from
`COMPOSE_PROFILES` in `.env`. The Judge0 containers are then not started and
the UI hides run and submit; the library, AI drafting, bundles and MCP keep
working.

## Configuration

Everything is configured with environment variables, all documented in
[`.env.example`](.env.example). The most common ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEATROPHY_HOST_PORT` | `8080` | Port on the host |
| `CODEATROPHY_BIND_ADDRESS` | `127.0.0.1` | Host address to publish on |
| `CODEATROPHY_PUBLIC_URL` | unset | URL the instance is reached at, when not `localhost` |
| `CODEATROPHY_ALLOWED_HOSTS` | unset | Extra host names or addresses the server answers to (see [Security](#security)) |
| `CODEATROPHY_JUDGE_ENGINE` | `judge0` in `.env.example` | `judge0` or `none` |
| `CODEATROPHY_SECRET_KEY` | generated | Key that encrypts stored API keys |
| `CODEATROPHY_AI_PROVIDER` | unset | Default AI provider: `anthropic` or `openai_compatible` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | unset | Provider keys for unattended setups |
| `CODEATROPHY_MCP_TOKEN` | unset | Require a bearer token on `/mcp` |

AI providers are normally set up in the UI under Settings: choose a provider,
enter the model and key, and test the connection. Keys entered there are
stored encrypted (AES-256-GCM) and are never shown again, logged, exported or
exposed over MCP. Environment variables supply defaults for anything not saved
in the settings.

With Anthropic, the default model is `claude-opus-5-5`. For models that
support it, requests to the Anthropic API ask for the server-side refusal
fallback, so a request declined by the model's safety classifiers is answered
by a fallback model instead of failing.

Style presets (Settings → Styles) hold your own standing instructions for how
drafted items should be written, such as statement layout, tone or starter
languages. One preset can be the default.

## Connecting an MCP client

The MCP endpoint is `http://localhost:8080/mcp` (Streamable HTTP).

```sh
claude mcp add --transport http codeatrophy http://localhost:8080/mcp
```

Clients that only speak stdio can bridge with
`npx mcp-remote http://localhost:8080/mcp`. If you set `CODEATROPHY_MCP_TOKEN`,
configure the client to send `Authorization: Bearer <token>`.

Over MCP the connected assistant does the writing; the server stores items,
searches, and runs code to verify test cases. No AI provider needs to be
configured for this. See [`docs/mcp.md`](docs/mcp.md) for the tools and
prompts.

## Backup and restore

All state lives in the `codeatrophy-data` volume: the SQLite database
(`codeatrophy.db` with its `-wal`/`-shm` files) and, unless you set
`CODEATROPHY_SECRET_KEY`, the generated `secret.key`.

```sh
# Back up (stop the app so the database files are consistent)
docker compose stop app
docker run --rm -v codeatrophy_codeatrophy-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/codeatrophy-backup.tgz -C /data .
docker compose start app

# Restore
docker compose stop app
docker run --rm -v codeatrophy_codeatrophy-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/codeatrophy-backup.tgz -C /data'
docker compose start app
```

Keep `secret.key` (or your `CODEATROPHY_SECRET_KEY`) with the backup: without
it, stored API keys cannot be decrypted and must be entered again. Everything
else is readable without it.

For moving content between instances, use bundles (Export / Import in the UI)
instead; they carry content only, not your progress, notes or settings.

## Security

- **No authentication.** Codeatrophy is a single-user app without login. The
  Compose file publishes it on `127.0.0.1` only. Anyone who can reach the port
  can read and change the library and run code on the judge. To expose it
  beyond the local machine, put it behind a reverse proxy that authenticates,
  and set `CODEATROPHY_PUBLIC_URL` to the public URL (its origin is then
  allowed to make changes, and MCP clients are told the endpoint's URL).
  AI requests and verification runs can take minutes: raise the proxy's read
  timeout to at least five minutes for `/api/v1/ai/` and `/api/v1/items/*/ai/`,
  and leave `/mcp` unbuffered with a long timeout, since it streams.
- **Host names it answers to (DNS rebinding).** The API and `/mcp` answer
  only to requests whose `Host` is `localhost` or a loopback address, the host
  of `CODEATROPHY_PUBLIC_URL`, the host of an allowed origin, or a host listed
  in `CODEATROPHY_ALLOWED_HOSTS`; anything else gets `403`. This stops a web
  page whose DNS name has been re-pointed at your machine from using the app.
  To reach the app from other machines on your network (after setting
  `CODEATROPHY_BIND_ADDRESS`), set `CODEATROPHY_PUBLIC_URL` to the URL you
  use, or list the name or address in `CODEATROPHY_ALLOWED_HOSTS`, for
  example `CODEATROPHY_ALLOWED_HOSTS=192.168.1.20,nas.local`. The port does
  not matter, so remapping `CODEATROPHY_HOST_PORT` needs no change.
- **Cross-site requests.** State-changing requests from web pages on other
  origins are rejected, on the API and on `/mcp`: only loopback origins and
  the configured ones (`CODEATROPHY_PUBLIC_URL`, `CODEATROPHY_ALLOWED_ORIGINS`,
  `CODEATROPHY_MCP_ALLOWED_ORIGINS`, and origins on an allowed host) may make
  changes. Set `CODEATROPHY_MCP_TOKEN` before making `/mcp` reachable from
  other machines.
- **API keys stay with their provider.** A stored key is bound to the origin
  of the base URL it was saved for. Pointing a provider at another base URL
  without entering a new key deletes the stored key, and a connection test
  against another URL never sends a stored key.
- **The judge runs untrusted code.** Judge0's sandbox (isolate) requires its
  worker container to run `privileged`. The Judge0 containers sit on an
  internal network without internet access, and submissions run without
  network. Treat the host accordingly.
- **cgroup v2 hosts.** Judge0 1.13's sandbox can only use control groups on
  cgroup v1, which most current distributions no longer provide. Codeatrophy
  therefore asks Judge0 for per-process limits by default
  (`CODEATROPHY_JUDGE0_CGROUPS=false`). In this mode:
  - the memory limit is an address-space limit. Runtimes that reserve large
    virtual ranges get an extra allowance (64 MB for C, C++, Rust and Python;
    128 MB for Go, Ruby and C#; 768 MB for JavaScript and TypeScript; 512 MB
    above the Java/Kotlin heap). For C, C++, Rust, Python, Go and Ruby the
    problem's limit is then enforced on the program's peak resident memory;
    Java and Kotlin run with `-Xmx` set to the limit; for C#, JavaScript and
    TypeScript the limit is approximate.
  - a running program is stopped by the wall-clock limit (about one second
    above the time limit); CPU time is checked when it exits.
  - memory-limit verdicts are recognised from the runtime's allocation error
    (`MemoryError`, `std::bad_alloc`, `OutOfMemoryError`, ...) or from the
    peak memory, since Judge0 reports no memory-limit status.
  On a cgroup v1 host you can set `CODEATROPHY_JUDGE0_CGROUPS=true` for
  Judge0's cgroup accounting instead.
- **AI input.** Generated drafts are never saved without your review, model
  output is schema-checked, and text you paste is passed to the model as data,
  not instructions.

## Development

Layout: `cmd/` and `internal/` hold the Go server, `web/` the React UI,
`docs/` the design documents. Start with
[`docs/architecture.md`](docs/architecture.md); the HTTP API in
[`docs/api.md`](docs/api.md) is the contract between server and UI.

```sh
make help          # all targets
make test          # Go tests
make lint          # go vet, gofmt check, UI lint and type check
make web-dev-mock  # UI dev server with an in-memory API mock
make run           # server on :8080 with data in ./data
make build         # UI + server binary with the UI embedded (bin/codeatrophy)
make up            # the whole Compose stack
```

The Makefile uses Go and npm from your machine when they are installed and
otherwise runs them in the official Docker images, so Docker alone is enough.
A server binary built without the UI (`make build-server`, or plain
`go build ./...`) serves a placeholder page; the Docker image always
contains the UI.

## License

Copyright (C) 2026 Yohanes Alfredo Phoa

Codeatrophy is licensed under the GNU Affero General Public License v3.0 only
(SPDX: `AGPL-3.0-only`); see [`LICENSE`](LICENSE). In plain terms: if you run a
modified version as a network service, you must offer its source code to that
service's users.

Judge0 is separate software under its own license (GPL-3.0). Codeatrophy runs
it as an independent service, reached over HTTP; none of its code is included
in this project.
