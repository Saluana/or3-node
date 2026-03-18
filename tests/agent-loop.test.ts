import { describe, expect, test } from "bun:test";

import { NodeAgentLoop, type WebSocketLike } from "../src/transport/agent-loop.ts";
import { HostControlService } from "../src/host-control/service.ts";
import { createAgentLogger, type LogEntry } from "../src/utils/logger.ts";

const createLogWriter = (): {
  readonly chunks: string[];
  readonly writer: Pick<typeof process.stderr, "write">;
} => {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {
      write: (chunk) => {
        chunks.push(String(chunk));
        return true;
      },
    },
  };
};

const parseLogEntries = (chunks: readonly string[]): LogEntry[] =>
  chunks
    .join("")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogEntry);

class FakeSocket {
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { readonly data: string }) => void) | null = null;
  public onclose: (() => void) | null = null;
  public onerror: ((event: { readonly error?: unknown }) => void) | null = null;
  public readonly outbound: string[] = [];

  public constructor() {
    queueMicrotask(() => {
      this.onopen?.();
    });
  }

  public send(data: string): void {
    this.outbound.push(data);
  }

  public close(): void {
    this.onclose?.();
  }

  public pushInbound(data: string): void {
    this.onmessage?.({ data });
  }
}

class FailingOpenSocket implements WebSocketLike {
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { readonly data: string }) => void) | null = null;
  public onclose: (() => void) | null = null;
  public onerror: ((event: { readonly error?: unknown }) => void) | null = null;
  public readonly outbound: string[] = [];

  public constructor() {
    queueMicrotask(() => {
      this.onerror?.({ error: new Error("failed open") });
      this.onclose?.();
    });
  }

  public send(data: string): void {
    this.outbound.push(data);
  }

  public close(): void {
    this.onclose?.();
  }
}

class ErrorAfterOpenSocket extends FakeSocket {
  public constructor() {
    super();
    queueMicrotask(() => {
      queueMicrotask(() => {
        this.onerror?.({ error: new Error("socket failed after open") });
      });
    });
  }
}

describe("node agent loop", () => {
  test("handles execute, heartbeat, and abort frames over a live socket", async () => {
    const socket = new FakeSocket();
    const loop = new NodeAgentLoop({
      controlPlaneUrl: "http://or3.test",
      credential: { token: "or3n_live", expiresAt: "2099-01-01T00:00:00.000Z" },
      hostControl: new HostControlService(),
      webSocketFactory: () => socket,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });

    const run = loop.connectOnce();
    socket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-create-session",
          method: "create_session",
          params: { session_id: "sess_1", workspace_id: "ws_test" },
        },
      }),
    );
    socket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-heartbeat",
          method: "heartbeat",
        },
      }),
    );
    socket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-exec",
          method: "execute",
          params: {
            workspace_id: "ws_test",
            job_id: "job_exec",
            kind: "runtime-exec",
            instructions: "echo hello",
            artifacts: [],
            tool_policy: { mode: "deny_all", allowed_tools: [], blocked_tools: [] },
            timeout: { soft_ms: 1000 },
            lease_profile: {
              profile_id: "runtime-exec",
              ttl_seconds: 60,
              required_capabilities: ["exec"],
            },
            subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
            metadata: { command: "echo", args: ["hello"], session_id: "sess_1" },
          },
        },
      }),
    );
    socket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-logs",
          method: "get_logs",
          params: { session_id: "sess_1" },
        },
      }),
    );
    socket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-abort",
          method: "abort",
          params: { job_id: "job_exec" },
        },
      }),
    );
    await Bun.sleep(20);
    socket.close();
    await run;

    expect(socket.outbound.some((payload) => payload.includes("req-heartbeat"))).toBeTrue();
    expect(socket.outbound.some((payload) => payload.includes("req-exec"))).toBeTrue();
    expect(socket.outbound.some((payload) => payload.includes("hello"))).toBeTrue();
    expect(socket.outbound.some((payload) => payload.includes("req-logs"))).toBeTrue();
    expect(socket.outbound.some((payload) => payload.includes("req-abort"))).toBeTrue();
  });

  test("retries connection attempts until a later socket opens", async () => {
    const controller = new AbortController();
    const factoryCalls: string[] = [];
    const openedSockets: FakeSocket[] = [];
    const logs = createLogWriter();
    const loop = new NodeAgentLoop({
      controlPlaneUrl: "http://or3.test",
      credential: { token: "or3n_live", expiresAt: "2099-01-01T00:00:00.000Z" },
      hostControl: new HostControlService(),
      logger: createAgentLogger(logs.writer),
      webSocketFactory: (url) => {
        factoryCalls.push(url);
        if (factoryCalls.length === 1) {
          return new FailingOpenSocket();
        }
        const socket = new FakeSocket();
        openedSockets.push(socket);
        queueMicrotask(() => {
          socket.close();
          controller.abort();
        });
        return socket;
      },
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 2,
    });

    await loop.start(controller.signal);

    expect(factoryCalls.length).toBeGreaterThanOrEqual(2);
    expect(openedSockets.length).toBeGreaterThanOrEqual(1);
    const entries = parseLogEntries(logs.chunks);
    expect(entries.some((entry) => entry.event === "transport.connect")).toBe(true);
    expect(entries.some((entry) => entry.event === "transport.reconnect")).toBe(true);
  });

  test("connectOnce resolves when the socket errors after opening", async () => {
    const logs = createLogWriter();
    const loop = new NodeAgentLoop({
      controlPlaneUrl: "http://or3.test",
      credential: { token: "or3n_live", expiresAt: "2099-01-01T00:00:00.000Z" },
      hostControl: new HostControlService(),
      logger: createAgentLogger(logs.writer),
      webSocketFactory: () => new ErrorAfterOpenSocket(),
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });

    await Promise.race([
      loop.connectOnce(),
      Bun.sleep(100).then(() => {
        throw new Error("connectOnce timed out after socket error");
      }),
    ]);

    const entries = parseLogEntries(logs.chunks);
    expect(entries.filter((entry) => entry.event === "transport.disconnect")).toHaveLength(1);
  });

  test("logs capability mismatch when file operations are disabled", async () => {
    const socket = new FakeSocket();
    const logs = createLogWriter();
    const loop = new NodeAgentLoop({
      controlPlaneUrl: "http://or3.test",
      credential: { token: "or3n_live", expiresAt: "2099-01-01T00:00:00.000Z" },
      hostControl: new HostControlService(),
      logger: createAgentLogger(logs.writer),
      webSocketFactory: () => socket,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });

    const run = loop.connectOnce();
    socket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-file-read",
          method: "file_read",
          params: { path: "/tmp/test.txt" },
        },
      }),
    );
    await Bun.sleep(20);
    socket.close();
    await run;

    const entries = parseLogEntries(logs.chunks);
    expect(
      entries.some(
        (entry) =>
          entry.event === "capability.mismatch" &&
          entry.details?.failure_class === "capability_mismatch",
      ),
    ).toBe(true);
  });
});
