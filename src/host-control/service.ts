import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { createId } from "or3-net";

import type {
  HostControlConfig,
  HostExecHandle,
  HostExecRequest,
  HostExecResult,
  HostExecSnapshot,
  HostExecStatus,
} from "./types.ts";
import { resolveAllowedWorkingDirectory } from "./paths.ts";
import { ConfigError } from "../utils/errors.ts";

const DEFAULT_CONFIG: HostControlConfig = {
  allowedRoots: [],
  allowedEnvPassthrough: [],
  maxConcurrentExecs: 2,
  maxStdoutBytes: 128 * 1024,
  maxStderrBytes: 128 * 1024,
  maxStdinBytes: 64 * 1024,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 300_000,
};

export class HostControlService {
  private readonly config: HostControlConfig;
  private readonly activeExecs = new Map<string, { abort: () => void }>();
  private readonly completedExecs = new Map<string, HostExecResult>();

  public constructor(config: Partial<HostControlConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  public getConfig(): HostControlConfig {
    return this.config;
  }

  public listExecs(): Promise<readonly HostExecSnapshot[]> {
    return Promise.resolve([...this.completedExecs.values()].map(toSnapshot));
  }

  public getExec(execId: string): Promise<HostExecResult | null> {
    return Promise.resolve(this.completedExecs.get(execId) ?? null);
  }

  public exec(input: HostExecRequest): Promise<HostExecHandle> {
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
    let abortProcess: () => void = () => {
      return;
    };
    this.activeExecs.set(execId, {
      abort: () => {
        abortProcess();
      },
    });

    const result = this.runProcess(execId, command, args, input, cwd, stdin, timeoutMs, (abort) => {
      abortProcess = abort;
    }).finally(() => {
      this.activeExecs.delete(execId);
    });

    return Promise.resolve({
      execId,
      result,
      abort: (): Promise<void> => {
        this.activeExecs.get(execId)?.abort();
        return Promise.resolve();
      },
    });
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
    const child = spawn(command, [...args], {
      cwd: cwd ?? undefined,
      env:
        input.env === undefined
          ? { ...process.env }
          : {
              ...process.env,
              ...input.env,
            },
      stdio: "pipe",
    }) as {
      readonly stdout: Readable;
      readonly stderr: Readable;
      readonly stdin: Writable;
      once(event: "error", listener: (error: Error) => void): unknown;
      once(
        event: "exit",
        listener: (code: number | null, signal: NodeJS.Signals | null) => void,
      ): unknown;
      kill(signal?: NodeJS.Signals | number): boolean;
    };
    setAbort(() => {
      child.kill("SIGTERM");
    });

    let stdout = "";
    let stderr = "";
    let truncationCount = 0;
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const next = appendBounded(stdout, chunk, this.config.maxStdoutBytes);
      stdout = next.value;
      truncationCount += Number(next.truncated);
    });
    child.stderr.on("data", (chunk: string) => {
      const next = appendBounded(stderr, chunk, this.config.maxStderrBytes);
      stderr = next.value;
      truncationCount += Number(next.truncated);
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
          stdoutPreview: stdout,
          stderrPreview: toErrorMessage(error),
          stdout,
          stderr: toErrorMessage(error),
          startedAt,
          completedAt: new Date().toISOString(),
          exitCode: -1,
          signal: null,
          truncated: truncationCount > 0,
        };
        this.completedExecs.set(execId, result);
        return null;
      });

    if (terminal === null) {
      const failedResult = this.completedExecs.get(execId);
      if (failedResult === undefined) {
        throw new Error(`host exec result was not recorded for ${execId}`);
      }
      return failedResult;
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
      stdoutPreview: stdout,
      stderrPreview: stderr,
      stdout,
      stderr,
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: terminal.code,
      signal: terminal.signal === "" ? null : (terminal.signal as NodeJS.Signals),
      truncated: truncationCount > 0,
    };
    this.completedExecs.set(execId, result);
    return result;
  }
}

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
    value: nextBuffer.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
};

const validateRequestedEnv = (
  requestedEnv: Readonly<Record<string, string>>,
  allowedNames: readonly string[],
): void => {
  const disallowed = Object.keys(requestedEnv).filter((name) => !allowedNames.includes(name));
  if (disallowed[0] !== undefined) {
    throw new ConfigError(`env vars are outside allowlist: ${disallowed.join(", ")}`);
  }
};

const toSnapshot = (result: HostExecResult): HostExecSnapshot => ({
  execId: result.execId,
  argv: result.argv,
  cwd: result.cwd,
  status: result.status,
  stdoutPreview: result.stdoutPreview,
  stderrPreview: result.stderrPreview,
  startedAt: result.startedAt,
  completedAt: result.completedAt,
  exitCode: result.exitCode,
  signal: result.signal,
  truncated: result.truncated,
});

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";
