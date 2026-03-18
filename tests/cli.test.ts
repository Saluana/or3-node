import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli/index.ts";
import { resolveStoragePaths } from "../src/storage/paths.ts";

const tempHomes: string[] = [];

const useTempHome = async (): Promise<string> => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "or3-node-test-"));
  tempHomes.push(tempHome);
  process.env.HOME = tempHome;
  process.env.XDG_CONFIG_HOME = path.join(tempHome, ".config");
  process.env.XDG_DATA_HOME = path.join(tempHome, ".local", "share");
  return tempHome;
};

const createWriter = (): {
  readonly chunks: string[];
  readonly writer: Pick<typeof process.stdout, "write">;
} => {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {
      write: (chunk) => {
        chunks.push(String(chunk));
        return true;
      },
    },
  };
};

const pendingBootstrapResponse = (nodeId = "node-pending-abc123"): Response =>
  new Response(
    JSON.stringify({
      workspace_id: "ws_nodes",
      node: {
        status: "pending",
        manifest: { node_id: nodeId },
        approved_at: null,
      },
      credential: null,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );

const approvedBootstrapResponse = (
  nodeId = "node-approved-abc123",
  token = "or3n_secret_123",
  expiresAt = "2026-03-18T00:00:00.000Z",
): Response =>
  new Response(
    JSON.stringify({
      workspace_id: "ws_nodes",
      node: {
        status: "approved",
        manifest: { node_id: nodeId },
        approved_at: "2026-03-17T00:00:00.000Z",
      },
      credential: {
        token,
        expires_at: expiresAt,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );

describe("or3-node cli", () => {
  beforeEach(async () => {
    await useTempHome();
  });

  afterEach(async () => {
    for (const tempHome of tempHomes.splice(0, tempHomes.length)) {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  test("prints help for empty input", async () => {
    const stdout = createWriter();
    const exitCode = await runCli([], {
      stdout: stdout.writer,
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    expect(stdout.chunks.join("")).toContain("launch");
  });

  test("launch persists config and explains approval is still pending", async () => {
    const stdout = createWriter();
    const exitCode = await runCli(
      ["launch", "--url", "http://or3.test", "--token", "bootstrap-123", "--name", "devbox"],
      {
        fetch: () => Promise.resolve(pendingBootstrapResponse("devbox-abc123")),
        stdout: stdout.writer,
        stderr: { write: () => true },
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.chunks.join("")).toContain("bootstrap: node status pending");
    expect(stdout.chunks.join("")).toContain("agent loop: waiting for approval before connecting");
    expect(stdout.chunks.join("")).toContain(
      'next step: approve this node in or3-net, then run "or3-node launch --foreground"',
    );

    const { configFilePath: configPath, identityFilePath: identityPath, stateFilePath: statePath } =
      resolveStoragePaths();
    expect(await fs.readFile(configPath, "utf8")).toContain("http://or3.test");
    expect(await fs.readFile(identityPath, "utf8")).toContain("publicKeyBase64");
    expect(await fs.readFile(statePath, "utf8")).toContain("devbox-abc123");
  });

  test("doctor reports the next step when approval is still pending", async () => {
    await runCli(["launch", "--url", "http://or3.test", "--token", "bootstrap-123"], {
      fetch: () => Promise.resolve(pendingBootstrapResponse()),
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    const stdout = createWriter();
    const exitCode = await runCli(["doctor"], {
      stdout: stdout.writer,
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    expect(stdout.chunks.join("")).toContain("control plane url: http://or3.test");
    expect(stdout.chunks.join("")).toContain("bootstrap token: present");
    expect(stdout.chunks.join("")).toContain("node id: node-pending-abc123");
    expect(stdout.chunks.join("")).toContain(
      'next step: approve this node in or3-net, then run "or3-node launch --foreground"',
    );
  });

  test("status reports the next step when approval is still pending", async () => {
    await runCli(["launch", "--url", "http://or3.test", "--token", "bootstrap-123"], {
      fetch: () => Promise.resolve(pendingBootstrapResponse()),
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    const stdout = createWriter();
    const exitCode = await runCli(["status"], {
      stdout: stdout.writer,
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    expect(stdout.chunks.join("")).toContain("approved at: pending");
    expect(stdout.chunks.join("")).toContain(
      'next step: approve this node in or3-net, then run "or3-node launch --foreground"',
    );
  });

  test("interactive launch prompts for missing values", async () => {
    const prompts = ["prompt-token"];
    const exitCode = await runCli(["launch"], {
      prompt: () => prompts.shift() ?? null,
      fetch: () => Promise.resolve(pendingBootstrapResponse("prompt-node-abc123")),
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    const { configFilePath: configPath } = resolveStoragePaths();
    expect(await fs.readFile(configPath, "utf8")).toContain("http://127.0.0.1:3001");
    expect(await fs.readFile(configPath, "utf8")).toContain("prompt-token");
  });

  test("launch stores credentials outside the main state file", async () => {
    await runCli(["launch", "--url", "http://or3.test", "--token", "bootstrap-123"], {
      fetch: () => Promise.resolve(approvedBootstrapResponse()),
      backgroundLauncher: () => undefined,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    const { stateFilePath: statePath, credentialFilePath: credentialPath } = resolveStoragePaths();
    expect(await fs.readFile(statePath, "utf8")).not.toContain("or3n_secret_123");
    expect(await fs.readFile(credentialPath, "utf8")).toContain("or3n_secret_123");
  });

  test("launch refreshes near-expiry credentials on restart", async () => {
    let redeemCount = 0;
    const fetchImpl = (): Promise<Response> => {
      redeemCount += 1;
      return Promise.resolve(
        approvedBootstrapResponse(
          "node-refresh-abc123",
          `or3n_refresh_${String(redeemCount)}`,
          redeemCount === 1 ? "2026-03-17T00:03:00.000Z" : "2026-03-18T00:00:00.000Z",
        ),
      );
    };

    await runCli(["launch", "--url", "http://or3.test", "--token", "bootstrap-123"], {
      fetch: fetchImpl,
      backgroundLauncher: () => undefined,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });
    await runCli(
      ["launch", "--url", "http://or3.test", "--token", "bootstrap-123", "--no-interactive"],
      {
        fetch: fetchImpl,
        backgroundLauncher: () => undefined,
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );

    const { credentialFilePath: credentialPath } = resolveStoragePaths();
    expect(redeemCount).toBe(2);
    expect(await fs.readFile(credentialPath, "utf8")).toContain("or3n_refresh_2");
  });

  test("launch clears stored credentials when approval is no longer active", async () => {
    await runCli(["launch", "--url", "http://or3.test", "--token", "bootstrap-123"], {
      fetch: () => Promise.resolve(approvedBootstrapResponse("node-revoked-abc123", "or3n_old_secret")),
      backgroundLauncher: () => undefined,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    await runCli(
      ["launch", "--url", "http://or3.test", "--token", "bootstrap-123", "--no-interactive"],
      {
        fetch: () => Promise.resolve(pendingBootstrapResponse("node-revoked-abc123")),
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );

    const { stateFilePath: statePath, credentialFilePath: credentialPath } = resolveStoragePaths();
    expect(await fs.readFile(statePath, "utf8")).toContain('"expiresAt": null');
    try {
      await fs.readFile(credentialPath, "utf8");
      throw new Error("expected credential file to be removed");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  test("launch starts the background agent when approved credentials are present", async () => {
    const spawnedCommands: string[][] = [];
    const stdout = createWriter();

    const exitCode = await runCli(["launch", "--url", "http://or3.test", "--token", "bootstrap-123"], {
      fetch: () => Promise.resolve(approvedBootstrapResponse()),
      backgroundLauncher: (argv) => {
        spawnedCommands.push([...argv]);
      },
      stdout: stdout.writer,
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    expect(spawnedCommands).toEqual([["launch", "--foreground", "--no-interactive"]]);
    expect(stdout.chunks.join("")).toContain("agent loop: started in background");
    expect(stdout.chunks.join("")).toContain(
      'next step: run "or3-node launch" to start the background agent, or use "--foreground" to keep it attached here',
    );
  });

  test("launch starts the live agent loop in foreground mode", async () => {
    let started = false;
    const stdout = createWriter();

    const exitCode = await runCli(
      ["launch", "--url", "http://or3.test", "--token", "bootstrap-123", "--foreground"],
      {
        fetch: () => Promise.resolve(approvedBootstrapResponse("node-foreground-abc123", "or3n_foreground")),
        agentLoopFactory: () => ({
          start: () => {
            started = true;
            return Promise.resolve();
          },
        }),
        stdout: stdout.writer,
        stderr: { write: () => true },
      },
    );

    expect(exitCode).toBe(0);
    expect(started).toBeTrue();
    expect(stdout.chunks.join("")).toContain("agent loop: starting in foreground");
    expect(stdout.chunks.join("")).toContain("agent loop: stopped");
  });
});
