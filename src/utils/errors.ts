export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

interface ErrorWithCode {
  readonly code?: unknown;
}

export const getErrorCode = (error: unknown): string | undefined =>
  error instanceof Error &&
  typeof (error as ErrorWithCode).code === "string"
    ? ((error as ErrorWithCode).code as string)
    : undefined;

export const isFileNotFoundError = (error: unknown): boolean => getErrorCode(error) === "ENOENT";

export const isPermissionDeniedError = (error: unknown): boolean =>
  getErrorCode(error) === "EACCES";

export const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";
