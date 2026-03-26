import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { HostFileService } from "../src/host-control/files.ts";
import { createAgentLogger, type LogEntry } from "../src/utils/logger.ts";

let tmpDir: string;
let outsideDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "or3-files-test-"));
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "or3-files-outside-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(outsideDir, { recursive: true, force: true });
});

const expectThrowsAsync = async (fn: () => Promise<unknown>, match: string): Promise<void> => {
  try {
    await fn();
    throw new Error("expected error");
  } catch (error: unknown) {
    expect(error instanceof Error && error.message.includes(match)).toBe(true);
  }
};

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

describe("HostFileService", () => {
  test("isEnabled returns true when allowed roots are configured", () => {
    const service = new HostFileService({ allowedRoots: [tmpDir] });
    expect(service.isEnabled()).toBe(true);
  });

  test("isEnabled returns false when no allowed roots", () => {
    const service = new HostFileService({ allowedRoots: [] });
    expect(service.isEnabled()).toBe(false);
  });

  test("write and read text file round-trip", async () => {
    const service = new HostFileService({ allowedRoots: [tmpDir] });
    const filePath = path.join(tmpDir, "hello.txt");
    const written = await service.write(filePath, { content_text: "hello world" });
    const expectedPath = await fs.realpath(filePath);
    expect(written.bytes_transferred).toBeGreaterThan(0);
    expect(written.path).toBe(expectedPath);

    const read = await service.read(filePath, "text");
    expect(read.content_text).toBe("hello world");
    expect(read.encoding).toBe("text");
    expect(read.size_bytes).toBe(11);
  });

  test("emits structured file operation logs", async () => {
    const logs = createLogWriter();
    const service = new HostFileService({
      allowedRoots: [tmpDir],
      logger: createAgentLogger(logs.writer),
    });
    const filePath = path.join(tmpDir, "logged.txt");

    await service.write(filePath, { content_text: "logged" });
    await service.read(filePath, "text");

    const entries = parseLogEntries(logs.chunks);
    expect(entries.some((entry) => entry.event === "file.write")).toBe(true);
    expect(entries.some((entry) => entry.event === "file.read")).toBe(true);
  });

  test("write and read base64 file round-trip", async () => {
    const service = new HostFileService({ allowedRoots: [tmpDir] });
    const filePath = path.join(tmpDir, "binary.bin");
    const content = Buffer.from([0x00, 0x01, 0x02, 0xff]).toString("base64");
    await service.write(filePath, { content_base64: content });

    const read = await service.read(filePath, "base64");
    expect(read.content_base64).toBe(content);
    expect(read.encoding).toBe("base64");
    expect(read.size_bytes).toBe(4);
  });

  test("write creates intermediate directories", async () => {
    const service = new HostFileService({ allowedRoots: [tmpDir] });
    const filePath = path.join(tmpDir, "a", "b", "c", "deep.txt");
    await service.write(filePath, { content_text: "deep" });
    const read = await service.read(filePath, "text");
    expect(read.content_text).toBe("deep");
  });

  test("write rejects when overwrite is false and file exists", async () => {
    const service = new HostFileService({ allowedRoots: [tmpDir] });
    const filePath = path.join(tmpDir, "existing.txt");
    await service.write(filePath, { content_text: "first" });
    await expectThrowsAsync(
      () => service.write(filePath, { content_text: "second", overwrite: false }),
      "already exists",
    );
  });

  test("write overwrites by default", async () => {
    const service = new HostFileService({ allowedRoots: [tmpDir] });
    const filePath = path.join(tmpDir, "overwrite.txt");
    await service.write(filePath, { content_text: "first" });
    await service.write(filePath, { content_text: "second" });

    const read = await service.read(filePath, "text");
    expect(read.content_text).toBe("second");
  });

  test("delete removes files", async () => {
    const service = new HostFileService({ allowedRoots: [tmpDir] });
    const filePath = path.join(tmpDir, "deleteme.txt");
    await service.write(filePath, { content_text: "gone" });
    const result = await service.delete(filePath);
    expect(result.deleted).toBe(true);

    let exists = true;
    try {
      await fs.access(filePath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test("delete returns false for non-existent files", async () => {
    const service = new HostFileService({ allowedRoots: [tmpDir] });
    const result = await service.delete(path.join(tmpDir, "ghost.txt"));
    expect(result.deleted).toBe(false);
  });

  test("browse lists directory contents", async () => {
    const service = new HostFileService({ allowedRoots: [tmpDir] });
    await service.write(path.join(tmpDir, "a.txt"), { content_text: "a" });
    await service.write(path.join(tmpDir, "b.txt"), { content_text: "b" });
    await fs.mkdir(path.join(tmpDir, "subdir"));

    const entries = await service.browse(tmpDir);
    const names = entries.map((e) => path.basename(e.path)).sort();
    expect(names).toEqual(["a.txt", "b.txt", "subdir"]);
    const subdir = entries.find((e) => path.basename(e.path) === "subdir");
    expect(subdir).toBeDefined();
    if (subdir) expect(subdir.kind).toBe("directory");
    const aFile = entries.find((e) => path.basename(e.path) === "a.txt");
    expect(aFile).toBeDefined();
    if (aFile) expect(aFile.kind).toBe("file");
  });

  test("browse recursive walks subdirectories", async () => {
    const service = new HostFileService({ allowedRoots: [tmpDir] });
    await service.write(path.join(tmpDir, "top.txt"), { content_text: "top" });
    await service.write(path.join(tmpDir, "sub", "nested.txt"), { content_text: "nested" });

    const entries = await service.browse(tmpDir, true);
    const paths = entries.map((e) => path.basename(e.path)).sort();
    expect(paths).toContain("top.txt");
    expect(paths).toContain("sub");
    expect(paths).toContain("nested.txt");
  });

  test("rejects paths outside allowed roots", async () => {
    const service = new HostFileService({ allowedRoots: [tmpDir] });
    await expectThrowsAsync(() => service.read("/etc/passwd"), "outside allowed roots");
  });

  test("rejects write outside allowed roots", async () => {
    const service = new HostFileService({ allowedRoots: [tmpDir] });
    await expectThrowsAsync(
      () => service.write("/tmp/evil.txt", { content_text: "bad" }),
      "outside allowed roots",
    );
  });

  test("logs file path violations clearly", async () => {
    const logs = createLogWriter();
    const service = new HostFileService({
      allowedRoots: [tmpDir],
      logger: createAgentLogger(logs.writer),
    });

    await expectThrowsAsync(
      () => service.write("/tmp/evil.txt", { content_text: "bad" }),
      "outside allowed roots",
    );

    const entries = parseLogEntries(logs.chunks);
    expect(entries.some((entry) => entry.event === "path.violation")).toBe(true);
    expect(entries.some((entry) => entry.details?.failure_class === "path_violation")).toBe(true);
  });

  test("rejects content exceeding size cap", async () => {
    const service = new HostFileService({ allowedRoots: [tmpDir], maxFileBytes: 10 });
    const filePath = path.join(tmpDir, "big.txt");
    await expectThrowsAsync(
      () => service.write(filePath, { content_text: "a".repeat(100) }),
      "exceeds size cap",
    );
  });

  test("rejects reading file exceeding size cap", async () => {
    const service = new HostFileService({ allowedRoots: [tmpDir], maxFileBytes: 5 });
    const filePath = path.join(tmpDir, "big.txt");
    await fs.writeFile(filePath, "a".repeat(100));
    await expectThrowsAsync(() => service.read(filePath), "exceeds size cap");
  });

  test("rejects reading through a symlink that escapes the allowed root", async () => {
    const service = new HostFileService({ allowedRoots: [tmpDir] });
    const outsideFile = path.join(outsideDir, "outside.txt");
    const linkPath = path.join(tmpDir, "outside-link.txt");
    await fs.writeFile(outsideFile, "secret");
    await fs.symlink(outsideFile, linkPath);

    await expectThrowsAsync(() => service.read(linkPath), "outside allowed roots");
  });

  test("rejects writing through a symlinked directory that escapes the allowed root", async () => {
    const service = new HostFileService({ allowedRoots: [tmpDir] });
    const linkDir = path.join(tmpDir, "linkdir");
    await fs.symlink(outsideDir, linkDir);

    await expectThrowsAsync(
      () => service.write(path.join(linkDir, "escape.txt"), { content_text: "nope" }),
      "outside allowed roots",
    );
  });

  test("returns canonical file paths after resolving allowed symlinks", async () => {
    const service = new HostFileService({ allowedRoots: [tmpDir] });
    const canonicalPath = path.join(tmpDir, "target.txt");
    const symlinkPath = path.join(tmpDir, "link.txt");
    await fs.writeFile(canonicalPath, "hello");
    await fs.symlink(canonicalPath, symlinkPath);

    const result = await service.read(symlinkPath, "text");
    const expectedCanonicalPath = await fs.realpath(canonicalPath);

    expect(result.path).toBe(expectedCanonicalPath);
    expect(result.content_text).toBe("hello");
  });

  test("browse defaults to first allowed root when no path provided", async () => {
    const service = new HostFileService({ allowedRoots: [tmpDir] });
    await service.write(path.join(tmpDir, "root.txt"), { content_text: "root" });
    const entries = await service.browse();
    expect(entries.some((e) => path.basename(e.path) === "root.txt")).toBe(true);
  });
});
