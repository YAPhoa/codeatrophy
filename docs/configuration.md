# Configuration

This document covers the environment variables most installations set,
the AI providers and the style presets.

Everything is configured with environment variables, all documented in
[`.env.example`](../.env.example). The most common ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEATROPHY_HOST_PORT` | `8484` | Port on the host |
| `CODEATROPHY_BIND_ADDRESS` | `127.0.0.1` | Host address to publish on |
| `CODEATROPHY_PUBLIC_URL` | unset | URL the instance is reached at, when not `localhost` |
| `CODEATROPHY_ALLOWED_HOSTS` | unset | Extra host names or addresses the server answers to (see [Security](security.md)) |
| `CODEATROPHY_JUDGE_ENGINE` | `judge0` in `.env.example` | `judge0` or `none` |
| `CODEATROPHY_SECRET_KEY` | generated | Key that encrypts stored API keys |
| `CODEATROPHY_DATABASE_URL` | the Compose `db` service | PostgreSQL URL; empty for SQLite (see [Storage](storage.md)) |
| `CODEATROPHY_POSTGRES_PASSWORD` | `codeatrophy-postgres` | Password of the Compose database; change it before the first start |
| `CODEATROPHY_DB_AUTO_MIGRATE` | `on` | Apply schema migrations at startup; `off` leaves them to `db migrate` (see [Upgrading](storage.md#upgrading)) |
| `CODEATROPHY_AI_PROVIDER` | unset | Initial default AI provider: the environment provider of `anthropic`, `gemini` or `openai_compatible` |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` | unset | Keys of the environment providers, for unattended setups |
| `CODEATROPHY_AI_BLOCK_PRIVATE` | `false` | Also refuse loopback and private addresses as AI provider base URLs (see [Security](security.md)) |
| `CODEATROPHY_AI_ALLOWED_HOSTS` | unset | Host names, addresses or CIDR prefixes AI providers may reach whatever the rules say |
| `CODEATROPHY_AUTH` | `on` | Require signing in to the web UI and API; `off` skips it (see [Signing in](signing-in.md)) |
| `CODEATROPHY_SESSION_TTL` | `720h` | How long a sign-in lasts without being used |
| `CODEATROPHY_TRUSTED_PROXIES` | unset | Addresses or CIDR prefixes of reverse proxies whose `X-Forwarded-For` is believed (see [Signing in](signing-in.md)) |
| `CODEATROPHY_MCP_TOKEN` | unset | Server-wide bearer token for `/mcp`, besides the per-account tokens made in the UI |
| `CODEATROPHY_LOG_LEVEL`, `CODEATROPHY_LOG_FORMAT` | `info`, `text` | Log level (`debug`, `info`, `warn`, `error`) and format (`text`, `json`) |
| `CODEATROPHY_ACCESS_LOG` | `off` | Log every request (method, path, status, client) at info instead of debug |

A variable that turns something on or off takes `on`/`off`, `true`/`false`,
`yes`/`no`, `1`/`0` or `t`/`f`, in any case.

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
