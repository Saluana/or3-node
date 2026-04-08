import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig, loadState } from "../src/config/store.ts";
import { loadIdentity } from "../src/identity/store.ts";
import { resolveStoragePaths } from "../src/storage/paths.ts";

const tempHomes: string[] = [];

beforeEach(async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "or3-node-persistence-"));
  tempHomes.push(tempHome);
  process.env.HOME = tempHome;
  process.env.XDG_CONFIG_HOME = path.join(tempHome, ".config");
  process.env.XDG_DATA_HOME = path.join(tempHome, ".local", "share");
});

afterEach(async () => {
  for (const tempHome of tempHomes.splice(0, tempHomes.length)) {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

describe("persisted file validation", () => {
  test("normalizes malformed config and state files", async () => {
    const { configDir, dataDir, configFilePath, stateFilePath, credentialFilePath } =
      resolveStoragePaths();
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      configFilePath,
      JSON.stringify({
        controlPlaneUrl: 42,
        bootstrapToken: 123,
        nodeName: {},
        allowedRoots: "/tmp",
        allowedEnvNames: ["SAFE_ENV", 5],
      }),
      "utf8",
    );
    await fs.writeFile(
      stateFilePath,
      JSON.stringify({
        nodeId: 42,
        enrolledAt: false,
        approvedAt: {},
        credential: "broken",
      }),
      "utf8",
    );
    await fs.writeFile(
      credentialFilePath,
      JSON.stringify({
        token: 123,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
      "utf8",
    );

    const config = await loadConfig();
    const state = await loadState();

    expect(config.controlPlaneUrl).toBe("http://127.0.0.1:3001");
    expect(config.bootstrapToken).toBeNull();
    expect(config.nodeName).toBeNull();
    expect(config.allowedRoots).toEqual([]);
    expect(config.allowedEnvNames).toEqual(["SAFE_ENV"]);
    expect(state.nodeId).toBeNull();
    expect(state.enrolledAt).toBeNull();
    expect(state.approvedAt).toBeNull();
    expect(state.credential.token).toBeNull();
    expect(state.credential.expiresAt).toBe("2099-01-01T00:00:00.000Z");
  });

  test("rejects malformed identity records", async () => {
    const { dataDir, identityFilePath } = resolveStoragePaths();
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      identityFilePath,
      JSON.stringify({ publicKeyBase64: "abc", secretKeyBase64: 42, createdAt: null }),
      "utf8",
    );

    await expect(loadIdentity()).rejects.toThrow("identity file is malformed");
  });
});
