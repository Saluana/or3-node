# OR3 Node Agent — Platform Support and Packaging Matrix

This document closes the Phase 14 cross-platform and packaging decisions for `or3-node`.

## Primary packaging story

The default install and runtime path is Bun-first:

```bash
bun install -g or3-node
or3-node launch
```

That is the primary operator story for v1.

Service managers are a follow-up deployment shape after the agent already works interactively:

- Linux: `systemd`
- macOS: `launchd`
- Windows: Task Scheduler or NSSM today

See [docs/service-management.md](service-management.md) for those follow-up paths.

## Trusted-machine boundary

`or3-node` runs in **host-trusted mode**.

That means:

- it is meant for machines you control and trust
- safety comes from explicit capability gating, allowed roots, byte caps, timeouts, and concurrency limits
- it is **not** a hostile-code sandbox
- it does **not** claim multi-tenant isolation on the host

Practical guidance:

- use a dedicated VM, workstation, or server when the trust boundary matters
- enable only the capabilities you intend to expose
- keep `allowedRoots` narrow when file access is enabled
- treat runtime credentials and machine access as sensitive operator authority

## v1 support matrix

Legend:

- **Supported**: expected to work and included in the v1 story
- **Conditional**: supported only when explicitly enabled or when platform/runtime requirements are met
- **Disabled**: intentionally not advertised in v1

| Capability / behavior | Linux | macOS | Windows | Notes |
| --- | --- | --- | --- | --- |
| Global Bun install | Supported | Supported | Supported | Primary packaging story is `bun install -g or3-node`. Ensure Bun global bin is on `PATH`. |
| `or3-node launch` / `doctor` / `info` / `status` / `reset` | Supported | Supported | Supported | Core operator workflow for v1. |
| Enrollment, approval handoff, credential refresh | Supported | Supported | Supported | Same control-plane model across platforms. |
| Outbound `outbound-wss` transport | Supported | Supported | Supported | Primary live connection path for v1. |
| HTTPS fallback transport | Supported | Supported | Supported | Dev/fallback transport only, not the preferred production path. |
| Leased exec / runtime-session create-exec-destroy-logs | Supported | Supported | Supported | Core remote-machine control path. |
| File read / write / copy in / copy out | Conditional | Conditional | Conditional | Enabled only when `allowedRoots` is configured; always bounded by allowed-root and byte-cap checks. |
| PTY | Supported | Supported | Disabled | PTY relies on Bun Terminal APIs that are POSIX-only in the current v1 implementation. |
| Service launch / preview-backed service exposure | Disabled by default | Disabled by default | Disabled by default | Release-gated and test-covered, but still hidden as a default advertised capability until the service-manager story is stronger. |
| Foreground launch as canonical runtime path | Supported | Supported | Supported | `or3-node launch --foreground --no-interactive` is the most trustworthy managed command. |
| Managed service wrapper follow-up | `systemd` follow-up | `launchd` follow-up | Task Scheduler / NSSM follow-up | Follow-up operational shape, not the primary packaging story. |

## Platform notes

### Linux

Linux is the richest v1 target:

- exec, file access, runtime sessions, and PTY are all available
- `systemd` is the preferred long-running service wrapper after interactive validation
- this is the recommended first production platform when the full capability set is required

### macOS

macOS supports the same core machine-control path as Linux except that service management follows the `launchd` story instead of `systemd`.

- PTY is supported
- file access is supported when enabled
- foreground launch should be proven before wrapping with `launchd`

### Windows

Windows supports the core operator flow:

- Bun global install
- launch / doctor / info / status / reset
- enrollment, approval, credential refresh
- live outbound connection
- exec and file control when enabled

Current v1 caveats:

- PTY is intentionally hidden
- Windows service management is still a follow-up path rather than a polished first-class wrapper
- use a foreground validation pass before introducing Task Scheduler or NSSM

## Packaging guidance

The packaging order for v1 is:

1. Bun global install
2. interactive or non-interactive `or3-node launch`
3. approve the node in `or3-net`
4. verify one real remote command
5. only then wrap the foreground launch path with a service manager

Do not invert that order.

The service-manager guides exist to operationalize a known-good foreground command, not to replace the Bun-first onboarding story.
