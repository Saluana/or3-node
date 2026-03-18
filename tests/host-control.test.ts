import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import { HostControlService } from "../src/host-control/service.ts";

describe("HostControlService", () => {
  test("executes argv-based commands", async () => {
    const service = new HostControlService({ maxConcurrentExecs: 1 });
    const handle = await service.exec({ argv: ["echo", "hello"] });
    const result = await handle.result;

    expect(result.status).toBe("completed");
    expect(result.stdout).toContain("hello");
  });

  test("rejects cwd outside allowed roots", () => {
    const service = new HostControlService({
      allowedRoots: [path.join(os.tmpdir(), "allowed-root")],
    });
    expect(() => service.exec({ argv: ["pwd"], cwd: "/" })).toThrow(/outside allowed roots/);
  });

  test("aborts long-running commands", async () => {
    const service = new HostControlService({ maxConcurrentExecs: 1 });
    const handle = await service.exec({ argv: ["sleep", "5"], timeoutMs: 5_000 });
    await handle.abort();
    const result = await handle.result;

    expect(result.status).toBe("aborted");
  });

  test("rejects env vars outside the allowlist", () => {
    const service = new HostControlService({ allowedEnvPassthrough: ["SAFE_ENV"] });
    expect(() => service.exec({ argv: ["echo", "nope"], env: { SECRET_ENV: "value" } })).toThrow(
      /allowlist/,
    );
  });

  test("returns a failed result when the binary is missing", async () => {
    const service = new HostControlService();
    const handle = await service.exec({ argv: ["definitely-not-a-real-or3-binary"] });
    const result = await handle.result;

    expect(result.status).toBe("failed");
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test("caps oversized stdout output", async () => {
    const service = new HostControlService({ maxStdoutBytes: 32, maxConcurrentExecs: 1 });
    const handle = await service.exec({ argv: ["python3", "-c", 'print("x" * 128)'] });
    const result = await handle.result;

    expect(result.status).toBe("completed");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(32);
    expect(result.truncated).toBeTrue();
  });

  test("times out runaway commands", async () => {
    const service = new HostControlService({
      maxConcurrentExecs: 1,
      defaultTimeoutMs: 5,
      maxTimeoutMs: 5,
    });
    const handle = await service.exec({ argv: ["sleep", "1"] });
    const result = await handle.result;

    expect(result.status).toBe("timed_out");
  });
});
