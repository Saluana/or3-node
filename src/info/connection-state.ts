import fs from "node:fs/promises";

import { resolveStoragePaths } from "../storage/paths.ts";

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

export const loadConnectionState = async (): Promise<PersistedConnectionState> => {
  const { connectionStateFilePath } = resolveStoragePaths();
  try {
    const content = await fs.readFile(connectionStateFilePath, "utf8");
    const parsed = JSON.parse(content) as Partial<PersistedConnectionState>;
    return {
      ...defaultConnectionState(),
      ...parsed,
    };
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
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
  await fs.writeFile(
    connectionStateFilePath,
    `${JSON.stringify(
      {
        connectionState,
        recentError,
        updatedAt: new Date().toISOString(),
      } satisfies PersistedConnectionState,
      null,
      2,
    )}\n`,
    "utf8",
  );
};

const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";