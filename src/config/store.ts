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
  const { stateFilePath, credentialFilePath } = resolveStoragePaths();
  try {
    const [stateContent, credentialContent] = await Promise.all([
      fs.readFile(stateFilePath, "utf8"),
      fs.readFile(credentialFilePath, "utf8").catch((error: unknown) => {
        if (isMissingFileError(error)) {
          return "";
        }
        throw error;
      }),
    ]);
    const parsedState = JSON.parse(stateContent) as Partial<NodeAgentState>;
    const parsedCredentials =
      credentialContent === ""
        ? null
        : (JSON.parse(credentialContent) as Partial<NodeAgentState["credential"]>);
    return {
      ...defaultState(),
      ...parsedState,
      credential: {
        ...defaultState().credential,
        ...parsedState.credential,
        ...parsedCredentials,
      },
    };
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return defaultState();
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
  await fs.writeFile(stateFilePath, `${JSON.stringify(persistedState, null, 2)}\n`, "utf8");
  if (state.credential.token === null) {
    await fs.rm(credentialFilePath, { force: true });
    return;
  }

  await fs.writeFile(
    credentialFilePath,
    `${JSON.stringify(
      {
        token: state.credential.token,
        expiresAt: state.credential.expiresAt,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.chmod(credentialFilePath, 0o600);
};

const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
