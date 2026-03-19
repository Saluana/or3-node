# OR3 Node Agent — Contributor Verification Guide

Repeatable contributor walkthrough from clean install to first remote command.

Goal: make it easy to verify the main happy path, expected status output, and
basic recovery flows without guessing what "good" looks like.

## Prerequisites

- Bun v1.1+ installed
- A running `or3-net` control plane (local or remote)
- Network connectivity between the agent machine and the control plane

## Reset to a known state

Before re-running this guide, start clean:

```bash
or3-node reset
```

Expected result:

- local identity removed
- enrollment metadata removed
- runtime credentials removed
- bootstrap token removed
- exec history removed

## 1. Install

```bash
bun install -g or3-node
```

Verify installation:

```bash
or3-node --help
```

Expected result:

- help output lists `launch`, `doctor`, `info`, `status`, and `reset`

## 2. System Info

Check the agent environment:

```bash
or3-node info
```

This shows version, platform, arch, memory, CPU cores, and which capabilities
(exec always, plus file-read/file-write when `allowedRoots` is configured) are available.

Expected result:

- `version` matches the package version
- `connection: unknown`
- `capabilities: exec` unless file operations were explicitly configured

## 3. First Launch (Interactive)

```bash
or3-node launch --url http://localhost:3100
```

If no bootstrap token is stored, the CLI will prompt for one. You can generate
a bootstrap token from the control plane:

```bash
curl -X POST http://localhost:3100/v1/workspaces/ws_xxx/nodes/bootstrap-tokens \
  -H 'Authorization: Bearer <admin-token>'
```

Use the returned token when prompted.

Expected result:

- the CLI prints the control-plane URL, identity prefix, and manifest node id
- if approval has not happened yet, the CLI explains that the node is pending
- no manual config-file editing is required

## 4. Non-Interactive Launch

For automation:

```bash
or3-node launch \
  --url http://localhost:3100 \
  --token <bootstrap-token> \
  --name my-dev-box \
  --no-interactive
```

Expected result:

- config persists locally
- the command can be repeated without being re-prompted

## 5. Check Status

```bash
or3-node status
# Shows: node id, approval status, credential expiry

or3-node doctor
# Shows: control plane url, bootstrap token, identity, credential state
```

Expected result before approval:

- `approval: pending`
- `credential: missing`
- next-step guidance to approve the node in `or3-net`

Expected result after approval and successful re-launch:

- `approval: approved`
- `credential: valid`

## 6. Approve the Node (Control Plane Side)

After enrollment, the node is "pending". Approve it:

```bash
curl -X POST http://localhost:3100/v1/workspaces/ws_xxx/nodes/<node-id>/approve \
  -H 'Authorization: Bearer <admin-token>'
```

Then rerun:

```bash
or3-node launch
```

Expected result:

- runtime credentials are issued or refreshed
- the background or foreground launch path can start the live agent loop

## 7. Verify Connection Health

Check node health from the control plane:

```bash
curl http://localhost:3100/v1/workspaces/ws_xxx/nodes/<node-id> \
  -H 'Authorization: Bearer <admin-token>'
```

The response includes `connection.health_status` and `connection.last_seen_at`.

Expected result:

- a healthy node shows recent `last_seen_at`
- a stale node usually means the process is not running, cannot reconnect, or is pointed at the wrong control plane

## 8. Execute a Remote Command

Through the runtime session API:

```bash
# Create a session
curl -X POST http://localhost:3100/v1/workspaces/ws_xxx/runtime/remote-node-agent/sessions \
  -H 'Authorization: Bearer <admin-token>' \
  -H 'Content-Type: application/json' \
  -d '{"config": {"workspace_mode": "none", "network_policy": {"internet_access": false, "ingress": "none"}, "resource_hints": {"metadata": {}}, "persistence_mode": "ephemeral", "env_refs": [], "secret_refs": [], "timeout_rules": {}, "artifact_rules": {"capture_paths": [], "push_on_completion": false, "metadata": {}}}}'

# Execute within the session
curl -X POST http://localhost:3100/v1/workspaces/ws_xxx/runtime/remote-node-agent/sessions/<session-ref>/exec \
  -H 'Authorization: Bearer <admin-token>' \
  -H 'Content-Type: application/json' \
  -d '{"command": "echo", "args": ["hello from remote node"], "env": {}, "background": false}'
```

Expected result:

- stdout contains `hello from remote node`
- the node remains healthy after execution
- structured logs show execution lifecycle events locally

## 9. Contributor verification checklist

Treat the run as complete when all of these are true:

- `or3-node info` works from a clean install
- `or3-node launch` enrolls without hand-editing local files
- pending approval is obvious in `doctor` and `status`
- approval + rerun produces a valid credential
- the node reaches healthy connection state in the control plane
- one remote command executes successfully
- `or3-node reset` returns the machine to a clean local state

## 10. Cleanup

```bash
or3-node reset
```

If you used a service manager for local testing, stop and disable that service
before the next verification cycle.

## 11. Troubleshooting

| Symptom                   | Check                                               |
| ------------------------- | --------------------------------------------------- |
| "not enrolled" in status  | Run `or3-node launch` with a valid bootstrap token  |
| Node stays "pending"      | Approve the node from the control plane             |
| "credential expired"      | Re-run `or3-node launch` to refresh credentials     |
| Connection health "stale" | Verify network between agent and control plane      |
| PTY not available         | Expected today — full PTY is not advertised until the Bun Terminal implementation lands on Linux/macOS |

For more day-to-day operational behavior and recovery guidance, see
[docs/operations.md](operations.md). 
