import type { NodeTransportFrame, NodeRequest, TaskPackage } from "or3-net";
import { nodeTransportFrameSchema } from "or3-net";

import type { HostControlService } from "../host-control/service.ts";
import type { HostExecHandle, HostExecRequest } from "../host-control/types.ts";
import type { HostFileService } from "../host-control/files.ts";
import type { HostPtyService } from "../host-control/pty.ts";
import type { HostServiceManager } from "../host-control/services.ts";

export interface AgentLoopCredential {
  readonly token: string;
  readonly expiresAt: string;
}

export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: { readonly error?: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface NodeAgentLoopOptions {
  readonly controlPlaneUrl: string;
  readonly credential: AgentLoopCredential;
  readonly hostControl: HostControlService;
  readonly fileService?: HostFileService;
  readonly ptyService?: HostPtyService;
  readonly serviceManager?: HostServiceManager;
  readonly webSocketFactory?: (url: string) => WebSocketLike;
  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
  readonly heartbeatIntervalMs?: number;
}

/** Purpose: Agent sessions track exec log history for get_logs support. */
interface AgentSession {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly createdAt: string;
  readonly logs: { stream: string; message: string; created_at: string }[];
  status: "ready" | "destroyed";
}

export class NodeAgentLoop {
  private readonly activeExecs = new Map<string, HostExecHandle>();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly webSocketFactory: (url: string) => WebSocketLike;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly heartbeatIntervalMs: number;

  public constructor(private readonly options: NodeAgentLoopOptions) {
    this.webSocketFactory =
      options.webSocketFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.reconnectDelayMs = options.reconnectDelayMs ?? 100;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 1_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
  }

  public async connectOnce(): Promise<void> {
    const socket = this.webSocketFactory(
      buildTransportUrl(this.options.controlPlaneUrl, this.options.credential.token),
    );
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let opened = false;
    let closedResolved = false;
    let resolveClosed: (() => void) | null = null;
    const finishClosed = (): void => {
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (!closedResolved) {
        closedResolved = true;
        resolveClosed?.();
      }
    };
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    socket.onmessage = (event) => {
      void this.handleIncomingFrame(socket, event.data);
    };
    socket.onclose = () => {
      finishClosed();
    };
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => {
        opened = true;
        heartbeatTimer = setInterval(() => {
          socket.send(JSON.stringify({ type: "heartbeat", sent_at: new Date().toISOString() }));
        }, this.heartbeatIntervalMs);
        resolve();
      };
      socket.onerror = (event) => {
        if (!opened) {
          reject(event.error instanceof Error ? event.error : new Error("websocket open failed"));
          return;
        }
        finishClosed();
      };
    });
    await closed;
  }

  public async start(signal?: AbortSignal): Promise<void> {
    let delayMs = this.reconnectDelayMs;
    while (!signal?.aborted) {
      try {
        await this.connectOnce();
        delayMs = this.reconnectDelayMs;
      } catch {
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, this.maxReconnectDelayMs);
      }
    }
  }

  private async handleIncomingFrame(socket: WebSocketLike, raw: string): Promise<void> {
    const frame = nodeTransportFrameSchema.parse(JSON.parse(raw) as NodeTransportFrame);
    if (frame.type !== "request") {
      return;
    }

    const response = await this.handleRequest(socket, frame.payload);
    socket.send(JSON.stringify({ type: "response", payload: response }));
  }

  private async handleRequest(
    socket: WebSocketLike,
    request: NodeRequest,
  ): Promise<{
    id: string;
    result?: Record<string, unknown>;
    error?: { code: string; message: string; retriable: boolean; details: Record<string, unknown> };
  }> {
    switch (request.method) {
      case "heartbeat":
        return { id: request.id, result: { output_text: "ok", artifacts: [], meta: {} } };
      case "abort": {
        const handle = this.activeExecs.get(request.params.job_id);
        if (handle !== undefined) {
          await handle.abort();
          this.activeExecs.delete(request.params.job_id);
        }
        return { id: request.id, result: { output_text: "aborted", artifacts: [], meta: {} } };
      }
      case "execute": {
        try {
          const hostRequest = toHostExecRequest(request.params);
          const sessionId = getTaskPackageSessionId(request.params);
          const handle = await this.options.hostControl.exec({
            ...hostRequest,
            onStdout: (chunk): void => {
              this.appendSessionLog(sessionId, "stdout", chunk);
              socket.send(
                JSON.stringify({
                  type: "event",
                  request_id: request.id,
                  payload: { event: "output", data: { text: chunk } },
                }),
              );
            },
            onStderr: (chunk): void => {
              this.appendSessionLog(sessionId, "stderr", chunk);
              socket.send(
                JSON.stringify({
                  type: "event",
                  request_id: request.id,
                  payload: { event: "output", data: { text: chunk } },
                }),
              );
            },
          });
          this.activeExecs.set(request.params.job_id, handle);
          const result = await handle.result;
          this.activeExecs.delete(request.params.job_id);
          return {
            id: request.id,
            result: {
              output_text: result.stdout,
              artifacts: [],
              meta: {
                exit_code: result.exitCode,
                stderr: result.stderr,
                signal: result.signal,
                status: result.status,
              },
            },
          };
        } catch (error: unknown) {
          return {
            id: request.id,
            error: {
              code: "remote_execution_failed",
              message: error instanceof Error ? error.message : "execution failed",
              retriable: true,
              details: {},
            },
          };
        }
      }
      case "handshake":
        return { id: request.id, result: { output_text: "handshake-ok", artifacts: [], meta: {} } };
      case "create_session":
        return this.handleCreateSession(request.id, request.params);
      case "get_session":
        return this.handleGetSession(request.id, request.params);
      case "destroy_session":
        return this.handleDestroySession(request.id, request.params);
      case "session_exec":
        return this.handleSessionExec(socket, request.id, request.params);
      case "get_logs":
        return this.handleGetLogs(request.id, request.params);
      case "file_read":
        return this.handleFileRead(request.id, request.params);
      case "file_write":
        return this.handleFileWrite(request.id, request.params);
      case "file_delete":
        return this.handleFileDelete(request.id, request.params);
      case "file_browse":
        return this.handleFileBrowse(request.id, request.params);
      case "pty_open":
        return this.handlePtyOpen(socket, request.id, request.params);
      case "pty_input":
        return this.handlePtyInput(request.id, request.params);
      case "pty_resize":
        return this.handlePtyResize(request.id, request.params);
      case "pty_close":
        return this.handlePtyClose(request.id, request.params);
      case "service_launch":
        return this.handleServiceLaunch(request.id, request.params);
      case "service_stop":
        return this.handleServiceStop(request.id, request.params);
    }
  }

  private appendSessionLog(sessionId: string | undefined, stream: "stdout" | "stderr", message: string): void {
    if (sessionId === undefined) {
      return;
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return;
    }
    session.logs.push({
      stream,
      message,
      created_at: new Date().toISOString(),
    });
  }

  private handleCreateSession(
    requestId: string,
    params: { session_id: string; workspace_id: string },
  ): RpcResult {
    if (this.sessions.has(params.session_id)) {
      return okResult(requestId, { session_id: params.session_id, status: "ready" });
    }
    const session: AgentSession = {
      sessionId: params.session_id,
      workspaceId: params.workspace_id,
      createdAt: new Date().toISOString(),
      logs: [],
      status: "ready",
    };
    this.sessions.set(params.session_id, session);
    return okResult(requestId, { session_id: params.session_id, status: "ready" });
  }

  private handleGetSession(requestId: string, params: { session_id: string }): RpcResult {
    const session = this.sessions.get(params.session_id);
    if (session === undefined) {
      return errorResult(requestId, "session_not_found", `session ${params.session_id} not found`);
    }
    return okResult(requestId, {
      session_id: session.sessionId,
      status: session.status,
      created_at: session.createdAt,
    });
  }

  private handleDestroySession(requestId: string, params: { session_id: string }): RpcResult {
    const session = this.sessions.get(params.session_id);
    if (session === undefined) {
      return okResult(requestId, { destroyed: true });
    }
    session.status = "destroyed";
    this.sessions.delete(params.session_id);
    return okResult(requestId, { destroyed: true });
  }

  private async handleSessionExec(
    socket: WebSocketLike,
    requestId: string,
    params: {
      session_id: string;
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      timeout_ms?: number;
      stdin?: string;
    },
  ): Promise<RpcResult> {
    const session = this.sessions.get(params.session_id);
    if (session === undefined) {
      return errorResult(requestId, "session_not_found", `session ${params.session_id} not found`);
    }
    try {
      const argv = [params.command, ...(params.args ?? [])];
      const handle = await this.options.hostControl.exec({
        argv,
        cwd: params.cwd,
        env: params.env,
        stdin: params.stdin,
        timeoutMs: params.timeout_ms,
        onStdout: (chunk): void => {
          session.logs.push({
            stream: "stdout",
            message: chunk,
            created_at: new Date().toISOString(),
          });
          socket.send(
            JSON.stringify({
              type: "event",
              request_id: requestId,
              payload: { event: "output", data: { text: chunk } },
            }),
          );
        },
        onStderr: (chunk): void => {
          session.logs.push({
            stream: "stderr",
            message: chunk,
            created_at: new Date().toISOString(),
          });
          socket.send(
            JSON.stringify({
              type: "event",
              request_id: requestId,
              payload: { event: "output", data: { text: chunk } },
            }),
          );
        },
      });
      const result = await handle.result;
      return okResult(requestId, {
        output_text: result.stdout,
        artifacts: [],
        meta: {
          exit_code: result.exitCode,
          stderr: result.stderr,
          signal: result.signal,
          status: result.status,
        },
      });
    } catch (error: unknown) {
      return errorResult(
        requestId,
        "remote_execution_failed",
        error instanceof Error ? error.message : "session exec failed",
      );
    }
  }

  private handleGetLogs(
    requestId: string,
    params: { session_id: string; cursor?: string; limit?: number },
  ): RpcResult {
    const session = this.sessions.get(params.session_id);
    if (session === undefined) {
      return errorResult(requestId, "session_not_found", `session ${params.session_id} not found`);
    }
    const cursorIndex = params.cursor !== undefined ? parseInt(params.cursor, 10) : 0;
    const limit = params.limit ?? 100;
    const chunks = session.logs.slice(cursorIndex, cursorIndex + limit).map((log, index) => ({
      stream: log.stream,
      message: log.message,
      cursor: String(cursorIndex + index + 1),
      created_at: log.created_at,
    }));
    const nextCursor =
      cursorIndex + chunks.length < session.logs.length
        ? String(cursorIndex + chunks.length)
        : undefined;
    return okResult(requestId, {
      output_text: JSON.stringify({ chunks, next_cursor: nextCursor }),
      artifacts: [],
      meta: { chunks, next_cursor: nextCursor },
    });
  }

  private async handleFileRead(
    requestId: string,
    params: { path: string; encoding?: "text" | "base64" },
  ): Promise<RpcResult> {
    if (!this.options.fileService?.isEnabled()) {
      return errorResult(requestId, "unsupported_capability", "file operations are not enabled");
    }
    try {
      const result = await this.options.fileService.read(params.path, params.encoding ?? "text");
      return okResult(requestId, {
        output_text: result.content_text ?? "",
        artifacts: [],
        meta: {
          path: result.path,
          encoding: result.encoding,
          size_bytes: result.size_bytes,
          content_base64: result.content_base64,
        },
      });
    } catch (error: unknown) {
      return errorResult(
        requestId,
        "file_operation_failed",
        error instanceof Error ? error.message : "file read failed",
      );
    }
  }

  private async handleFileWrite(
    requestId: string,
    params: { path: string; content_text?: string; content_base64?: string; overwrite?: boolean },
  ): Promise<RpcResult> {
    if (!this.options.fileService?.isEnabled()) {
      return errorResult(requestId, "unsupported_capability", "file operations are not enabled");
    }
    try {
      const result = await this.options.fileService.write(params.path, {
        content_text: params.content_text,
        content_base64: params.content_base64,
        overwrite: params.overwrite,
      });
      return okResult(requestId, {
        output_text: `wrote ${String(result.bytes_transferred)} bytes`,
        artifacts: [],
        meta: { path: result.path, bytes_transferred: result.bytes_transferred },
      });
    } catch (error: unknown) {
      return errorResult(
        requestId,
        "file_operation_failed",
        error instanceof Error ? error.message : "file write failed",
      );
    }
  }

  private async handleFileDelete(
    requestId: string,
    params: { path: string; recursive?: boolean },
  ): Promise<RpcResult> {
    if (!this.options.fileService?.isEnabled()) {
      return errorResult(requestId, "unsupported_capability", "file operations are not enabled");
    }
    try {
      const result = await this.options.fileService.delete(params.path, params.recursive ?? false);
      return okResult(requestId, {
        output_text: result.deleted ? "deleted" : "not found",
        artifacts: [],
        meta: { path: result.path, deleted: result.deleted },
      });
    } catch (error: unknown) {
      return errorResult(
        requestId,
        "file_operation_failed",
        error instanceof Error ? error.message : "file delete failed",
      );
    }
  }

  private async handleFileBrowse(
    requestId: string,
    params: { path?: string; recursive?: boolean },
  ): Promise<RpcResult> {
    if (!this.options.fileService?.isEnabled()) {
      return errorResult(requestId, "unsupported_capability", "file operations are not enabled");
    }
    try {
      const entries = await this.options.fileService.browse(
        params.path ?? undefined,
        params.recursive ?? false,
      );
      return okResult(requestId, {
        output_text: JSON.stringify(entries),
        artifacts: [],
        meta: { entries, count: entries.length },
      });
    } catch (error: unknown) {
      return errorResult(
        requestId,
        "file_operation_failed",
        error instanceof Error ? error.message : "file browse failed",
      );
    }
  }

  private handlePtyOpen(
    socket: WebSocketLike,
    requestId: string,
    params: {
      session_id: string;
      cols?: number;
      rows?: number;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    },
  ): RpcResult {
    if (this.options.ptyService === undefined) {
      return errorResult(requestId, "unsupported_capability", "PTY is not enabled");
    }
    try {
      const session = this.options.ptyService.open({
        sessionId: params.session_id,
        cols: params.cols,
        rows: params.rows,
        command: params.command,
        args: params.args,
        env: params.env,
        cwd: params.cwd,
      });
      // Wire output events to the socket
      const originalOnOutput = this.options.ptyService.constructor.name;
      void originalOnOutput;
      // PTY output is wired via the HostPtyService constructor onOutput callback,
      // but we also send event frames for the specific request
      return okResult(requestId, {
        output_text: session.ptyId,
        artifacts: [],
        meta: { pty_id: session.ptyId, session_id: session.sessionId },
      });
    } catch (error: unknown) {
      return errorResult(
        requestId,
        "pty_failed",
        error instanceof Error ? error.message : "pty open failed",
      );
    }
  }

  private handlePtyInput(requestId: string, params: { pty_id: string; data: string }): RpcResult {
    if (this.options.ptyService === undefined) {
      return errorResult(requestId, "unsupported_capability", "PTY is not enabled");
    }
    const session = this.options.ptyService.get(params.pty_id);
    if (session === null) {
      return errorResult(requestId, "pty_not_found", `PTY ${params.pty_id} not found`);
    }
    session.write(params.data);
    return okResult(requestId, { output_text: "ok", artifacts: [], meta: {} });
  }

  private handlePtyResize(
    requestId: string,
    params: { pty_id: string; cols: number; rows: number },
  ): RpcResult {
    if (this.options.ptyService === undefined) {
      return errorResult(requestId, "unsupported_capability", "PTY is not enabled");
    }
    const session = this.options.ptyService.get(params.pty_id);
    if (session === null) {
      return errorResult(requestId, "pty_not_found", `PTY ${params.pty_id} not found`);
    }
    session.resize(params.cols, params.rows);
    return okResult(requestId, { output_text: "ok", artifacts: [], meta: {} });
  }

  private handlePtyClose(requestId: string, params: { pty_id: string }): RpcResult {
    if (this.options.ptyService === undefined) {
      return errorResult(requestId, "unsupported_capability", "PTY is not enabled");
    }
    const session = this.options.ptyService.get(params.pty_id);
    if (session === null) {
      return okResult(requestId, { output_text: "closed", artifacts: [], meta: {} });
    }
    session.close();
    return okResult(requestId, { output_text: "closed", artifacts: [], meta: {} });
  }

  private handleServiceLaunch(
    requestId: string,
    params: {
      service_name: string;
      command: string;
      args?: string[];
      port: number;
      env?: Record<string, string>;
      cwd?: string;
    },
  ): RpcResult {
    if (this.options.serviceManager === undefined) {
      return errorResult(requestId, "unsupported_capability", "service launch is not enabled");
    }
    try {
      const service = this.options.serviceManager.launch({
        serviceName: params.service_name,
        command: params.command,
        args: params.args,
        port: params.port,
        env: params.env,
        cwd: params.cwd,
      });
      return okResult(requestId, {
        output_text: service.serviceId,
        artifacts: [],
        meta: {
          service_id: service.serviceId,
          service_name: service.serviceName,
          port: service.port,
          pid: service.pid,
        },
      });
    } catch (error: unknown) {
      return errorResult(
        requestId,
        "service_launch_failed",
        error instanceof Error ? error.message : "service launch failed",
      );
    }
  }

  private handleServiceStop(requestId: string, params: { service_id: string }): RpcResult {
    if (this.options.serviceManager === undefined) {
      return errorResult(requestId, "unsupported_capability", "service management is not enabled");
    }
    const stopped = this.options.serviceManager.stop(params.service_id);
    return okResult(requestId, {
      output_text: stopped ? "stopped" : "not found",
      artifacts: [],
      meta: { service_id: params.service_id, stopped },
    });
  }
}

