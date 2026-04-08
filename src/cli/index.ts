import { spawn } from "node:child_process";
import { redeemBootstrapToken } from "../enroll/client.ts";
import type { FetchLike } from "../enroll/client.ts";
import { buildSignedManifest } from "../enroll/manifest.ts";
import { ensureIdentity, loadIdentity, resetIdentity } from "../identity/store.ts";
import {
  clearBootstrapToken,
  loadConfig,
  loadState,
  resetState,
  saveConfig,
  saveState,
} from "../config/store.ts";
import type { LaunchCommandOptions, NodeAgentConfig, NodeAgentState } from "../config/types.ts";
import { HostFileService } from "../host-control/files.ts";
import { resetHostExecHistory } from "../host-control/history.ts";
import { HostControlService } from "../host-control/service.ts";
import { collectAgentInfo, formatAgentInfo } from "../info/agent-info.ts";
import { loadConnectionState, type AgentConnectionState } from "../info/connection-state.ts";
import { NodeAgentLoop } from "../transport/agent-loop.ts";
import type { NodeAgentLoopOptions } from "../transport/agent-loop.ts";
import { CliUsageError, ConfigError, toErrorMessage } from "../utils/errors.ts";
import { AgentEvent, createAgentLogger, type AgentLogger } from "../utils/logger.ts";

export interface CliDependencies {
  readonly fetch?: FetchLike;
  readonly prompt?: (message: string) => string | null;
  readonly stdout?: Pick<typeof process.stdout, "write">;
  readonly stderr?: Pick<typeof process.stderr, "write">;
  readonly logger?: AgentLogger;
  readonly launchSignal?: AbortSignal;
  readonly agentLoopFactory?: (options: NodeAgentLoopOptions) => AgentLoopLike;
  readonly backgroundLauncher?: (argv: readonly string[]) => Promise<void> | void;
}

interface AgentLoopLike {
  start(signal?: AbortSignal): Promise<void>;
}

