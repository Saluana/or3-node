import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli/index.ts";
import { saveConfig, saveState } from "../src/config/store.ts";
import { loadIdentity } from "../src/identity/store.ts";
import { saveConnectionState } from "../src/info/connection-state.ts";
import { resolveStoragePaths } from "../src/storage/paths.ts";
import type { LogEntry } from "../src/utils/logger.ts";
import { AGENT_VERSION } from "../src/version.ts";

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

const parseLogEntries = (chunks: readonly string[]): LogEntry[] =>
  chunks
    .join("")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogEntry);

const expectMissingFile = async (filePath: string): Promise<void> => {
  let exists = true;
  try {
    await fs.access(filePath);
  } catch {
    exists = false;
  }

  expect(exists).toBe(false);
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
  expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
): Response =>
  new Response(
    JSON.stringify({
      workspace_id: "ws_nodes",
      node: {
        status: "approved",
        manifest: { node_id: nodeId },
        approved_at: new Date(Date.now() - 60_000).toISOString(),
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

    const {
      configFilePath: configPath,
      identityFilePath: identityPath,
      stateFilePath: statePath,
    } = resolveStoragePaths();
    expect(await fs.readFile(configPath, "utf8")).toContain("http://or3.test");
    expect(await fs.readFile(identityPath, "utf8")).toContain("publicKeyBase64");
    expect(await fs.readFile(statePath, "utf8")).toContain("devbox-abc123");
  });

  test("launch emits structured bootstrap, approval, and credential logs", async () => {
    const stderr = createWriter();

    const exitCode = await runCli(
      ["launch", "--url", "http://or3.test", "--token", "bootstrap-123"],
      {
        fetch: () => Promise.resolve(approvedBootstrapResponse()),
        backgroundLauncher: () => undefined,
        stdout: { write: () => true },
        stderr: stderr.writer,
      },
    );

    expect(exitCode).toBe(0);
    const entries = parseLogEntries(stderr.chunks);
    expect(entries.some((entry) => entry.event === "bootstrap.start")).toBe(true);
    expect(entries.some((entry) => entry.event === "bootstrap.success")).toBe(true);
    expect(entries.some((entry) => entry.event === "approval.received")).toBe(true);
    expect(entries.some((entry) => entry.event === "credential.refreshed")).toBe(true);
  });

  test("launch classifies pending approval in structured logs", async () => {
    const stderr = createWriter();

    const exitCode = await runCli(
      ["launch", "--url", "http://or3.test", "--token", "bootstrap-123"],
      {
        fetch: () => Promise.resolve(pendingBootstrapResponse()),
        stdout: { write: () => true },
        stderr: stderr.writer,
      },
    );

    expect(exitCode).toBe(0);
    const entries = parseLogEntries(stderr.chunks);
    expect(
      entries.some(
        (entry) =>
          entry.event === "bootstrap.success" && entry.details?.failure_class === "approval",
      ),
    ).toBe(true);
  });

  test("launch bootstrap failures stay single-classified in structured logs", async () => {
    const stderr = createWriter();

    const exitCode = await runCli(
      ["launch", "--url", "http://or3.test", "--token", "bootstrap-123"],
      {
        fetch: () => Promise.reject(new Error("bootstrap network failed")),
        stdout: { write: () => true },
        stderr: stderr.writer,
      },
    );

    expect(exitCode).toBe(1);
    const entries = parseLogEntries(stderr.chunks);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.event).toBe("bootstrap.start");
    expect(entries[1]?.event).toBe("bootstrap.fail");
    expect(entries.some((entry) => entry.event === "config.fail")).toBe(false);
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
    expect(stdout.chunks.join("")).toContain("node id:          node-pending-abc123");
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
    expect(stdout.chunks.join("")).toContain("enrollment:       enrolled");
    expect(stdout.chunks.join("")).toContain("approval:         pending");
    expect(stdout.chunks.join("")).toContain("credential:       missing");
    expect(stdout.chunks.join("")).toContain("connection:       unknown");
    expect(stdout.chunks.join("")).toContain("approved at:      pending");
    expect(stdout.chunks.join("")).toContain(
      'next step: approve this node in or3-net, then run "or3-node launch --foreground"',
    );
  });

  test("info reports the package version and lifecycle summary", async () => {
    const stdout = createWriter();

    const exitCode = await runCli(["info"], {
      stdout: stdout.writer,
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    expect(stdout.chunks.join("")).toContain(`version:          ${AGENT_VERSION}`);
    expect(stdout.chunks.join("")).toContain("capabilities:     exec");
    expect(stdout.chunks.join("")).not.toContain("pty");
    expect(stdout.chunks.join("")).not.toContain("service-launch");
    expect(stdout.chunks.join("")).toContain("enrollment:       not enrolled");
    expect(stdout.chunks.join("")).toContain("approval:         not enrolled");
    expect(stdout.chunks.join("")).toContain("credential:       missing");
    expect(stdout.chunks.join("")).toContain("connection:       unknown");
  });

  test("info advertises file capabilities only when allowed roots are configured", async () => {
    await saveConfig({
      controlPlaneUrl: "http://127.0.0.1:3001",
      bootstrapToken: null,
      nodeName: null,
      allowedRoots: ["/tmp/or3-node-allowed"],
      allowedEnvNames: [],
    });

    const stdout = createWriter();
    const exitCode = await runCli(["info"], {
      stdout: stdout.writer,
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    expect(stdout.chunks.join("")).toContain("capabilities:     exec, file-read, file-write");
  });

  test("status shows approved and valid runtime state clearly", async () => {
    const stdout = createWriter();

    await runCli(["launch", "--url", "http://or3.test", "--token", "bootstrap-123"], {
      fetch: () => Promise.resolve(approvedBootstrapResponse()),
      backgroundLauncher: () => undefined,
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    const exitCode = await runCli(["status"], {
      stdout: stdout.writer,
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    expect(stdout.chunks.join("")).toContain("enrollment:       enrolled");
    expect(stdout.chunks.join("")).toContain("approval:         approved");
    expect(stdout.chunks.join("")).toContain("credential:       valid");
    expect(stdout.chunks.join("")).toContain("connection:       unknown");
    expect(stdout.chunks.join("")).toContain(
      'next step: run "or3-node launch" to start the background agent, or use "--foreground" to keep it attached here',
    );
  });

  test("status reports the persisted transport connection state", async () => {
    await saveConnectionState("disconnected", "socket failed after open");

    const stdout = createWriter();
    const exitCode = await runCli(["status"], {
      stdout: stdout.writer,
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    expect(stdout.chunks.join("")).toContain("connection:       disconnected");
  });

  test("info surfaces the persisted recent transport error", async () => {
    await saveConnectionState("disconnected", "socket failed after open");

    const stdout = createWriter();
    const exitCode = await runCli(["info"], {
      stdout: stdout.writer,
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    expect(stdout.chunks.join("")).toContain("connection:       disconnected");
    expect(stdout.chunks.join("")).toContain("recent error:     socket failed after open");
  });

  test("status marks expired credentials and points to refresh", async () => {
    await saveState({
      nodeId: "node-expired-abc123",
      enrolledAt: "2026-03-17T00:00:00.000Z",
      approvedAt: "2026-03-17T00:00:00.000Z",
      credential: {
        token: "or3n_expired_secret",
        expiresAt: "2026-03-17T00:00:00.000Z",
      },
    });

    const stdout = createWriter();
    const exitCode = await runCli(["status"], {
      stdout: stdout.writer,
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    expect(stdout.chunks.join("")).toContain("credential:       expired");
    expect(stdout.chunks.join("")).toContain(
      'next step: run "or3-node launch" to refresh runtime credentials',
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
          redeemCount === 1
            ? new Date(Date.now() + 3 * 60_000).toISOString()
            : new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
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

  test("launch preserves the same identity across restart", async () => {
    await runCli(["launch", "--url", "http://or3.test", "--token", "bootstrap-123"], {
      fetch: () => Promise.resolve(pendingBootstrapResponse("node-persist-abc123")),
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    const firstIdentity = await loadIdentity();
    await runCli(
      ["launch", "--url", "http://or3.test", "--token", "bootstrap-123", "--no-interactive"],
      {
        fetch: () => Promise.resolve(pendingBootstrapResponse("node-persist-abc123")),
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );
    const secondIdentity = await loadIdentity();

    expect(firstIdentity?.publicKeyBase64).toBe(secondIdentity?.publicKeyBase64);
    expect(firstIdentity?.createdAt).toBe(secondIdentity?.createdAt);
  });

  test("launch clears stored credentials when approval is no longer active", async () => {
    await runCli(["launch", "--url", "http://or3.test", "--token", "bootstrap-123"], {
      fetch: () =>
        Promise.resolve(
          approvedBootstrapResponse(
            "node-revoked-abc123",
            "or3n_old_secret",
            new Date(Date.now() + 60_000).toISOString(),
          ),
        ),
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

    const exitCode = await runCli(
      ["launch", "--url", "http://or3.test", "--token", "bootstrap-123"],
      {
        fetch: () => Promise.resolve(approvedBootstrapResponse()),
        backgroundLauncher: (argv) => {
          spawnedCommands.push([...argv]);
        },
        stdout: stdout.writer,
        stderr: { write: () => true },
      },
    );

    expect(exitCode).toBe(0);
    expect(spawnedCommands).toEqual([["launch", "--foreground", "--no-interactive"]]);
    expect(stdout.chunks.join("")).toContain("agent loop: background launch requested");
    expect(stdout.chunks.join("")).toContain(
      'next step: run "or3-node status" to inspect local state, or use "--foreground" to keep it attached here',
    );
  });

  test("launch starts the live agent loop in foreground mode", async () => {
    let started = false;
    const stdout = createWriter();

    const exitCode = await runCli(
      ["launch", "--url", "http://or3.test", "--token", "bootstrap-123", "--foreground"],
      {
        fetch: () =>
          Promise.resolve(approvedBootstrapResponse("node-foreground-abc123", "or3n_foreground")),
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

  test("launch wires file operations in foreground mode when allowed roots are configured", async () => {
    let fileServiceEnabled = false;

    await saveConfig({
      controlPlaneUrl: "http://127.0.0.1:3001",
      bootstrapToken: null,
      nodeName: null,
      allowedRoots: ["/tmp/or3-node-allowed"],
      allowedEnvNames: [],
    });

    const exitCode = await runCli(
      ["launch", "--url", "http://or3.test", "--token", "bootstrap-123", "--foreground"],
      {
        fetch: () => Promise.resolve(approvedBootstrapResponse("node-files-abc123", "or3n_files")),
        agentLoopFactory: (options) => ({
          start: () => {
            fileServiceEnabled = options.fileService?.isEnabled() ?? false;
            return Promise.resolve();
          },
        }),
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );

    expect(exitCode).toBe(0);
    expect(fileServiceEnabled).toBeTrue();
  });

  test("reset clears local enrollment state while preserving operator config", async () => {
    await runCli(
      ["launch", "--url", "http://or3.test", "--token", "bootstrap-123", "--name", "devbox"],
      {
        fetch: () =>
          Promise.resolve(approvedBootstrapResponse("node-reset-abc123", "or3n_reset_secret")),
        backgroundLauncher: () => undefined,
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );

    const {
      configFilePath: configPath,
      stateFilePath: statePath,
      credentialFilePath: credentialPath,
      identityFilePath: identityPath,
      execHistoryFilePath: execHistoryPath,
      connectionStateFilePath: connectionStatePath,
    } = resolveStoragePaths();
    await fs.writeFile(execHistoryPath, '[{"execId":"exec-1"}]\n', "utf8");
    await saveConnectionState("disconnected", "stale socket error");

    const stdout = createWriter();
    const exitCode = await runCli(["reset"], {
      stdout: stdout.writer,
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    expect(stdout.chunks.join("")).toContain("local node state reset");
    expect(stdout.chunks.join("")).toContain(
      "cleared: identity, enrollment state, runtime credentials, bootstrap token, exec history",
    );

    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      controlPlaneUrl: string;
      bootstrapToken: string | null;
      nodeName: string | null;
    };
    expect(config.controlPlaneUrl).toBe("http://or3.test");
    expect(config.nodeName).toBe("devbox");
    expect(config.bootstrapToken).toBeNull();

    await expectMissingFile(statePath);
    await expectMissingFile(credentialPath);
    await expectMissingFile(identityPath);
    await expectMissingFile(execHistoryPath);
    await expectMissingFile(connectionStatePath);
  });
});
