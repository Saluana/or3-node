import path from "node:path";

type SimpleHeaders = Record<string, string>;

interface SmokeConfig {
  readonly controlPlaneUrl: string;
  readonly workspaceId: string;
  readonly adminToken: string;
  readonly runtimeToken: string;
  readonly nodeName: string;
  readonly cliCommand: string;
  readonly packageDir: string;
  readonly installGlobal: boolean;
  readonly resetFirst: boolean;
  readonly cleanup: boolean;
  readonly connectTimeoutMs: number;
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  printHelp();
  process.exit(0);
}

const packageDir = path.resolve(import.meta.dir, "..");
const config: SmokeConfig = {
  controlPlaneUrl: requireString("control-plane-url", process.env.OR3_SMOKE_CONTROL_PLANE_URL),
  workspaceId: requireString("workspace-id", process.env.OR3_SMOKE_WORKSPACE_ID),
  adminToken: requireString("admin-token", process.env.OR3_SMOKE_ADMIN_TOKEN),
  runtimeToken: optionValue("runtime-token") ?? process.env.OR3_SMOKE_RUNTIME_TOKEN ?? requireString("admin-token", process.env.OR3_SMOKE_ADMIN_TOKEN),
  nodeName: optionValue("node-name") ?? process.env.OR3_SMOKE_NODE_NAME ?? "or3-node-smoke",
  cliCommand: optionValue("cli") ?? process.env.OR3_SMOKE_CLI ?? "or3-node",
  packageDir: optionValue("package-dir") ?? process.env.OR3_SMOKE_PACKAGE_DIR ?? packageDir,
  installGlobal: flagEnabled("install-global"),
  resetFirst: flagEnabled("reset-first"),
  cleanup: flagEnabled("cleanup"),
  connectTimeoutMs: Number(optionValue("connect-timeout-ms") ?? process.env.OR3_SMOKE_CONNECT_TIMEOUT_MS ?? "30000"),
};

const summary: string[] = [];
let agentProcess: Bun.Subprocess | null = null;
let sessionId: string | null = null;

const remoteNodeAdapterId = "remote-node-agent";

