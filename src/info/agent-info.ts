/**
 * @module src/info
 *
 * Purpose:
 * Agent-local info and health reporting. Provides version, platform, arch,
 * capability summary, and connection state for the `or3-node info` command
 * and for embedding in heartbeat/handshake metadata.
 */
import os from "node:os";
import { createRequire } from "node:module";

import type { NodeAgentConfig } from "../config/types.ts";

const require = createRequire(import.meta.url);

const packageMetadata = require("../../package.json") as { version?: string };

const AGENT_VERSION = packageMetadata.version ?? "0.0.0";

export interface AgentInfo {
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly hostname: string;
  readonly uptime_seconds: number;
  readonly memory_total_mb: number;
  readonly memory_free_mb: number;
  readonly cpu_cores: number;
  readonly capabilities: readonly string[];
  readonly connection_state: "connected" | "disconnected" | "unknown";
  readonly recent_error: string | null;
}

export interface AgentHealthReport {
  readonly status: "healthy" | "degraded" | "unavailable";
  readonly checked_at: string;
  readonly details: Record<string, unknown>;
}

/** Purpose: Collects system and agent info for reporting. */
export const collectAgentInfo = (
  config: Pick<NodeAgentConfig, "allowedRoots">,
  connectionState: "connected" | "disconnected" | "unknown" = "unknown",
  recentError: string | null = null,
): AgentInfo => {
  const capabilities: string[] = ["exec"];
  if (config.allowedRoots.length > 0) {
    capabilities.push("file-read", "file-write");
  }
  if (isPtySupported()) {
    capabilities.push("pty");
  }
  capabilities.push("service-launch");

  return {
    version: AGENT_VERSION,
    platform: process.platform,
    arch: os.arch(),
    hostname: os.hostname(),
    uptime_seconds: Math.floor(os.uptime()),
    memory_total_mb: Math.floor(os.totalmem() / (1024 * 1024)),
    memory_free_mb: Math.floor(os.freemem() / (1024 * 1024)),
    cpu_cores: os.cpus().length,
    capabilities,
    connection_state: connectionState,
    recent_error: recentError,
  };
};

/** Purpose: Produces a quick health assessment. */
export const collectAgentHealth = (
  connectionState: "connected" | "disconnected" | "unknown",
  recentError: string | null = null,
): AgentHealthReport => {
  let status: AgentHealthReport["status"] = "healthy";
  if (connectionState === "disconnected") {
    status = "unavailable";
  } else if (recentError !== null) {
    status = "degraded";
  }

  return {
    status,
    checked_at: new Date().toISOString(),
    details: {
      connection: connectionState,
      recent_error: recentError,
      platform: process.platform,
    },
  };
};

/** Purpose: Formats agent info for terminal output. */
export const formatAgentInfo = (info: AgentInfo): string => {
  const lines: string[] = [
    "or3-node info",
    "",
    `version:          ${info.version}`,
    `platform:         ${info.platform}`,
    `arch:             ${info.arch}`,
    `hostname:         ${info.hostname}`,
    `uptime:           ${formatDuration(info.uptime_seconds)}`,
    `memory:           ${String(info.memory_free_mb)} MB free / ${String(info.memory_total_mb)} MB total`,
    `cpu cores:        ${String(info.cpu_cores)}`,
    `capabilities:     ${info.capabilities.join(", ")}`,
    `connection:       ${info.connection_state}`,
    `recent error:     ${info.recent_error ?? "none"}`,
    "",
  ];
  return lines.join("\n");
};

const formatDuration = (seconds: number): string => {
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }
  if (seconds < 3600) {
    return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${String(hours)}h ${String(minutes)}m`;
};

const isPtySupported = (): boolean => process.platform === "linux" || process.platform === "darwin";
