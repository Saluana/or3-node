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
