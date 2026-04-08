import type { AgentLogger } from "../utils/logger.ts";

export type HostExecStatus = "running" | "completed" | "failed" | "aborted" | "timed_out";

export interface HostExecRequest {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

export interface HostExecSnapshot {
  readonly execId: string;
  readonly argv: readonly string[];
  readonly cwd: string | null;
  readonly status: HostExecStatus;
  readonly stdoutPreview: string;
  readonly stderrPreview: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly truncated: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface HostExecResult extends HostExecSnapshot {
  readonly stdout: string;
  readonly stderr: string;
}

export interface HostExecHandle {
  readonly execId: string;
  readonly result: Promise<HostExecResult>;
  abort(): Promise<void>;
}

export interface HostControlConfig {
  readonly allowedRoots: readonly string[];
  readonly allowedEnvPassthrough: readonly string[];
  readonly maxConcurrentExecs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxStdinBytes: number;
  readonly maxCompletedExecs: number;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly onResult?: (result: HostExecResult) => Promise<void> | void;
  readonly logger?: AgentLogger;
}

export const toExecSnapshot = (result: HostExecResult): HostExecSnapshot => ({
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
  stdoutTruncated: result.stdoutTruncated,
  stderrTruncated: result.stderrTruncated,
});
