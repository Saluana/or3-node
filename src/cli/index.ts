import { redeemBootstrapToken } from "../enroll/client.ts";
import type { FetchLike } from "../enroll/client.ts";
import { buildSignedManifest } from "../enroll/manifest.ts";
import { ensureIdentity, resetIdentity } from "../identity/store.ts";
import { loadConfig, loadState, saveConfig, saveState } from "../config/store.ts";
import type { LaunchCommandOptions, NodeAgentConfig } from "../config/types.ts";
import { CliUsageError } from "../utils/errors.ts";

export interface CliDependencies {
  readonly fetch?: FetchLike;
  readonly stdout?: Pick<typeof process.stdout, "write">;
  readonly stderr?: Pick<typeof process.stderr, "write">;
}

export const runCli = async (
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> => {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const fetchImpl: FetchLike = dependencies.fetch ?? fetch;

  try {
    const [command, ...rest] = argv;
    switch (command) {
      case undefined:
      case "--help":
      case "help":
        stdout.write(renderHelp());
        return 0;
      case "launch":
        return await handleLaunch(rest, stdout, fetchImpl);
      case "doctor":
        return await handleDoctor(stdout);
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
  stdout: Pick<typeof process.stdout, "write">,
  fetchImpl: FetchLike,
): Promise<number> => {
  const options = parseLaunchOptions(argv);
  const identity = await ensureIdentity();
  const [config, state] = await Promise.all([loadConfig(), loadState()]);
  const mergedConfig = mergeConfig(config, options);
  await saveConfig(mergedConfig);
  const manifest = buildSignedManifest(identity, mergedConfig);

  let nextState = state;
  if (mergedConfig.bootstrapToken !== null) {
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
          ? state.credential
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
  } else {
    stdout.write(
      `bootstrap: node status ${nextState.approvedAt === null ? "pending" : "approved"}\n`,
    );
  }
  stdout.write("agent loop: not yet started in this phase\n");
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
  return 0;
};

const handleStatus = async (stdout: Pick<typeof process.stdout, "write">): Promise<number> => {
  const state = await loadState();
  stdout.write("or3-node status\n");
  stdout.write(`node id: ${state.nodeId ?? "not enrolled"}\n`);
  stdout.write(`approved at: ${state.approvedAt ?? "pending"}\n`);
  stdout.write(`credential expires at: ${state.credential.expiresAt ?? "unknown"}\n`);
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

const renderHelp = (): string =>
  [
    "or3-node",
    "",
    "Commands:",
    "  launch [--url <url>] [--token <token>] [--name <name>] [--foreground] [--no-interactive]",
    "  doctor",
    "  status",
    "  reset",
    "",
  ].join("\n");

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";
