# OR3 Node Agent — Smoke Test Guide

Quick walkthrough from install to first remote command.

## Prerequisites

- Bun v1.1+ installed
- A running `or3-net` control plane (local or remote)
- Network connectivity between the agent machine and the control plane

## 1. Install

```bash
bun install -g or3-node
```

Verify installation:

```bash
or3-node --help
```

## 2. System Info

Check the agent environment:

```bash
or3-node info
```

This shows version, platform, arch, memory, CPU cores, and which capabilities
(exec, file-read, file-write, pty, service-launch) are available.

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

## 4. Non-Interactive Launch

For automation:

```bash
or3-node launch \
  --url http://localhost:3100 \
  --token <bootstrap-token> \
  --name my-dev-box \
  --no-interactive
```

## 5. Check Status

```bash
or3-node status
# Shows: node id, approval status, credential expiry

or3-node doctor
# Shows: control plane url, bootstrap token, identity, credential state
```

## 6. Approve the Node (Control Plane Side)

After enrollment, the node is "pending". Approve it:

```bash
curl -X POST http://localhost:3100/v1/workspaces/ws_xxx/nodes/<node-id>/approve \
  -H 'Authorization: Bearer <admin-token>'
```

## 7. Verify Connection Health

Check node health from the control plane:

```bash
curl http://localhost:3100/v1/workspaces/ws_xxx/nodes/<node-id> \
  -H 'Authorization: Bearer <admin-token>'
```

The response includes `connection.health_status` and `connection.last_seen_at`.

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

## 9. Troubleshooting

| Symptom                   | Check                                               |
| ------------------------- | --------------------------------------------------- |
| "not enrolled" in status  | Run `or3-node launch` with a valid bootstrap token  |
| Node stays "pending"      | Approve the node from the control plane             |
| "credential expired"      | Re-run `or3-node launch` to refresh credentials     |
| Connection health "stale" | Verify network between agent and control plane      |
| PTY not available         | Check `or3-node info` — PTY requires Linux or macOS |

## 10. Reset Identity

To start fresh (new keypair, re-enroll):

```bash
or3-node reset
```
