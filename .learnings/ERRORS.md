# Errors

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
