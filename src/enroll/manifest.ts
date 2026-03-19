import os from "node:os";

import { signNodeManifest } from "or3-net";
import type { NodeManifest } from "or3-net";

import type { NodeAgentConfig } from "../config/types.ts";
import type { NodeIdentityRecord } from "../identity/store.ts";
import { getAdvertisedCapabilityList } from "../runtime-capabilities.ts";
import { AGENT_VERSION } from "../version.ts";

const DEFAULT_MAX_CONCURRENT_JOBS = 2;
const DEFAULT_MAX_TTL_SECONDS = 300;

export const buildSignedManifest = (
  identity: NodeIdentityRecord,
  config: NodeAgentConfig,
): NodeManifest => {
  const secretKey = Buffer.from(identity.secretKeyBase64, "base64");
  const nodeId = buildNodeId(identity.publicKeyBase64, config.nodeName);
  const unsignedManifest: Omit<NodeManifest, "signature"> = {
    node_id: nodeId,
    pubkey: identity.publicKeyBase64,
    adapter_kind: "remote",
    capabilities: buildCapabilities(config),
    isolation_class: "host-trusted",
    supports_transports: ["outbound-wss", "https"],
    resource_limits: {
      max_concurrent_jobs: DEFAULT_MAX_CONCURRENT_JOBS,
      cpu_cores: Math.max(1, os.cpus().length),
      memory_mb: Math.max(512, Math.floor(os.totalmem() / 1024 / 1024)),
      disk_mb: 1024 * 100,
    },
    lease_policy: {
      max_ttl_seconds: DEFAULT_MAX_TTL_SECONDS,
      supports_warm_pool: false,
      reset_methods: ["process_kill", "credential_rotation"],
    },
    version: AGENT_VERSION,
  };

  return {
    ...unsignedManifest,
    signature: signNodeManifest(unsignedManifest, new Uint8Array(secretKey)),
  };
};

const buildNodeId = (publicKeyBase64: string, nodeName: string | null): string => {
  const suffix = publicKeyBase64
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 12)
    .toLowerCase();
  const prefix =
    nodeName === null
      ? "node"
      : nodeName
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 24) || "node";
  return `${prefix}-${suffix}`;
};

const buildCapabilities = (config: NodeAgentConfig): string[] => {
  return getAdvertisedCapabilityList(config);
};
