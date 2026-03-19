import { realpathSync } from "node:fs";
import path from "node:path";

import { ConfigError } from "../utils/errors.ts";

export const resolveAllowedWorkingDirectory = (
  requestedPath: string | undefined,
  allowedRoots: readonly string[],
): string | null => {
  if (requestedPath === undefined) {
    return null;
  }

  const resolvedPath = canonicalizePath(requestedPath);
  if (allowedRoots.length === 0) {
    throw new ConfigError("no allowed roots configured for cwd-sensitive execution");
  }

  const allowed = allowedRoots.some((root) => {
    const canonicalRoot = canonicalizeAllowedRoot(root);
    return resolvedPath === canonicalRoot || resolvedPath.startsWith(`${canonicalRoot}${path.sep}`);
  });

  if (!allowed) {
    throw new ConfigError(`cwd is outside allowed roots: ${resolvedPath}`);
  }

  return resolvedPath;
};

const canonicalizePath = (targetPath: string): string => {
  const resolvedPath = path.resolve(targetPath);
  try {
    return realpathSync(resolvedPath);
  } catch (error: unknown) {
    if (isMissingPathError(error) || isPermissionError(error)) {
      throw new ConfigError(`cwd could not be resolved: ${resolvedPath}`);
    }
    throw error;
  }
};

const canonicalizeAllowedRoot = (targetPath: string): string => {
  const resolvedPath = path.resolve(targetPath);
  try {
    return realpathSync(resolvedPath);
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return resolvedPath;
    }
    throw error;
  }
};

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const isPermissionError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "EACCES";
