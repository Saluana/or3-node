# OR3 Node Agent — End-to-End Release Validation

This is the Day 7 validation pass for `or3-node`.

Goal: run one repeatable pass that covers install, launch, approval, connect,
execute, abort, reconnect, and final cleanup with explicit expected results.

## Scope

This validation pass is intentionally practical rather than fully automated.

It combines:

- the contributor verification flow in [smoke-test.md](smoke-test.md)
- live foreground execution for transport visibility
- one abort exercise
- one reconnect exercise
- final cleanup and release signoff

## Prerequisites

- Bun installed
- a reachable `or3-net` control plane
- admin ability to mint bootstrap tokens and approve nodes
- a clean local machine state, or willingness to reset local node state first

## 1. Clean start

```bash
or3-node reset
or3-node info
```

Expected result:

- local state is empty
- `info` shows the correct package version
- `capabilities` are truthful for the current config

## 2. Install and help surface

```bash
bun install
bun run index.ts --help
```

Expected result:

- install succeeds
- help output lists `launch`, `doctor`, `info`, `status`, and `reset`

## 3. Enroll and launch

Run:

```bash
or3-node launch --url http://localhost:3100
```

Expected result:

- a local identity is created
- the CLI prints a manifest node id
- if approval is pending, the CLI says so clearly

## 4. Approve and verify credential issuance

Approve the node in the control plane, then rerun:

```bash
or3-node launch
or3-node status
```

Expected result:

- `approval: approved`
- `credential: valid`
- local `credentials.json` exists

## 5. Connect in foreground

```bash
or3-node launch --foreground --no-interactive
```

Expected result:

- the node enters the live transport loop
- structured logs show `transport.connect`
- control-plane health becomes current instead of stale

## 6. Execute a remote command

Use the control-plane runtime API to create a session and run a command.

Expected result:

- stdout matches the command output
- local logs show execution lifecycle events
- the node remains healthy after execution

## 7. Exercise PTY on supported hosts

On Linux/macOS, use the control-plane runtime-session PTY route to open a PTY,
write a simple command such as `printf 'hello from pty\n'`, and then close it.

Expected result on Linux/macOS:

- `or3-node info` advertises `pty`
- PTY output streams back through the runtime-session PTY endpoint
- PTY exit is observed after close or process termination

Expected result on Windows:

- `or3-node info` does not advertise `pty`
- PTY open fails clearly with an unsupported-capability/platform error

## 8. Abort a running command

Trigger a long-running remote exec, then send an abort.

Good test commands:

- `sleep 30`
- `python3 -c 'import time; time.sleep(30)'`

Expected result:

- the request is acknowledged
- the command terminates early
- local logs show an abort or disconnected execution path instead of hanging forever

## 9. Reconnect exercise

With the foreground loop running:

- temporarily stop the control plane or block the node’s network path
- restore connectivity

Expected result:

- local logs show `transport.disconnect`
- reconnect scheduling logs include backoff delays
- once connectivity returns, `transport.connect` appears again
- shutdown during reconnect wait does not hang through the whole backoff window

## 10. Restart behavior verification

Restart the node process and re-run:

```bash
or3-node doctor
or3-node status
or3-node launch --foreground --no-interactive
```

Expected result:

- identity persists across restart
- near-expiry credentials refresh on restart
- revoked approval clears stale runtime credentials on the next launch
- in-memory runtime sessions do not survive restart and are treated as cleaned up

## 11. Final cleanup

```bash
or3-node reset
```

Expected result:

- local files return to clean-state behavior for the next pass

## Signoff checklist

- install path works
- launch path works
- approval path works
- connection path works
- execute path works
- PTY path matches the platform support matrix
- abort path works
- reconnect path works
- restart semantics match expectations
- cleanup returns the machine to a known local state