export const runCli = async (
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> => {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const fetchImpl: FetchLike = dependencies.fetch ?? fetch;
  const promptImpl = dependencies.prompt ?? globalThis.prompt;
  const logger = dependencies.logger ?? createAgentLogger(stderr);
  const [command] = argv;

  try {
    const [, ...rest] = argv;
    switch (command) {
      case undefined:
      case "--help":
      case "help":
        stdout.write(renderHelp());
        return 0;
      case "launch":
        return await handleLaunch(rest, dependencies, stdout, fetchImpl, promptImpl, logger);
      case "doctor":
        return await handleDoctor(stdout, logger);
      case "info":
        return await handleInfo(stdout, logger);
      case "status":
        return await handleStatus(stdout, logger);
      case "reset":
        return await handleReset(stdout, logger);
      default:
        throw new CliUsageError(`unknown command: ${command}`);
    }
  } catch (error: unknown) {
    if (error instanceof CliUsageError || error instanceof ConfigError) {
      logger.error(AgentEvent.CONFIG_FAIL, "cli command failed", {
        command: command ?? "help",
        error: toErrorMessage(error),
        failure_class: "config",
      });
    }
    return 1;
  }
};

const handleLaunch = async (
  argv: readonly string[],
  dependencies: CliDependencies,
  stdout: Pick<typeof process.stdout, "write">,
  fetchImpl: FetchLike,
  promptImpl: ((message: string) => string | null) | undefined,
  logger: AgentLogger,
): Promise<number> => {
  const options = parseLaunchOptions(argv);
  const identity = await ensureIdentity();
  const [config, state] = await Promise.all([loadConfig(), loadState()]);
  const mergedConfig = resolveLaunchConfig(config, options, promptImpl);
  await saveConfig(mergedConfig);
  const manifest = buildSignedManifest(identity, mergedConfig);

  let nextState = state;
  if (mergedConfig.bootstrapToken !== null && shouldRedeemBootstrap(nextState)) {
    logger.info(AgentEvent.BOOTSTRAP_START, "redeeming bootstrap token", {
      control_plane_url: mergedConfig.controlPlaneUrl,
      manifest_node_id: manifest.node_id,
      node_name: mergedConfig.nodeName,
    });
    const redemption = await redeemBootstrapToken(
      mergedConfig.controlPlaneUrl,
      mergedConfig.bootstrapToken,
      manifest,
      fetchImpl,
    ).catch((error: unknown) => {
      logger.error(AgentEvent.BOOTSTRAP_FAIL, "bootstrap token redemption failed", {
        control_plane_url: mergedConfig.controlPlaneUrl,
        manifest_node_id: manifest.node_id,
        error: toErrorMessage(error),
        failure_class: "bootstrap",
      });
      throw error;
    });
    nextState = {
      nodeId: redemption.node.manifest.node_id,
      enrolledAt: state.enrolledAt ?? new Date().toISOString(),
      approvedAt: redemption.node.approved_at,
      credential:
        redemption.credential === null
          ? {
              token: null,
              expiresAt: null,
            }
          : {
              token: redemption.credential.token,
              expiresAt: redemption.credential.expires_at,
            },
    };
    await saveState(nextState);
    logger.info(AgentEvent.BOOTSTRAP_SUCCESS, "bootstrap token redeemed", {
      node_id: nextState.nodeId,
      approval_state: nextState.approvedAt === null ? "pending" : "approved",
      failure_class: nextState.approvedAt === null ? "approval" : undefined,
    });
    if (nextState.approvedAt !== null) {
      logger.info(AgentEvent.APPROVAL_RECEIVED, "node approval received", {
        node_id: nextState.nodeId,
        approved_at: nextState.approvedAt,
      });
    }
    if (redemption.credential !== null) {
      logger.info(AgentEvent.CREDENTIAL_REFRESHED, "runtime credential refreshed", {
        node_id: nextState.nodeId,
        expires_at: redemption.credential.expires_at,
      });
    }
  }

  stdout.write("or3-node launch\n");
  stdout.write(`control plane: ${mergedConfig.controlPlaneUrl}\n`);
  stdout.write(`identity: ${identity.publicKeyBase64.slice(0, 16)}…\n`);
  stdout.write(`manifest node id: ${manifest.node_id}\n`);

  if (mergedConfig.bootstrapToken === null) {
    stdout.write("bootstrap: missing token; launch is configured but not enrolled yet\n");
    stdout.write(`${renderNextStepLine(mergedConfig, nextState)}\n`);
    return 0;
  }

  stdout.write(
    `bootstrap: node status ${nextState.approvedAt === null ? "pending" : "approved"}\n`,
  );
  if (nextState.approvedAt === null) {
    logger.warn(AgentEvent.BOOTSTRAP_SUCCESS, "node is enrolled and waiting for approval", {
      node_id: nextState.nodeId,
      approval_state: "pending",
      failure_class: "approval",
    });
    stdout.write("agent loop: waiting for approval before connecting\n");
    stdout.write(`${renderNextStepLine(mergedConfig, nextState)}\n`);
    return 0;
  }

  if (getCredentialState(nextState) !== "valid") {
    logger.warn(AgentEvent.CREDENTIAL_EXPIRED, "runtime credential is not ready for launch", {
      node_id: nextState.nodeId,
      credential_state: getCredentialState(nextState),
      expires_at: nextState.credential.expiresAt,
      failure_class: "credential",
    });
    stdout.write("credential: missing or expired\n");
    stdout.write(`${renderNextStepLine(mergedConfig, nextState)}\n`);
    return 0;
  }

  const credentialToken = nextState.credential.token;
  const credentialExpiresAt = nextState.credential.expiresAt;
  if (credentialToken === null || credentialExpiresAt === null) {
    logger.error(AgentEvent.CONFIG_FAIL, "launch reached an impossible credential state", {
      node_id: nextState.nodeId,
      failure_class: "credential",
    });
    stdout.write("credential: missing or expired\n");
    stdout.write(`${renderNextStepLine(mergedConfig, nextState)}\n`);
    return 0;
  }

  if (options.foreground) {
    stdout.write("agent loop: starting in foreground\n");
    const fileService =
      mergedConfig.allowedRoots.length > 0
        ? new HostFileService({
            allowedRoots: mergedConfig.allowedRoots,
            logger,
          })
        : undefined;
    const agentLoop = (dependencies.agentLoopFactory ?? defaultAgentLoopFactory)({
      controlPlaneUrl: mergedConfig.controlPlaneUrl,
      credential: {
        token: credentialToken,
        expiresAt: credentialExpiresAt,
      },
      hostControl: new HostControlService({
        allowedRoots: mergedConfig.allowedRoots,
        allowedEnvPassthrough: mergedConfig.allowedEnvNames,
        logger,
      }),
      fileService,
      logger,
    });
    await agentLoop.start(dependencies.launchSignal);
    stdout.write("agent loop: stopped\n");
    return 0;
  }

  await (dependencies.backgroundLauncher ?? defaultBackgroundLauncher)([
    "launch",
    "--foreground",
    "--no-interactive",
  ]);
  stdout.write("agent loop: background launch requested\n");
  stdout.write(
    'next step: run "or3-node status" to inspect local state, or use "--foreground" to keep it attached here\n',
  );
  return 0;
};

const handleDoctor = async (
  stdout: Pick<typeof process.stdout, "write">,
  logger: AgentLogger,
): Promise<number> => {
  const [config, state, identity, connection] = await Promise.all([
    loadConfig(),
    loadState(),
    loadIdentity(),
    loadConnectionState(),
  ]);
  logger.info(AgentEvent.INFO_COLLECT, "doctor collected local node status", {
    enrollment: getEnrollmentState(state),
    approval: getApprovalState(state),
    credential: getCredentialState(state),
    connection: connection.connectionState,
  });
  stdout.write("or3-node doctor\n");
  stdout.write(`control plane url: ${config.controlPlaneUrl}\n`);
  stdout.write(`bootstrap token: ${config.bootstrapToken === null ? "missing" : "present"}\n`);
  stdout.write(
    `identity: ${identity === null ? "missing" : `${identity.publicKeyBase64.slice(0, 16)}…`}\n`,
  );
  stdout.write(renderLifecycleStatusLines(state, connection.connectionState));
  stdout.write(`${renderNextStepLine(config, state)}\n`);
  return 0;
};

const handleInfo = async (
  stdout: Pick<typeof process.stdout, "write">,
  logger: AgentLogger,
): Promise<number> => {
  const [config, state] = await Promise.all([loadConfig(), loadState()]);
  const connection = await loadConnectionState();
  const info = collectAgentInfo(config, connection.connectionState, connection.recentError);
  logger.info(AgentEvent.INFO_COLLECT, "agent info collected", {
    enrollment: getEnrollmentState(state),
    approval: getApprovalState(state),
    credential: getCredentialState(state),
    connection: connection.connectionState,
  });
  stdout.write(formatAgentInfo(info));
  stdout.write(renderLifecycleStatusLines(state, connection.connectionState));
  return 0;
};

const handleStatus = async (
  stdout: Pick<typeof process.stdout, "write">,
  logger: AgentLogger,
): Promise<number> => {
  const [config, state, connection] = await Promise.all([
    loadConfig(),
    loadState(),
    loadConnectionState(),
  ]);
  logger.info(AgentEvent.INFO_COLLECT, "status collected local node status", {
    enrollment: getEnrollmentState(state),
    approval: getApprovalState(state),
    credential: getCredentialState(state),
    connection: connection.connectionState,
  });
  stdout.write("or3-node status\n");
  stdout.write(renderLifecycleStatusLines(state, connection.connectionState));
  stdout.write(`${renderNextStepLine(config, state)}\n`);
  return 0;
};

const handleReset = async (
  stdout: Pick<typeof process.stdout, "write">,
  logger: AgentLogger,
): Promise<number> => {
  await Promise.all([resetIdentity(), resetState(), clearBootstrapToken(), resetHostExecHistory()]);
  logger.info(AgentEvent.INFO_COLLECT, "local node state reset", {
    cleared: ["identity", "state", "credentials", "bootstrap_token", "exec_history"],
  });
  stdout.write("local node state reset\n");
  stdout.write(
    "cleared: identity, enrollment state, runtime credentials, bootstrap token, exec history\n",
  );
  return 0;
};

const parseLaunchOptions = (argv: readonly string[]): LaunchCommandOptions => {
  const options: LaunchCommandOptions = {
    foreground: false,
    interactive: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) {
      throw new CliUsageError("unexpected missing launch flag");
    }

    switch (value) {
      case "--url":
        options.controlPlaneUrl = readFlagValue(argv, ++index, "--url");
        break;
      case "--token":
        options.bootstrapToken = readFlagValue(argv, ++index, "--token");
        break;
      case "--name":
        options.nodeName = readFlagValue(argv, ++index, "--name");
        break;
      case "--foreground":
        options.foreground = true;
        break;
      case "--no-interactive":
        options.interactive = false;
        break;
      default:
        throw new CliUsageError(`unknown launch flag: ${value}`);
    }
  }

  return options;
};

