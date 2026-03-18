# or3-node Weekly Scrum List

This plan was built by comparing the `or3-net` planning docs in `planning/node-agent/{requirements,design,technical-details,tasks}.md` on the `or3-sandbox-removal` branch with the current `or3-node` codebase.

## What stood out during analysis

### Biggest UX / DX gaps

- `or3-node launch` still ends with `agent loop: not yet started in this phase`, so the main happy-path command does not yet do the thing the plan says it should do.
- `--foreground` is parsed, but it is not used to change behavior yet.
- The planning docs call out `service install` / `service uninstall`, but the current CLI only exposes `launch`, `doctor`, `info`, `status`, and `reset`.
- `doctor` and `status` report stored data, but they do not yet tell the operator whether the agent is actually connected right now.
- Structured logging exists in `src/utils/logger.ts`, but it is not wired into the CLI or transport flow, which makes debugging much harder than it needs to be.

### Obvious bugs or mismatches

- `src/info/agent-info.ts` reports `version: "1.0.0"`, while `package.json` says `0.1.0`.
- `reset` only removes the identity file today; it does not clearly reset config, credential, or local state, which can create confusing half-reset behavior.
- Session logs in `src/transport/agent-loop.ts` are appended in memory without a visible cap.
- Reconnect backoff in `src/transport/agent-loop.ts` starts at 100 ms and caps at 1 second, while the planning docs recommend a slower, jittered backoff envelope.

### Performance / reliability wins

- Bound in-memory session log retention so long-lived sessions do not quietly grow RAM usage.
- Add jittered reconnect backoff to reduce thundering-herd reconnect patterns and noisy logs.
- Stream and cap file and output payloads consistently so large tasks do not create memory spikes.
- Expose recent connection failures and last-known health directly in the CLI so support loops are faster.

## Day 1 — Make the main command trustworthy

- [x] Make `or3-node launch` actually start the agent loop after enrollment when the node has a valid credential.
- [x] Make `--foreground` do real work instead of being a no-op flag.
- [x] Update `doctor` and `status` copy so the next action is obvious when approval is still pending.
- [x] Add or update tests for launch behavior, pending approval, and credential-present startup flow.

## Day 2 — Fix the most visible paper cuts

- [x] Replace the hard-coded version in `src/info/agent-info.ts` with the package version.
- [x] Decide what `reset` should mean, then implement a true reset that clears identity, credentials, and related persisted local state safely.
- [x] Improve CLI output so operators can see whether the node is enrolled, approved, connected, or expired without reading source code.
- [x] Add regression tests for `reset`, `info`, and `status`.

## Day 3 — Make debugging much easier

- [x] Wire `src/utils/logger.ts` into bootstrap, approval, connection, execution, PTY, and file-operation flows.
- [x] Ensure logs classify failures clearly: config, bootstrap, approval, credential, transport, exec, capability mismatch, and path violation.
- [x] Add a documented log format example to the README or docs so operators know what they are looking at.
- [x] Add tests around structured logging for the highest-value lifecycle events.

## Day 4 — Reduce connection and memory risk

- [ ] Add jittered reconnect backoff, closer to the planning recommendation of starting slower and backing off longer.
- [ ] Add bounded retention for in-memory session logs in `src/transport/agent-loop.ts`.
- [ ] Surface truncation warnings when stdout or stderr is capped so users know results are partial.
- [ ] Add focused tests for reconnect behavior, truncation signaling, and session-log retention.

## Day 5 — Tighten feature truthfulness and capability reporting

- [ ] Review capability advertisement so `info` and manifests reflect what the platform can really do today.
- [ ] Make sure file, PTY, and service capabilities are only shown when they are truly enabled.
- [ ] Clarify the supported platform matrix for Linux, macOS, and Windows in docs, matching the planning tasks that are still open.
- [ ] Add tests for capability gating and platform-specific fallbacks.

## Day 6 — Improve onboarding and operations

- [ ] Add service-manager guidance for `systemd`, `launchd`, and Windows service usage as a follow-up path after the simple `launch` workflow.
- [ ] Turn the smoke flow into a more repeatable end-to-end verification path for contributors.
- [ ] Document how approval, credential refresh, reconnect, and stale-health recovery are expected to work in real life.
- [ ] Add a troubleshooting section focused on the first 30 minutes after install.

## Day 7 — Close the release-confidence gap

- [ ] Add an end-to-end validation pass that covers install, launch, approve, connect, execute, abort, and reconnect.
- [ ] Verify restart behavior for identity persistence, credential expiry, revocation, and stale session cleanup.
- [ ] Review file-transfer and PTY limits for large-output and long-lived-session cases.
- [ ] Turn the week’s findings into a short release-readiness checklist for future iterations.

## Recommended order of attack

1. Make `launch` real.
2. Fix operator trust issues (`version`, `reset`, `status`, `doctor`).
3. Wire logging and connection diagnostics.
4. Bound memory and reconnect behavior.
5. Tighten capability truthfulness and cross-platform docs.
6. Finish service/install guidance and end-to-end validation.
