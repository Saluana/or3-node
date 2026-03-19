import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

import { buildSignedManifest } from "../src/enroll/manifest.ts";
import type { NodeAgentConfig } from "../src/config/types.ts";
import type { NodeIdentityRecord } from "../src/identity/store.ts";
import { AGENT_VERSION } from "../src/version.ts";

const createIdentity = (): NodeIdentityRecord => {
  const keyPair = nacl.sign.keyPair();
  return {
    publicKeyBase64: Buffer.from(keyPair.publicKey).toString("base64"),
    secretKeyBase64: Buffer.from(keyPair.secretKey).toString("base64"),
    createdAt: "2026-03-18T00:00:00.000Z",
  };
};

const createConfig = (overrides: Partial<NodeAgentConfig> = {}): NodeAgentConfig => ({
  controlPlaneUrl: "http://127.0.0.1:3001",
  bootstrapToken: null,
  nodeName: "devbox",
  allowedRoots: [],
  allowedEnvNames: [],
  ...overrides,
});

describe("buildSignedManifest", () => {
  test("advertises only exec by default", () => {
    const manifest = buildSignedManifest(createIdentity(), createConfig());

    expect(manifest.capabilities).toEqual(["exec"]);
  });

  test("advertises file capabilities when allowed roots are configured", () => {
    const manifest = buildSignedManifest(
      createIdentity(),
      createConfig({ allowedRoots: ["/tmp/or3-node-allowed"] }),
    );

    expect(manifest.capabilities).toEqual(["exec", "file-read", "file-write"]);
  });

  test("uses the shared agent version", () => {
    const manifest = buildSignedManifest(createIdentity(), createConfig());

    expect(manifest.version).toBe(AGENT_VERSION);
  });
});