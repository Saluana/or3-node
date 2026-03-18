import { afterEach, describe, expect, test } from "bun:test";

import { HostPtyService } from "../src/host-control/pty.ts";

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

  test("isSupported returns true on linux/darwin", () => {
    service = new HostPtyService();
    // Test is running on one of these platforms in CI/dev
    expect(service.isSupported()).toBe(true);
  });

  test("open creates a session and list returns it", () => {
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
    service = new HostPtyService();
    const session = service.open({ sessionId: "sess_1" });
    expect(service.get(session.ptyId)).not.toBeNull();
    expect(service.get("nonexistent")).toBeNull();
  });

  test("write sends data to stdin", async () => {
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
    service = new HostPtyService();
    const session = service.open({ sessionId: "sess_1" });
    session.close();
    expect(service.get(session.ptyId)).toBeNull();
  });

  test("closeAll terminates all sessions", () => {
    service = new HostPtyService({ maxConcurrentPtys: 10 });
    service.open({ sessionId: "sess_1" });
    service.open({ sessionId: "sess_2" });
    expect(service.list().length).toBe(2);
    service.closeAll();
    expect(service.list().length).toBe(0);
  });

  test("max concurrent PTY sessions enforced", () => {
    service = new HostPtyService({ maxConcurrentPtys: 1 });
    service.open({ sessionId: "sess_1" });
    expect(() => service.open({ sessionId: "sess_2" })).toThrow("too many concurrent PTY sessions");
  });

  test("resize is callable without error", () => {
    service = new HostPtyService();
    const session = service.open({ sessionId: "sess_1" });
    // resize is a no-op with pipe-based stdio but should not throw
    expect(() => {
      session.resize(120, 40);
    }).not.toThrow();
  });

  test("onExit callback fires when process terminates", async () => {
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
});
