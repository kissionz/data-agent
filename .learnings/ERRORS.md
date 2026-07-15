# Errors

## [ERR-20260623-007] impeccable context script path

**Logged**: 2026-06-23T15:33:49+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary

The `impeccable` skill documentation referenced `.claude/skills/impeccable/scripts/context.mjs`, but this Codex workspace does not mirror skills into `.claude/skills`.

### Error

```text
Error: Cannot find module '/Users/kissionz/Documents/data-agent/.claude/skills/impeccable/scripts/context.mjs'
```

### Context

- Command attempted: `node .claude/skills/impeccable/scripts/context.mjs`
- The installed skill exists at `/Users/kissionz/.codex/skills/impeccable`.

### Suggested Fix

When using filesystem-backed Codex skills from this workspace, run helper scripts from the skill's installed source path, for example `node /Users/kissionz/.codex/skills/impeccable/scripts/context.mjs`.

### Metadata

- Reproducible: yes
- Related Files: PRODUCT.md, DESIGN.md

### Resolution

- **Resolved**: 2026-06-23T15:33:49+08:00
- **Notes**: Re-ran the context script from `/Users/kissionz/.codex/skills/impeccable/scripts/context.mjs` and continued implementation.

---

## [ERR-20260715-003] pnpm store mismatch in managed sandbox

**Logged**: 2026-07-15T20:40:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary

Running `corepack pnpm add` inside the managed sandbox selected the workspace-local pnpm store, while the existing `node_modules` links use the user's pnpm v11 store.

### Error

```text
ERR_PNPM_UNEXPECTED_STORE
node_modules is linked from /Users/kissionz/Library/pnpm/store/v11
pnpm wants to use /Users/kissionz/Documents/data-agent/.pnpm-store/v11
```

### Context

- The dependency change was required for the Node-only PostgreSQL adapter.
- Network access and writes to the existing user-level store require an escalated command.

### Suggested Fix

Use the existing store explicitly: `corepack pnpm --store-dir /Users/kissionz/Library/pnpm/store/v11 ...`, with the required approval for network/store access.

### Metadata

- Reproducible: yes
- Related Files: package.json, pnpm-lock.yaml

### Resolution

- **Resolved**: 2026-07-15T20:41:00+08:00
- **Notes**: Installed `pg`, `@types/pg`, `@types/node`, and `tsx` through the existing pnpm v11 store.

---

## [ERR-20260623-006] npm start script assumption

**Logged**: 2026-06-23T15:24:06+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary

Browser smoke verification initially failed because the project does not define an `npm start` script.

### Error

```text
npm error Missing script: "start"
```

### Context

- Command attempted: `npm start -- --host 127.0.0.1 --port 4183`
- The project defines `dev`, `build`, `test`, `test:watch`, and `preview` scripts in `package.json`.

### Suggested Fix

For local Vite browser checks in this repo, use `npm run dev -- --host 127.0.0.1 --port <port>` or `npm exec vite -- --host ...`.

### Metadata

- Reproducible: yes
- Related Files: package.json

### Resolution

- **Resolved**: 2026-06-23T15:24:06+08:00
- **Notes**: Restarted with `npm run dev -- --host 127.0.0.1 --port 4183` and completed browser smoke verification.

---

## [ERR-20260623-005] browser bundle imported node persistence adapter

**Logged**: 2026-06-23T00:00:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: build

### Summary

Vite production build failed because the browser application imported the persistence barrel, which re-exported the Node-only file adapter using `node:fs` and `node:path`.

### Error

```text
Module "node:fs" has been externalized for browser compatibility
"existsSync" is not exported by "__vite-browser-external"
```

### Context

`src/App.tsx` imports the application service. The service imported from `../persistence`, whose barrel also exported `file.ts`. That made Rollup include the Node-only adapter in the browser graph.

### Suggested Fix

Keep Node-only adapters out of browser import paths. Application/browser-safe code should import `persistence/memory` and `persistence/ports` directly; tests or Node API code can import `persistence/file` explicitly.

