import fs from "node:fs/promises";

import nacl from "tweetnacl";

import { resolveStoragePaths } from "../storage/paths.ts";

export interface NodeIdentityRecord {
  readonly publicKeyBase64: string;
  readonly secretKeyBase64: string;
  readonly createdAt: string;
}

export const loadIdentity = async (): Promise<NodeIdentityRecord | null> => {
  const { identityFilePath } = resolveStoragePaths();
  try {
    const content = await fs.readFile(identityFilePath, "utf8");
    return JSON.parse(content) as NodeIdentityRecord;
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
};

export const ensureIdentity = async (): Promise<NodeIdentityRecord> => {
  const existing = await loadIdentity();
  if (existing !== null) {
    return existing;
  }

  const keyPair = nacl.sign.keyPair();
  const identity: NodeIdentityRecord = {
    publicKeyBase64: Buffer.from(keyPair.publicKey).toString("base64"),
    secretKeyBase64: Buffer.from(keyPair.secretKey).toString("base64"),
    createdAt: new Date().toISOString(),
  };

  const { dataDir, identityFilePath } = resolveStoragePaths();
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(identityFilePath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  return identity;
};

export const resetIdentity = async (): Promise<void> => {
  const { identityFilePath } = resolveStoragePaths();
  await fs.rm(identityFilePath, { force: true });
};

const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
