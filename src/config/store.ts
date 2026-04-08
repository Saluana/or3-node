import fs from "node:fs/promises";

import {
  DEFAULT_NODE_AGENT_CONFIG,
  DEFAULT_NODE_AGENT_STATE,
  type NodeAgentConfig,
  type NodeAgentState,
  normalizeNodeAgentConfig,
  normalizeNodeAgentState,
} from "./types.ts";
import { resolveStoragePaths } from "../storage/paths.ts";
import { writePrivateJsonFile } from "../storage/json.ts";
import { isFileNotFoundError } from "../utils/errors.ts";

export const loadConfig = async (): Promise<NodeAgentConfig> => {
  const { configFilePath } = resolveStoragePaths();
  try {
    const content = await fs.readFile(configFilePath, "utf8");
    return normalizeNodeAgentConfig(JSON.parse(content));
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) {
      return DEFAULT_NODE_AGENT_CONFIG;
    }
    throw error;
  }
};

export const saveConfig = async (config: NodeAgentConfig): Promise<void> => {
  const { configDir, configFilePath } = resolveStoragePaths();
  await fs.mkdir(configDir, { recursive: true });
  await writePrivateJsonFile(configFilePath, config);
};

export const clearBootstrapToken = async (): Promise<void> => {
  const config = await loadConfig();
  if (config.bootstrapToken === null) {
    return;
  }

  await saveConfig({
    ...config,
    bootstrapToken: null,
  });
};

export const loadState = async (): Promise<NodeAgentState> => {
  const { stateFilePath, credentialFilePath } = resolveStoragePaths();
  try {
    const [stateContent, credentialContent] = await Promise.all([
      fs.readFile(stateFilePath, "utf8"),
      fs.readFile(credentialFilePath, "utf8").catch((error: unknown) => {
        if (isFileNotFoundError(error)) {
          return "";
        }
        throw error;
      }),
    ]);
    const parsedState = normalizeNodeAgentState(JSON.parse(stateContent));
    const parsedCredentials =
      credentialContent === "" ? null : normalizeNodeAgentState({ credential: JSON.parse(credentialContent) });
    return {
      ...DEFAULT_NODE_AGENT_STATE,
      ...parsedState,
      credential: {
        ...DEFAULT_NODE_AGENT_STATE.credential,
        ...parsedState.credential,
        ...(parsedCredentials?.credential ?? {}),
      },
    };
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) {
      return DEFAULT_NODE_AGENT_STATE;
    }
    throw error;
  }
};

export const saveState = async (state: NodeAgentState): Promise<void> => {
  const { dataDir, stateFilePath, credentialFilePath } = resolveStoragePaths();
  await fs.mkdir(dataDir, { recursive: true });
  const persistedState: NodeAgentState = {
    ...state,
    credential: {
      token: null,
      expiresAt: state.credential.expiresAt,
    },
  };
  await writePrivateJsonFile(stateFilePath, persistedState);
  if (state.credential.token === null) {
    await fs.rm(credentialFilePath, { force: true });
    return;
  }

  await writePrivateJsonFile(credentialFilePath, {
    token: state.credential.token,
    expiresAt: state.credential.expiresAt,
  });
};

export const resetState = async (): Promise<void> => {
  const { stateFilePath, credentialFilePath, connectionStateFilePath } = resolveStoragePaths();
  await Promise.all([
    fs.rm(stateFilePath, { force: true }),
    fs.rm(credentialFilePath, { force: true }),
    fs.rm(connectionStateFilePath, { force: true }),
  ]);
};
