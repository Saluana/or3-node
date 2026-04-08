import fs from "node:fs/promises";

import nacl from "tweetnacl";

import { writePrivateJsonFile } from "../storage/json.ts";
import { resolveStoragePaths } from "../storage/paths.ts";
import { isFileNotFoundError } from "../utils/errors.ts";

export interface NodeIdentityRecord {
  readonly publicKeyBase64: string;
  readonly secretKeyBase64: string;
  readonly createdAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const normalizeIdentityRecord = (value: unknown): NodeIdentityRecord => {
  if (!isRecord(value)) {
    throw new Error("identity file is malformed");
  }
  const publicKeyBase64 =
    typeof value.publicKeyBase64 === "string" ? value.publicKeyBase64 : null;
  const secretKeyBase64 =
    typeof value.secretKeyBase64 === "string" ? value.secretKeyBase64 : null;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : null;
  if (publicKeyBase64 === null || secretKeyBase64 === null || createdAt === null) {
    throw new Error("identity file is malformed");
  }
  return {
    publicKeyBase64,
    secretKeyBase64,
    createdAt,
  };
};

export const loadIdentity = async (): Promise<NodeIdentityRecord | null> => {
  const { identityFilePath } = resolveStoragePaths();
  try {
    const content = await fs.readFile(identityFilePath, "utf8");
    return normalizeIdentityRecord(JSON.parse(content));
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) {
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
  await writePrivateJsonFile(identityFilePath, identity);
  return identity;
};

export const resetIdentity = async (): Promise<void> => {
  const { identityFilePath } = resolveStoragePaths();
  await fs.rm(identityFilePath, { force: true });
};
