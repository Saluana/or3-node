# OR3 Node Agent — Staged Release Gates

This document closes the Phase 15 release-gate work for `or3-node`.

The node-agent surface is broad enough that release confidence should be built in stages instead of hiding runtime sessions, file access, PTY, and service launch behind a single vague “it probably works” bucket.

## Gate model

Use the Bun runner in [scripts/release-gates.ts](../scripts/release-gates.ts):

```bash
bun run validate:release
```

By default it runs all staged gates:

- `core`
- `runtime`
- `file`
- `pty`
- `service`
- `restart`

Useful variants:

```bash
bun run validate:release -- --list
bun run validate:release -- core
bun run validate:release -- runtime file
bun run validate:release -- --dry-run
```

## Stage definitions

### `core`

Covers the must-not-break path for shipping the agent at all.

Includes:

- `or3-net` typecheck and lint
- `or3-node` typecheck and lint
- bootstrap and approval coverage in [or3-net/tests/nodes.phase3.test.ts](../../or3-net/tests/nodes.phase3.test.ts)
- connected transport coverage in [or3-net/tests/transport.test.ts](../../or3-net/tests/transport.test.ts)
- leased remote execution coverage in [or3-net/tests/local-jobs.test.ts](../../or3-net/tests/local-jobs.test.ts)
- first-launch UX and restart-sensitive CLI coverage in [or3-node/tests/cli.test.ts](../tests/cli.test.ts)
- reconnect behavior in [or3-node/tests/agent-loop.test.ts](../tests/agent-loop.test.ts)
- persisted connection-state behavior in [or3-node/tests/connection-state.test.ts](../tests/connection-state.test.ts)

Ship blocker if this stage fails.

### `runtime`

Covers runtime-session parity instead of treating it as hidden stretch work.

Includes:

- [or3-net/tests/runtime.phase7.integration.test.ts](../../or3-net/tests/runtime.phase7.integration.test.ts)
- [or3-net/tests/app.phase6.runtime.test.ts](../../or3-net/tests/app.phase6.runtime.test.ts)

This stage proves:

- runtime-session lifecycle routes remain usable
- remote-node adapter behavior stays aligned with the generic runtime-session model
- session exec, logs, PTY/file route surfaces, and destroy paths are still wired

### `file`

Covers explicit file-control behavior.

Includes:

- [or3-node/tests/host-control-files.test.ts](../tests/host-control-files.test.ts)
- [or3-net/tests/runtime/adapters/remote-node.test.ts](../../or3-net/tests/runtime/adapters/remote-node.test.ts)

This stage proves:

- allowed-root enforcement is real
- size caps and traversal protection are real
- remote-node runtime projection keeps file capability behavior honest

### `pty`

Covers interactive terminal support as its own gate.

Includes:

- [or3-node/tests/host-control-pty.test.ts](../tests/host-control-pty.test.ts)
- [or3-net/tests/app.phase6.runtime.test.ts](../../or3-net/tests/app.phase6.runtime.test.ts)

This stage proves:

- PTY lifecycle on supported POSIX hosts still works
- PTY route wiring remains compatible with runtime sessions
- unsupported platforms fail clearly instead of degrading silently

### `service`

Covers service launch and preview-backed service exposure.

Includes:

- [or3-node/tests/host-control-services.test.ts](../tests/host-control-services.test.ts)
- [or3-net/tests/previews.phase45.test.ts](../../or3-net/tests/previews.phase45.test.ts)

This stage proves:

- service lifecycle remains bounded locally
- preview and service-launch control-plane flows still work together
- service launch is treated as a real release gate even while its default advertised capability remains hidden for v1 GA

### `restart`

Covers the restart semantics that operators care about most.

Includes:

- [or3-node/tests/cli.test.ts](../tests/cli.test.ts)
- [or3-node/tests/connection-state.test.ts](../tests/connection-state.test.ts)
- [or3-net/tests/nodes.phase3.test.ts](../../or3-net/tests/nodes.phase3.test.ts)

This stage proves:

- identity persists across restart
- connection-state persistence is sane
- credential revocation / rotation semantics stay intact
- stale runtime credentials are not treated as healthy long-lived state

## Manual release gates

Automated gates are not enough on their own.

Use these manual gates before calling the node-agent release ready:

### Real-machine smoke

Run the Bun smoke helper:

```bash
bun run smoke:real-machine -- \
  --install-global \
  --reset-first \
  --cleanup \
  --control-plane-url http://localhost:3100 \
  --workspace-id ws_xxx \
  --admin-token <admin-token>
```

This validates:

- global Bun install
- `or3-node launch`
- approval handoff
- first remote command through the live control plane

### Restart validation

Use the checklist in [docs/release-validation.md](release-validation.md) and [docs/operations.md](operations.md) to confirm:

- identity survives restart
- revoked approval clears stale runtime credentials on the next launch
- reconnect recovery behaves as documented after a dropped control-plane path

## Release decision

Do not ship on a green `core` stage alone.

A release-ready pass means:

- automated gates are green for the stages intended for that release
- the real-machine smoke passes
- the platform matrix in [docs/platform-support.md](platform-support.md) still matches the actual capability truth
- no doc says a capability is available where the CLI/runtime still hides it
