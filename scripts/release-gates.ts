import path from "node:path";

type StageName = "core" | "runtime" | "file" | "pty" | "service" | "restart";

interface CommandStep {
  readonly title: string;
  readonly cwd: string;
  readonly cmd: readonly string[];
}

interface StageDefinition {
  readonly description: string;
  readonly steps: readonly CommandStep[];
}

const packageRoot = path.resolve(import.meta.dir, "..");
const netRoot = path.resolve(packageRoot, "../or3-net");

const stageDefinitions: Record<StageName, StageDefinition> = {
  core: {
    description: "Typecheck/lint plus bootstrap, approval, connect, remote execute, reconnect, and first-launch UX.",
    steps: [
      { title: "or3-net typecheck", cwd: netRoot, cmd: ["bun", "run", "typecheck"] },
      { title: "or3-net lint", cwd: netRoot, cmd: ["bun", "run", "lint"] },
      {
        title: "or3-net focused core tests",
        cwd: netRoot,
        cmd: ["bun", "test", "tests/nodes.phase3.test.ts", "tests/transport.test.ts", "tests/local-jobs.test.ts"],
      },
      { title: "or3-node typecheck", cwd: packageRoot, cmd: ["bun", "run", "typecheck"] },
      { title: "or3-node lint", cwd: packageRoot, cmd: ["bun", "run", "lint"] },
      {
        title: "or3-node focused core tests",
        cwd: packageRoot,
        cmd: ["bun", "test", "tests/cli.test.ts", "tests/agent-loop.test.ts", "tests/connection-state.test.ts"],
      },
    ],
  },
  runtime: {
    description: "Runtime-session parity gate.",
    steps: [
      {
        title: "or3-net runtime-session parity tests",
        cwd: netRoot,
        cmd: ["bun", "test", "tests/runtime.phase7.integration.test.ts", "tests/app.phase6.runtime.test.ts"],
      },
    ],
  },
  file: {
    description: "File access gate.",
    steps: [
      {
        title: "or3-node file host-control tests",
        cwd: packageRoot,
        cmd: ["bun", "test", "tests/host-control-files.test.ts"],
      },
      {
        title: "or3-net remote-node file capability tests",
        cwd: netRoot,
        cmd: ["bun", "test", "tests/runtime/adapters/remote-node.test.ts"],
      },
    ],
  },
  pty: {
    description: "PTY gate.",
    steps: [
      {
        title: "or3-node PTY host-control tests",
        cwd: packageRoot,
        cmd: ["bun", "test", "tests/host-control-pty.test.ts"],
      },
      {
        title: "or3-net runtime PTY route tests",
        cwd: netRoot,
        cmd: ["bun", "test", "tests/app.phase6.runtime.test.ts"],
      },
    ],
  },
  service: {
    description: "Service-launch and preview integration gate.",
    steps: [
      {
        title: "or3-node local service manager tests",
        cwd: packageRoot,
        cmd: ["bun", "test", "tests/host-control-services.test.ts"],
      },
      {
        title: "or3-net preview and service-launch tests",
        cwd: netRoot,
        cmd: ["bun", "test", "tests/previews.phase45.test.ts"],
      },
    ],
  },
  restart: {
    description: "Restart, persistence, and stale-connection recovery gate.",
    steps: [
      {
        title: "or3-node restart-sensitive CLI tests",
        cwd: packageRoot,
        cmd: ["bun", "test", "tests/cli.test.ts", "tests/connection-state.test.ts"],
      },
      {
        title: "or3-net approval and credential lifecycle tests",
        cwd: netRoot,
        cmd: ["bun", "test", "tests/nodes.phase3.test.ts"],
      },
    ],
  },
};

const allStages = Object.keys(stageDefinitions) as StageName[];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const listOnly = args.includes("--list");
const requestedStages = args.filter((arg) => !arg.startsWith("--"));
const selectedStages = requestedStages.length === 0 || requestedStages.includes("all")
  ? allStages
  : parseStages(requestedStages);

if (listOnly) {
  for (const stage of allStages) {
    console.log(`${stage}: ${stageDefinitions[stage].description}`);
  }
  process.exit(0);
}

for (const stage of selectedStages) {
  const definition = stageDefinitions[stage];
  console.log(`\n== ${stage} ==`);
  console.log(definition.description);
  for (const step of definition.steps) {
    await runStep(step, dryRun);
  }
}

console.log(`\nrelease gates complete: ${selectedStages.join(", ")}`);

function parseStages(values: readonly string[]): StageName[] {
  const parsed: StageName[] = [];
  for (const value of values) {
    if (!allStages.includes(value as StageName)) {
      throw new Error(`unknown release gate stage: ${value}`);
    }
    parsed.push(value as StageName);
  }
  return parsed;
}

async function runStep(step: CommandStep, dryRunMode: boolean): Promise<void> {
  const renderedCommand = step.cmd.join(" ");
  console.log(`\n→ ${step.title}`);
  console.log(`  cwd: ${step.cwd}`);
  console.log(`  cmd: ${renderedCommand}`);
  if (dryRunMode) {
    return;
  }

  const startedAt = Date.now();
  const proc = Bun.spawn({
    cmd: [...step.cmd],
    cwd: step.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const exitCode = await proc.exited;
  const durationMs = Date.now() - startedAt;
  if (exitCode !== 0) {
    throw new Error(`${step.title} failed with exit code ${String(exitCode)}`);
  }
  console.log(`✓ ${step.title} (${String(durationMs)}ms)`);
}
