/**
 * @module src/utils/logger
 *
 * Purpose:
 * Structured logging helpers for the node agent. Outputs JSON-formatted log
 * entries for bootstrap, approval, connect, disconnect, exec, PTY lifecycle,
 * and service launch events.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type AgentFailureClass =
  | "config"
  | "bootstrap"
  | "approval"
  | "credential"
  | "transport"
  | "exec"
  | "capability_mismatch"
  | "path_violation";

export interface LogEntry {
  readonly level: LogLevel;
  readonly event: string;
  readonly message: string;
  readonly timestamp: string;
  readonly details?: Record<string, unknown>;
}

export interface AgentLogger {
  debug(event: string, message: string, details?: Record<string, unknown>): void;
  info(event: string, message: string, details?: Record<string, unknown>): void;
  warn(event: string, message: string, details?: Record<string, unknown>): void;
  error(event: string, message: string, details?: Record<string, unknown>): void;
}

/** Purpose: Creates a structured logger that outputs JSON lines. */
export const createAgentLogger = (
  writer: Pick<typeof process.stderr, "write"> = process.stderr,
  minLevel: LogLevel = "info",
): AgentLogger => {
  const levelOrder: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const minLevelNum = levelOrder[minLevel];

  const log = (
    level: LogLevel,
    event: string,
    message: string,
    details?: Record<string, unknown>,
  ): void => {
    if (levelOrder[level] < minLevelNum) {
      return;
    }
    const entry: LogEntry = {
      level,
      event,
      message,
      timestamp: new Date().toISOString(),
      ...(details !== undefined ? { details } : {}),
    };
    writer.write(`${JSON.stringify(entry)}\n`);
  };

  return {
    debug: (event, message, details) => {
      log("debug", event, message, details);
    },
    info: (event, message, details) => {
      log("info", event, message, details);
    },
    warn: (event, message, details) => {
      log("warn", event, message, details);
    },
    error: (event, message, details) => {
      log("error", event, message, details);
    },
  };
};

export const createNoopAgentLogger = (): AgentLogger => ({
  debug: () => {
    return;
  },
  info: () => {
    return;
  },
  warn: () => {
    return;
  },
  error: () => {
    return;
  },
});

// Well-known event names for structured logging across the agent.
export const AgentEvent = {
  CONFIG_FAIL: "config.fail",

  // Bootstrap & enrollment
  BOOTSTRAP_START: "bootstrap.start",
  BOOTSTRAP_SUCCESS: "bootstrap.success",
  BOOTSTRAP_FAIL: "bootstrap.fail",

  // Approval & credentials
  APPROVAL_RECEIVED: "approval.received",
  CREDENTIAL_REFRESHED: "credential.refreshed",
  CREDENTIAL_EXPIRED: "credential.expired",

  // Connection lifecycle
  CONNECT: "transport.connect",
  DISCONNECT: "transport.disconnect",
  RECONNECT: "transport.reconnect",
  AUTH_FAIL: "transport.auth_fail",

  // Exec lifecycle
  EXEC_START: "exec.start",
  EXEC_FINISH: "exec.finish",
  EXEC_ABORT: "exec.abort",
  EXEC_TIMEOUT: "exec.timeout",

  // Session lifecycle
  SESSION_CREATE: "session.create",
  SESSION_DESTROY: "session.destroy",

  // File operations
  FILE_READ: "file.read",
  FILE_WRITE: "file.write",
  FILE_DELETE: "file.delete",

  // PTY lifecycle
  PTY_OPEN: "pty.open",
  PTY_CLOSE: "pty.close",
  PTY_EXIT: "pty.exit",

  // Service lifecycle
  SERVICE_LAUNCH: "service.launch",
  SERVICE_STOP: "service.stop",
  SERVICE_EXIT: "service.exit",

  CAPABILITY_MISMATCH: "capability.mismatch",
  PATH_VIOLATION: "path.violation",

  // Health & info
  HEALTH_CHECK: "health.check",
  INFO_COLLECT: "info.collect",
} as const;
