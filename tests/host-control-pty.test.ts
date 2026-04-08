import { afterEach, describe, expect, test } from "bun:test";

import { HostPtyService } from "../src/host-control/pty.ts";
import { isPtySupportedPlatform } from "../src/runtime-capabilities.ts";
import { createAgentLogger, type LogEntry } from "../src/utils/logger.ts";

const PTY_SUPPORTED = isPtySupportedPlatform();

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

describe("HostPtyService", () => {
  let service: HostPtyService;
  const cleanup: (() => void)[] = [];

  afterEach(() => {
    for (const fn of cleanup) {
      fn();
    }
    cleanup.length = 0;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- service may be uninitialized if test throws before assignment
    if (service) service.closeAll();
  });

  test("isSupported reflects the current platform", () => {
    service = new HostPtyService();
    expect(service.isSupported()).toBe(PTY_SUPPORTED);
  });

  test("open creates a session and list returns it", () => {
    if (!PTY_SUPPORTED) {
      service = new HostPtyService();
      expect(() => service.open({ sessionId: "sess_1" })).toThrow("PTY is not supported");
      return;
    }
    const outputs: string[] = [];
    service = new HostPtyService({
      onOutput: (_id, data) => outputs.push(data),
    });
    const session = service.open({ sessionId: "sess_1" });
    expect(session.ptyId).toMatch(/^pty_/);
    expect(session.sessionId).toBe("sess_1");
    expect(service.list().length).toBe(1);
  });

  test("get retrieves session by id", () => {
    if (!PTY_SUPPORTED) {
      return;
    }
    service = new HostPtyService();
    const session = service.open({ sessionId: "sess_1" });
    expect(service.get(session.ptyId)).not.toBeNull();
    expect(service.get("nonexistent")).toBeNull();
  });

  test("write sends data to stdin", async () => {
    if (!PTY_SUPPORTED) {
      return;
    }
    const outputs: string[] = [];
    service = new HostPtyService({
      onOutput: (_id, data) => outputs.push(data),
    });
    const session = service.open({
      sessionId: "sess_1",
      command: "cat",
    });
    session.write("hello\n");

    // Wait for output to arrive
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (outputs.some((o) => o.includes("hello"))) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      setTimeout(check, 50);
    });
    expect(outputs.some((o) => o.includes("hello"))).toBe(true);
  });

  test("close terminates the session", () => {
    if (!PTY_SUPPORTED) {
      return;
    }
    service = new HostPtyService();
    const session = service.open({ sessionId: "sess_1" });
    session.close();
    expect(service.get(session.ptyId)).toBeNull();
  });

  test("closeAll terminates all sessions", () => {
    if (!PTY_SUPPORTED) {
      return;
    }
    service = new HostPtyService({ maxConcurrentPtys: 10 });
    service.open({ sessionId: "sess_1" });
    service.open({ sessionId: "sess_2" });
    expect(service.list().length).toBe(2);
    service.closeAll();
    expect(service.list().length).toBe(0);
  });

  test("max concurrent PTY sessions enforced", () => {
    if (!PTY_SUPPORTED) {
      return;
    }
    service = new HostPtyService({ maxConcurrentPtys: 1 });
    service.open({ sessionId: "sess_1" });
    expect(() => service.open({ sessionId: "sess_2" })).toThrow("too many concurrent PTY sessions");
  });

  test("resize is callable without error", () => {
    if (!PTY_SUPPORTED) {
      return;
    }
    service = new HostPtyService();
    const session = service.open({ sessionId: "sess_1" });
    // resize is a no-op with pipe-based stdio but should not throw
    expect(() => {
      session.resize(120, 40);
    }).not.toThrow();
  });

  test("onExit callback fires when process terminates", async () => {
    if (!PTY_SUPPORTED) {
      return;
    }
    let exitPtyId = "";
    let exitCode = -999;
    service = new HostPtyService({
      onExit: (ptyId, code) => {
        exitPtyId = ptyId;
        exitCode = code;
      },
    });
    const session = service.open({
      sessionId: "sess_1",
      command: "true",
    });

    // Wait for exit
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (exitCode !== -999) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      setTimeout(check, 50);
    });
    expect(exitPtyId).toBe(session.ptyId);
    expect(exitCode).toBe(0);
  });

  test("emits structured PTY lifecycle logs", async () => {
    if (!PTY_SUPPORTED) {
      return;
    }
    const logs = createLogWriter();
    let exitCode = -999;
    service = new HostPtyService({
      logger: createAgentLogger(logs.writer),
      onExit: (_ptyId, code) => {
        exitCode = code;
      },
    });
    service.open({ sessionId: "sess_logs", command: "true" });

    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (exitCode !== -999) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      setTimeout(check, 50);
    });

    const entries = parseLogEntries(logs.chunks);
    expect(entries.some((entry) => entry.event === "pty.open")).toBe(true);
    expect(entries.some((entry) => entry.event === "pty.exit")).toBe(true);
  });

  test("rejects PTY env vars outside the allowlist", () => {
    if (!PTY_SUPPORTED) {
      return;
    }
    service = new HostPtyService({ allowedEnvNames: [] });
    expect(() =>
      service.open({
        sessionId: "sess_env_blocked",
        command: "cat",
        env: { AWS_SECRET_ACCESS_KEY: "blocked" },
      }),
    ).toThrow("env vars are outside allowlist");
  });

  test("allows PTY env vars that are explicitly allowlisted", async () => {
    if (!PTY_SUPPORTED) {
      return;
    }
    const outputs: string[] = [];
    service = new HostPtyService({
      allowedEnvNames: ["ALLOWED_NAME"],
      onOutput: (_id, data) => outputs.push(data),
    });
    const session = service.open({
      sessionId: "sess_env_allowed",
      command: "/bin/sh",
      args: ["-c", 'printf "%s\\n" "$ALLOWED_NAME"'],
      env: { ALLOWED_NAME: "ok" },
    });

    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (outputs.some((entry) => entry.includes("ok"))) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      setTimeout(check, 50);
    });

    expect(outputs.some((entry) => entry.includes("ok"))).toBe(true);
    session.close();
  });
});
