# or3-node bug audit task list

_Date:_ 2026-03-19  
_Scope:_ static review of `index.ts`, every file under `src/`, and the existing test suite under `tests/`.

## Validation status / audit limitations

- I attempted to run the repository's standard validation commands before making changes:
  - `bun run lint`
  - `bun run typecheck`
  - `bun test`
- Those commands could not run in this sandbox because `bun` is not installed (`bash: bun: command not found`).
- Because of that, this file is a **best-effort static audit**, not a claim that every possible runtime bug has been proven.

## Confirmed bugs and high-confidence follow-up tasks

### Security / correctness issues to fix first

- [ ] **`src/config/store.ts:40-44` — `config.json` is written without locked-down permissions.**  
  `saveConfig()` persists `bootstrapToken` to disk using a plain `writeFile(..., "utf8")`. Unlike `credentials.json`, there is no `mode: 0o600` / `chmod(0o600)`. On multi-user systems this can expose a still-valid bootstrap token to other local users.

- [ ] **`src/identity/store.ts:39-42` — `identity.json` stores the node signing secret without `0600` permissions.**  
  `ensureIdentity()` writes `secretKeyBase64` with default permissions. That private key is enough to impersonate the node when signing manifests.

- [ ] **`src/host-control/paths.ts:13-27` — cwd allow-root checks are vulnerable to symlink escapes.**  
  `resolveAllowedWorkingDirectory()` uses `path.resolve()` and string-prefix checks, but never canonicalizes with `realpath()`. A symlink inside an allowed root can therefore point the child process outside the sandbox while still passing validation.

- [ ] **`src/transport/agent-loop.ts:157-158,238-245` — malformed inbound frames can escape as unhandled async errors.**  
  `socket.onmessage` fires `void this.handleIncomingFrame(...)`, and `handleIncomingFrame()` immediately does `JSON.parse(raw)` plus schema parsing without its own `try/catch`. A malformed or hostile frame can therefore produce an unhandled rejection instead of a controlled transport error.

- [ ] **`src/transport/agent-loop.ts:864-868` — secure `wss://` base URLs are downgraded to `ws://`.**  
  `buildTransportUrl()` maps `https:` to `wss:`, but maps **every other protocol** to `ws:`. If the configured control-plane URL is already `wss://...`, the generated transport URL becomes insecure `ws://...`.

### Medium-priority bugs / hardening items

- [ ] **`src/host-control/files.ts:174-182` — file access validates the canonical path but returns the unresolved path.**  
  `resolveAllowedPath()` checks `canonicalPath` against allowed roots, then returns `resolved` instead of the canonical path it just validated. That leaves file operations exposed to re-resolution/symlink-swap races after validation.

- [ ] **`src/host-control/files.ts:249-258` — directory browse silently hides metadata failures.**  
  `walkDir()` swallows all `fs.stat()` errors and emits a bare `{ path, kind: "file" }`. Permission problems and broken filesystem states become invisible to the caller, which makes debugging file-access issues harder.

- [ ] **`src/host-control/service.ts:339-352` — stdout/stderr truncation can split UTF-8 characters.**  
  `appendBounded()` truncates by raw bytes and then decodes the clipped byte slice as UTF-8. If a multibyte code point lands on the boundary, the stored preview can contain replacement characters / corrupted text.

- [ ] **`src/transport/agent-loop.ts:928-936` — session log chunk clipping has the same UTF-8 boundary bug.**  
  `clipSessionLogChunk()` uses the same byte-slice-then-decode approach as `appendBounded()`.

### Latent / currently less-exposed issues

- [ ] **`src/host-control/services.ts:60-63` — service launches inherit unrestricted process state.**  
  If the hidden `service-launch` capability is ever enabled, spawned services currently inherit the full parent `process.env` and accept any `cwd` passed in by the caller. That is weaker than the guardrails enforced for regular exec/PTy flows and should be tightened before this path is exposed.

- [ ] **`src/cli/index.ts:72-80` — unexpected CLI failures can exit silently.**  
  `runCli()` logs `CliUsageError` and `ConfigError`, but any other thrown error path just falls through to `return 1`. In cases where a lower layer did not already log the failure, operators can get a non-zero exit with little to no diagnostic output.

## Recommended regression tests to add with the fixes

- [ ] Add a test proving `config.json` is created with `0600` permissions when it contains a bootstrap token.
- [ ] Add a test proving `identity.json` is created with `0600` permissions.
- [ ] Add a symlink-escape regression test for `resolveAllowedWorkingDirectory()`.
- [ ] Add a malformed-WebSocket-frame test for `NodeAgentLoop.handleIncomingFrame()` / the `onmessage` path.
- [ ] Add a test proving `buildTransportUrl()` preserves `wss://` inputs.
- [ ] Add UTF-8 truncation regression tests for both exec previews and session log clipping.

## File-by-file review coverage

### Files with concrete findings

- `src/cli/index.ts`
- `src/config/store.ts`
- `src/host-control/files.ts`
- `src/host-control/paths.ts`
- `src/host-control/service.ts`
- `src/host-control/services.ts`
- `src/identity/store.ts`
- `src/transport/agent-loop.ts`

### Reviewed with no concrete bug flagged during this pass

- `index.ts`
- `src/config/types.ts`
- `src/enroll/client.ts`
- `src/enroll/manifest.ts`
- `src/host-control/env-policy.ts`
- `src/host-control/history.ts`
- `src/host-control/pty.ts`
- `src/host-control/types.ts`
- `src/info/agent-info.ts`
- `src/info/connection-state.ts`
- `src/runtime-capabilities.ts`
- `src/storage/paths.ts`
- `src/utils/errors.ts`
- `src/utils/logger.ts`
- `src/version.ts`

### Existing tests reviewed for coverage gaps (no direct edits made)

- `tests/agent-loop.test.ts`
- `tests/cli.test.ts`
- `tests/connection-state.test.ts`
- `tests/host-control-files.test.ts`
- `tests/host-control-pty.test.ts`
- `tests/host-control-services.test.ts`
- `tests/host-control.test.ts`
- `tests/manifest.test.ts`
