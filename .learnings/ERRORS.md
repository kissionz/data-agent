# Errors

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
