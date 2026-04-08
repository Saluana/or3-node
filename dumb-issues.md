# Neckbead Review — or3-node

---

## 1. `toErrorMessage` copy-pasted five times

**Files:**

- `src/cli/index.ts:520`
- `src/host-control/files.ts:295`
- `src/host-control/pty.ts:191`
- `src/host-control/service.ts:373`
- `src/transport/agent-loop.ts:1009`

**Snippet:**

```ts
const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";
```

**Why this is bad:**
Five identical copies of the same trivial helper, each `const`-scoped per file. This is the textbook case for a shared utility. When someone inevitably needs to also extract `error.cause` or `error.code`, they have to remember to fix all five call sites—and they won't.

**Consequences:**
Divergence across copies over time. One file gets a richer error message, the rest stay stale. Grep catches it, code review doesn't.

**Fix:**
Export one `toErrorMessage` from `src/utils/errors.ts` and import it everywhere.

---

## 2. `isMissingFileError` copy-pasted three times

**Files:**

- `src/config/store.ts:136-137`
- `src/identity/store.ts:54-55`
- `src/info/connection-state.ts:57-58`

**Snippet:**

```ts
const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
```

**Why this is bad:**
Same logic, same shape, same bug surface. The `"code" in error` guard is also slightly fragile—TypeScript won't narrow `error` to `{ code: string }` from the `in` check alone. Repeating this three times just means three places to forget to update if someone wants to handle `EACCES` similarly.

**Consequences:**
Inconsistent error handling if one copy changes. Missed error codes in some call sites but not others.

**Fix:**
Move to `src/utils/errors.ts`:

```ts
export const isFileNotFoundError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
```

---

## 3. `toSnapshot` duplicated in two files

**Files:**

- `src/host-control/history.ts:38-52`
- `src/host-control/service.ts:357-371`

**Why this is bad:**
Both functions do the exact same field-by-field copy from `HostExecResult` to `HostExecSnapshot`. If someone adds a new field to `HostExecSnapshot`, they need to update both mappers. They will only find one.

**Consequences:**
Future fields silently missing from snapshots in one of the two paths. Debugging "why did the exec history lose the new field" wastes hours.

**Fix:**
Export a single `toExecSnapshot` from `src/host-control/types.ts` or `src/host-control/history.ts`.

---

## 4. Platform check duplicated across `pty.ts` and `runtime-capabilities.ts`

**Files:**

- `src/host-control/pty.ts:70`
- `src/runtime-capabilities.ts:37-38`

**Snippet (pty.ts):**

```ts
public isSupported(): boolean {
  return process.platform === "linux" || process.platform === "darwin";
}
```

**Snippet (runtime-capabilities.ts):**

```ts
export const isPtySupportedPlatform = (): boolean =>
  process.platform === "linux" || process.platform === "darwin";
```

**Why this is bad:**
Two independent truth sources for "does this platform support PTY." If someone adds FreeBSD support, they update one and not the other. The capability advertisement and the actual service disagree, and the control plane sends PTY requests to a machine that can't handle them (or vice versa).

**Consequences:**
Capability advertisement lies. The control plane routes PTY work to a node that rejects it, or hides PTY from a node that supports it.

**Fix:**
Have `HostPtyService.isSupported()` call `isPtySupportedPlatform()` from `runtime-capabilities.ts`, or vice versa.

---

## 5. `appendBounded` re-encodes entire accumulated output on every chunk

**File:** `src/host-control/service.ts:340-355`

**Snippet:**

```ts
const appendBounded = (
  existing: string,
  chunk: string,
  maxBytes: number,
): { value: string; truncated: boolean } => {
  const nextValue = `${existing}${chunk}`;
  const nextBuffer = Buffer.from(nextValue, "utf8");
  if (nextBuffer.byteLength <= maxBytes) {
    return { value: nextValue, truncated: false };
  }
  return {
    value: truncateUtf8(nextValue, maxBytes),
    truncated: true,
  };
};
```

