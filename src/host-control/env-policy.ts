import { ConfigError } from "../utils/errors.ts";

export const validateRequestedEnv = (
  requestedEnv: Readonly<Record<string, string>>,
  allowedNames: readonly string[],
): void => {
  const allowedNameSet = new Set(allowedNames);
  const disallowed = Object.keys(requestedEnv).filter((name) => !allowedNameSet.has(name));
  if (disallowed[0] !== undefined) {
    throw new ConfigError(`env vars are outside allowlist: ${disallowed.join(", ")}`);
  }
};