const readFlagValue = (argv: readonly string[], index: number, flag: string): string => {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new CliUsageError(`missing value for ${flag}`);
  }
  return value;
};

const mergeConfig = (config: NodeAgentConfig, options: LaunchCommandOptions): NodeAgentConfig => ({
  controlPlaneUrl: options.controlPlaneUrl ?? config.controlPlaneUrl,
  bootstrapToken: options.bootstrapToken ?? config.bootstrapToken,
  nodeName: options.nodeName ?? config.nodeName,
  allowedRoots: config.allowedRoots,
  allowedEnvNames: config.allowedEnvNames,
});

const resolveLaunchConfig = (
  config: NodeAgentConfig,
  options: LaunchCommandOptions,
  promptImpl: ((message: string) => string | null) | undefined,
): NodeAgentConfig => {
  const merged = mergeConfig(config, options);
  if (!options.interactive) {
    return merged;
  }

  return {
    ...merged,
    bootstrapToken:
      merged.bootstrapToken ??
      resolveOptionalPromptValue(promptImpl, "Bootstrap token (leave empty to skip)", null),
  };
};

const resolveOptionalPromptValue = (
  promptImpl: ((message: string) => string | null) | undefined,
  label: string,
  fallback: string | null,
): string | null => {
  if (promptImpl === undefined) {
    return fallback;
  }
  const response = promptImpl(`${label}:`)?.trim();
  return response === undefined || response === "" ? fallback : response;
};

