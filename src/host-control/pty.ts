/**
 * @module src/host-control/pty
 *
 * Purpose:
 * Host-level PTY lifecycle management with platform checks and session limits.
 */
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { createId } from "or3-net";

import { ConfigError } from "../utils/errors.ts";

export interface PtyOpenRequest {
  readonly sessionId: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface PtySession {
  readonly ptyId: string;
  readonly sessionId: string;
  readonly createdAt: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface HostPtyServiceConfig {
  readonly maxConcurrentPtys?: number;
  readonly allowedRoots?: readonly string[];
  readonly onOutput?: (ptyId: string, data: string) => void;
  readonly onExit?: (ptyId: string, exitCode: number, signal?: string) => void;
}

/**
 * Purpose:
 * Manages PTY sessions on the host using platform-standard child_process with
 * stdio: pipe as a portable fallback.
 *
 * Note:
 * True PTY support requires a platform-specific pty library (e.g. node-pty).
 * This implementation provides a compatible interface using pipe-based stdio,
 * which works on all platforms but does not provide terminal features like
 * control codes, window sizing, or raw mode.
 */
export class HostPtyService {
  private readonly sessions = new Map<string, PtySessionHandle>();
  private readonly maxConcurrentPtys: number;
  private readonly onOutput: ((ptyId: string, data: string) => void) | undefined;
  private readonly onExit: ((ptyId: string, exitCode: number, signal?: string) => void) | undefined;

  public constructor(config: HostPtyServiceConfig = {}) {
    this.maxConcurrentPtys = config.maxConcurrentPtys ?? 4;
    this.onOutput = config.onOutput;
    this.onExit = config.onExit;
  }

  public isSupported(): boolean {
    return process.platform === "linux" || process.platform === "darwin";
  }

  public open(request: PtyOpenRequest): PtySession {
    if (!this.isSupported()) {
      throw new ConfigError(`PTY is not supported on platform: ${process.platform}`);
    }
    if (this.sessions.size >= this.maxConcurrentPtys) {
      throw new ConfigError(
        `too many concurrent PTY sessions (max: ${String(this.maxConcurrentPtys)})`,
      );
    }

    const ptyId = createId("pty");
    const command = request.command ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
    const args = request.args !== undefined ? [...request.args] : [];

    const child = spawn(command, args, {
      cwd: request.cwd ?? undefined,
      env: request.env !== undefined ? { ...process.env, ...request.env } : { ...process.env },
      stdio: "pipe",
    }) as {
      readonly stdout: Readable;
      readonly stderr: Readable;
      readonly stdin: Writable;
      once(event: "error", listener: (error: Error) => void): unknown;
      once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
      kill(signal?: NodeJS.Signals | number): boolean;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.onOutput?.(ptyId, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      this.onOutput?.(ptyId, chunk);
    });
    child.once("exit", (code, signal) => {
      this.sessions.delete(ptyId);
      this.onExit?.(ptyId, code ?? -1, signal ?? undefined);
    });
    child.once("error", () => {
      this.sessions.delete(ptyId);
      this.onExit?.(ptyId, -1, undefined);
    });

    const handle: PtySessionHandle = {
      ptyId,
      sessionId: request.sessionId,
      createdAt: new Date().toISOString(),
      write: (data: string): void => {
        child.stdin.write(data);
      },
      resize: (cols: number, rows: number): void => {
        void cols;
        void rows;
        // resize is a no-op when using pipe-based stdio;
        // true terminal resize requires a pty library like node-pty.
      },
      close: (): void => {
        child.kill("SIGTERM");
        this.sessions.delete(ptyId);
      },
      child,
    };

    this.sessions.set(ptyId, handle);
    return handle;
  }

  public get(ptyId: string): PtySession | null {
    return this.sessions.get(ptyId) ?? null;
  }

  public list(): readonly PtySession[] {
    return [...this.sessions.values()];
  }

  public closeAll(): void {
    for (const session of this.sessions.values()) {
      session.close();
    }
  }
}

interface PtySessionHandle extends PtySession {
  readonly child: {
    kill(signal?: NodeJS.Signals | number): boolean;
  };
}
