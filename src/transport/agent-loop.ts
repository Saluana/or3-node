import type { NodeTransportFrame, NodeRequest, TaskPackage } from "or3-net";
import { nodeTransportFrameSchema } from "or3-net";

import type { HostControlService } from "../host-control/service.ts";
import type { HostExecHandle, HostExecRequest } from "../host-control/types.ts";
import type { HostFileService } from "../host-control/files.ts";
import { HostPtyService } from "../host-control/pty.ts";
import type { HostServiceManager } from "../host-control/services.ts";
import {
  saveConnectionState,
  type AgentConnectionState,
} from "../info/connection-state.ts";
import { toErrorMessage } from "../utils/errors.ts";
import { truncateUtf8 } from "../utils/utf8.ts";
import {
  AgentEvent,
  createNoopAgentLogger,
  type AgentEventName,
  type AgentLogger,
} from "../utils/logger.ts";

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
  readonly reconnectJitterRatio?: number;
  readonly random?: () => number;
  readonly sessionLogLimit?: number;
  readonly maxSessions?: number;
  readonly persistConnectionState?: (
    connectionState: AgentConnectionState,
    recentError?: string | null,
  ) => Promise<void> | void;
  readonly logger?: AgentLogger;
}

/** Purpose: Agent sessions track exec log history for get_logs support. */
type AgentSessionLogStream = "stdout" | "stderr" | "system";

interface AgentSessionLogChunk {
  readonly cursor: number;
  readonly stream: AgentSessionLogStream;
  readonly message: string;
  readonly created_at: string;
}

interface AgentSession {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly createdAt: string;
  readonly logs: AgentSessionLogChunk[];
  nextCursor: number;
  status: "ready" | "destroyed";
}

const DEFAULT_RECONNECT_DELAY_MS = 500;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_RECONNECT_JITTER_RATIO = 0.25;
const DEFAULT_SESSION_LOG_LIMIT = 256;
const DEFAULT_SESSION_LOG_CHUNK_MAX_BYTES = 8 * 1024;
const DEFAULT_MAX_SESSIONS = 128;

export class NodeAgentLoop {
  private readonly activeExecs = new Map<string, HostExecHandle>();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly ptyRequestIds = new Map<string, string>();
  private readonly webSocketFactory: (url: string) => WebSocketLike;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly reconnectJitterRatio: number;
  private readonly random: () => number;
  private readonly sessionLogLimit: number;
  private readonly maxSessions: number;
  private readonly persistConnectionState: (
    connectionState: AgentConnectionState,
    recentError?: string | null,
  ) => Promise<void> | void;
  private readonly ptyService: HostPtyService;
  private readonly logger: AgentLogger;
  private currentSocket: WebSocketLike | null = null;

  public constructor(private readonly options: NodeAgentLoopOptions) {
    this.logger = options.logger ?? createNoopAgentLogger();
    this.webSocketFactory =
      options.webSocketFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.reconnectJitterRatio = options.reconnectJitterRatio ?? DEFAULT_RECONNECT_JITTER_RATIO;
    this.random = options.random ?? Math.random;
    this.sessionLogLimit = options.sessionLogLimit ?? DEFAULT_SESSION_LOG_LIMIT;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.persistConnectionState = options.persistConnectionState ?? saveConnectionState;
    this.ptyService =
      options.ptyService ??
      new HostPtyService({
        allowedRoots: options.hostControl.getConfig().allowedRoots,
        allowedEnvNames: options.hostControl.getConfig().allowedEnvPassthrough,
        logger: this.logger,
        onOutput: (ptyId, data) => {
          this.emitPtyOutput(ptyId, data);
        },
        onExit: (ptyId, exitCode, signal) => {
          this.emitPtyExit(ptyId, exitCode, signal);
        },
      });
  }

