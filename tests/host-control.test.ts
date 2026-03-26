import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { HostExecHistoryStore } from "../src/host-control/history.ts";
import { HostControlService } from "../src/host-control/service.ts";
import { resolveStoragePaths } from "../src/storage/paths.ts";
import { createAgentLogger, type LogEntry } from "../src/utils/logger.ts";

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

describe("HostControlService", () => {
  test("executes argv-based commands", async () => {
    const service = new HostControlService({ maxConcurrentExecs: 1 });
    const handle = await service.exec({ argv: ["echo", "hello"] });
    const result = await handle.result;

    expect(result.status).toBe("completed");
    expect(result.stdout).toContain("hello");
  });

  test("emits structured exec lifecycle logs", async () => {
    const logs = createLogWriter();
    const service = new HostControlService({
      maxConcurrentExecs: 1,
      logger: createAgentLogger(logs.writer),
    });

    const handle = await service.exec({ argv: ["echo", "logged"] });
    const result = await handle.result;

    expect(result.status).toBe("completed");
    const entries = parseLogEntries(logs.chunks);
    expect(entries.some((entry) => entry.event === "exec.start")).toBe(true);
    expect(entries.some((entry) => entry.event === "exec.finish")).toBe(true);
  });

  test("rejects cwd outside allowed roots", () => {
    const service = new HostControlService({
      allowedRoots: [path.join(os.tmpdir(), "allowed-root")],
    });
    expect(() => service.exec({ argv: ["pwd"], cwd: "/" })).toThrow(/outside allowed roots/);
  });

  test("logs cwd path violations clearly", () => {
    const logs = createLogWriter();
    const service = new HostControlService({
      allowedRoots: [path.join(os.tmpdir(), "allowed-root")],
      logger: createAgentLogger(logs.writer),
    });

    expect(() => service.exec({ argv: ["pwd"], cwd: "/" })).toThrow(/outside allowed roots/);

    const entries = parseLogEntries(logs.chunks);
    expect(entries.some((entry) => entry.event === "path.violation")).toBe(true);
    expect(entries.some((entry) => entry.details?.failure_class === "path_violation")).toBe(true);
  });

  test("rejects cwd symlinks that escape the allowed root", async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "or3-allowed-root-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "or3-outside-root-"));
    const escapedLink = path.join(allowedRoot, "escaped");
    await fs.symlink(outsideRoot, escapedLink);

    try {
      const service = new HostControlService({
        allowedRoots: [allowedRoot],
      });
      expect(() => service.exec({ argv: ["pwd"], cwd: escapedLink })).toThrow(
        /outside allowed roots/,
      );
    } finally {
      await fs.rm(allowedRoot, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
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

  test("env validation errors do not leak secret values", () => {
    const service = new HostControlService({ allowedEnvPassthrough: ["SAFE_ENV"] });
    expect(() =>
      service.exec({ argv: ["echo", "nope"], env: { SECRET_ENV: "super-secret-value" } }),
    ).toThrow(/SECRET_ENV/);
    expect(() =>
      service.exec({ argv: ["echo", "nope"], env: { SECRET_ENV: "super-secret-value" } }),
    ).not.toThrow(/super-secret-value/);
  });

  test("caps oversized stdout output", async () => {
    const service = new HostControlService({ maxStdoutBytes: 32, maxConcurrentExecs: 1 });
    const handle = await service.exec({ argv: ["python3", "-c", 'print("x" * 128)'] });
    const result = await handle.result;

    expect(result.status).toBe("completed");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(32);
    expect(result.truncated).toBeTrue();
    expect(result.stdoutTruncated).toBeTrue();
    expect(result.stderrTruncated).toBeFalse();
  });

  test("caps oversized stderr output separately", async () => {
    const service = new HostControlService({ maxStderrBytes: 24, maxConcurrentExecs: 1 });
    const handle = await service.exec({
      argv: ["python3", "-c", 'import sys; sys.stderr.write("e" * 128)'],
    });
    const result = await handle.result;

    expect(result.status).toBe("completed");
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(24);
    expect(result.truncated).toBeTrue();
    expect(result.stdoutTruncated).toBeFalse();
    expect(result.stderrTruncated).toBeTrue();
  });

  test("truncates stdout on UTF-8 character boundaries", async () => {
    const emoji = "😀";
    const service = new HostControlService({ maxStdoutBytes: 10, maxConcurrentExecs: 1 });
    const handle = await service.exec({
      argv: ["python3", "-c", `import sys; sys.stdout.write(${JSON.stringify(emoji.repeat(3))})`],
    });
    const result = await handle.result;

    expect(result.status).toBe("completed");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(10);
    expect(result.stdout).toBe(emoji.repeat(2));
    expect(result.stdout).not.toContain("�");
  });

  test("persists recent execution snapshots for restart-safe debugging", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "or3-node-history-"));
    process.env.HOME = tempHome;
    const history = new HostExecHistoryStore();
    const service = new HostControlService({ onResult: (result) => history.append(result) });

    const handle = await service.exec({ argv: ["echo", "persisted"] });
    await handle.result;

    const snapshots = await history.list();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.stdoutPreview).toContain("persisted");
  });

  test("reads legacy execution snapshots without truncation flags", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "or3-node-history-legacy-"));
    process.env.HOME = tempHome;
    const { dataDir, execHistoryFilePath } = resolveStoragePaths();
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      execHistoryFilePath,
      `${JSON.stringify([
        {
          execId: "hostexec_legacy",
          argv: ["echo", "legacy"],
          cwd: null,
          status: "completed",
          stdoutPreview: "legacy",
          stderrPreview: "",
          startedAt: "2024-01-01T00:00:00.000Z",
          completedAt: "2024-01-01T00:00:01.000Z",
          exitCode: 0,
          signal: null,
          truncated: false,
        },
      ])}\n`,
      "utf8",
    );

    const history = new HostExecHistoryStore();
    const snapshots = await history.list();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.stdoutTruncated).toBeFalse();
    expect(snapshots[0]?.stderrTruncated).toBeFalse();
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
