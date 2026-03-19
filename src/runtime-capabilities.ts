import type { NodeAgentConfig } from "./config/types.ts";

export interface AgentRuntimeCapabilities {
  readonly fileOperations: boolean;
  readonly pty: boolean;
  readonly serviceLaunch: boolean;
}

export const resolveAdvertisedRuntimeCapabilities = (
  config: Pick<NodeAgentConfig, "allowedRoots">,
): AgentRuntimeCapabilities => ({
  fileOperations: config.allowedRoots.length > 0,
  pty: isPtySupportedPlatform(),
  serviceLaunch: false,
});

export const buildAdvertisedCapabilityList = (
  capabilities: AgentRuntimeCapabilities,
): string[] => {
  const names = ["exec"];
  if (capabilities.fileOperations) {
    names.push("file-read", "file-write");
  }
  if (capabilities.pty) {
    names.push("pty");
  }
  if (capabilities.serviceLaunch) {
    names.push("service-launch");
  }
  return names;
};

export const getAdvertisedCapabilityList = (
  config: Pick<NodeAgentConfig, "allowedRoots">,
): string[] => buildAdvertisedCapabilityList(resolveAdvertisedRuntimeCapabilities(config));

export const isPtySupportedPlatform = (): boolean =>
  process.platform === "linux" || process.platform === "darwin";