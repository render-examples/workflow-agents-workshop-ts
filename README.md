# Render Workflow Agents Workshop

A hands-on workshop that deploys **one agentic code-review use case** across
**three Render execution substrates**: an in-process web service, a web service
plus queue-backed worker, and Render Workflows.

You deploy the same multi-agent PR reviewer (`security`, `performance`, `ux`, then
a `judge`) across progressively more durable execution models. Along the way, you
open live Render URLs, inspect logs and traces in the Dashboard, and use local
development for focused test loops.

For someone facilitating this workshop, start with [`workshop/facilitator-guide.md`](workshop/facilitator-guide.md).

## The three patterns

| Pattern | Package | Substrate | Render primitives | You own |
| --- | --- | --- | --- | --- |
| **1. Naive** | [`packages/naive-agent`](packages/naive-agent) | Agent runs in-process, inside the web request | Web Service + Postgres | Nothing, but no scale or durability |
| **2. Queue** | [`packages/queue-agents`](packages/queue-agents) | Thin producer + background worker over a Valkey queue | Web Service + Background Worker + Key Value + Postgres | The queue, consumer group, acks, retries, and pub/sub |
| **3. Workflows** | [`packages/workflow-agents`](packages/workflow-agents) | Each agent is a Render `task()` in its own container | Web Service + Workflows + Postgres | Nothing. Render does the coordination |

The agent code lives in the shared [`@workshop/agent`](shared/agent) package. The substrate decides how it is invoked.

## Start here

Before you begin, make sure you have:

- A Render account
- A fork or writable copy of this repo on GitHub, GitLab, or Bitbucket
- The Render CLI, for Workflow operations and deploy/log checks
- Node.js >= 22.12, for local tests and fallback runs

Install dependencies from the repo root:

```sh
npm install
```

The apps run without an LLM API key. With no key set, [`@workshop/agent`](shared/agent)
uses a deterministic **mock** model, so live deploys and local tests still work.
Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for real reviews, or force the mock
with `AGENT_MODEL=mock`.

## Workshop path

Patterns 1 and 2 use Blueprints:

- [`packages/naive-agent/render.yaml`](packages/naive-agent/render.yaml) — Web Service + Postgres
- [`packages/queue-agents/render.yaml`](packages/queue-agents/render.yaml) — Web Service + Background Worker + Key Value + Postgres

Each Blueprint creates its own Render project with a `production` environment, so
the services and datastores for each pattern stay grouped in the Dashboard.

Pattern 3 uses both:

- [`packages/workflow-agents/render.yaml`](packages/workflow-agents/render.yaml) creates the web service and Postgres database
- `render workflows create` creates the Workflow service
- `render workflows start` triggers task runs
- `render logs`, `render deploys`, and the Dashboard help learners inspect what ran

## Interactive beats

- **Session 1 — inspect the coordination.** In queue-agents, learners trace the ack
  contract in [`packages/queue-agents/src/kv.ts`](packages/queue-agents/src/kv.ts),
  run the focused test with `npm run test:worker`, scale the worker, and observe
  what they now own.
- **Session 2 — let agents author tasks.** In workflow-agents, learners explore the
  `your-review` sandbox and work with the small `task()` API surface. The same
  durability that took a whole queue in Session 1 is now a config object, a live
  task run, and a Dashboard trace.

## Local development

Local runs are useful for tests, facilitator prep, and debugging.

For local runs, copy the example env file:

```sh
cp .env.example .env
```

Local services need only what each pattern uses:

```sh
createdb agents_workshop        # Postgres: naive-agent and queue-agents
valkey-server &                 # Valkey: queue-agents only
```

Run any pattern on the host:

```sh
# Pattern 1: in-process
npm run naive:dev               # http://localhost:3000

# Pattern 2: producer + worker
npm run queue:web               # terminal A: http://localhost:3000
npm run queue:worker            # terminal B: one worker
npm run queue:worker            # terminal C: another worker

# Pattern 3: Render Workflows
npm run dev --workspace @workshop/workflow-agents            # in-process local mode
npm run dev:workflows --workspace @workshop/workflow-agents  # full local Workflows runtime
```

Open `http://localhost:3000/` for the shared telemetry viewer, paste a public PR
URL, and watch the review run with per-agent findings and spans.

## Repository structure

Start with the pattern you care about, then follow the shared core the patterns
all import.

