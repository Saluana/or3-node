import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli/index.ts";

const tempHomes: string[] = [];

const useTempHome = async (): Promise<string> => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "or3-node-test-"));
  tempHomes.push(tempHome);
  process.env.HOME = tempHome;
  return tempHome;
};

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
    const stdout: string[] = [];
    const exitCode = await runCli([], {
      stdout: {
        write: (chunk) => {
          stdout.push(String(chunk));
          return true;
        },
      },
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toContain("launch");
  });

  test("launch persists config and creates identity", async () => {
    const stdout: string[] = [];
    const exitCode = await runCli(
      ["launch", "--url", "http://or3.test", "--token", "bootstrap-123", "--name", "devbox"],
      {
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                workspace_id: "ws_nodes",
                node: {
                  status: "pending",
                  manifest: { node_id: "devbox-abc123" },
                  approved_at: null,
                },
                credential: null,
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          ),
        stdout: {
          write: (chunk) => {
            stdout.push(String(chunk));
            return true;
          },
        },
        stderr: { write: () => true },
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toContain("bootstrap: node status pending");

    const configPath = path.join(process.env.HOME ?? "", ".config", "or3-node", "config.json");
    const identityPath = path.join(
      process.env.HOME ?? "",
      ".local",
      "share",
      "or3-node",
      "identity.json",
    );
    const statePath = path.join(
      process.env.HOME ?? "",
      ".local",
      "share",
      "or3-node",
      "state.json",
    );
    expect(await fs.readFile(configPath, "utf8")).toContain("http://or3.test");
    expect(await fs.readFile(identityPath, "utf8")).toContain("publicKeyBase64");
    expect(await fs.readFile(statePath, "utf8")).toContain("devbox-abc123");
  });

  test("doctor reports saved state", async () => {
    await runCli(["launch", "--url", "http://or3.test", "--token", "bootstrap-123"], {
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              workspace_id: "ws_nodes",
              node: {
                status: "approved",
                manifest: { node_id: "node-abc123" },
                approved_at: "2026-03-17T00:00:00.000Z",
              },
              credential: {
                token: "or3n_123",
                expires_at: "2026-03-18T00:00:00.000Z",
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    const stdout: string[] = [];
    const exitCode = await runCli(["doctor"], {
      stdout: {
        write: (chunk) => {
          stdout.push(String(chunk));
          return true;
        },
      },
      stderr: { write: () => true },
    });

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toContain("control plane url: http://or3.test");
    expect(stdout.join("")).toContain("bootstrap token: present");
    expect(stdout.join("")).toContain("node id: node-abc123");
  });
});