  public async connectOnce(): Promise<void> {
    const socket = this.webSocketFactory(
      buildTransportUrl(this.options.controlPlaneUrl, this.options.credential.token),
    );
    this.currentSocket = socket;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let opened = false;
    let closedResolved = false;
    let disconnectLogged = false;
    let resolveClosed: (() => void) | null = null;
    const logDisconnect = (
      level: "warn" | "error",
      message: string,
      details?: Record<string, unknown>,
    ): void => {
      if (disconnectLogged) {
        return;
      }
      disconnectLogged = true;
      this.logger[level](AgentEvent.DISCONNECT, message, details);
    };
    const finishClosed = (): void => {
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (!closedResolved) {
        closedResolved = true;
        this.currentSocket = null;
        this.clearTransientState();
        resolveClosed?.();
      }
    };
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    socket.onmessage = (event) => {
      void this.handleIncomingFrame(socket, event.data).catch((error: unknown) => {
        const requestId = tryReadRequestId(event.data);
        if (requestId !== null) {
          socket.send(
            JSON.stringify({
              type: "response",
              payload: errorResult(requestId, "invalid_request", "invalid transport frame"),
            }),
          );
        }
        this.logger.warn(AgentEvent.FRAME_INVALID, "transport received invalid frame", {
          error: toErrorMessage(error),
          failure_class: "transport",
        });
      });
    };
    socket.onclose = () => {
      if (opened) {
        this.updateConnectionState("disconnected");
        logDisconnect("warn", "transport disconnected", {
          control_plane_url: this.options.controlPlaneUrl,
          failure_class: "transport",
        });
      }
      finishClosed();
    };
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => {
        opened = true;
        this.updateConnectionState("connected");
        this.logger.info(AgentEvent.CONNECT, "transport connected", {
          control_plane_url: this.options.controlPlaneUrl,
        });
        heartbeatTimer = setInterval(() => {
          socket.send(JSON.stringify({ type: "heartbeat", sent_at: new Date().toISOString() }));
        }, this.heartbeatIntervalMs);
        resolve();
      };
      socket.onerror = (event) => {
        const errorMessage = toErrorMessage(event.error);
        if (!opened) {
          this.updateConnectionState("disconnected", errorMessage);
          this.logger.error(getConnectFailureEvent(errorMessage), "transport connection failed", {
            control_plane_url: this.options.controlPlaneUrl,
            error: errorMessage,
            failure_class: "transport",
          });
          reject(event.error instanceof Error ? event.error : new Error("websocket open failed"));
          return;
        }
        this.updateConnectionState("disconnected", errorMessage);
        logDisconnect("error", "transport errored after connect", {
          control_plane_url: this.options.controlPlaneUrl,
          error: errorMessage,
          failure_class: "transport",
        });
        finishClosed();
      };
    });
    await closed;
  }

  private updateConnectionState(
    connectionState: AgentConnectionState,
    recentError: string | null = null,
  ): void {
    void Promise.resolve(this.persistConnectionState(connectionState, recentError)).catch(
      () => undefined,
    );
  }

  private clearTransientState(): void {
    this.ptyService.closeAll();
    this.ptyRequestIds.clear();
    this.sessions.clear();
  }

  public async start(signal?: AbortSignal): Promise<void> {
    let delayMs = this.reconnectDelayMs;
    while (!signal?.aborted) {
      try {
        await this.connectOnce();
        delayMs = this.reconnectDelayMs;
      } catch (error: unknown) {
        if (signal?.aborted) {
          break;
        }
        const scheduledDelayMs = applyJitter(delayMs, this.reconnectJitterRatio, this.random);
        this.logger.warn(AgentEvent.RECONNECT, "transport reconnect scheduled", {
          delay_ms: scheduledDelayMs,
          base_delay_ms: delayMs,
          error: toErrorMessage(error),
          failure_class: "transport",
        });
        await sleep(scheduledDelayMs, signal);
        delayMs = Math.min(delayMs * 2, this.maxReconnectDelayMs);
      }
    }
  }

  private async handleIncomingFrame(socket: WebSocketLike, raw: string): Promise<void> {
    const parsedFrame = JSON.parse(raw) as NodeTransportFrame;
    const frame = nodeTransportFrameSchema.parse(parsedFrame);
    if (frame.type !== "request") {
      return;
    }

    const response = await this.handleRequest(socket, frame.payload as NodeRequest);
    socket.send(JSON.stringify({ type: "response", payload: response }));
  }

  private async handleRequest(
    socket: WebSocketLike,
    request: NodeRequest,
  ): Promise<RpcResult> {
    switch (request.method) {
      case "heartbeat":
        return this.handleHeartbeat(request.id);
      case "abort":
        return this.handleAbort(request.id, request.params.job_id);
      case "execute":
        return this.handleExecute(socket, request.id, request.params);
      case "handshake":
        return this.handleHandshake(request.id);
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
        return this.handlePtyOpen(request.id, request.params);
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
    return unreachableRequest(request);
  }

  private handleHeartbeat(requestId: string): RpcResult {
    return okResult(requestId, { output_text: "ok", artifacts: [], meta: {} });
  }

  private async handleAbort(requestId: string, jobId: string): Promise<RpcResult> {
    const handle = this.activeExecs.get(jobId);
    if (handle !== undefined) {
      await handle.abort();
      this.activeExecs.delete(jobId);
    }
    return okResult(requestId, { output_text: "aborted", artifacts: [], meta: {} });
  }

  private async handleExecute(
    socket: WebSocketLike,
    requestId: string,
    taskPackage: TaskPackage,
  ): Promise<RpcResult> {
    try {
      const hostRequest = toHostExecRequest(taskPackage);
      const sessionId = getTaskPackageSessionId(taskPackage);
      const handle = this.options.hostControl.exec({
        ...hostRequest,
        ...this.createExecutionStreamHandlers(socket, requestId, sessionId),
      });
      this.activeExecs.set(taskPackage.job_id, handle);
      const result = await handle.result;
      this.activeExecs.delete(taskPackage.job_id);
      this.appendSessionTruncationWarning(sessionId, result);
      return okResult(requestId, {
        output_text: result.stdout,
        artifacts: [],
        meta: toExecutionMeta(result),
      });
    } catch (error: unknown) {
      return {
        id: requestId,
        error: {
          code: "remote_execution_failed",
          message: error instanceof Error ? error.message : "execution failed",
          retriable: true,
          details: {},
        },
      };
    }
  }

  private handleHandshake(requestId: string): RpcResult {
    return okResult(requestId, { output_text: "handshake-ok", artifacts: [], meta: {} });
  }

  private appendSessionLog(
    sessionId: string | undefined,
    stream: AgentSessionLogStream,
    message: string,
  ): void {
    if (sessionId === undefined) {
      return;
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return;
    }
    session.logs.push({
      cursor: session.nextCursor,
      stream,
      message,
      created_at: new Date().toISOString(),
    });
    session.nextCursor += 1;
    const overflow = session.logs.length - this.sessionLogLimit;
    if (overflow > 0) {
      session.logs.splice(0, overflow);
    }
  }

  private ensureSessionCapacity(): void {
    while (this.sessions.size >= this.maxSessions) {
      const oldestSessionId = this.sessions.keys().next().value;
      if (oldestSessionId === undefined) {
        break;
      }
      this.sessions.delete(oldestSessionId);
      this.logger.warn(AgentEvent.SESSION_DESTROY, "agent session evicted from in-memory cache", {
        session_id: oldestSessionId,
        failure_class: "transport",
      });
    }
  }

  private createExecutionStreamHandlers(
    socket: WebSocketLike,
    requestId: string,
    sessionId: string | undefined,
  ): Pick<HostExecRequest, "onStdout" | "onStderr"> {
    let streamChunkClipWarningLogged = false;
    const handleChunk = (stream: "stdout" | "stderr", chunk: string): void => {
      const outputChunk = clipSessionLogChunk(chunk);
      this.appendSessionLog(sessionId, stream, outputChunk.text);
      if (outputChunk.clipped && !streamChunkClipWarningLogged) {
        streamChunkClipWarningLogged = true;
        this.appendSessionLog(
          sessionId,
          "system",
          "output chunk clipped to the session log transport limit",
        );
      }
      socket.send(
        JSON.stringify({
          type: "event",
          request_id: requestId,
          payload: { event: "output", data: { text: outputChunk.text } },
        }),
      );
    };

    return {
      onStdout: (chunk): void => {
        handleChunk("stdout", chunk);
      },
      onStderr: (chunk): void => {
        handleChunk("stderr", chunk);
      },
    };
  }

  private handleCreateSession(
    requestId: string,
    params: { session_id: string; workspace_id: string },
  ): RpcResult {
    if (this.sessions.has(params.session_id)) {
      return okResult(requestId, { session_id: params.session_id, status: "ready" });
    }
    this.ensureSessionCapacity();
    const session: AgentSession = {
      sessionId: params.session_id,
      workspaceId: params.workspace_id,
      createdAt: new Date().toISOString(),
      logs: [],
      nextCursor: 1,
      status: "ready",
    };
    this.sessions.set(params.session_id, session);
    this.logger.info(AgentEvent.SESSION_CREATE, "agent session created", {
      session_id: params.session_id,
      workspace_id: params.workspace_id,
    });
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
    this.logger.info(AgentEvent.SESSION_DESTROY, "agent session destroyed", {
      session_id: params.session_id,
    });
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
      const handle = this.options.hostControl.exec({
        argv,
        cwd: params.cwd,
        env: params.env,
        stdin: params.stdin,
        timeoutMs: params.timeout_ms,
        ...this.createExecutionStreamHandlers(socket, requestId, params.session_id),
      });
      const result = await handle.result;
      this.appendSessionTruncationWarning(params.session_id, result);
      return okResult(requestId, {
        output_text: result.stdout,
        artifacts: [],
        meta: toExecutionMeta(result),
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
    const cursorIndex = parseLogCursor(params.cursor);
    const limit = params.limit ?? 100;
    const chunks = session.logs
      .filter((log) => log.cursor > cursorIndex)
      .slice(0, limit)
      .map((log) => ({
      stream: log.stream,
      message: log.message,
      cursor: String(log.cursor),
      created_at: log.created_at,
      }));
    const lastReturnedCursor = chunks.at(-1)?.cursor;
    const nextCursor =
      lastReturnedCursor !== undefined && session.logs.some((log) => log.cursor > Number(lastReturnedCursor))
        ? lastReturnedCursor
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
      return this.unsupportedCapability(requestId, "file_read", "file operations are not enabled");
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
      return this.unsupportedCapability(requestId, "file_write", "file operations are not enabled");
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
      return this.unsupportedCapability(
        requestId,
        "file_delete",
        "file operations are not enabled",
      );
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
      return this.unsupportedCapability(
        requestId,
        "file_browse",
        "file operations are not enabled",
      );
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
    try {
      const session = this.ptyService.open({
        sessionId: params.session_id,
        cols: params.cols,
        rows: params.rows,
        command: params.command,
        args: params.args,
        env: params.env,
        cwd: params.cwd,
      });
      this.ptyRequestIds.set(session.ptyId, requestId);
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
    const session = this.ptyService.get(params.pty_id);
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
    const session = this.ptyService.get(params.pty_id);
    if (session === null) {
      return errorResult(requestId, "pty_not_found", `PTY ${params.pty_id} not found`);
    }
    session.resize(params.cols, params.rows);
    return okResult(requestId, { output_text: "ok", artifacts: [], meta: {} });
  }

  private handlePtyClose(requestId: string, params: { pty_id: string }): RpcResult {
    const session = this.ptyService.get(params.pty_id);
    if (session === null) {
      return okResult(requestId, { output_text: "closed", artifacts: [], meta: {} });
    }
    session.close();
    return okResult(requestId, { output_text: "closed", artifacts: [], meta: {} });
  }

  private emitPtyOutput(ptyId: string, data: string): void {
    const socket = this.currentSocket;
    const requestId = this.ptyRequestIds.get(ptyId);
    if (socket === null || requestId === undefined || data.length === 0) {
      return;
    }
    socket.send(
      JSON.stringify({
        type: "event",
        request_id: requestId,
        payload: {
          event: "pty_output",
          data: {
            pty_id: ptyId,
            text: data,
          },
        },
      }),
    );
  }

  private emitPtyExit(ptyId: string, exitCode: number, signal?: string): void {
    const socket = this.currentSocket;
    const requestId = this.ptyRequestIds.get(ptyId);
    if (requestId === undefined) {
      return;
    }
    this.ptyRequestIds.delete(ptyId);
    if (socket === null) {
      return;
    }
    socket.send(
      JSON.stringify({
        type: "event",
        request_id: requestId,
        payload: {
          event: "pty_exit",
          data: {
            pty_id: ptyId,
            exit_code: exitCode,
            signal: signal ?? null,
          },
        },
      }),
    );
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
      return this.unsupportedCapability(
        requestId,
        "service_launch",
        "service launch is not enabled",
      );
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
      return this.unsupportedCapability(
        requestId,
        "service_stop",
        "service management is not enabled",
      );
    }
    const stopped = this.options.serviceManager.stop(params.service_id);
    return okResult(requestId, {
      output_text: stopped ? "stopped" : "not found",
      artifacts: [],
      meta: { service_id: params.service_id, stopped },
    });
  }

  private unsupportedCapability(requestId: string, method: string, message: string): RpcResult {
    this.logger.warn(AgentEvent.CAPABILITY_MISMATCH, "request blocked by disabled capability", {
      method,
      message,
      failure_class: "capability_mismatch",
    });
    return errorResult(requestId, "unsupported_capability", message);
  }

  private appendSessionTruncationWarning(
    sessionId: string | undefined,
    result: Awaited<HostExecHandle["result"]>,
  ): void {
    if (sessionId === undefined || !result.truncated) {
      return;
    }

    const warning = buildTruncationWarningMessage(result);
    if (warning === null) {
      return;
    }

    this.appendSessionLog(sessionId, "system", warning);
  }
}

const buildTransportUrl = (baseUrl: string, token: string): string => {
  const url = new URL("/v1/nodes/connect", baseUrl);
  url.protocol =
    url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
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

const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", finish);
      resolve();
    }, ms);

    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };

    signal?.addEventListener("abort", finish, { once: true });
  });
};

