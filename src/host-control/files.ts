/**
 * @module src/host-control/files
 *
 * Purpose:
 * Host-level file operations with allowed-root validation, size caps, and
 * traversal prevention.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { ConfigError } from "../utils/errors.ts";
import { AgentEvent, createNoopAgentLogger, type AgentLogger } from "../utils/logger.ts";

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface HostFileServiceConfig {
  readonly allowedRoots: readonly string[];
  readonly maxFileBytes?: number;
  readonly logger?: AgentLogger;
}

export interface FileReadResult {
  readonly path: string;
  readonly encoding: "text" | "base64";
  readonly content_text?: string;
  readonly content_base64?: string;
  readonly size_bytes: number;
}

export interface FileWriteResult {
  readonly path: string;
  readonly bytes_transferred: number;
}

export interface FileEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size_bytes?: number;
  readonly modified_at?: string;
}

export class HostFileService {
  private readonly config: HostFileServiceConfig;
  private readonly maxFileBytes: number;
  private readonly logger: AgentLogger;

  public constructor(config: HostFileServiceConfig) {
    this.config = config;
    this.maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.logger = config.logger ?? createNoopAgentLogger();
  }

  public isEnabled(): boolean {
    return this.config.allowedRoots.length > 0;
  }

  public async read(
    filePath: string,
    encoding: "text" | "base64" = "text",
  ): Promise<FileReadResult> {
    try {
      const resolved = await this.resolveAllowedPath(filePath);
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        throw new ConfigError(`not a file: ${resolved}`);
      }
      if (stat.size > this.maxFileBytes) {
        throw new ConfigError(
          `file exceeds size cap (${String(stat.size)} > ${String(this.maxFileBytes)}): ${resolved}`,
        );
      }
      const buffer = await fs.readFile(resolved);
      const result: FileReadResult = {
        path: resolved,
        encoding,
        ...(encoding === "text"
          ? { content_text: buffer.toString("utf8") }
          : { content_base64: buffer.toString("base64") }),
        size_bytes: buffer.byteLength,
      };
      this.logger.info(AgentEvent.FILE_READ, "host file read completed", {
        path: result.path,
        encoding: result.encoding,
        size_bytes: result.size_bytes,
      });
      return result;
    } catch (error: unknown) {
      this.logFileFailure(AgentEvent.FILE_READ, "host file read failed", filePath, error);
      throw error;
    }
  }

  public async write(
    filePath: string,
    options: { content_text?: string; content_base64?: string; overwrite?: boolean },
  ): Promise<FileWriteResult> {
    try {
      const resolved = await this.resolveAllowedPath(filePath, { allowMissingLeaf: true });
      const buffer =
        options.content_base64 !== undefined
          ? Buffer.from(options.content_base64, "base64")
          : Buffer.from(options.content_text ?? "", "utf8");
      if (buffer.byteLength > this.maxFileBytes) {
        throw new ConfigError(
          `content exceeds size cap (${String(buffer.byteLength)} > ${String(this.maxFileBytes)})`,
        );
      }
      if (options.overwrite === false) {
        try {
          await fs.access(resolved);
          throw new ConfigError(`file already exists and overwrite is disabled: ${resolved}`);
        } catch (error: unknown) {
          if (error instanceof ConfigError) {
            throw error;
          }
        }
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, buffer);
      const result = { path: resolved, bytes_transferred: buffer.byteLength };
      this.logger.info(AgentEvent.FILE_WRITE, "host file write completed", {
        path: result.path,
        bytes_transferred: result.bytes_transferred,
      });
      return result;
    } catch (error: unknown) {
      this.logFileFailure(AgentEvent.FILE_WRITE, "host file write failed", filePath, error);
      throw error;
    }
  }

  public async delete(
    filePath: string,
    recursive = false,
  ): Promise<{ deleted: boolean; path: string }> {
    try {
      const resolved = await this.resolveAllowedPath(filePath, { allowMissingLeaf: true });
      try {
        await fs.rm(resolved, { recursive });
        const result = { deleted: true, path: resolved };
        this.logger.info(AgentEvent.FILE_DELETE, "host file delete completed", result);
        return result;
      } catch (error: unknown) {
        if (isNotFoundError(error)) {
          const result = { deleted: false, path: resolved };
          this.logger.info(AgentEvent.FILE_DELETE, "host file delete found nothing", result);
          return result;
        }
        throw error;
      }
    } catch (error: unknown) {
      this.logFileFailure(AgentEvent.FILE_DELETE, "host file delete failed", filePath, error);
      throw error;
    }
  }

  public async browse(dirPath?: string, recursive = false): Promise<FileEntry[]> {
    const resolved =
      dirPath !== undefined && dirPath !== ""
        ? await this.resolveAllowedPath(dirPath)
        : await this.resolveDefaultRoot();
    const entries: FileEntry[] = [];
    await this.walkDir(resolved, entries, recursive ? 10 : 0, 0);
    return entries;
  }

  private async resolveAllowedPath(
    requestedPath: string,
    options: { allowMissingLeaf?: boolean } = {},
  ): Promise<string> {
    if (this.config.allowedRoots.length === 0) {
      throw new ConfigError("no allowed roots configured for file operations");
    }
    const resolved = path.resolve(requestedPath);
    const canonicalPath = await this.resolveCanonicalPath(
      resolved,
      options.allowMissingLeaf ?? false,
    );
    if (!(await this.isWithinAllowedRoots(canonicalPath))) {
      throw new ConfigError(`path is outside allowed roots: ${resolved}`);
    }
    return resolved;
  }

  private async resolveDefaultRoot(): Promise<string> {
    const root = this.config.allowedRoots[0];
    if (root === undefined) {
      throw new ConfigError("no allowed roots configured for file browsing");
    }
    return await this.resolveCanonicalPath(path.resolve(root), true);
  }

  private async resolveCanonicalPath(
    resolvedPath: string,
    allowMissingLeaf: boolean,
  ): Promise<string> {
    if (!allowMissingLeaf) {
      return await fs.realpath(resolvedPath);
    }

    const missingSegments: string[] = [];
    let currentPath = resolvedPath;
    for (;;) {
      try {
        const canonicalExistingPath = await fs.realpath(currentPath);
        return path.resolve(canonicalExistingPath, ...missingSegments.reverse());
      } catch (error: unknown) {
        if (!isNotFoundError(error)) {
          throw error;
        }
        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
          return resolvedPath;
        }
        missingSegments.push(path.basename(currentPath));
        currentPath = parentPath;
      }
    }
  }

  private async isWithinAllowedRoots(canonicalPath: string): Promise<boolean> {
    for (const root of this.config.allowedRoots) {
      const canonicalRoot = await this.resolveCanonicalPath(path.resolve(root), true);
      if (
        canonicalPath === canonicalRoot ||
        canonicalPath.startsWith(`${canonicalRoot}${path.sep}`)
      ) {
        return true;
      }
    }
    return false;
  }

  private async walkDir(
    dirPath: string,
    entries: FileEntry[],
    maxDepth: number,
    currentDepth: number,
  ): Promise<void> {
    const dirEntries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of dirEntries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        entries.push({ path: fullPath, kind: "directory" });
        if (currentDepth < maxDepth) {
          await this.walkDir(fullPath, entries, maxDepth, currentDepth + 1);
        }
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          entries.push({
            path: fullPath,
            kind: "file",
            size_bytes: stat.size,
            modified_at: stat.mtime.toISOString(),
          });
        } catch {
          entries.push({ path: fullPath, kind: "file" });
        }
      }
    }
  }

  private logFileFailure(
    event: string,
    message: string,
    requestedPath: string,
    error: unknown,
  ): void {
    const errorMessage = toErrorMessage(error);
    if (errorMessage.includes("outside allowed roots")) {
      this.logger.error(AgentEvent.PATH_VIOLATION, "host file operation blocked by path policy", {
        path: requestedPath,
        error: errorMessage,
        failure_class: "path_violation",
      });
      return;
    }

    this.logger.error(event, message, {
      path: requestedPath,
      error: errorMessage,
      failure_class: "config",
    });
  }
}

const isNotFoundError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";
