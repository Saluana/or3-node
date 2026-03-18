import { spawn } from "node:child_process";
import { redeemBootstrapToken } from "../enroll/client.ts";
import type { FetchLike } from "../enroll/client.ts";
import { buildSignedManifest } from "../enroll/manifest.ts";
import { ensureIdentity, resetIdentity } from "../identity/store.ts";
import { loadConfig, loadState, saveConfig, saveState } from "../config/store.ts";
import type { LaunchCommandOptions, NodeAgentConfig, NodeAgentState } from "../config/types.ts";
import { HostControlService } from "../host-control/service.ts";
import { collectAgentInfo, formatAgentInfo } from "../info/agent-info.ts";
import { NodeAgentLoop } from "../transport/agent-loop.ts";
import type { NodeAgentLoopOptions } from "../transport/agent-loop.ts";
import { CliUsageError } from "../utils/errors.ts";

export interface CliDependencies {
  readonly fetch?: FetchLike;
  readonly prompt?: (message: string) => string | null;
  readonly stdout?: Pick<typeof process.stdout, "write">;
  readonly stderr?: Pick<typeof process.stderr, "write">;
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

  try {
    const [command, ...rest] = argv;
    switch (command) {
      case undefined:
      case "--help":
      case "help":
        stdout.write(renderHelp());
        return 0;
      case "launch":
        return await handleLaunch(rest, dependencies, stdout, fetchImpl, promptImpl);
      case "doctor":
        return await handleDoctor(stdout);
      case "info":
        return await handleInfo(stdout);
      case "status":
        return await handleStatus(stdout);
      case "reset":
        return await handleReset(stdout);
      default:
        throw new CliUsageError(`unknown command: ${command}`);
    }
  } catch (error: unknown) {
    stderr.write(`${toErrorMessage(error)}\n`);
    return 1;
  }
};

const handleLaunch = async (
  argv: readonly string[],
  dependencies: CliDependencies,
  stdout: Pick<typeof process.stdout, "write">,
  fetchImpl: FetchLike,
  promptImpl: ((message: string) => string | null) | undefined,
): Promise<number> => {
  const options = parseLaunchOptions(argv);
  const identity = await ensureIdentity();
  const [config, state] = await Promise.all([loadConfig(), loadState()]);
  const mergedConfig = resolveLaunchConfig(config, options, promptImpl);
  await saveConfig(mergedConfig);
  const manifest = buildSignedManifest(identity, mergedConfig);

  let nextState = state;
  if (mergedConfig.bootstrapToken !== null && shouldRedeemBootstrap(nextState)) {
    const redemption = await redeemBootstrapToken(
      mergedConfig.controlPlaneUrl,
      mergedConfig.bootstrapToken,
      manifest,
      fetchImpl,
    );
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

  stdout.write(`bootstrap: node status ${nextState.approvedAt === null ? "pending" : "approved"}\n`);
  if (nextState.approvedAt === null) {
    stdout.write("agent loop: waiting for approval before connecting\n");
    stdout.write(`${renderNextStepLine(mergedConfig, nextState)}\n`);
    return 0;
  }

  if (nextState.credential.token === null || nextState.credential.expiresAt === null) {
    stdout.write("credential: missing or expired\n");
    stdout.write(`${renderNextStepLine(mergedConfig, nextState)}\n`);
    return 0;
  }

  if (options.foreground) {
    stdout.write("agent loop: starting in foreground\n");
    const agentLoop = (dependencies.agentLoopFactory ?? defaultAgentLoopFactory)({
      controlPlaneUrl: mergedConfig.controlPlaneUrl,
      credential: {
        token: nextState.credential.token,
        expiresAt: nextState.credential.expiresAt,
      },
      hostControl: new HostControlService({
        allowedRoots: mergedConfig.allowedRoots,
        allowedEnvPassthrough: mergedConfig.allowedEnvNames,
      }),
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
  stdout.write("agent loop: started in background\n");
  stdout.write(`${renderNextStepLine(mergedConfig, nextState)}\n`);
  return 0;
};

const handleDoctor = async (stdout: Pick<typeof process.stdout, "write">): Promise<number> => {
  const [config, state, identity] = await Promise.all([
    loadConfig(),
    loadState(),
    ensureIdentity(),
  ]);
  stdout.write("or3-node doctor\n");
  stdout.write(`control plane url: ${config.controlPlaneUrl}\n`);
  stdout.write(`bootstrap token: ${config.bootstrapToken === null ? "missing" : "present"}\n`);
  stdout.write(`identity: ${identity.publicKeyBase64.slice(0, 16)}…\n`);
  stdout.write(`node id: ${state.nodeId ?? "not enrolled"}\n`);
  stdout.write(`credential: ${state.credential.token === null ? "missing" : "present"}\n`);
  stdout.write(`${renderNextStepLine(config, state)}\n`);
  return 0;
};

const handleInfo = async (stdout: Pick<typeof process.stdout, "write">): Promise<number> => {
  const config = await loadConfig();
  const info = collectAgentInfo(config);
  stdout.write(formatAgentInfo(info));
  return 0;
};

const handleStatus = async (stdout: Pick<typeof process.stdout, "write">): Promise<number> => {
  const [config, state] = await Promise.all([loadConfig(), loadState()]);
  stdout.write("or3-node status\n");
  stdout.write(`node id: ${state.nodeId ?? "not enrolled"}\n`);
  stdout.write(`approved at: ${state.approvedAt ?? "pending"}\n`);
  stdout.write(`credential expires at: ${state.credential.expiresAt ?? "unknown"}\n`);
  stdout.write(`${renderNextStepLine(config, state)}\n`);
  return 0;
};

const handleReset = async (stdout: Pick<typeof process.stdout, "write">): Promise<number> => {
  await resetIdentity();
  stdout.write("identity reset\n");
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
    controlPlaneUrl: merged.controlPlaneUrl,
    bootstrapToken:
      merged.bootstrapToken ??
      resolveOptionalPromptValue(promptImpl, "Bootstrap token (leave empty to skip)", null),
    nodeName: merged.nodeName,
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

const defaultBackgroundLauncher = (argv: readonly string[]): void => {
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
  if (state.credential.token === null || state.credential.expiresAt === null) {
    return 'next step: run "or3-node launch" to refresh runtime credentials';
  }
  return 'next step: run "or3-node launch" to start the background agent, or use "--foreground" to keep it attached here';
};

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";

const shouldRedeemBootstrap = (state: Awaited<ReturnType<typeof loadState>>): boolean => {
  if (state.credential.token === null || state.credential.expiresAt === null) {
    return true;
  }

  return new Date(state.credential.expiresAt).getTime() <= Date.now() + 5 * 60_000;
};