const renderHelp = (): string =>
  [
    "or3-node",
    "",
    "Commands:",
    "  launch [--url <url>] [--token <token>] [--name <name>] [--foreground] [--no-interactive]",
    "  doctor",
    "  info",
    "  status",
    "  reset",
    "",
  ].join("\n");

const defaultAgentLoopFactory = (options: NodeAgentLoopOptions): AgentLoopLike =>
  new NodeAgentLoop(options);

const defaultBackgroundLauncher = async (argv: readonly string[]): Promise<void> => {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    throw new Error(
      "unable to determine the or3-node entrypoint for background launch; ensure or3-node was launched with a valid script path",
    );
  }
  const child = spawn(process.execPath, [entrypoint, ...argv], {
    detached: true,
    stdio: "ignore",
    env: buildBackgroundLaunchEnv(),
  });
  child.unref();
};

const buildBackgroundLaunchEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        value !== undefined &&
        (BACKGROUND_ENV_NAMES.has(name) || name.startsWith("BUN_") || name.startsWith("OR3_NODE_")),
    ),
  );

const BACKGROUND_ENV_NAMES = new Set([
  "APPDATA",
  "ComSpec",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LOCALAPPDATA",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
]);

const renderNextStepLine = (config: NodeAgentConfig, state: NodeAgentState): string => {
  if (state.nodeId === null) {
    return config.bootstrapToken === null
      ? 'next step: run "or3-node launch --token <bootstrap-token>" to enroll this node'
      : 'next step: run "or3-node launch" to continue enrollment with the saved bootstrap token';
  }
  if (state.approvedAt === null) {
    return 'next step: approve this node in or3-net, then run "or3-node launch --foreground"';
  }
  if (getCredentialState(state) !== "valid") {
    return 'next step: run "or3-node launch" to refresh runtime credentials';
  }
  return 'next step: run "or3-node launch" to start the background agent, or use "--foreground" to keep it attached here';
};

const renderLifecycleStatusLines = (
  state: NodeAgentState,
  connectionState: AgentConnectionState,
): string =>
  [
    `enrollment:       ${getEnrollmentState(state)}`,
    `approval:         ${getApprovalState(state)}`,
    `credential:       ${getCredentialState(state)}`,
    `connection:       ${connectionState}`,
    `node id:          ${state.nodeId ?? "not enrolled"}`,
    `approved at:      ${state.approvedAt ?? "pending"}`,
    `credential until: ${state.credential.expiresAt ?? "unknown"}`,
  ].join("\n") + "\n";

const getEnrollmentState = (state: NodeAgentState): "enrolled" | "not enrolled" =>
  state.nodeId === null ? "not enrolled" : "enrolled";

const getApprovalState = (state: NodeAgentState): "approved" | "pending" | "not enrolled" => {
  if (state.nodeId === null) {
    return "not enrolled";
  }
  return state.approvedAt === null ? "pending" : "approved";
};

const getCredentialState = (state: NodeAgentState): "missing" | "valid" | "expired" => {
  if (state.credential.token === null || state.credential.expiresAt === null) {
    return "missing";
  }

  return Date.parse(state.credential.expiresAt) <= Date.now() ? "expired" : "valid";
};

const shouldRedeemBootstrap = (state: Awaited<ReturnType<typeof loadState>>): boolean => {
  if (getCredentialState(state) !== "valid") {
    return true;
  }

  const expiresAt = state.credential.expiresAt;
  if (expiresAt === null) {
    return true;
  }

  return new Date(expiresAt).getTime() <= Date.now() + 5 * 60_000;
};
