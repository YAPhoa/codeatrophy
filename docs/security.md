# Security

This document covers what protects an instance and what to set before
it is reached from other machines: sign-in, host and origin checks, AI
provider keys and addresses, and the judge's sandbox.

- **Sign-in.** The web UI and the API need a signed-in session, and `/mcp`
  a bearer token (see [Signing in](signing-in.md)). The Compose file still
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
  against another URL never sends a stored key. A provider that redirects
  to another origin is not followed, so the key does not travel with the
  redirect.
- **Addresses AI providers may reach.** A provider's base URL is chosen in
  the settings, so the server refuses to connect to cloud metadata and
  other link-local addresses (such as `169.254.169.254`, where a cloud VPS
  hands out its credentials). Loopback and private addresses stay
  reachable, so a model server on the same machine or your network
  (Ollama, LM Studio) works without setup. When people you don't fully
  trust have accounts, set `CODEATROPHY_AI_BLOCK_PRIVATE=true` to refuse
  loopback and private addresses too, and list the model servers they may
  use in `CODEATROPHY_AI_ALLOWED_HOSTS`, for example
  `CODEATROPHY_AI_ALLOWED_HOSTS=ollama,192.168.1.30`.
- **The judge runs untrusted code.** Judge0's sandbox (isolate) requires its
  worker container to run `privileged`. The Judge0 containers sit on an
  internal network without internet access, and submissions run without
  network. Treat the host accordingly. Judge0 keeps no copy of what it ran:
  the app deletes each submission there once it has read the result.
  The sandbox limits each process, so the worker container as a whole is
  capped at 4 GB of memory and 1024 processes, and a program that forks
  cannot use up the host's memory and take the database down with it. Raise
  `JUDGE0_WORKERS_MEMORY` (and `JUDGE0_WORKERS_PIDS`) if you raise
  `JUDGE0_WORKER_COUNT` or set problems near the 2 GiB memory maximum;
  `JUDGE0_WORKERS_CPUS` caps CPU, which is not capped by default.
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
