# OR3 Node Agent — Release Readiness Checklist

Use this as the short Day 7 release-confidence checklist.

## Core behavior

- `launch` enrolls and starts the agent loop when valid credentials exist
- `doctor`, `info`, `status`, and `reset` all match current runtime truth
- foreground launch remains the canonical reliable runtime path

## Identity and credentials

- identity persists across restart
- credentials stay out of `state.json`
- expired or near-expiry credentials refresh on launch
- revoked approval clears stale runtime credentials

## Transport and execution

- connect, disconnect, reconnect, execute, and abort are observable in logs
- reconnect backoff is jittered and abort-aware
- large stdout/stderr results surface truncation instead of failing silently
- session log retention is bounded

## Capability truthfulness

- file capability is only advertised when enabled and wired
- PTY remains hidden until Bun Terminal-backed implementation is complete
- service-launch remains hidden until the service story is stronger than today’s scaffold

## Limits and known constraints

- exec stdout cap: 128 KiB by default
- exec stderr cap: 128 KiB by default
- exec stdin cap: 64 KiB by default
- file read/write cap: 10 MiB by default
- PTY session cap: 4 concurrent sessions by default
- session log retention: 256 chunks, clipped to 8 KiB per chunk by default

## Docs and handoff

- contributor verification guide is current
- service-manager guide is current
- operations and troubleshooting guide is current
- release validation pass is current

## Ship / no-ship call

Ship only if:

- the Day 7 validation pass succeeds end-to-end
- no known truthfulness mismatch remains in CLI or docs
- current PTY and service limitations are documented, not implied away