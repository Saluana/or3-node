import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { createId } from "or3-net";

import {
  toExecSnapshot,
  type HostControlConfig,
  type HostExecHandle,
  type HostExecRequest,
  type HostExecResult,
  type HostExecSnapshot,
  type HostExecStatus,
} from "./types.ts";
import { validateRequestedEnv } from "./env-policy.ts";
import { resolveAllowedWorkingDirectory } from "./paths.ts";
import { ConfigError, toErrorMessage } from "../utils/errors.ts";
import { truncateUtf8 } from "../utils/utf8.ts";
import { AgentEvent, createNoopAgentLogger, type AgentLogger } from "../utils/logger.ts";

const DEFAULT_CONFIG: HostControlConfig = {
  allowedRoots: [],
  allowedEnvPassthrough: [],
  maxConcurrentExecs: 2,
  maxStdoutBytes: 128 * 1024,
  maxStderrBytes: 128 * 1024,
  maxStdinBytes: 64 * 1024,
  maxCompletedExecs: 100,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 300_000,
};

export class HostControlService {
  private readonly config: HostControlConfig;
  private readonly activeExecs = new Map<string, { abort: () => void }>();
  private readonly completedExecs = new Map<string, HostExecResult>();
  private readonly logger: AgentLogger;

  public constructor(config: Partial<HostControlConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    this.logger = config.logger ?? createNoopAgentLogger();
  }

  public getConfig(): HostControlConfig {
    return this.config;
  }

  public listExecs(): Promise<readonly HostExecSnapshot[]> {
    return Promise.resolve([...this.completedExecs.values()].map(toExecSnapshot));
  }

  public getExec(execId: string): Promise<HostExecResult | null> {
    return Promise.resolve(this.completedExecs.get(execId) ?? null);
  }

  public exec(input: HostExecRequest): HostExecHandle {
    try {
      const [command, ...args] = input.argv;
      if (command === undefined) {
        throw new ConfigError("argv must contain at least one executable");
      }
      if (this.activeExecs.size >= this.config.maxConcurrentExecs) {
        throw new ConfigError("too many concurrent execs");
      }

      const stdin = input.stdin ?? "";
      if (Buffer.byteLength(stdin, "utf8") > this.config.maxStdinBytes) {
        throw new ConfigError("stdin exceeds configured maxStdinBytes");
      }
      if (input.env !== undefined) {
        validateRequestedEnv(input.env, this.config.allowedEnvPassthrough);
      }

      const execId = createId("hostexec");
      const cwd = resolveAllowedWorkingDirectory(input.cwd, this.config.allowedRoots);
      const timeoutMs = Math.min(
        input.timeoutMs ?? this.config.defaultTimeoutMs,
        this.config.maxTimeoutMs,
      );
      this.logger.info(AgentEvent.EXEC_START, "host execution started", {
        exec_id: execId,
        argv: [...input.argv],
        cwd,
        timeout_ms: timeoutMs,
      });

      let abortProcess: () => void = () => {
        return;
      };
      this.activeExecs.set(execId, {
        abort: () => {
          abortProcess();
        },
      });

      const result = this.runProcess(
        execId,
        command,
        args,
        input,
        cwd,
        stdin,
        timeoutMs,
        (abort) => {
          abortProcess = abort;
        },
      ).finally(() => {
        this.activeExecs.delete(execId);
      });

      return {
        execId,
        result,
        abort: (): Promise<void> => {
          this.activeExecs.get(execId)?.abort();
          return Promise.resolve();
        },
      };
    } catch (error: unknown) {
      this.logExecSetupFailure(input, error);
      throw error;
    }
  }