### Metadata

- Reproducible: yes
- Related Files: src/application/chatbiService.ts, src/persistence/index.ts

### Resolution

- **Resolved**: 2026-06-23T00:00:00+08:00
- **Notes**: Updated browser-facing application imports to avoid the persistence barrel.

---

## [ERR-20260623-004] public error catalog typing

**Logged**: 2026-06-23T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: contracts

### Summary

Adding `PUBLIC_ERROR_CATALOG` failed TypeScript because `PARTIAL_RESULT` is a public result condition with HTTP 200, while the catalog status union only allowed error statuses.

### Error

```text
Type '200' is not assignable to type '400 | 403 | 404 | 409 | 422 | 429 | 500 | 503'
```

### Context

`PARTIAL_RESULT` is exposed through the same public code catalog but should not be treated as a failed HTTP response. The test also needed `PublicErrorCode` re-exported from `src/contracts`.

### Suggested Fix

Allow `200` in the public catalog status union and explicitly re-export shared domain code types from the contracts package boundary.

### Metadata

- Reproducible: yes
- Related Files: src/contracts/api.ts

### Resolution

- **Resolved**: 2026-06-23T00:00:00+08:00
- **Notes**: Updated `PublicErrorCatalogItem.httpStatus` and re-exported `PublicErrorCode`.

---

## [ERR-20260623-003] in-app browser locator timing

**Logged**: 2026-06-23T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The in-app browser Playwright-style locator hit an `Element is not attached` error while clicking a clarification candidate during a React state transition.

### Error

```text
Browser Use encountered an error interacting with this webpage: Error: Element is not attached
```

### Context

The click target existed, but a broad locator and immediate wait crossed a DOM replacement caused by React state updates. The app itself continued to work; a later exact accessible-name locator completed the flow.

### Suggested Fix

For Codex in-app browser checks, use exact accessible names for dynamic buttons and add a short post-click wait or re-resolve locators after state transitions.

### Metadata

- Reproducible: intermittent
- Related Files: src/App.tsx

### Resolution

- **Resolved**: 2026-06-23T00:00:00+08:00
- **Notes**: Re-ran the check with the exact candidate button name and verified completion.

---

## [ERR-20260623-002] security test scope

**Logged**: 2026-06-23T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The new application service security test treated the user's original question text as system leakage.

### Error

```text
expected public run view not to match /手机号|客户|事业部|select|policy/i
```

### Context

The public run view should preserve the user's own question in conversation history. The no-leak assertion should apply to system-generated fields such as errors, audit summaries, Analysis IR, result payloads, clarification candidates, and safe details.

### Suggested Fix

Scope resource-leak assertions to system-generated response fields and keep separate assertions for preserving user question text.

### Metadata

- Reproducible: yes
- Related Files: src/test/application.test.ts

### Resolution

- **Resolved**: 2026-06-23T00:00:00+08:00
- **Notes**: Updated the test to exclude the `question` field from system leakage checks.

---

## [ERR-20260623-001] pnpm command lookup

**Logged**: 2026-06-23T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary

The shell in the resumed Codex turn could not find the global `pnpm` command, even though project dependencies were already installed.

### Error

```text
zsh:1: command not found: pnpm
```

### Context

- Commands: `pnpm test`, `pnpm build`
- Local project binaries remained available under `node_modules/.bin`.

### Suggested Fix

Use local binaries for verification in this environment: `./node_modules/.bin/vitest run`, `./node_modules/.bin/tsc -b`, and `./node_modules/.bin/vite build`. Keep README instructions as `pnpm` for normal developer setup.

### Metadata

- Reproducible: yes in current resumed shell
- Related Files: README.md, package.json

### Resolution

- **Resolved**: 2026-06-23T00:00:00+08:00
- **Notes**: Switched to local binaries for this verification run.

---

## [ERR-20260622-001] pnpm install

