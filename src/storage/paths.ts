import os from "node:os";
import path from "node:path";

export interface NodeStoragePaths {
  readonly configDir: string;
  readonly dataDir: string;
  readonly configFilePath: string;
  readonly stateFilePath: string;
  readonly identityFilePath: string;
}

export const resolveStoragePaths = (): NodeStoragePaths => {
  const homeDirectory = process.env.HOME ?? os.homedir();
  const configDir =
    process.env.XDG_CONFIG_HOME === undefined
      ? path.join(homeDirectory, ".config", "or3-node")
      : path.join(process.env.XDG_CONFIG_HOME, "or3-node");
  const dataDir =
    process.env.XDG_DATA_HOME === undefined
      ? path.join(homeDirectory, ".local", "share", "or3-node")
      : path.join(process.env.XDG_DATA_HOME, "or3-node");
  return {
    configDir,
    dataDir,
    configFilePath: path.join(configDir, "config.json"),
    stateFilePath: path.join(dataDir, "state.json"),
    identityFilePath: path.join(dataDir, "identity.json"),
  };
};