**Why this is bad:**
Every single `data` event on stdout/stderr, this function concatenates the entire accumulated output, then encodes the entire thing into a new `Buffer` just to check byte length. For a command that produces 120 KiB of output, the final chunks are re-encoding ~120 KiB of text every time. This is O(n²) total work over the life of the process.

**Consequences:**
CPU spikes during chatty commands. Unnecessary GC pressure from throwaway buffers. For the 128 KiB default cap this is tolerable but embarrassing. For any future cap increase it gets worse fast.

**Fix:**
Track `usedBytes` as an integer alongside `existing`. Only encode the new chunk to check if it fits:

```ts
const chunkBytes = Buffer.byteLength(chunk, "utf8");
if (usedBytes + chunkBytes <= maxBytes) {
  return { value: existing + chunk, usedBytes: usedBytes + chunkBytes, truncated: false };
}
```

---

## 6. `truncateUtf8` uses string concatenation in a loop

**File:** `src/utils/utf8.ts:1-20`

**Snippet:**

```ts
let truncated = "";
for (const character of value) {
  const characterBytes = Buffer.byteLength(character, "utf8");
  if (usedBytes + characterBytes > maxBytes) {
    break;
  }
  truncated += character;
  usedBytes += characterBytes;
}
return truncated;
```

**Why this is bad:**
String concatenation in a loop creates a new string allocation for every character. For a 128 KiB string, this is 128K+ allocations. JavaScript engines optimize `+=` in some cases, but not reliably with this pattern where `Buffer.byteLength` is called between each concat.

**Consequences:**
Slow truncation of large outputs. Combined with issue #5, this means truncation of a full 128 KiB buffer is doing character-by-character work after already doing an O(n²) accumulation.

**Fix:**
Use `Buffer.from(value).subarray(0, maxBytes).toString("utf8")` for a single-pass truncation that respects multi-byte boundaries (Node/Bun decoders handle incomplete sequences). Or at minimum, collect chars into an array and `.join("")` at the end.

---

## 7. `state.json` written without restricted file permissions

**File:** `src/config/store.ts:106`

**Snippet:**

```ts
await fs.writeFile(stateFilePath, `${JSON.stringify(persistedState, null, 2)}\n`, "utf8");
```

**Why this is bad:**
`config.json` gets `mode: 0o600`. `credentials.json` gets `mode: 0o600`. `identity.json` gets `mode: 0o600`. But `state.json`, which contains the `nodeId`, `enrolledAt`, `approvedAt`, and expiration metadata, is written world-readable (subject to umask). On a shared host with a permissive umask, any user can read the node's enrollment state.

**Consequences:**
Information disclosure on multi-user systems. The `nodeId` is used in API requests—leaking it narrows the attack surface for an adversary who wants to impersonate or target this node.

**Fix:**

