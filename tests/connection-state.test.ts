import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConnectionState, saveConnectionState } from "../src/info/connection-state.ts";
import { resolveStoragePaths } from "../src/storage/paths.ts";

const tempHomes: string[] = [];

beforeEach(async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "or3-node-connection-state-"));
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

describe("connection state persistence", () => {
  test("defaults to unknown when nothing has been persisted", async () => {
    const state = await loadConnectionState();

    expect(state.connectionState).toBe("unknown");
    expect(state.recentError).toBeNull();
    expect(state.updatedAt).toBeNull();
  });

  test("persists state and recent error to disk", async () => {
    await saveConnectionState("disconnected", "transport failed");

    const state = await loadConnectionState();
    const { connectionStateFilePath } = resolveStoragePaths();

    expect(state.connectionState).toBe("disconnected");
    expect(state.recentError).toBe("transport failed");
    expect(state.updatedAt).not.toBeNull();
    expect(await fs.readFile(connectionStateFilePath, "utf8")).toContain("transport failed");
  });
});