const clipSessionLogChunk = (message: string): { text: string; clipped: boolean } => {
  const encoded = Buffer.from(message, "utf8");
  if (encoded.byteLength <= DEFAULT_SESSION_LOG_CHUNK_MAX_BYTES) {
    return { text: message, clipped: false };
  }

  return {
    text: truncateUtf8(message, DEFAULT_SESSION_LOG_CHUNK_MAX_BYTES),
    clipped: true,
  };
};

const applyJitter = (delayMs: number, jitterRatio: number, random: () => number): number => {
  if (delayMs <= 0 || jitterRatio <= 0) {
    return delayMs;
  }

  const spread = delayMs * jitterRatio;
  const minDelay = Math.max(0, delayMs - spread);
  const maxDelay = delayMs + spread;
  const jittered = minDelay + (maxDelay - minDelay) * random();
  return Math.max(1, Math.round(jittered));
};

const parseLogCursor = (cursor: string | undefined): number => {
  if (cursor === undefined) {
    return 0;
  }

  const parsed = Number.parseInt(cursor, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
};

const buildTruncationWarnings = (
  result: Pick<HostExecRequestResultLike, "stdoutTruncated" | "stderrTruncated">,
): string[] => {
  const warnings: string[] = [];
  if (result.stdoutTruncated) {
    warnings.push("stdout output was truncated to the configured limit");
  }
  if (result.stderrTruncated) {
    warnings.push("stderr output was truncated to the configured limit");
  }
  return warnings;
};

const buildTruncationWarningMessage = (
  result: Pick<HostExecRequestResultLike, "stdoutTruncated" | "stderrTruncated">,
): string | null => {
  const warnings = buildTruncationWarnings(result);
  if (warnings.length === 0) {
    return null;
  }
  return `output truncated: ${warnings.join("; ")}`;
};

const toExecutionMeta = (result: HostExecRequestResultLike): Record<string, unknown> => ({
  exit_code: result.exitCode,
  stderr: result.stderr,
  signal: result.signal,
  status: result.status,
  truncated: result.truncated,
  stdout_truncated: result.stdoutTruncated,
  stderr_truncated: result.stderrTruncated,
  truncation_warnings: buildTruncationWarnings(result),
});

const getConnectFailureEvent = (message: string): AgentEventName =>
  /auth|credential|401|403/i.test(message) ? AgentEvent.AUTH_FAIL : AgentEvent.CONNECT;

interface HostExecRequestResultLike {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly signal: string | null;
  readonly status: string;
  readonly truncated: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

const tryReadRequestId = (raw: string): string | null => {
  try {
    const parsed = JSON.parse(raw) as { payload?: { id?: unknown } };
    return typeof parsed.payload?.id === "string" ? parsed.payload.id : null;
  } catch {
    return null;
  }
};

const unreachableRequest = (request: never): never => {
  void request;
  throw new Error("unreachable request method");
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
