import fs from "node:fs/promises";

import type { NodeAgentConfig, NodeAgentState } from "./types.ts";
import { resolveStoragePaths } from "../storage/paths.ts";

const defaultConfig = (): NodeAgentConfig => ({
  controlPlaneUrl: "http://127.0.0.1:3001",
  bootstrapToken: null,
  nodeName: null,
  allowedRoots: [],
  allowedEnvNames: [],
});

const defaultState = (): NodeAgentState => ({
  nodeId: null,
  enrolledAt: null,
  approvedAt: null,
  credential: {
    token: null,
    expiresAt: null,
  },
});

export const loadConfig = async (): Promise<NodeAgentConfig> => {
  const { configFilePath } = resolveStoragePaths();
  try {
    const content = await fs.readFile(configFilePath, "utf8");
    return {
      ...defaultConfig(),
      ...(JSON.parse(content) as Partial<NodeAgentConfig>),
    };
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return defaultConfig();
    }
    throw error;
  }
};

export const saveConfig = async (config: NodeAgentConfig): Promise<void> => {
  const { configDir, configFilePath } = resolveStoragePaths();
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configFilePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
};

export const loadState = async (): Promise<NodeAgentState> => {
  const { stateFilePath } = resolveStoragePaths();
  try {
    const content = await fs.readFile(stateFilePath, "utf8");
    return {
      ...defaultState(),
      ...(JSON.parse(content) as Partial<NodeAgentState>),
    };
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return defaultState();
    }
    throw error;
  }
};

export const saveState = async (state: NodeAgentState): Promise<void> => {
  const { dataDir, stateFilePath } = resolveStoragePaths();
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(stateFilePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
};

const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
