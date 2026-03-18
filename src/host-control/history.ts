import fs from "node:fs/promises";

import type { HostExecResult, HostExecSnapshot } from "./types.ts";
import { resolveStoragePaths } from "../storage/paths.ts";

const DEFAULT_HISTORY_LIMIT = 20;

export class HostExecHistoryStore {
  public constructor(private readonly limit = DEFAULT_HISTORY_LIMIT) {}

  public async list(): Promise<readonly HostExecSnapshot[]> {
    const { execHistoryFilePath } = resolveStoragePaths();
    try {
      const content = await fs.readFile(execHistoryFilePath, "utf8");
      return normalizeSnapshots(JSON.parse(content));
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  public async append(result: HostExecResult): Promise<void> {
    const { dataDir, execHistoryFilePath } = resolveStoragePaths();
    const current = await this.list();
    const next = [toSnapshot(result), ...current].slice(0, this.limit);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(execHistoryFilePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }
}

export const resetHostExecHistory = async (): Promise<void> => {
  const { execHistoryFilePath } = resolveStoragePaths();
  await fs.rm(execHistoryFilePath, { force: true });
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
  stdoutTruncated: result.stdoutTruncated,
  stderrTruncated: result.stderrTruncated,
});

const normalizeSnapshots = (value: unknown): HostExecSnapshot[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    const snapshot = entry as Partial<HostExecSnapshot>;
    return {
      execId: snapshot.execId ?? "",
      argv: Array.isArray(snapshot.argv) ? snapshot.argv.filter((item): item is string => typeof item === "string") : [],
      cwd: typeof snapshot.cwd === "string" ? snapshot.cwd : null,
      status: snapshot.status ?? "failed",
      stdoutPreview: typeof snapshot.stdoutPreview === "string" ? snapshot.stdoutPreview : "",
      stderrPreview: typeof snapshot.stderrPreview === "string" ? snapshot.stderrPreview : "",
      startedAt: typeof snapshot.startedAt === "string" ? snapshot.startedAt : "",
      completedAt: typeof snapshot.completedAt === "string" ? snapshot.completedAt : null,
      exitCode: typeof snapshot.exitCode === "number" ? snapshot.exitCode : null,
      signal: typeof snapshot.signal === "string" ? snapshot.signal : null,
      truncated: snapshot.truncated === true,
      stdoutTruncated: snapshot.stdoutTruncated === true,
      stderrTruncated: snapshot.stderrTruncated === true,
    } satisfies HostExecSnapshot;
  });
};