try {
  if (config.installGlobal) {
    await runCommand(["bun", "install", "-g", config.packageDir], process.cwd(), "global Bun install");
    summary.push("global Bun install succeeded");
  }

  await runCli(["--help"], "CLI help");
  summary.push("CLI help succeeded");

  if (config.resetFirst) {
    await runCli(["reset"], "pre-smoke reset", true);
    summary.push("pre-smoke reset completed");
  }

  const bootstrap = await issueBootstrapToken();
  summary.push("bootstrap token issued");

  const initialLaunch = await runCli([
    "launch",
    "--url",
    config.controlPlaneUrl,
    "--token",
    bootstrap,
    "--name",
    config.nodeName,
    "--no-interactive",
  ], "initial launch");
  const nodeId = parseNodeId(initialLaunch.stdout);
  summary.push(`initial launch enrolled node ${nodeId}`);

  await approveNode(nodeId);
  summary.push(`node ${nodeId} approved`);

  agentProcess = Bun.spawn({
    cmd: [config.cliCommand, "launch", "--foreground", "--no-interactive"],
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  await waitForHealthyNode(nodeId, config.connectTimeoutMs);
  summary.push(`node ${nodeId} reached healthy connected state`);

  const status = await runCli(["status"], "status after approval");
  if (!status.stdout.includes("approval: approved") || !status.stdout.includes("credential: valid")) {
    throw new Error(`unexpected status output:\n${status.stdout}`);
  }
  summary.push("local status shows approved + valid credential");

  sessionId = await createRuntimeSession();
  summary.push(`runtime session ${sessionId} created`);

  const execStdout = await execRuntimeSession(sessionId);
  summary.push(`first remote command returned: ${execStdout.trim()}`);

  console.log("real-machine smoke passed");
  for (const line of summary) {
    console.log(`- ${line}`);
  }
} finally {
  if (sessionId !== null) {
    await destroyRuntimeSession(sessionId).catch(() => undefined);
  }
  if (agentProcess !== null) {
    agentProcess.kill();
    await Promise.race([
      agentProcess.exited,
      Bun.sleep(5_000),
    ]);
  }
  if (config.cleanup) {
    await runCli(["reset"], "post-smoke cleanup", true).catch(() => undefined);
  }
}

async function issueBootstrapToken(): Promise<string> {
  const response = await fetchJson<{ token: string }>(
    `${config.controlPlaneUrl}/v1/workspaces/${config.workspaceId}/nodes/bootstrap-tokens`,
    {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({}),
    },
  );
  if (!response.token.startsWith("or3b_")) {
    throw new Error("bootstrap response did not return an or3b_ token");
  }
  return response.token;
}

async function approveNode(nodeId: string): Promise<void> {
  await fetchJson(
    `${config.controlPlaneUrl}/v1/workspaces/${config.workspaceId}/nodes/${nodeId}/approve`,
    {
      method: "POST",
      headers: adminHeaders(false),
    },
  );
}

async function waitForHealthyNode(nodeId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await fetchJson<{ connection?: { health_status?: string; last_seen_at?: string | null } }>(
      `${config.controlPlaneUrl}/v1/workspaces/${config.workspaceId}/nodes/${nodeId}`,
      {
        headers: adminHeaders(false),
      },
    ).catch(() => null);
    if (payload?.connection?.health_status === "healthy" && payload.connection.last_seen_at) {
      return;
    }
    await ensureAgentStillRunning();
    await Bun.sleep(1_000);
  }
  throw new Error(`node did not reach healthy state within ${String(timeoutMs)}ms`);
}

async function createRuntimeSession(): Promise<string> {
  const payload = await fetchJson<{ session?: { session_id?: string; adapter_id?: string } }>(
    `${config.controlPlaneUrl}/v1/workspaces/${config.workspaceId}/runtime-sessions`,
    {
      method: "POST",
      headers: runtimeHeaders(true),
      body: JSON.stringify({
        adapter_id: remoteNodeAdapterId,
        workspace_mode: "none",
      }),
    },
  );
  if (payload.session?.adapter_id !== undefined && payload.session.adapter_id !== remoteNodeAdapterId) {
    throw new Error(`runtime session used unexpected adapter ${payload.session.adapter_id}; expected ${remoteNodeAdapterId}`);
  }
  const session = payload.session?.session_id;
  if (!session) {
    throw new Error(`runtime session response missing session_id: ${JSON.stringify(payload)}`);
  }
  return session;
}

async function execRuntimeSession(session: string): Promise<string> {
  const payload = await fetchJson<{ result?: { stdout?: string } }>(
    `${config.controlPlaneUrl}/v1/workspaces/${config.workspaceId}/runtime-sessions/${session}/exec`,
    {
      method: "POST",
      headers: runtimeHeaders(true),
      body: JSON.stringify({
        command: "echo",
        args: ["hello from remote node"],
        env: {},
        background: false,
      }),
    },
  );
  const stdout = payload.result?.stdout ?? "";
  if (!stdout.includes("hello from remote node")) {
    throw new Error(`unexpected exec stdout: ${stdout}`);
  }
  return stdout;
}

async function destroyRuntimeSession(session: string): Promise<void> {
  await fetchJson(
    `${config.controlPlaneUrl}/v1/workspaces/${config.workspaceId}/runtime-sessions/${session}/destroy`,
    {
      method: "POST",
      headers: runtimeHeaders(false),
    },
  );
}

function parseNodeId(stdout: string): string {
  const match = /^manifest node id: (.+)$/m.exec(stdout);
  if (!match?.[1]) {
    throw new Error(`could not parse manifest node id from launch output:\n${stdout}`);
  }
  return match[1].trim();
}

async function ensureAgentStillRunning(): Promise<void> {
  const processHandle = agentProcess;
  if (processHandle === null) {
    return;
  }
  const exitCode = processHandle.exitCode;
  if (exitCode !== null) {
    const stdout = await readProcessStream(processHandle.stdout);
    const stderr = await readProcessStream(processHandle.stderr);
    throw new Error(`foreground agent exited early with code ${String(exitCode)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
}

async function readProcessStream(stream: number | ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (stream === undefined || typeof stream === "number") {
    return "";
  }
  return await new Response(stream).text().catch(() => "");
}

async function runCli(
  cliArgs: readonly string[],
  label: string,
  allowFailure = false,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await runCommand([config.cliCommand, ...cliArgs], process.cwd(), label, allowFailure);
}

async function runCommand(
  cmd: readonly string[],
  cwd: string,
  label: string,
  allowFailure = false,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`${label} failed with exit code ${String(exitCode)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return { stdout, stderr, exitCode };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  const payload = text.length === 0 ? {} : JSON.parse(text) as unknown;
  if (!response.ok) {
    throw new Error(`request failed (${String(response.status)}) ${url}\n${JSON.stringify(payload, null, 2)}`);
  }
  return payload as T;
}

function adminHeaders(includeJson: boolean): SimpleHeaders {
  return {
    Authorization: `Bearer ${config.adminToken}`,
    ...(includeJson ? { "Content-Type": "application/json" } : {}),
  };
}

function runtimeHeaders(includeJson: boolean): SimpleHeaders {
  return {
    Authorization: `Bearer ${config.runtimeToken}`,
    ...(includeJson ? { "Content-Type": "application/json" } : {}),
  };
}

function flagEnabled(name: string): boolean {
  return args.includes(`--${name}`);
}

function optionValue(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function requireString(name: string, fallback: string | undefined): string {
  const value = optionValue(name) ?? fallback;
  if (!value) {
    throw new Error(`missing required option --${name}`);
  }
  return value;
}

function printHelp(): void {
  console.log(`real-machine smoke for or3-node

Required:
  --control-plane-url <url>
  --workspace-id <workspace-id>
  --admin-token <token>

Optional:
  --runtime-token <token>         Defaults to admin token
  --node-name <name>              Defaults to or3-node-smoke
  --cli <command>                 Defaults to or3-node
  --package-dir <path>            Defaults to current package root
  --install-global                Run bun install -g <package-dir> first
  --reset-first                   Run or3-node reset before starting
  --cleanup                       Run or3-node reset at the end
  --connect-timeout-ms <ms>       Defaults to 30000

Environment aliases:
  OR3_SMOKE_CONTROL_PLANE_URL
  OR3_SMOKE_WORKSPACE_ID
  OR3_SMOKE_ADMIN_TOKEN
  OR3_SMOKE_RUNTIME_TOKEN
  OR3_SMOKE_NODE_NAME
  OR3_SMOKE_CLI
  OR3_SMOKE_PACKAGE_DIR
  OR3_SMOKE_CONNECT_TIMEOUT_MS
`);
}
