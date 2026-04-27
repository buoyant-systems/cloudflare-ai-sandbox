# cloudflare-ai-sandbox

A customised fork of the [Cloudflare Sandbox Bridge](https://github.com/cloudflare/sandbox-sdk/tree/main/bridge) — a Cloudflare Worker that creates on-demand sandboxed execution environments backed by [Cloudflare Containers](https://developers.cloudflare.com/containers/). It wraps the [`@cloudflare/sandbox`](https://www.npmjs.com/package/@cloudflare/sandbox) SDK and exposes the full sandbox API over HTTP.

## What changed from upstream

This fork strips the warm-pool machinery and adds first-class private Git operations with ephemeral credential injection.

| Area | Upstream (`cloudflare/sandbox-sdk`) | This fork |
| --- | --- | --- |
| **Warm pool** | `WarmPool` Durable Object, cron triggers, `WARM_POOL_TARGET` / `WARM_POOL_REFRESH_INTERVAL` vars | Fully removed — containers are created on-demand only |
| **DO migrations** | Two migrations (`Sandbox` v1, `WarmPool` v2) | Single migration (`Sandbox` v1) |
| **Cron triggers** | `* * * * *` cron to prime the pool | Removed |
| **Git endpoints** | None | `POST /v1/sandbox/:id/git/{clone,pull,push,fetch}` with ephemeral credential helpers — tokens are never written to disk |
| **Worker name** | `cloudflare-sandbox-bridge` | `cloudflare-ai-sandbox` |
| **Sandbox base image** | `cloudflare/sandbox:0.9.0` | `cloudflare/sandbox:0.8.11` |
| **Scheduled handler** | `bridge({ scheduled })` | Removed — `bridge()` only uses `fetch` |
| **Test suite** | Upstream tests | New: `git.test.ts`, `resolveWorkspacePath.test.ts`, `shellQuote.test.ts` alongside existing bridge tests |

## Repository layout

| Directory | Description |
| --- | --- |
| [`worker/`](./worker/) | Deployable Cloudflare Worker — the bridge itself |
| [`examples/`](./examples/) | Demo applications (basic CLI agent, workspace chat) |
| [`harness/`](./harness/) | Stress-testing and integration harness |
| [`script/`](./script/) | Development scripts |

## Quick start

```sh
cd worker
npm ci
cp .dev.vars.example .dev.vars    # set SANDBOX_API_KEY
npm run dev                        # http://localhost:8787
```

### Deploy

```sh
cd worker
npm ci
npx wrangler login
npx wrangler secret put SANDBOX_API_KEY   # paste output of: openssl rand -hex 32
npx wrangler deploy
```

Verify:

```sh
curl https://<your-worker>.workers.dev/health
```

## API surface

The worker exposes the full [`BaseSandboxSession`](https://developers.cloudflare.com/sandbox/) interface as HTTP routes, plus the custom Git endpoints added by this fork.

### Core routes (from `@cloudflare/sandbox/bridge`)

| Route | Method | Description |
| --- | --- | --- |
| `/health` | GET | Unauthenticated liveness probe |
| `/v1/sandbox` | POST | Create a new sandbox session |
| `/v1/sandbox/:id/exec` | POST | Execute a command (returns stdout/stderr/exit code) |
| `/v1/sandbox/:id/read` | POST | Read a file from the workspace |
| `/v1/sandbox/:id/write` | POST | Write a file into the workspace |
| `/v1/sandbox/:id/running` | GET | Check sandbox liveness |
| `/v1/sandbox/:id/persist` | POST | Serialize workspace to a tar archive |
| `/v1/sandbox/:id/hydrate` | POST | Populate workspace from a tar archive |
| `/v1/sandbox/:id` | DELETE | Destroy the sandbox (returns 204) |
| `/v1/sandbox/:id/pty` | GET | WebSocket PTY proxy |
| `/v1/sandbox/:id/mount` | POST | Mount an S3-compatible bucket |
| `/v1/sandbox/:id/unmount` | POST | Unmount a mounted bucket |
| `/v1/sandbox/:id/session` | POST | Create an execution session |
| `/v1/sandbox/:id/session/:sid` | DELETE | Delete an execution session |
| `/v1/openapi.json` | GET | OpenAPI 3.1 schema |
| `/v1/openapi.html` | GET | Interactive API explorer |

### Git routes (added by this fork)

All Git routes authenticate with the same `Authorization: Bearer <SANDBOX_API_KEY>` header as core routes.

| Route | Description |
| --- | --- |
| `POST /v1/sandbox/:id/git/clone` | Clone a private repo into the sandbox |
| `POST /v1/sandbox/:id/git/pull` | Pull from a remote |
| `POST /v1/sandbox/:id/git/push` | Push to a remote |
| `POST /v1/sandbox/:id/git/fetch` | Fetch refs without merging |

#### Security model

Credentials are **never written to disk**. Each operation injects the token via an inline Git credential helper (`git -c credential.helper='!f() { ... }; f'`), which is scoped to the lifetime of the `git` process. After the process exits, no trace of the token remains in `.git/config`, the reflog, environment variables, or credential stores. All error output is sanitized to strip the token before being returned to the caller.

All destination paths are validated to resolve within `/workspace`, preventing path-traversal attacks.

#### Example — clone a private repository

```sh
curl -X POST http://localhost:8787/v1/sandbox/$ID/git/clone \
  -H "Authorization: Bearer $SANDBOX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://github.com/org/private-repo.git", "token": "ghp_xxxx"}'
```

```json
{ "ok": true, "path": "/workspace/private-repo" }
```

See [`worker/README.md`](./worker/README.md) for the full API reference, request/response schemas, and security documentation.

## Container image

[`worker/Dockerfile`](./worker/Dockerfile) extends `docker.io/cloudflare/sandbox:0.8.11` and pre-installs:

- **git** — version control (also required by the Git endpoints)
- **ripgrep** (`rg`) — fast text/file search
- **curl**, **wget** — HTTP fetching
- **jq** — JSON processing
- **procps** — process management (`ps`, `pkill`)
- **sed**, **gawk** — text processing
- **uv + Python 3.13** — Python package management and runtime

A non-root `sandbox` user is created for defense-in-depth; all commands run as this user.

## Examples

- **[`examples/basic/`](./examples/basic/)** — One-shot coding agent that executes a task and copies output files to the host. Supports `--image` for visual references.
- **[`examples/workspace-chat/`](./examples/workspace-chat/)** — Full-stack chat UI with a persistent sandboxed filesystem, file browser sidebar, drag-and-drop uploads, and inline HTML previews.

## Development

```sh
cd worker
npm ci
npm run dev          # start local dev server
npm run test         # run unit tests
npm run typecheck    # type-check without emitting
```

## Upstream

This project is forked from [`cloudflare/sandbox-sdk` → `bridge/`](https://github.com/cloudflare/sandbox-sdk/tree/main/bridge). To pull in upstream changes, cherry-pick or diff against that directory.
