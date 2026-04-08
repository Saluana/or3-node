import fs from "node:fs/promises";

import { writeJsonFile } from "../storage/json.ts";
import { resolveStoragePaths } from "../storage/paths.ts";
import { isFileNotFoundError } from "../utils/errors.ts";

export type AgentConnectionState = "connected" | "disconnected" | "unknown";

export interface PersistedConnectionState {
  readonly connectionState: AgentConnectionState;
  readonly recentError: string | null;
  readonly updatedAt: string | null;
}

const defaultConnectionState = (): PersistedConnectionState => ({
  connectionState: "unknown",
  recentError: null,
  updatedAt: null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const normalizeConnectionState = (value: unknown): PersistedConnectionState => {
  if (!isRecord(value)) {
    return defaultConnectionState();
  }
  return {
    connectionState:
      value.connectionState === "connected" ||
      value.connectionState === "disconnected" ||
      value.connectionState === "unknown"
        ? value.connectionState
        : "unknown",
    recentError: typeof value.recentError === "string" ? value.recentError : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
};

export const loadConnectionState = async (): Promise<PersistedConnectionState> => {
  const { connectionStateFilePath } = resolveStoragePaths();
  try {
    const content = await fs.readFile(connectionStateFilePath, "utf8");
    return normalizeConnectionState(JSON.parse(content));
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) {
      return defaultConnectionState();
    }
    throw error;
  }
};

export const saveConnectionState = async (
  connectionState: AgentConnectionState,
  recentError: string | null = null,
): Promise<void> => {
  const { dataDir, connectionStateFilePath } = resolveStoragePaths();
  await fs.mkdir(dataDir, { recursive: true });
  await writeJsonFile(connectionStateFilePath, {
    connectionState,
    recentError,
    updatedAt: new Date().toISOString(),
  } satisfies PersistedConnectionState);
};
