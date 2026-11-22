# Signing in

This document covers signing in to the web UI and the API: the first
account, sessions, accounts, turning sign-in off, and tokens for MCP.

Sign-in is on by default. The web UI shows a sign-in page, and every API
request needs a session, except the health checks (`/api/v1/health` and
`/api/v1/health/ready`). Uptime monitors should poll `/api/v1/health/ready`,
which also checks the database.

- **First account.** While no account exists, the sign-in page offers to
  create one with an email and password. Whoever gets there first creates
  it, so do it right after the first start, or create it on the server
  instead with `codeatrophy user add`. Once an account exists, the page only
  signs in.
- **Staying signed in.** A sign-in lasts `CODEATROPHY_SESSION_TTL` (30 days)
  and is renewed as you use the app, so you are asked again only after that
  long away. Sign out from the sidebar or Settings → Account, where you can
  also change your password (which signs out your other browsers).
- **Accounts on the command line.** Accounts share one library. Each keeps
  its own progress (status, favorites, notes), collections, code,
  submissions, drafts, AI history and preferences, and deleting an account
  deletes those.

  ```sh
  docker compose exec app codeatrophy user list
  docker compose exec app codeatrophy user add someone@example.com
  docker compose exec app codeatrophy user password you@example.com
  docker compose exec app codeatrophy user delete someone@example.com
  ```

  `add` and `password` ask for the password on a terminal (add `-it` if
  Compose does not give one) or read it from the first line of standard
  input.
- **Forgotten password.** There is no reset by email. Whoever runs the
  server sets a new password on the command line, which also signs that
  account out everywhere:

  ```sh
  docker compose exec app codeatrophy user password you@example.com
  ```

  Without Compose, run `codeatrophy user password you@example.com` with the
  server's environment.
- **Turning it off.** Set `CODEATROPHY_AUTH=off` to skip sign-in entirely,
  for example on a machine only you use, or behind a reverse proxy that
  already authenticates. Anyone who can reach the port can then use the app,
  as before sign-in existed, and it keeps the progress of the oldest
  account (or of none, until one is created). The server logs a warning at
  startup.
- **MCP.** Assistants cannot sign in with a password, so while sign-in is on
  `/mcp` needs a bearer token: make one per machine or assistant under
  Settings → MCP server → Tokens (shown once, with the command that
  connects Claude Code), and revoke it there. `CODEATROPHY_MCP_TOKEN` adds a
  server-wide token for unattended setups. With sign-in off that is the only
  token, and optional.

Passwords are stored as bcrypt hashes. The session cookie is `HttpOnly` and
`SameSite=Strict`, and `Secure` over HTTPS (also behind a proxy that sends
`X-Forwarded-Proto: https`); the server keeps only a hash of it. Changes
must come from the app's own pages (a cross-origin check). Each client
gets 10 failed sign-ins per 15 minutes, and a browser that has signed in
before has a count of its own, so someone guessing passwords cannot keep
you out of a browser you use. Behind a reverse proxy every client has the
proxy's address; set `CODEATROPHY_TRUSTED_PROXIES` to the proxy's address
so that the server reads each client's own from `X-Forwarded-For`. To
check it, set `CODEATROPHY_ACCESS_LOG=on` and look at the `client` of each
request in the log; a peer that sends `X-Forwarded-For` without being
listed also gets a warning there.