  private async runProcess(
    execId: string,
    command: string,
    args: readonly string[],
    input: HostExecRequest,
    cwd: string | null,
    stdin: string,
    timeoutMs: number,
    setAbort: (abort: () => void) => void,
  ): Promise<HostExecResult> {
    const startedAt = new Date().toISOString();
    const child: ChildProcessWithoutNullStreams = spawn(command, [...args], {
      cwd: cwd ?? undefined,
      env:
        input.env === undefined
          ? { ...process.env }
          : {
              ...process.env,
              ...input.env,
            },
      stdio: "pipe",
    });
    setAbort(() => {
      child.kill("SIGTERM");
    });

    let stdoutState = createBoundedTextState();
    let stderrState = createBoundedTextState();
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutState = appendBounded(stdoutState, chunk, this.config.maxStdoutBytes);
      input.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderrState = appendBounded(stderrState, chunk, this.config.maxStderrBytes);
      input.onStderr?.(chunk);
    });

    if (stdin.length > 0) {
      child.stdin.write(stdin);
    }
    child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const terminal = await new Promise<{ code: number; signal: string; aborted: boolean }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          resolve({ code: code ?? -1, signal: signal ?? "", aborted: signal !== null });
        });
      },
    )
      .finally(() => {
        clearTimeout(timer);
      })
      .catch((error: unknown) => {
        const result: HostExecResult = {
          execId,
          argv: [...input.argv],
          cwd,
          status: "failed",
          stdoutPreview: stdoutState.value,
          stderrPreview: toErrorMessage(error),
          stdout: stdoutState.value,
          stderr: toErrorMessage(error),
          startedAt,
          completedAt: new Date().toISOString(),
          exitCode: -1,
          signal: null,
          truncated: stdoutState.truncated || stderrState.truncated,
          stdoutTruncated: stdoutState.truncated,
          stderrTruncated: stderrState.truncated,
        };
        this.logger.error(AgentEvent.EXEC_FINISH, "host execution failed before exit", {
          exec_id: execId,
          argv: [...input.argv],
          cwd,
          status: result.status,
          error: result.stderr,
          truncated: result.truncated,
          stdout_truncated: result.stdoutTruncated,
          stderr_truncated: result.stderrTruncated,
          failure_class: "exec",
        });
        this.rememberCompletedExec(result);
        return result;
      });

    if ("execId" in terminal) {
      return terminal;
    }

    const status: HostExecStatus = timedOut
      ? "timed_out"
      : terminal.aborted
        ? "aborted"
        : terminal.code === 0
          ? "completed"
          : "failed";

    const result: HostExecResult = {
      execId,
      argv: [...input.argv],
      cwd,
      status,
      stdoutPreview: stdoutState.value,
      stderrPreview: stderrState.value,
      stdout: stdoutState.value,
      stderr: stderrState.value,
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: terminal.code,
      signal: terminal.signal === "" ? null : (terminal.signal as NodeJS.Signals),
      truncated: stdoutState.truncated || stderrState.truncated,
      stdoutTruncated: stdoutState.truncated,
      stderrTruncated: stderrState.truncated,
    };
    this.rememberCompletedExec(result);
    this.logExecResult(result);
    await this.config.onResult?.(result);
    return result;
  }

  private rememberCompletedExec(result: HostExecResult): void {
    if (this.config.maxCompletedExecs <= 0) {
      return;
    }
    this.completedExecs.set(result.execId, result);
    while (this.completedExecs.size > this.config.maxCompletedExecs) {
      const oldestExecId = this.completedExecs.keys().next().value;
      if (oldestExecId === undefined) {
        break;
      }
      this.completedExecs.delete(oldestExecId);
    }
  }

  private logExecSetupFailure(input: HostExecRequest, error: unknown): void {
    const errorMessage = toErrorMessage(error);
    if (isPathViolationMessage(errorMessage)) {
      this.logger.error(AgentEvent.PATH_VIOLATION, "host execution blocked by path policy", {
        argv: [...input.argv],
        cwd: input.cwd ?? null,
        error: errorMessage,
        failure_class: "path_violation",
      });
      return;
    }

    this.logger.error(AgentEvent.CONFIG_FAIL, "host execution rejected by config", {
      argv: [...input.argv],
      cwd: input.cwd ?? null,
      error: errorMessage,
      failure_class: "config",
    });
  }

  private logExecResult(result: HostExecResult): void {
    const details = {
      exec_id: result.execId,
      argv: [...result.argv],
      cwd: result.cwd,
      status: result.status,
      exit_code: result.exitCode,
      signal: result.signal,
      truncated: result.truncated,
      stdout_truncated: result.stdoutTruncated,
      stderr_truncated: result.stderrTruncated,
    };

    switch (result.status) {
      case "running":
        return;
      case "completed":
        this.logger.info(AgentEvent.EXEC_FINISH, "host execution completed", details);
        return;
      case "aborted":
        this.logger.warn(AgentEvent.EXEC_ABORT, "host execution aborted", {
          ...details,
          failure_class: "exec",
        });
        return;
      case "timed_out":
        this.logger.warn(AgentEvent.EXEC_TIMEOUT, "host execution timed out", {
          ...details,
          failure_class: "exec",
        });
        return;
      case "failed":
        this.logger.error(AgentEvent.EXEC_FINISH, "host execution failed", {
          ...details,
          stderr: result.stderrPreview,
          failure_class: "exec",
        });
        return;
      default:
        return;
    }
  }
}

interface BoundedTextState {
  readonly value: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

const createBoundedTextState = (): BoundedTextState => ({
  value: "",
  bytes: 0,
  truncated: false,
});

const appendBounded = (
  existing: BoundedTextState,
  chunk: string,
  maxBytes: number,
): BoundedTextState => {
  if (existing.truncated) {
    return existing;
  }
  const chunkBytes = Buffer.byteLength(chunk, "utf8");
  if (existing.bytes + chunkBytes <= maxBytes) {
    return {
      value: `${existing.value}${chunk}`,
      bytes: existing.bytes + chunkBytes,
      truncated: false,
    };
  }

  return {
    value: `${existing.value}${truncateUtf8(chunk, maxBytes - existing.bytes)}`,
    bytes: maxBytes,
    truncated: true,
  };
};

const isPathViolationMessage = (message: string): boolean =>
  message.includes("outside allowed roots");
