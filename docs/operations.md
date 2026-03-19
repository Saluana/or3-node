# OR3 Node Agent — Operations and Troubleshooting

This guide covers how `or3-node` behaves after first install: approval,
credential refresh, reconnect, stale-health recovery, and the fastest ways to
debug the first 30 minutes of a deployment.

## Real-life lifecycle

### 1. Enrollment and approval

Expected flow:

1. Run `or3-node launch` with a valid bootstrap token.
2. The node enrolls and receives a signed node identity plus manifest-based node id.
3. If approval is still pending, the CLI stops there and tells you the next step.
4. Once the control plane approves the node, the next launch can obtain runtime credentials and connect.

What you should expect locally:

- `or3-node doctor` shows bootstrap token presence and identity state
- `or3-node status` shows `approval: pending` until the control plane approves the node
- structured logs show `bootstrap.start`, `bootstrap.success`, and then either
  `approval.received` or a pending approval state

### 2. Credential refresh

Runtime credentials are separate from enrollment identity.

Expected behavior:

- the credential is refreshed during `launch` when it is missing, expired, or
  close to expiry
- the secret token stays in `credentials.json`
- the main `state.json` stores metadata only

What to look for:

- `or3-node status` shows `credential: valid`, `missing`, or `expired`
- structured logs show `credential.refreshed` when refresh succeeds
- rerunning `or3-node launch` is the intended recovery path when credentials expire

### 3. Reconnect behavior

Once the node has a valid credential and starts the live loop:

- the transport uses outbound authenticated WebSocket connection(s)
- disconnects are retried with jittered backoff
- shutdown now aborts reconnect waits promptly instead of hanging through long backoff windows

What to look for:

- `transport.connect` when the socket is attached
- `transport.disconnect` when the socket drops
- `transport.reconnect` with `delay_ms` and `base_delay_ms` while reconnect is scheduled

### 4. Stale health recovery

If the control plane reports a node as stale or unavailable:

- first verify the local process is still running
- then inspect structured logs for connect/disconnect/auth failures
- rerun `or3-node launch --foreground --no-interactive` manually to reproduce cleanly
- if needed, use `or3-node reset` only when you intend to fully re-enroll

## First 30 minutes troubleshooting

### Fast checklist

1. `or3-node info`
2. `or3-node doctor`
3. `or3-node status`
4. rerun `or3-node launch --foreground --no-interactive`
5. inspect structured logs and control-plane node health side by side

### Common symptoms

#### Node never gets past pending approval

Check:

- the control-plane approve step actually succeeded
- you are looking at the same workspace and node id that the CLI printed
- the stored state still matches the current environment

Recovery:

- approve the node in the control plane
- rerun `or3-node launch`

#### Credential is missing or expired

Check:

- `or3-node status`
- `credentials.json` existence in the local data directory
- `credential.refreshed` vs `bootstrap.fail` logs

Recovery:

- rerun `or3-node launch`
- if approval was revoked upstream, re-approve before retrying

#### Transport keeps reconnecting

Check:

- network path to the control plane
- control-plane URL correctness
- whether auth failures are showing up instead of plain network failures

Recovery:

- verify the stored control-plane URL
- rerun foreground launch for live logs
- replace stale credentials by running `or3-node launch` again

#### Control plane shows stale health

Check:

- whether the local process is running at all
- whether the agent is stuck in reconnect or never successfully attached
- whether the machine slept, changed networks, or lost outbound access

Recovery:

- restart the foreground launch path once
- if managed by a service, confirm the service manager restarted it correctly
- inspect service logs and local structured logs together

#### File operations expected but not available

Check:

- whether `allowedRoots` is configured
- whether `or3-node info` shows `file-read, file-write`

Recovery:

- configure allowed roots first
- relaunch the agent so the runtime wiring matches the advertised capability set

#### PTY or service-launch expected but not shown

This depends on platform and wiring.

- PTY is expected on Linux/macOS when the default host-control runtime is active
- PTY remains hidden on Windows because Bun's Terminal API is POSIX-only in this phase
- service-launch remains hidden until the operational story is stronger than the current local process manager scaffold

## When to reset

Use `or3-node reset` only when you want a true clean slate:

- new identity
- cleared enrollment state
- removed runtime credentials
- cleared bootstrap token
- cleared recent exec history

Do not reset for routine reconnect or credential refresh issues first; retry the
normal launch path before burning the current identity.

## Current limits review

These are the practical Day 7 limits to keep in mind when validating or sizing deployments.

### Exec and output limits

- stdout cap: `128 KiB` by default
- stderr cap: `128 KiB` by default
- stdin cap: `64 KiB` by default
- exec timeout defaults to `30s`, capped at `300s`
- large outputs are truncated intentionally and surfaced through metadata and session warnings

### File-transfer limits

- file read/write cap: `10 MiB` per operation by default
- allowed-root enforcement is always on for file operations
- symlink escapes outside allowed roots are blocked

### PTY limits

- Linux/macOS PTY uses Bun's Terminal API through the default runtime path
- PTY is advertised on supported POSIX hosts and stays hidden on Windows
- max concurrent PTY sessions: `4` by default
- resize is supported on the live PTY session

### Long-lived session limits

- in-memory session logs retain `256` chunks by default
- each stored/sent session log chunk is clipped to `8 KiB`
- runtime sessions are in-memory only and do not survive process restart