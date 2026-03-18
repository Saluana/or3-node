/**
 * @module src/host-control/services
 *
 * Purpose:
 * Host-level service launch and management with controlled lifecycle.
 */
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { createId } from "or3-net";

import { ConfigError } from "../utils/errors.ts";

export interface ServiceLaunchRequest {
  readonly serviceName: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly port: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface HostService {
  readonly serviceId: string;
  readonly serviceName: string;
  readonly port: number;
  readonly pid: number;
  readonly createdAt: string;
  stop(): void;
}

export interface HostServiceManagerConfig {
  readonly maxConcurrentServices?: number;
  readonly onOutput?: (serviceId: string, data: string) => void;
  readonly onExit?: (serviceId: string, exitCode: number) => void;
}

export class HostServiceManager {
  private readonly services = new Map<string, HostServiceHandle>();
  private readonly maxConcurrentServices: number;
  private readonly onOutput: ((serviceId: string, data: string) => void) | undefined;
  private readonly onExit: ((serviceId: string, exitCode: number) => void) | undefined;

  public constructor(config: HostServiceManagerConfig = {}) {
    this.maxConcurrentServices = config.maxConcurrentServices ?? 4;
    this.onOutput = config.onOutput;
    this.onExit = config.onExit;
  }

  public launch(request: ServiceLaunchRequest): HostService {
    if (this.services.size >= this.maxConcurrentServices) {
      throw new ConfigError(
        `too many concurrent services (max: ${String(this.maxConcurrentServices)})`,
      );
    }

    const serviceId = createId("svc");
    const args = request.args !== undefined ? [...request.args] : [];

    const child = spawn(request.command, args, {
      cwd: request.cwd ?? undefined,
      env: request.env !== undefined ? { ...process.env, ...request.env } : { ...process.env },
      stdio: "pipe",
      detached: false,
    }) as {
      readonly pid: number | undefined;
      readonly stdout: Readable;
      readonly stderr: Readable;
      once(event: "error", listener: (error: Error) => void): unknown;
      once(event: "exit", listener: (code: number | null) => void): unknown;
      kill(signal?: NodeJS.Signals | number): boolean;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.onOutput?.(serviceId, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      this.onOutput?.(serviceId, chunk);
    });
    child.once("exit", (code) => {
      this.services.delete(serviceId);
      this.onExit?.(serviceId, code ?? -1);
    });
    child.once("error", () => {
      this.services.delete(serviceId);
      this.onExit?.(serviceId, -1);
    });

    const handle: HostServiceHandle = {
      serviceId,
      serviceName: request.serviceName,
      port: request.port,
      pid: child.pid ?? -1,
      createdAt: new Date().toISOString(),
      stop: (): void => {
        child.kill("SIGTERM");
        this.services.delete(serviceId);
      },
      child,
    };

    this.services.set(serviceId, handle);
    return handle;
  }

  public get(serviceId: string): HostService | null {
    return this.services.get(serviceId) ?? null;
  }

  public list(): readonly HostService[] {
    return [...this.services.values()];
  }

  public stop(serviceId: string): boolean {
    const handle = this.services.get(serviceId);
    if (handle === undefined) {
      return false;
    }
    handle.stop();
    return true;
  }

  public stopAll(): void {
    for (const service of this.services.values()) {
      service.stop();
    }
  }
}

interface HostServiceHandle extends HostService {
  readonly child: {
    kill(signal?: NodeJS.Signals | number): boolean;
  };
}