**Logged**: 2026-06-22T18:12:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: config

### Summary

pnpm 11 downloaded dependencies but exited with `ERR_PNPM_IGNORED_BUILDS` because esbuild was not on the project build-script allowlist.

### Error

```text
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.27.7
```

### Context

- Command: bundled `pnpm install`
- Environment: Codex bundled Node and pnpm 11.5.3
- The package tree installed, but Vite requires esbuild's platform binary.

### Suggested Fix

Add only `esbuild` to `pnpm.onlyBuiltDependencies`, then reinstall. Do not enable arbitrary dependency scripts globally.

### Metadata

- Reproducible: yes
- Related Files: package.json

### Resolution

- **Resolved**: 2026-06-22T18:14:00+08:00
- **Notes**: pnpm 11 moved build policy out of `package.json`; the project now stores `onlyBuiltDependencies` and noninteractive purge behavior in `pnpm-workspace.yaml`.

---

## [ERR-20260622-004] Vite dev server

**Logged**: 2026-06-22T18:21:00+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary

The workspace sandbox denied binding Vite to `127.0.0.1:4173`.

### Error

```text
Error: listen EPERM: operation not permitted 127.0.0.1:4173
```

### Context

- The build itself succeeds.
- Browser verification requires a local HTTP listener.

### Suggested Fix

Restart the same command with the environment's approved local-server escalation.

### Metadata

- Reproducible: yes
- Related Files: vite.config.ts

### Resolution

- **Resolved**: 2026-06-22T18:21:00+08:00
- **Notes**: Retried with narrow permission to bind the localhost development port.

---

## [ERR-20260622-003] TypeScript build

**Logged**: 2026-06-22T18:19:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: config

### Summary

`tsc -b` rejected Vitest's `test` key because Vite's narrower `defineConfig` type was imported.

### Error

```text
vite.config.ts: Object literal may only specify known properties, and 'test' does not exist in type 'UserConfigExport'.
```

### Context

- The runtime Vite build succeeded, but the referenced TypeScript node project failed its config type check.

### Suggested Fix

Import `defineConfig` from `vitest/config`, which merges Vite and Vitest config types.

### Metadata

- Reproducible: yes
- Related Files: vite.config.ts, tsconfig.node.json

### Resolution

- **Resolved**: 2026-06-22T18:19:00+08:00
- **Notes**: Switched the config helper and retained the same Vite plugin/build configuration.

---

## [ERR-20260622-002] web search

**Logged**: 2026-06-22T18:17:00+08:00
**Priority**: low
**Status**: resolved
**Area**: docs

### Summary

The web search endpoint returned a Cloudflare 403 while looking up pnpm's current build-policy setting.

### Error

```text
Fatal error: http 403 Forbidden
```

### Context

- Query was restricted to official pnpm documentation.
- The CLI provides an interactive `approve-builds` command, so web lookup is not required.

### Suggested Fix

Use `pnpm approve-builds` directly when the local CLI version supports it.

### Metadata

- Reproducible: unknown
- Related Files: pnpm-workspace.yaml

### Resolution

- **Resolved**: 2026-06-22T18:17:00+08:00
- **Notes**: Switched to the version-matched local CLI approval flow.

---
## [ERR-20260702-001] npm start

**Logged**: 2026-07-02T16:21:47+08:00
**Priority**: low
**Status**: resolved
**Area**: config

### Summary

The repository has no `npm start` script; the Vite development server uses `npm run dev`.

### Error

```text
npm error Missing script: "start"
```

### Context

- Attempted to start the local UI for browser verification.
- `package.json` defines `dev`, `build`, `test`, `test:e2e`, `test:watch`, and `preview`.

### Suggested Fix

Use `npm run dev` for interactive browser verification or `npm run preview` after a production build.

### Metadata

- Reproducible: yes
- Related Files: package.json

### Resolution

- **Resolved**: 2026-07-02T16:22:00+08:00
- **Notes**: Switched browser verification to the existing Vite `dev` script.