```
packages/
  naive-agent/              Pattern 1: in-process web service (Hono)
                              → src/server.ts         POST /api/reviews; composes pipeline inline (blocking)
                              → render.yaml             single-service Blueprint

  queue-agents/             Pattern 2: producer web + background worker (Valkey)
                              → src/web.ts              enqueue jobs, stream SSE progress
                              → src/worker.ts           consume the queue, compose pipeline inline (background)
                              → src/kv.ts               Valkey stream + pub/sub wiring

  workflow-agents/          Pattern 3: Render Workflows gateway + workflow service
                              → src/server.ts           dispatch workflows
                              → src/workflows/code-review/index.ts   the finished pipeline as tasks
                              → src/workflows/your-review/index.ts   sandbox for the hands-on finale

shared/
  agent/                    @workshop/agent — LLM loop, agents, composable review building blocks
                              → src/review.ts           review types + re-exports
                              → src/agents.ts           security, performance, ux, judge definitions
                              → src/loop.ts             provider-agnostic LLM + tool loop

  db/                       @workshop/db — telemetry store (Postgres or in-memory)
                              → src/index.ts            createReview, persistReview, storeTracer
                              → src/memory.ts           in-memory backend for local dev

  ui/                       @workshop/ui — mountable Hono telemetry viewer
                              → src/index.ts            createUiRouter() + read APIs
                              → src/page.ts             dashboard HTML template

docs/                       guided walkthrough (00–05)

facilitator/                facilitator notes and exercise solutions

tests/                      unit, integration, and e2e tests (mock model, no API key)
                              → integration/run-review.test.ts      core pipeline end-to-end
                              → integration/workflow-dispatch.test.ts   Pattern 3 dispatch path
                              → helpers.ts                          GitHub stub + shared fixtures
```

### Shared packages

- **[`@workshop/agent`](shared/agent)** — The substrate-agnostic core. Composable
  building blocks (`prepareDiff`, `filterDiff`, `selectReviewers`, `toReviewSummary`),
  the `defineAgent` reviewers (`securityReviewer`, `performanceReviewer`,
  `uxReviewer`, `judge`), the provider-agnostic LLM loop, and the mock client.
  Each pattern imports these and composes its own pipeline inline.
- **[`@workshop/db`](shared/db)** — The durable telemetry record the viewer reads.
  Auto-selects Postgres when `DATABASE_URL` is set, and uses in-memory storage
  otherwise.
- **[`@workshop/ui`](shared/ui)** — A single mountable Hono router that renders the
  reviews table with drill-in to findings and agent spans.

## The code-review pipeline

Every pattern runs the same review:

```
prepareDiff -> filterDiff -> [ security || performance || ux? ] -> judge
```

- `prepareDiff` turns a GitHub PR URL into per-file patches. Public repos need no token.
- `filterDiff` drops noise: lock files, minified assets, source maps, and bundles.
- `security` and `performance` always run in parallel. `ux` joins when the diff
  touches frontend files (`.tsx`, `.jsx`, `.vue`, `.css`, and so on).
- `judge` consolidates findings into an approve / request-changes verdict.

Trigger one against any deployed or local web service:

```sh
curl -s -X POST "$SERVICE_URL/api/reviews" \
  -H 'content-type: application/json' \
  -d '{"prUrl":"https://github.com/octocat/Hello-World/pull/9681"}'
```

## Configuration

All patterns read the same env:

| Var | Used by | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | all | Optional. Deterministic mock model if absent |
| `AGENT_MODEL=mock` | all | Force the mock model even with a key |
| `DATABASE_URL` | naive-agent, queue-agents, workflow-agents | Postgres. In-memory fallback when unset |
| `VALKEY_URL` | queue-agents | Queue and pub/sub. Defaults to `redis://127.0.0.1:6379` |
| `PORT` | web tiers | Defaults to `3000` |
| `GITHUB_TOKEN` | all | Optional. Raises rate limits and enables private-repo diffs |
| `RENDER_USE_LOCAL_DEV` | workflow-agents | Set to `true` only for local dev |
| `RENDER_LOCAL_DEV_URL` | workflow-agents | Local Workflow task server URL |
| `RENDER_API_KEY` | workflow-agents | Required in production Workflow dispatch |
| `RENDER_WORKFLOW_SLUG` | workflow-agents | Required in production. Slug of the Workflow service |

## Testing

All suites run against the deterministic mock model, so they need no LLM provider
API key:

```sh
npm test                 # everything
npm run test:unit        # pure logic
npm run test:integration # per-pattern app + worker kv contract
npm run test:e2e         # end-to-end naive + workflow flows
npm run test:worker      # worker ack/retry contract
npm run typecheck        # TypeScript across every workspace
```

Tests live under [`tests/`](tests) (`unit/`, `integration/`, `e2e/`). The
`worker-kv` integration test is the red-to-green check for the Session 1 exercise.

### Troubleshooting `test:worker`

The worker test needs a running Valkey (or Redis) instance. If it hangs or
skips:

| Symptom | Cause | Fix |
| --- | --- | --- |
| All tests show "skipped" | `VALKEY_URL` not set in the environment | Run with the var inline: `VALKEY_URL=redis://127.0.0.1:6379 npm run test:worker` |
| `ECONNREFUSED 127.0.0.1:6379` | No Valkey/Redis server running | Start one first: `valkey-server &` or `docker run -d -p 6379:6379 valkey/valkey` or `redis-server &` |
| Tests pass but process hangs | Open Redis connections preventing exit (fixed in recent commits) | Update to the latest code; if still stuck, press Ctrl-C — results are valid |

## Notes

- This is an **npm workspaces** monorepo (`shared/*` and the three `packages/*`).
  Install from the root with a single `npm install`.
- The mock model means the entire pipeline, all three patterns, and the full test
  suite run offline with zero credentials.
- Pattern 3 uses the Render SDK (`@renderinc/sdk/workflows`). Workflows are
  auto-discovered from `src/workflows/`. Any subfolder with an `index.ts` exporting
  a `task()` needs no manual registration.
