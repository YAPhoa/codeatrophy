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

The first visit asks you to create your account. It needs the one-time setup
code the server prints in its log while no account exists:

```sh
docker compose logs app | grep setupCode
```

Enter it with the email and password you want to sign in with. A sign-in
lasts 30 days from the last time you used the app in that browser. See
[Signing in](#signing-in) to turn sign-in off or manage accounts.

To stop: `docker compose down` (your data stays in the `codeatrophy-db` and
`codeatrophy-data` volumes).

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
| `CODEATROPHY_DATABASE_URL` | the Compose `db` service | PostgreSQL URL; empty for SQLite (see [Storage](#storage)) |
| `CODEATROPHY_POSTGRES_PASSWORD` | `codeatrophy-postgres` | Password of the Compose database; change it before the first start |
| `CODEATROPHY_DB_AUTO_MIGRATE` | `on` | Apply schema migrations at startup; `off` leaves them to `db migrate` (see [Upgrading](#upgrading)) |
| `CODEATROPHY_AI_PROVIDER` | unset | Initial default AI provider: the environment provider of `anthropic`, `gemini` or `openai_compatible` |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` | unset | Keys of the environment providers, for unattended setups |
| `CODEATROPHY_AUTH` | `on` | Require signing in to the web UI and API; `off` skips it (see [Signing in](#signing-in)) |
| `CODEATROPHY_SESSION_TTL` | `720h` | How long a sign-in lasts without being used |
| `CODEATROPHY_MCP_TOKEN` | unset | Bearer token for `/mcp`; required while sign-in is on |

AI providers are normally set up in the UI under Settings. You can keep
several, such as a work key, a personal one and a local model server, and
choose one as the default the AI features use. For each, enter the key, test
the connection, pick a model from the list the service reports, and save.
Keys entered there are stored encrypted (AES-256-GCM) and are never shown
again, logged, exported or exposed over MCP. Environment variables (see
`.env.example`) add a read-only provider per kind for unattended setups;
they do not change the providers saved in the UI.

With Anthropic, the default model is `claude-opus-5-5`. For models that
support it, requests to the Anthropic API ask for the server-side refusal
fallback, so a request declined by the model's safety classifiers is answered
by a fallback model instead of failing.

Style presets (Settings → Styles) hold your own standing instructions for how
drafted items should be written, such as statement layout, tone or starter
languages. One preset can be the default. A new instance starts with three
built-in presets (Interview practice, the default; Contest style; Study
notes), which you can edit or delete like your own; deleted ones do not come
back.

## Signing in

Sign-in is on by default. The web UI shows a sign-in page, and every API
request needs a session, except the health check (`/api/v1/health`).

- **First account.** While no account exists, the server logs a setup code
  at startup (`setupCode=XXXX-XXXX-XXXX-XXXX`) and the UI asks for it with
  the email and password of the first account. Without the code nobody who
  merely reaches the server first can claim it. A new code is printed on
  every start until the account exists.
- **Staying signed in.** A sign-in lasts `CODEATROPHY_SESSION_TTL` (30 days)
  and is renewed as you use the app, so you are asked again only after that
  long away. Sign out from the sidebar or Settings → Account, where you can
  also change your password (which signs out your other browsers).
- **Accounts on the command line.** Every account sees the same library.

  ```sh
  docker compose exec app codeatrophy user list
  docker compose exec app codeatrophy user add someone@example.com
  docker compose exec app codeatrophy user password you@example.com   # forgotten password
  docker compose exec app codeatrophy user delete someone@example.com
  ```

  `add` and `password` ask for the password on a terminal (add `-it` if
  Compose does not give one) or read it from the first line of standard
  input.
- **Turning it off.** Set `CODEATROPHY_AUTH=off` to skip sign-in entirely,
  for example on a machine only you use, or behind a reverse proxy that
  already authenticates. Anyone who can reach the port can then use the app,
  as before sign-in existed. The server logs a warning at startup.
- **MCP.** Assistants cannot sign in with a password, so while sign-in is on
  `/mcp` requires `CODEATROPHY_MCP_TOKEN` and refuses every request until it
  is set. With sign-in off the token stays optional.

Passwords are stored as bcrypt hashes. The session cookie is `HttpOnly` and
`SameSite=Strict`, and `Secure` over HTTPS (also behind a proxy that sends
`X-Forwarded-Proto: https`); the server keeps only a hash of it. Changes
must come from the app's own pages (a cross-origin check), and each address
gets 10 failed sign-ins per 15 minutes. Behind a reverse proxy all clients
share the proxy's address and so that limit.

## Connecting an MCP client

The MCP endpoint is `http://localhost:8080/mcp` (Streamable HTTP).

```sh
claude mcp add --transport http codeatrophy http://localhost:8080/mcp
```

Clients that only speak stdio can bridge with
`npx mcp-remote http://localhost:8080/mcp`. While sign-in is on, set
`CODEATROPHY_MCP_TOKEN` on the server (`openssl rand -hex 32` makes one) and
configure the client to send `Authorization: Bearer <token>`, for example
`claude mcp add --transport http codeatrophy http://localhost:8080/mcp --header "Authorization: Bearer <token>"`.

Over MCP the connected assistant does the writing; the server stores items,
searches, and runs code to verify test cases. No AI provider needs to be
configured for this. See [`docs/mcp.md`](docs/mcp.md) for the tools and
prompts.

## Storage

The Compose stack keeps the library in PostgreSQL, in its own `db` service
(`postgres:18.7-alpine`, volume `codeatrophy-db`), reachable only from the app and
never published to the host. The `codeatrophy-data` volume is still needed:
it holds `secret.key`, which encrypts stored API keys.

**SQLite instead.** Set `CODEATROPHY_DATABASE_URL=` (empty) in `.env` and the
app keeps the library in `/data/codeatrophy.db` in the `codeatrophy-data`
volume. The `db` container then has nothing to do; start the stack with
`docker compose up -d --scale db=0` to leave it out. A server binary run on
its own uses SQLite unless `CODEATROPHY_DATABASE_URL` is set.

Both backends behave the same, search included (same matching rules, same
relevance order). Searching PostgreSQL reads every item's index entry, which
is quick for a personal library of thousands of items.

### Upgrading

1. **Back up first** (see [Backup and restore](#backup-and-restore)):
   `pg_dump` for PostgreSQL, or the `codeatrophy-data` volume for SQLite.
2. Pull, then `docker compose up -d --build`. By default the server applies
   pending schema migrations at startup and logs each one. Before migrating
   a SQLite database it also writes a copy next to it, named after the
   version it was at (`codeatrophy.db.backup-v5-<time>`), and keeps the
   three newest; PostgreSQL gets no automatic backup.

**Judge0's database on PostgreSQL 18.** Judge0's database moved to a new
volume, `judge0-db-18`, and starts empty (it holds nothing the app needs).
The old `judge0-db` volume is no longer used; remove it with
`docker volume rm codeatrophy_judge0-db`.

**Migrating by hand.** With `CODEATROPHY_DB_AUTO_MIGRATE=off` the server
never changes the schema: on a database behind its version (or without a
schema) it stops with a message naming both versions. Then run

```sh
docker compose build app
docker compose stop app
docker compose run --rm app db migrate   # lists what is pending, then applies it
docker compose up -d
```

`db migrate` always migrates, whatever the setting, and says "nothing to do"
when the database is current. In this mode the automatic SQLite import below
does not run either: the server stops and says to run `db copy` instead.

**Rehearsing.** Try the upgrade on a copy first. While the old version still
runs, copy the library with the old binary, then migrate the copy with the
new one. With SQLite the copy is a file next to the database:

```sh
docker compose exec app codeatrophy db copy --from configured --to /data/rehearsal.db
docker compose build app
docker compose run --rm app db migrate --db /data/rehearsal.db
docker compose run --rm app db status --db /data/rehearsal.db
```

With PostgreSQL, rehearse on a scratch database in the same server
(`createdb -U codeatrophy rehearsal` in the `db` service, then use
`postgres://codeatrophy:<password>@db:5432/rehearsal?sslmode=disable` in place
of `/data/rehearsal.db`, and `dropdb` it afterwards). The copy has to be made
by the old version, because `db copy` first brings its source to its own
binary's schema; the new version would migrate your real database. Remove
the rehearsal copy when done.

**Forward only.** The schema only moves forward. A server older than the
database refuses to start ("this database was last used by a newer
Codeatrophy; upgrade the server") and changes nothing. To roll back, restore
the backup from step 1 and start the old version.

**Coming from SQLite.** Installs from before PostgreSQL have their library
in `codeatrophy.db` in the `codeatrophy-data` volume. On the first start
after the upgrade, the server finds the new PostgreSQL database empty,
copies the SQLite database into it, checks every table's row count, and
renames the file to `codeatrophy.db.migrated-<UTC time>`, which stays as a
backup. The log says what was imported. If the import fails, nothing is
imported, the file stays where it is, and the server stops with the reason;
set `CODEATROPHY_DATABASE_URL=` to keep running on SQLite meanwhile. Once
PostgreSQL holds a library, a SQLite file is never imported over it (the log
says so). `CODEATROPHY_SQLITE_IMPORT=off` turns the import off.

### Database commands

The server binary also inspects, migrates and copies databases, without the
server having to run: `docker compose run --rm app db …` runs it in a one-off
container with the app's configuration and volumes. A database is a SQLite
file path or a `postgres://` URL; `configured` (in `copy`) and the default
(in `status` and `migrate`) mean the configured one, which keeps its password
off the command line.

```sh
docker compose run --rm app db status     # backend, schema version, pending migrations, row counts
docker compose run --rm app db migrate    # list and apply pending migrations, then exit
docker compose run --rm app db copy --from <database> --to <database> [--replace]
```

`db copy` copies everything (settings, AI providers, style presets, items,
collections, test cases, solutions, submissions) with ids, timestamps and
order unchanged, in one transaction, in either direction. It refuses a
destination that already holds a library unless `--replace` is given, which
deletes that library first, and it refuses to copy a database onto itself.
Stop the app (`docker compose stop app`) before copying into the database
it uses. Stored API keys are copied encrypted, so the destination needs the
same `secret.key` (or `CODEATROPHY_SECRET_KEY`).

### Switching backends

- *SQLite to PostgreSQL:* point `CODEATROPHY_DATABASE_URL` at an empty
  PostgreSQL database and start; the import above does the rest.
- *PostgreSQL to SQLite:* copy the library into a file, then switch:

  ```sh
  docker compose run --rm app db copy --from configured --to /data/codeatrophy.db --replace
  # then set CODEATROPHY_DATABASE_URL= in .env and
  docker compose up -d
  ```

  (`--replace` overwrites a SQLite file that is already there. If the
  PostgreSQL database still holds the library, a later switch back to it
  ignores the file and keeps the PostgreSQL data.)

## Backup and restore

Back up the database and the secret key: `secret.key` in the
`codeatrophy-data` volume, unless you set `CODEATROPHY_SECRET_KEY`. Without
it, stored API keys cannot be decrypted and must be entered again;
everything else is readable without it.

**PostgreSQL** (the Compose default):

```sh
# Back up the database, and the data volume for secret.key
docker compose exec -T db pg_dump -U codeatrophy -d codeatrophy --format=custom > codeatrophy.dump
docker run --rm -v codeatrophy_codeatrophy-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/codeatrophy-data.tgz -C /data .

# Restore the database (into the running db service; the app is stopped)
docker compose stop app
docker compose exec -T db pg_restore -U codeatrophy -d codeatrophy --clean --if-exists < codeatrophy.dump
docker compose start app
```

**SQLite:** all state is in the `codeatrophy-data` volume (`codeatrophy.db`
with its `-wal`/`-shm` files, and `secret.key`).

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

`codeatrophy db copy` into a SQLite file is a backend-neutral backup too.
For moving content between instances, use bundles (Settings → Export / Import)
instead; they carry content only, not your progress, notes or settings. A
bundle that holds a solution-only problem uses bundle format version 2,
which an older Codeatrophy refuses to import; upgrade it first.

## Security

- **Sign-in.** The web UI and the API need a signed-in session, and `/mcp`
  a bearer token (see [Signing in](#signing-in)). The Compose file still
  publishes the app on `127.0.0.1` only. To expose it beyond the local
  machine, serve it over HTTPS (a reverse proxy such as Nginx Proxy Manager
  or Caddy), keep sign-in on, and set `CODEATROPHY_PUBLIC_URL` to the public
  URL (its origin is then allowed to make changes, and MCP clients are told
  the endpoint's URL). With `CODEATROPHY_AUTH=off` anyone who can reach the
  port can read and change the library and run code on the judge.
  AI generations run in the background, but verification runs, bundle
  transfers and connection tests can take minutes: raise the proxy's read
  timeout to at least six minutes for `/api/v1/items/check`,
  `/api/v1/items/*/testcases/verify`, `/api/v1/export`, `/api/v1/import*`,
  `/api/v1/settings/ai/test` and `/api/v1/settings/ai/models`, and leave
  `/mcp` unbuffered with a long timeout, since it streams.
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
  network. Treat the host accordingly. Judge0 keeps no copy of what it ran:
  the app deletes each submission there once it has read the result.
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
  - a Java or Kotlin program — the source, or for a solution-only problem the
    runner code with the solution — may be at most 10 MiB (Judge0's
    `MAX_EXTRACT_SIZE`); a larger one is refused with a validation error.
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
make test          # Go tests (SQLite)
make test-postgres # Go tests on PostgreSQL, against a throwaway server in Docker
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
