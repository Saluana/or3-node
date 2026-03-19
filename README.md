# or3-node

`or3-node` is the machine-side agent for OR3.

Product boundary:

- `or3-net` stays the control plane
- `or3-node` is the installable agent that runs on the computer being controlled
- `or3-node` must fit the existing `or3-net` node, transport, executor, and runtime-session seams with minimal control-plane churn

Primary UX target:

```bash
bun install -g or3-node
or3-node launch
```

## Current command surface

- `or3-node launch`
- `or3-node doctor`
- `or3-node info`
- `or3-node status`
- `or3-node reset`

## Current config surface

The common path avoids hand-editing config files. `or3-node launch` persists config and identity on first successful run.

Current config fields:

- `controlPlaneUrl`
- `bootstrapToken`
- `nodeName`
- `allowedRoots`

Current local state:

- persistent node identity
- enrollment metadata
- runtime credential metadata in `state.json`
- runtime credential secret in `credentials.json`
- recent execution snapshots in `exec-history.json`

## Source layout

This project is intentionally separate from `or3-net` even though it integrates closely with it.

```text
src/
	cli/
	config/
	host-control/
	identity/
	storage/
	transport/
	utils/
tests/
```

The shipped CLI name stays short (`or3-node`) even though the planning docs may refer to the broader concept as the node agent.

## V1 implementation stance

- first milestone scope: job execution first, then remote runtime-session support
- hostile multi-tenant isolation is out of scope
- the agent should reuse existing `or3-net` node and runtime-session seams instead of forcing a new public API family

## Transport notes

- primary transport is authenticated outbound `outbound-wss`, which keeps the agent behind NAT/firewalls while allowing live execute, abort, streaming, reconnect, and heartbeat updates
- `https` remains available as a dev/fallback transport because it is simpler to debug and useful before a live socket is attached
- tradeoff: `https` can exercise the same request contract, but it does not provide the same continuously attached session semantics as the connected `outbound-wss` path

## Capability truthfulness

- `exec` is always advertised.
- `file-read` and `file-write` are only advertised when `allowedRoots` is configured and the default launch path wires `HostFileService`.
- `pty` and `service-launch` are intentionally not advertised yet, even though scaffold code exists, because they are not fully implemented end-to-end in the default agent runtime.

## Full PTY follow-up

Full PTY support will land in `src/host-control/pty.ts` and `src/transport/agent-loop.ts`, with regression coverage in `tests/host-control-pty.test.ts` and transport-level PTY tests.

Planned implementation:

- switch the current pipe-backed fallback in `HostPtyService` to Bun's Terminal API on POSIX (`Bun.spawn({ terminal: { cols, rows, data, exit, drain } })`)
- drive PTY lifecycle through `proc.terminal.write(...)`, `proc.terminal.resize(...)`, `proc.terminal.setRawMode(...)`, and `proc.terminal.close()`
- stream PTY output through the existing `pty_*` RPC methods in `src/transport/agent-loop.ts` before re-advertising `pty`
- keep PTY hidden on Windows until there is a separate Windows-specific implementation path, because Bun's Terminal API is POSIX-only today

## Structured logs

`or3-node` writes structured JSON logs to `stderr` for bootstrap, approval, credentials, transport, exec, and enabled host-control flows.

Example success log:

```json
{
  "level": "info",
  "event": "transport.connect",
  "message": "transport connected",
  "timestamp": "2026-03-18T00:00:00.000Z",
  "details": { "control_plane_url": "http://127.0.0.1:3001" }
}
```

Example failure log:

```json
{
  "level": "error",
  "event": "path.violation",
  "message": "host file operation blocked by path policy",
  "timestamp": "2026-03-18T00:00:01.000Z",
  "details": {
    "path": "/tmp/outside.txt",
    "error": "path is outside allowed roots: /tmp/outside.txt",
    "failure_class": "path_violation"
  }
}
```

Useful fields:

- `event`: stable lifecycle name like `bootstrap.start`, `credential.refreshed`, or `exec.finish`
- `message`: short human-readable summary
- `details.failure_class`: broad failure bucket such as `bootstrap`, `credential`, `transport`, `exec`, `capability_mismatch`, or `path_violation`

## Development

Install dependencies:

```bash
bun install
```

Run the CLI locally:

```bash
bun run index.ts --help
```

Validate:

```bash
bun run typecheck
bun run lint
bun test
```

## Operations docs

- contributor verification: [docs/smoke-test.md](docs/smoke-test.md)
- service-manager follow-up: [docs/service-management.md](docs/service-management.md)
- real-life operations and troubleshooting: [docs/operations.md](docs/operations.md)
- end-to-end release validation: [docs/release-validation.md](docs/release-validation.md)
- release-readiness checklist: [docs/release-readiness.md](docs/release-readiness.md)