```ts
await fs.writeFile(stateFilePath, `${JSON.stringify(persistedState, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
```

---

## 8. Redundant `chmod` after `writeFile` with `mode`

**Files:**

- `src/config/store.ts:47` (after writeFile on line 43 with `mode: 0o600`)
- `src/config/store.ts:124` (after writeFile on line 112 with `mode: 0o600`)
- `src/identity/store.ts:45` (after writeFile on line 41 with `mode: 0o600`)

**Snippet:**

```ts
await fs.writeFile(configFilePath, ..., { encoding: "utf8", mode: 0o600 });
await fs.chmod(configFilePath, 0o600);
```

**Why this is bad:**
`writeFile` with `mode` already sets the file permissions on creation (modulo umask). The follow-up `chmod` is a belt-and-suspenders approach that makes sense if you're worried about umask, but it's not documented as intentional. It looks like the author didn't know that `mode` existed and someone added it later without removing the `chmod`.

The actual risk: between `writeFile` finishing and `chmod` executing, the file briefly exists with umask-affected permissions. If the intent was to guarantee 0o600 even with a loose umask, the correct approach is `chmod` only (or set umask before write).

**Consequences:**
Extra syscall on every write. False sense of security if umask is the concern—the race window still exists.

**Fix:**
Keep only the `chmod` call (the one that's guaranteed regardless of umask), or document the belt-and-suspenders intent.

---

## 9. No runtime validation of JSON parsed from disk

**Files:**

- `src/config/store.ts:30` — `JSON.parse(content) as Partial<NodeAgentConfig>`
- `src/config/store.ts:74` — `JSON.parse(stateContent) as Partial<NodeAgentState>`
- `src/identity/store.ts:17` — `JSON.parse(content) as NodeIdentityRecord`
- `src/info/connection-state.ts:23` — `JSON.parse(content) as Partial<PersistedConnectionState>`

**Why this is bad:**
Every file read trusts the JSON shape completely via `as` casts. If a file is corrupted, hand-edited, or tampered with, the agent gets an object with missing or wrong-typed fields. For `identity.json` this means potentially passing a non-string into crypto operations. For `config.json` this means `allowedRoots` might not be an array, which would bypass path policy checks entirely.

The project already uses Zod (`nodeTransportFrameSchema.parse`) for transport frames. The disk files—which are equally untrusted—get no validation at all.

**Consequences:**
Silent corruption. A malformed `config.json` with `"allowedRoots": "/tmp"` (string instead of array) would make `allowedRoots.length` return 4 instead of 1, and `.some()` would iterate characters instead of paths. Path policy becomes meaningless.

**Fix:**
Add Zod schemas (or at minimum manual type guards) for each persisted file. Fail loudly on invalid shapes.

---

## 10. `resolveLaunchConfig` spread is a no-op for two fields

**File:** `src/cli/index.ts:387-394`

**Snippet:**

```ts
return {
  ...merged,
  controlPlaneUrl: merged.controlPlaneUrl,
  bootstrapToken:
    merged.bootstrapToken ??
    resolveOptionalPromptValue(promptImpl, "Bootstrap token (leave empty to skip)", null),
  nodeName: merged.nodeName,
};
```

**Why this is bad:**
`controlPlaneUrl: merged.controlPlaneUrl` and `nodeName: merged.nodeName` are explicitly setting properties to the same values they already have from the spread. This is dead code that looks like it should be doing something (maybe prompting for those values too?). It makes a reader stop and wonder what's going on.

**Consequences:**
Confusion during future edits. Someone will add a prompt for `nodeName` here and think the pattern was intentional scaffolding, or they'll remove the duplicates and break something they didn't understand.

**Fix:**

```ts
return {
  ...merged,
  bootstrapToken:
    merged.bootstrapToken ??
    resolveOptionalPromptValue(promptImpl, "Bootstrap token (leave empty to skip)", null),
};
```

---

## 11. `completedExecs` map in `HostControlService` grows forever

**File:** `src/host-control/service.ts:34`

**Snippet:**

```ts
private readonly completedExecs = new Map<string, HostExecResult>();
```

Results are added at lines 233 and 270 but never removed:

```ts
this.completedExecs.set(execId, result);
```

**Why this is bad:**
Every completed exec stays in memory forever. Each result includes full stdout and stderr (up to 128 KiB each). A long-running agent that processes 1000 jobs accumulates ~256 MB of dead exec results that are never cleaned up.

**Consequences:**
Memory leak proportional to job count × output size. On a busy node this will eventually OOM the process.

**Fix:**
Add a maximum completed results count (e.g., 100), evicting the oldest on overflow. Or use a TTL-based eviction. Or just delete results after they're returned to the caller.

---

## 12. Agent sessions in `NodeAgentLoop` are never garbage collected

**File:** `src/transport/agent-loop.ts:78`

```ts
private readonly sessions = new Map<string, AgentSession>();
```

Sessions are created via `handleCreateSession` (line 403) and only removed via `handleDestroySession` (line 434). If the control plane creates sessions and never explicitly destroys them, they accumulate forever—including their log arrays.

**Why this is bad:**
The control plane may crash, disconnect, or simply never send `destroy_session`. Each session carries a log buffer (bounded per-session, but the session count is unbounded). This is a memory leak behind an API contract that may not be honored.

**Consequences:**
Memory leak proportional to session count. A misbehaving control plane (or network partition that prevents destroy messages) slowly exhausts agent memory.

**Fix:**
Add a maximum session count with LRU eviction, or add a session TTL that auto-destroys stale sessions. Alternatively, clear sessions on reconnect (line 150 already clears PTY state on reconnect—sessions should get the same treatment).

---

## 13. `exec()` method signature is `Promise<HostExecHandle>` but never awaits

**File:** `src/host-control/service.ts:57`

**Snippet:**

```ts
public exec(input: HostExecRequest): Promise<HostExecHandle> {
  try {
    // ...synchronous validation...
    return Promise.resolve({
      execId,
      result,
      abort: (): Promise<void> => {
        this.activeExecs.get(execId)?.abort();
        return Promise.resolve();
      },
    });
  } catch (error: unknown) {
    this.logExecSetupFailure(input, error);
    throw error;
  }
}
```

**Why this is bad:**
The method returns `Promise<HostExecHandle>` but the body is entirely synchronous. It wraps the return in `Promise.resolve()` and the abort in `Promise.resolve()` manually. The ESLint config has `@typescript-eslint/require-await: "error"`, so this is likely written this way to satisfy the interface—but the interface shouldn't require a Promise for a synchronous setup operation.

**Consequences:**
Misleading API. Callers `await` a value that's already resolved, adding a microtask hop for no reason. The `catch` block throws synchronously, which means callers need to handle both sync throws and async rejections.

**Fix:**
Either make the method synchronous (returning `HostExecHandle` directly) and update the interface, or add `async` and let the runtime handle the wrapping. The current pattern of sync `throw` + `Promise.resolve()` return is a footgun for callers.

---

## 14. `env-policy.ts` uses `Array.includes()` for allowlist lookup

**File:** `src/host-control/env-policy.ts:7`

**Snippet:**

```ts
const disallowed = Object.keys(requestedEnv).filter((name) => !allowedNames.includes(name));
```

**Why this is bad:**
`Array.includes()` is O(n) per lookup. For `k` requested env vars and `m` allowed names, this is O(k × m). The allowlist could easily be 20+ entries, and env vars passed could be 10+. This should be a Set lookup.

**Consequences:**
Not a performance problem at today's scale, but it's the kind of thing that shows carelessness about data structure choice. It also means equality checks are string reference-sensitive (though that's fine for env var names).

**Fix:**

```ts
const allowedSet = new Set(allowedNames);
const disallowed = Object.keys(requestedEnv).filter((name) => !allowedSet.has(name));
```

---

## 15. `handleIncomingFrame` swallows errors without responding

**File:** `src/transport/agent-loop.ts:158-165`

**Snippet:**

```ts
socket.onmessage = (event) => {
  void this.handleIncomingFrame(socket, event.data).catch((error: unknown) => {
    this.logger.warn(AgentEvent.FRAME_INVALID, "transport received invalid frame", {
      error: toErrorMessage(error),
      failure_class: "transport",
    });
  });
};
```

**Why this is bad:**
If `JSON.parse` fails or the Zod schema rejects the frame, the error is logged but no response is sent back to the control plane. The control plane sent a request and is waiting for a response that will never come. This creates a silent timeout on the control plane side.

**Consequences:**
Control plane hangs waiting for a response to a malformed or unexpected frame. Eventually times out and may retry, causing duplicate processing or lost commands.

**Fix:**
If the frame can be parsed enough to extract a request ID, send an error response. If not, the log is the best we can do—but add a comment explaining why.

---

## 16. `defaultBackgroundLauncher` is sync but called with `await`

**File:** `src/cli/index.ts:425-438, 232`

**Signature:**

```ts
const defaultBackgroundLauncher = (argv: readonly string[]): void => { ... };
```

**Call site:**

```ts
await (dependencies.backgroundLauncher ?? defaultBackgroundLauncher)([...]);
```

**Why this is bad:**
The function returns `void`, not `Promise<void>`. The `await` resolves immediately but looks like it's waiting for something asynchronous. The interface allows `Promise<void> | void` which is fine, but the default implementation silently swallows the fact that `spawn` with `detached: true` and `stdio: "ignore"` doesn't wait for the child to start. If the spawn fails (e.g., `process.argv[1]` is wrong), the error is thrown synchronously before the `await`, which means it's caught by the surrounding try/catch—so it works, but the code reads misleadingly.

**Consequences:**
The background launch succeeds or fails synchronously, but the code reads as if it's waiting for a result. Future maintainers might add async operations in the launcher and assume the `await` was already working—it is, but only by accident.

**Fix:**
Make the function `async` for clarity, or add a comment explaining the sync nature.

---

## 17. `walkDir` in `HostFileService` does sequential `stat` calls

**File:** `src/host-control/files.ts:234-266`

**Snippet:**

```ts
for (const entry of dirEntries) {
  const fullPath = path.join(dirPath, entry.name);
  if (entry.isDirectory()) {
    entries.push({ path: fullPath, kind: "directory" });
    if (currentDepth < maxDepth) {
      await this.walkDir(fullPath, entries, maxDepth, currentDepth + 1);
    }
  } else if (entry.isFile()) {
    try {
      const stat = await fs.stat(fullPath);
      // ...
```

**Why this is bad:**
Every file in a directory listing triggers a separate `await fs.stat()` sequentially. For a directory with 500 files, this is 500 serial filesystem round-trips. The recursive case makes it worse—each subdirectory is also awaited sequentially.

**Consequences:**
Browse operations on large directories are slow. A `/tmp` directory with hundreds of files takes noticeable time. This will feel broken in a UI that's waiting for a file listing.

**Fix:**
Batch the stat calls with `Promise.all()` (up to a reasonable concurrency limit), or use `readdir` with `{ withFileTypes: true }` which already provides `isFile()`/`isDirectory()`—then stat only when metadata is needed.

---

## 18. `version.ts` uses `createRequire` to read `package.json`

**File:** `src/version.ts:1-6`

**Snippet:**

```ts
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const packageMetadata = require("../package.json") as { version?: string };

export const AGENT_VERSION = packageMetadata.version ?? "0.0.0";
```

**Why this is bad:**
Bun supports `import packageJson from "../package.json"` natively. The `createRequire` hack exists for Node ESM compatibility but adds unnecessary indirection. The `as { version?: string }` cast is also unvalidated.

**Consequences:**
Fragile module resolution. If the relative path changes or the project structure moves, `createRequire(import.meta.url)` resolves differently than a static import would. Minor, but unnecessarily clever.

**Fix:**

```ts
import packageJson from "../package.json";
export const AGENT_VERSION: string = packageJson.version ?? "0.0.0";
```

Or if Node ESM compat is required, keep the current approach but add a comment explaining why.

---

## 19. `resolveStoragePaths()` recomputes paths on every call

**File:** `src/storage/paths.ts:15-35`

**Why this is bad:**
Every call to `loadConfig()`, `loadState()`, `loadIdentity()`, `saveConfig()`, `saveState()`, etc. calls `resolveStoragePaths()`, which re-reads `process.env.HOME`, `process.env.XDG_CONFIG_HOME`, `process.env.XDG_DATA_HOME`, and `os.homedir()` every time. The result is identical within a single process lifecycle (env vars don't change after startup in this agent).

**Consequences:**
Wasted work on every filesystem operation. More importantly, if `HOME` or `XDG_*` env vars were somehow mutated mid-process, different parts of the agent would read from different paths. Not caching means no single-source-of-truth for where files live.

**Fix:**
Compute once at module load time and export the result, or use a lazy singleton:

```ts
let cached: NodeStoragePaths | null = null;
export const resolveStoragePaths = (): NodeStoragePaths => {
  if (cached !== null) return cached;
  // ... compute paths ...
  cached = paths;
  return paths;
};
```

---

## 20. `HostServiceManager` swallows spawn errors silently

**File:** `src/host-control/services.ts:86-89`

**Snippet:**

```ts
child.once("error", () => {
  this.services.delete(serviceId);
  this.onExit?.(serviceId, -1);
});
```

**Why this is bad:**
The `error` event from `spawn` includes the actual `Error` object (e.g., `ENOENT` if the binary doesn't exist, `EACCES` if not executable). This handler throws away the error entirely and just reports exit code -1. There's no logging, no error message forwarding, nothing. The caller has no idea what went wrong.

**Consequences:**
"Service failed with exit code -1" with zero diagnostics. Debugging a typo in the command path requires re-reading the source code to realize errors are swallowed.

**Fix:**
Pass the error message through the exit callback, or add a separate `onError` callback, or at minimum log the error.

---

## 21. `child_process.spawn` return type asserted with `as` instead of using proper types

**Files:**

- `src/host-control/service.ts:147-157`
- `src/host-control/services.ts:64-72`

**Snippet (service.ts):**

```ts
const child = spawn(command, [...args], {
  // ...
}) as {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Writable;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
};
```

**Why this is bad:**
Instead of using `ChildProcess` from `node:child_process` (which already has these types), the code casts to a custom inline type. This hides the full API surface, making it harder to use other `ChildProcess` features. It also means TypeScript won't catch if the actual return type changes.

**Consequences:**
Maintenance burden. Anyone adding features (e.g., reading `child.pid` for monitoring) has to update the inline type assertion. The real types are right there in `@types/node`.

**Fix:**
Use `import type { ChildProcess } from "node:child_process"` and type the variable properly, or don't assert at all—let TypeScript infer the type from `spawn()`.

---

## 22. Structured logs use string literal events but `AgentEvent` constants exist

The `AgentEvent` object in `src/utils/logger.ts:96-148` defines well-known event names. But some log call sites already use these constants. The issue is that `AgentLogger.info` accepts `event: string`—not a union of `AgentEvent` values. There's no type safety ensuring event names are valid.

**File:** `src/utils/logger.ts:31`

```ts
info(event: string, message: string, details?: Record<string, unknown>): void;
```

**Why this is bad:**
The `AgentEvent` constants exist but aren't enforced by the type system. A typo like `logger.info("transpotr.connect", ...)` compiles fine. The constants are advisory, not structural.

**Consequences:**
Log aggregation pipelines that filter on event names will silently miss misspelled events. No compile-time safety for a system designed around structured events.

**Fix:**
Type the `event` parameter as `(typeof AgentEvent)[keyof typeof AgentEvent]` or a union type derived from the constants.

---

## 23. `handleRequest` method is a 120-line switch with mixed sync/async branches

**File:** `src/transport/agent-loop.ts:254-376`

**Why this is bad:**
This single method handles 16 different RPC methods in one switch statement. Some branches are synchronous, some are async. The return type is `Promise<RpcResult>` which means every sync branch gets implicitly wrapped. The method is the routing core of the entire transport layer and it's one monolithic block.

**Consequences:**
Adding a new RPC method means adding another case to an already-long switch. Testing individual handlers requires going through the full dispatch path. The mixed sync/async nature means error handling behavior differs per branch.

**Fix:**
Extract each handler into a method (most already are—`handleFileRead`, `handlePtyOpen`, etc.). The remaining inline handlers (`heartbeat`, `abort`, `handshake`) should get the same treatment. Then the switch becomes a pure dispatch table.

---

## 24. `onStdout`/`onStderr` streaming callbacks are duplicated between `execute` and `session_exec`

**Files:**

- `src/transport/agent-loop.ts:280-317` (execute handler)
- `src/transport/agent-loop.ts:470-507` (session_exec handler)

**Why this is bad:**
The streaming output logic—clip the chunk, append to session log, check if clip warning was already logged, send the event frame—is copy-pasted between the `execute` and `session_exec` handlers. It's ~35 lines of identical logic, duplicated for both stdout and stderr in both handlers. That's effectively 4 copies of the same streaming pattern.

**Consequences:**
If the streaming format changes (e.g., adding a sequence number, changing the event name), four code blocks need updating. This is exactly how streaming bugs diverge between the two execution paths.

**Fix:**
Extract a `createStreamingCallbacks(socket, requestId, sessionId)` factory that returns `{ onStdout, onStderr }`.

---

## 25. `disk_mb` in manifest is hardcoded to 100 GB

**File:** `src/enroll/manifest.ts:31`

**Snippet:**

```ts
resource_limits: {
  max_concurrent_jobs: DEFAULT_MAX_CONCURRENT_JOBS,
  cpu_cores: Math.max(1, os.cpus().length),
  memory_mb: Math.max(512, Math.floor(os.totalmem() / 1024 / 1024)),
  disk_mb: 1024 * 100,
},
```

**Why this is bad:**
CPU and memory are detected from the actual system. Disk is hardcoded to 102,400 MB (100 GB). The manifest is supposed to describe this specific machine's resources. A Raspberry Pi with 16 GB of storage advertises 100 GB. A server with 10 TB advertises 100 GB.

**Consequences:**
The control plane's resource scheduling decisions are based on a lie. Nodes may get assigned work that exceeds their actual disk capacity, or may be underutilized because the advertised capacity is artificially low.

**Fix:**
Use `os.totalmem()` equivalent for disk (e.g., `fs.statfs` on the data directory), or mark it as "unknown" and let the control plane handle the ambiguity. Don't lie.

---

## 26. `buildCapabilities` in manifest.ts is a pointless wrapper

**File:** `src/enroll/manifest.ts:64-66`

**Snippet:**

```ts
const buildCapabilities = (config: NodeAgentConfig): string[] => {
  return getAdvertisedCapabilityList(config);
};
```

**Why this is bad:**
A function that does nothing but call another function. Zero added value. It's not even providing a different signature or type narrowing—it's literally a pass-through.

**Consequences:**
One more function name to grep through. One more level of indirection to trace when debugging capability issues.

**Fix:**
Call `getAdvertisedCapabilityList(config)` directly at the manifest build site.

---

## 27. Token passed as URL query parameter in WebSocket transport

**File:** `src/transport/agent-loop.ts:870-876`

**Snippet:**

```ts
const buildTransportUrl = (baseUrl: string, token: string): string => {
  const url = new URL("/v1/nodes/connect", baseUrl);
  url.protocol =
    url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
};
```

**Why this is bad:**
The runtime credential token is placed in the URL query string. URLs are logged by proxies, load balancers, CDNs, browser history, and server access logs. Even over TLS, the URL (including query parameters) appears in server logs, referrer headers, and connection metadata.

**Consequences:**
Token leakage in infrastructure logs. Any reverse proxy, WAF, or monitoring tool that logs request URLs now has the runtime credential in plaintext. This is a well-known anti-pattern for authentication tokens.

**Fix:**
Pass the token via a WebSocket subprotocol header, or as the first message after connection, or via a standard `Authorization` header if the WebSocket library supports it. If the control plane requires it in the URL, document the security implication and ensure infrastructure is configured to not log query strings.
