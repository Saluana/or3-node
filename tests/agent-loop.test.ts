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

interface SocketFrame {
  type?: string;
  request_id?: string;
  payload?: {
    event?: string;
    data?: { text?: string };
    id?: string;
    result?: { meta?: Record<string, unknown> };
  };
}

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${String(timeoutMs)}ms`);
    }
    await Bun.sleep(10);
  }
};

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
    const connectionStates: { state: string; recentError: string | null | undefined }[] = [];
    const loop = new NodeAgentLoop({
      controlPlaneUrl: "http://or3.test",
      credential: { token: "or3n_live", expiresAt: "2099-01-01T00:00:00.000Z" },
      hostControl: new HostControlService(),
      logger: createAgentLogger(logs.writer),
      persistConnectionState: (state, recentError) => {
        connectionStates.push({ state, recentError });
      },
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
      reconnectDelayMs: 10,
      maxReconnectDelayMs: 20,
      reconnectJitterRatio: 0,
    });

    await loop.start(controller.signal);

    expect(factoryCalls.length).toBeGreaterThanOrEqual(2);
    expect(openedSockets.length).toBeGreaterThanOrEqual(1);
    expect(connectionStates.some((entry) => entry.state === "connected")).toBe(true);
    expect(
      connectionStates.some(
        (entry) => entry.state === "disconnected" && entry.recentError === "failed open",
      ),
    ).toBe(true);
    const entries = parseLogEntries(logs.chunks);
    expect(entries.some((entry) => entry.event === "transport.connect")).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.event === "transport.reconnect" && entry.details?.delay_ms === 10,
      ),
    ).toBe(true);
  });

  test("applies jittered reconnect delay within the configured envelope", async () => {
    const controller = new AbortController();
    const logs = createLogWriter();
    const randomValues = [1, 0];
    let attempts = 0;
    const loop = new NodeAgentLoop({
      controlPlaneUrl: "http://or3.test",
      credential: { token: "or3n_live", expiresAt: "2099-01-01T00:00:00.000Z" },
      hostControl: new HostControlService(),
      logger: createAgentLogger(logs.writer),
      webSocketFactory: () => {
        attempts += 1;
        if (attempts >= 3) {
          const socket = new FakeSocket();
          queueMicrotask(() => {
            socket.close();
            controller.abort();
          });
          return socket;
        }
        return new FailingOpenSocket();
      },
      reconnectDelayMs: 10,
      maxReconnectDelayMs: 20,
      reconnectJitterRatio: 0.25,
      random: () => randomValues.shift() ?? 0.5,
    });

    await loop.start(controller.signal);

    const reconnectEntries = parseLogEntries(logs.chunks).filter(
      (entry) => entry.event === "transport.reconnect",
    );
    expect(reconnectEntries).toHaveLength(2);
    expect(reconnectEntries[0]?.details?.delay_ms).toBe(13);
    expect(reconnectEntries[1]?.details?.delay_ms).toBe(15);
  });

  test("stops promptly when aborted during reconnect backoff", async () => {
    const controller = new AbortController();
    const loop = new NodeAgentLoop({
      controlPlaneUrl: "http://or3.test",
      credential: { token: "or3n_live", expiresAt: "2099-01-01T00:00:00.000Z" },
      hostControl: new HostControlService(),
      webSocketFactory: () => new FailingOpenSocket(),
      reconnectDelayMs: 250,
      maxReconnectDelayMs: 250,
      reconnectJitterRatio: 0,
    });

    const startedAt = Date.now();
    const run = loop.start(controller.signal);
    await Bun.sleep(20);
    controller.abort();
    await run;

    expect(Date.now() - startedAt).toBeLessThan(150);
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

  test("logs and ignores malformed inbound frames", async () => {
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
    socket.pushInbound("{ definitely not valid json");
    await Bun.sleep(20);
    socket.close();
    await run;

    const entries = parseLogEntries(logs.chunks);
    expect(entries.some((entry) => entry.event === "transport.frame_invalid")).toBe(true);
  });

  test("responds with an invalid_request error when a malformed frame still has a request id", async () => {
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
          id: "req-invalid",
          method: "execute",
          params: null,
        },
      }),
    );
    await Bun.sleep(20);
    socket.close();
    await run;

    const response = socket.outbound
      .map((payload) => JSON.parse(payload) as { payload?: { id?: string; error?: { code?: string } } })
      .find((frame) => frame.payload?.id === "req-invalid");
    expect(response?.payload?.error?.code).toBe("invalid_request");
  });

  test("preserves secure websocket URLs when already configured", async () => {
    const requestedUrls: string[] = [];
    const socket = new FakeSocket();
    const loop = new NodeAgentLoop({
      controlPlaneUrl: "wss://or3.test/base",
      credential: { token: "or3n_live", expiresAt: "2099-01-01T00:00:00.000Z" },
      hostControl: new HostControlService(),
      webSocketFactory: (url) => {
        requestedUrls.push(url);
        return socket;
      },
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });

    const run = loop.connectOnce();
    await Bun.sleep(20);
    socket.close();
    await run;

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]?.startsWith("wss://")).toBe(true);
    expect(requestedUrls[0]).toContain("/v1/nodes/connect");
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

  test("retains bounded session logs with stable absolute cursors", async () => {
    const socket = new FakeSocket();
    const loop = new NodeAgentLoop({
      controlPlaneUrl: "http://or3.test",
      credential: { token: "or3n_live", expiresAt: "2099-01-01T00:00:00.000Z" },
      hostControl: new HostControlService(),
      webSocketFactory: () => socket,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
      sessionLogLimit: 3,
    });

    const run = loop.connectOnce();
    socket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-create-session",
          method: "create_session",
          params: { session_id: "sess_trim", workspace_id: "ws_test" },
        },
      }),
    );
    await Bun.sleep(10);

    for (let index = 0; index < 5; index += 1) {
      const requestId = `req-session-exec-${String(index)}`;
      socket.pushInbound(
        JSON.stringify({
          type: "request",
          payload: {
            id: requestId,
            method: "session_exec",
            params: {
              session_id: "sess_trim",
              command: "python3",
              args: ["-c", `print("line-${String(index)}")`],
            },
          },
        }),
      );
      await waitFor(() => socket.outbound.some((payload) => payload.includes(requestId)));
    }
    socket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-get-logs",
          method: "get_logs",
          params: { session_id: "sess_trim" },
        },
      }),
    );
    await waitFor(() => socket.outbound.some((payload) => payload.includes("req-get-logs")));
    socket.close();
    await run;

    const getLogsResponse = socket.outbound
      .map((payload) => JSON.parse(payload) as { payload?: { id?: string; result?: { meta?: { chunks?: { cursor: string; message: string }[] } } } })
      .find((frame) => frame.payload?.id === "req-get-logs");
    const chunks = getLogsResponse?.payload?.result?.meta?.chunks ?? [];
    expect(chunks).toHaveLength(3);
    const cursorValues = chunks.map((chunk) => Number(chunk.cursor));
    expect(cursorValues[0]).toBeGreaterThan(1);
    expect(cursorValues[1]).toBe((cursorValues[0] ?? 0) + 1);
    expect(cursorValues[2]).toBe((cursorValues[1] ?? 0) + 1);
    expect(chunks.some((chunk) => chunk.message.includes("line-"))).toBe(true);
  });

  test("session exec surfaces truncation as system log and response metadata", async () => {
    const socket = new FakeSocket();
    const loop = new NodeAgentLoop({
      controlPlaneUrl: "http://or3.test",
      credential: { token: "or3n_live", expiresAt: "2099-01-01T00:00:00.000Z" },
      hostControl: new HostControlService({ maxStdoutBytes: 24, maxConcurrentExecs: 1 }),
      webSocketFactory: () => socket,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
      sessionLogLimit: 10,
    });

    const run = loop.connectOnce();
    socket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-create-session",
          method: "create_session",
          params: { session_id: "sess_trunc", workspace_id: "ws_test" },
        },
      }),
    );
    await Bun.sleep(10);
    socket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-session-trunc",
          method: "session_exec",
          params: {
            session_id: "sess_trunc",
            command: "python3",
            args: ["-c", 'print("x" * 128)'],
          },
        },
      }),
    );
    await Bun.sleep(50);
    socket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-get-logs-trunc",
          method: "get_logs",
          params: { session_id: "sess_trunc" },
        },
      }),
    );
    await Bun.sleep(20);
    socket.close();
    await run;

    const frames = socket.outbound.map(
      (payload) => JSON.parse(payload) as { payload?: { id?: string; result?: { meta?: Record<string, unknown> } } },
    );
    const execResponse = frames.find((frame) => frame.payload?.id === "req-session-trunc");
    expect(execResponse?.payload?.result?.meta?.stdout_truncated).toBe(true);
    expect(execResponse?.payload?.result?.meta?.truncation_warnings).toEqual([
      "stdout output was truncated to the configured limit",
    ]);

    const getLogsResponse = frames.find((frame) => frame.payload?.id === "req-get-logs-trunc");
    const chunks = (getLogsResponse?.payload?.result?.meta?.chunks ?? []) as {
      stream: string;
      message: string;
    }[];
    expect(chunks.some((chunk) => chunk.stream === "system")).toBe(true);
    expect(chunks.some((chunk) => chunk.message.includes("output truncated"))).toBe(true);
  });

  test("clips oversized streamed output chunks before storing session logs", async () => {
    const socket = new FakeSocket();
    const loop = new NodeAgentLoop({
      controlPlaneUrl: "http://or3.test",
      credential: { token: "or3n_live", expiresAt: "2099-01-01T00:00:00.000Z" },
      hostControl: new HostControlService({ maxStdoutBytes: 64 * 1024, maxConcurrentExecs: 1 }),
      webSocketFactory: () => socket,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
      sessionLogLimit: 10,
    });

    const run = loop.connectOnce();
    socket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-create-session-big",
          method: "create_session",
          params: { session_id: "sess_big", workspace_id: "ws_test" },
        },
      }),
    );
    await Bun.sleep(10);
    socket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-session-big",
          method: "session_exec",
          params: {
            session_id: "sess_big",
            command: "python3",
            args: ["-c", 'print("x" * 20000)'],
          },
        },
      }),
    );
    await Bun.sleep(80);
    socket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-get-logs-big",
          method: "get_logs",
          params: { session_id: "sess_big" },
        },
      }),
    );
    await Bun.sleep(20);
    socket.close();
    await run;

    const frames = socket.outbound.map((payload) => JSON.parse(payload) as SocketFrame);
    const outputEvents = frames.filter(
      (frame) => frame.type === "event" && frame.request_id === "req-session-big",
    );
    expect(outputEvents.length).toBeGreaterThan(0);
    expect(
      Buffer.byteLength(outputEvents[0]?.payload?.data?.text ?? "", "utf8"),
    ).toBeLessThanOrEqual(8 * 1024);

    const getLogsResponse = frames.find((frame) => frame.payload?.id === "req-get-logs-big");
    const chunks = (getLogsResponse?.payload?.result?.meta?.chunks ?? []) as {
      stream: string;
      message: string;
    }[];
    const stdoutChunk = chunks.find((chunk) => chunk.stream === "stdout");
    expect(Buffer.byteLength(stdoutChunk?.message ?? "", "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(
      chunks.some(
        (chunk) =>
          chunk.stream === "system" && chunk.message.includes("session log transport limit"),
      ),
    ).toBe(true);
  });

  test("clips session log chunks on UTF-8 character boundaries", async () => {
    const socket = new FakeSocket();
    const emoji = "😀";
    const loop = new NodeAgentLoop({
      controlPlaneUrl: "http://or3.test",
      credential: { token: "or3n_live", expiresAt: "2099-01-01T00:00:00.000Z" },
      hostControl: new HostControlService({ maxStdoutBytes: 64 * 1024, maxConcurrentExecs: 1 }),
      webSocketFactory: () => socket,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
      sessionLogLimit: 10,
    });

    const run = loop.connectOnce();
    socket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-create-session-utf8",
          method: "create_session",
          params: { session_id: "sess_utf8", workspace_id: "ws_test" },
        },
      }),
    );
    await Bun.sleep(10);
    socket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-session-utf8",
          method: "session_exec",
          params: {
            session_id: "sess_utf8",
            command: "python3",
            args: [
              "-c",
              `import sys; sys.stdout.write(${JSON.stringify(emoji.repeat(2050))})`,
            ],
          },
        },
      }),
    );
    await Bun.sleep(80);
    socket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-get-logs-utf8",
          method: "get_logs",
          params: { session_id: "sess_utf8" },
        },
      }),
    );
    await Bun.sleep(20);
    socket.close();
    await run;

    const frames = socket.outbound.map((payload) => JSON.parse(payload) as SocketFrame);
    const outputEvents = frames.filter(
      (frame) => frame.type === "event" && frame.request_id === "req-session-utf8",
    );
    expect(outputEvents.length).toBeGreaterThan(0);
    expect(outputEvents.every((frame) => !(frame.payload?.data?.text ?? "").includes("�"))).toBe(
      true,
    );

    const getLogsResponse = frames.find((frame) => frame.payload?.id === "req-get-logs-utf8");
    const chunks = (getLogsResponse?.payload?.result?.meta?.chunks ?? []) as {
      stream: string;
      message: string;
    }[];
    const stdoutChunk = chunks.find((chunk) => chunk.stream === "stdout");
    expect(stdoutChunk).toBeDefined();
    expect(stdoutChunk?.message.includes("�")).toBe(false);
    expect(Buffer.byteLength(stdoutChunk?.message ?? "", "utf8")).toBeLessThanOrEqual(8 * 1024);
  });

  test("does not retain in-memory sessions across agent loop restart", async () => {
    const firstSocket = new FakeSocket();
    const firstLoop = new NodeAgentLoop({
      controlPlaneUrl: "http://or3.test",
      credential: { token: "or3n_live", expiresAt: "2099-01-01T00:00:00.000Z" },
      hostControl: new HostControlService(),
      webSocketFactory: () => firstSocket,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });

    const firstRun = firstLoop.connectOnce();
    firstSocket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-create-session-restart",
          method: "create_session",
          params: { session_id: "sess_restart", workspace_id: "ws_test" },
        },
      }),
    );
    await Bun.sleep(10);
    firstSocket.close();
    await firstRun;

    const secondSocket = new FakeSocket();
    const secondLoop = new NodeAgentLoop({
      controlPlaneUrl: "http://or3.test",
      credential: { token: "or3n_live", expiresAt: "2099-01-01T00:00:00.000Z" },
      hostControl: new HostControlService(),
      webSocketFactory: () => secondSocket,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });

    const secondRun = secondLoop.connectOnce();
    secondSocket.pushInbound(
      JSON.stringify({
        type: "request",
        payload: {
          id: "req-get-session-restart",
          method: "get_session",
          params: { session_id: "sess_restart" },
        },
      }),
    );
    await Bun.sleep(20);
    secondSocket.close();
    await secondRun;

    const response = secondSocket.outbound
      .map((payload) => JSON.parse(payload) as { payload?: { id?: string; error?: { code?: string } } })
      .find((frame) => frame.payload?.id === "req-get-session-restart");
    expect(response?.payload?.error?.code).toBe("session_not_found");
  });

  test("drops in-memory sessions when the same loop reconnects", async () => {
    const sockets: FakeSocket[] = [];
    let attempts = 0;
    const loop = new NodeAgentLoop({
      controlPlaneUrl: "http://or3.test",
      credential: { token: "or3n_live", expiresAt: "2099-01-01T00:00:00.000Z" },
      hostControl: new HostControlService(),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        attempts += 1;
        if (attempts === 1) {
          queueMicrotask(() => {
            socket.pushInbound(
              JSON.stringify({
                type: "request",
                payload: {
                  id: "req-create-session-reconnect",
                  method: "create_session",
                  params: { session_id: "sess_reconnect", workspace_id: "ws_test" },
                },
              }),
            );
            setTimeout(() => {
              socket.close();
            }, 10);
          });
        } else {
          queueMicrotask(() => {
            socket.pushInbound(
              JSON.stringify({
                type: "request",
                payload: {
                  id: "req-get-session-reconnect",
                  method: "get_session",
                  params: { session_id: "sess_reconnect" },
                },
              }),
            );
            setTimeout(() => {
              socket.close();
            }, 10);
          });
        }
        return socket;
      },
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
      reconnectJitterRatio: 0,
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    await loop.start(controller.signal);

    const response = sockets[1]?.outbound
      .map((payload) => JSON.parse(payload) as { payload?: { id?: string; error?: { code?: string } } })
      .find((frame) => frame.payload?.id === "req-get-session-reconnect");
    expect(response?.payload?.error?.code).toBe("session_not_found");
  });
});