const buildTransportUrl = (baseUrl: string, token: string): string => {
  const url = new URL("/v1/nodes/connect", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
};

const toHostExecRequest = (taskPackage: TaskPackage): HostExecRequest => {
  const metadata = taskPackage.metadata as Record<string, unknown>;
  const command = typeof metadata.command === "string" ? metadata.command : null;
  const args = Array.isArray(metadata.args)
    ? metadata.args.filter((value): value is string => typeof value === "string")
    : [];
  const env = toStringRecord(metadata.env);
  const cwd = typeof metadata.cwd === "string" && metadata.cwd !== "" ? metadata.cwd : undefined;
  const stdin = typeof metadata.stdin === "string" ? metadata.stdin : undefined;

  return {
    argv: command === null ? ["sh", "-lc", taskPackage.instructions] : [command, ...args],
    cwd,
    env,
    stdin,
    timeoutMs: taskPackage.timeout.hard_ms ?? taskPackage.timeout.soft_ms,
  };
};

const getTaskPackageSessionId = (taskPackage: TaskPackage): string | undefined => {
  const sessionId = taskPackage.metadata.session_id;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
};

const toStringRecord = (value: unknown): Record<string, string> | undefined => {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

interface RpcResult {
  id: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; retriable: boolean; details: Record<string, unknown> };
}

const okResult = (id: string, result: Record<string, unknown>): RpcResult => ({
  id,
  result,
});

const errorResult = (id: string, code: string, message: string): RpcResult => ({
  id,
  error: { code, message, retriable: false, details: {} },
});
