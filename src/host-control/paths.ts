import path from "node:path";

import { ConfigError } from "../utils/errors.ts";

export const resolveAllowedWorkingDirectory = (
  requestedPath: string | undefined,
  allowedRoots: readonly string[],
): string | null => {
  if (requestedPath === undefined) {
    return null;
  }

  const resolvedPath = path.resolve(requestedPath);
  if (allowedRoots.length === 0) {
    throw new ConfigError("no allowed roots configured for cwd-sensitive execution");
  }

  const allowed = allowedRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);
  });

  if (!allowed) {
    throw new ConfigError(`cwd is outside allowed roots: ${resolvedPath}`);
  }

  return resolvedPath;
};