---

## [ERR-20260715-001] in-app browser load-state wait

**Logged**: 2026-07-15T10:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

The in-app browser runtime rejects `networkidle` even though the general browser documentation lists it as a load-state value.

### Error

```text
playwright_wait_for_load_state does not support networkidle
```

### Context

- Attempted to wait for the local Vite app after navigating to `http://127.0.0.1:4173/`.
- The tab was created successfully; only the unsupported wait-state parameter failed.

### Suggested Fix

Use the supported `load` or `domcontentloaded` state, then verify a concrete visible element instead of relying on network idleness.

### Metadata

- Reproducible: yes
- Related Files: tests/e2e/prd-acceptance.desktop.spec.ts

### Resolution

- **Resolved**: 2026-07-15T10:01:00+08:00
- **Notes**: Switched browser verification to `load` plus targeted DOM checks.

---

## [ERR-20260715-002] seeded evaluation approval

**Logged**: 2026-07-15T18:17:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: backend

### Summary

Direct approval of a seeded golden sample returned not found because the approval entry point did not initialize demo seeds.

### Error

```text
Evaluation service > requires and sanitizes approval notes before writing audit events
expected approved.ok to be true, received false
```

### Context

- List, get, and schedule paths initialized seeded samples, so UI tests passed because the UI lists samples first.
- A direct approval request could skip all of those entry points and observe an empty store.

### Suggested Fix

Initialize the scoped demo seed set inside every entry point that may address a seed identifier, including approval.

### Metadata

- Reproducible: yes
- Related Files: src/application/evaluation.ts, src/test/evaluationService.test.ts

### Resolution

- **Resolved**: 2026-07-15T18:18:00+08:00
- **Notes**: Added scoped seed initialization before the approval lookup and retained the direct-entry regression test.

---

## [ERR-20260715-004] Docker Desktop container start hangs

**Logged**: 2026-07-15T20:49:00+08:00
**Priority**: medium
**Status**: open
**Area**: tests

### Summary

Docker Desktop responds to `docker info`, can pull and inspect the arm64 PostgreSQL image, but cannot start any container.

### Error

```text
containers remain in Created
Post .../containers/<id>/start: failed to start containers
```

### Context

- `docker compose ... up -d --wait` stalled before the health check.
- A mount-free `docker run --rm postgres:16-alpine postgres --version` also stalled, proving the issue is not the Compose bind mount, init SQL, architecture, or PostgreSQL process.
- The real integration suite correctly fails closed with `QUERY_UNAVAILABLE` while the database is unreachable.

### Suggested Fix

Restart or repair Docker Desktop/containerd, verify a trivial container can start, then run the documented Compose and `test:integration:postgres` commands unchanged.

### Metadata

- Reproducible: yes
- Related Files: docker-compose.postgres.yml, tests/integration/postgresQueryAdapter.integration.test.ts

---

## [ERR-20260715-005] Vitest test collection option unavailable

**Logged**: 2026-07-15T19:13:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

Vitest 3.2.6 does not support the attempted `--list` option for collection-only verification.

### Error

```text
CACError: Unknown option `--list`
```

### Context

- Attempted to collect the real PostgreSQL integration files without connecting to a database.
- TypeScript build already imports and checks those files, while adapter unit suites provide the executable no-database boundary.

### Suggested Fix

Use `tsc -b` to verify real integration files load and typecheck, and run the dedicated adapter unit tests when PostgreSQL is unavailable. Run the integration files normally only when the database gate is available.

### Metadata

- Reproducible: yes
- Related Files: vitest.integration.config.ts, tests/integration/postgresRunJobQueue.integration.test.ts, tests/integration/postgresResultEventStore.integration.test.ts

### Resolution

- **Resolved**: 2026-07-15T19:13:00+08:00
- **Notes**: Kept the unsupported command out of the validation gate; build and 25 adapter unit tests pass.

---
