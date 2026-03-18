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

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface HostFileServiceConfig {
  readonly allowedRoots: readonly string[];
  readonly maxFileBytes?: number;
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

  public constructor(config: HostFileServiceConfig) {
    this.config = config;
    this.maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  public isEnabled(): boolean {
    return this.config.allowedRoots.length > 0;
  }

  public async read(
    filePath: string,
    encoding: "text" | "base64" = "text",
  ): Promise<FileReadResult> {
    const resolved = this.resolveAllowedPath(filePath);
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
    return {
      path: resolved,
      encoding,
      ...(encoding === "text"
        ? { content_text: buffer.toString("utf8") }
        : { content_base64: buffer.toString("base64") }),
      size_bytes: buffer.byteLength,
    };
  }

  public async write(
    filePath: string,
    options: { content_text?: string; content_base64?: string; overwrite?: boolean },
  ): Promise<FileWriteResult> {
    const resolved = this.resolveAllowedPath(filePath);
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
    return { path: resolved, bytes_transferred: buffer.byteLength };
  }

  public async delete(
    filePath: string,
    recursive = false,
  ): Promise<{ deleted: boolean; path: string }> {
    const resolved = this.resolveAllowedPath(filePath);
    try {
      await fs.rm(resolved, { recursive });
      return { deleted: true, path: resolved };
    } catch {
      return { deleted: false, path: resolved };
    }
  }

  public async browse(dirPath?: string, recursive = false): Promise<FileEntry[]> {
    const resolved =
      dirPath !== undefined && dirPath !== ""
        ? this.resolveAllowedPath(dirPath)
        : this.resolveDefaultRoot();
    const entries: FileEntry[] = [];
    await this.walkDir(resolved, entries, recursive ? 10 : 0, 0);
    return entries;
  }

  private resolveAllowedPath(requestedPath: string): string {
    if (this.config.allowedRoots.length === 0) {
      throw new ConfigError("no allowed roots configured for file operations");
    }
    const resolved = path.resolve(requestedPath);
    const normalizedResolved = path.normalize(resolved);
    if (normalizedResolved !== resolved) {
      throw new ConfigError(`path traversal detected: ${requestedPath}`);
    }
    const allowed = this.config.allowedRoots.some((root) => {
      const resolvedRoot = path.resolve(root);
      return (
        normalizedResolved === resolvedRoot ||
        normalizedResolved.startsWith(`${resolvedRoot}${path.sep}`)
      );
    });
    if (!allowed) {
      throw new ConfigError(`path is outside allowed roots: ${resolved}`);
    }
    return resolved;
  }

  private resolveDefaultRoot(): string {
    const root = this.config.allowedRoots[0];
    if (root === undefined) {
      throw new ConfigError("no allowed roots configured for file browsing");
    }
    return path.resolve(root);
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
}
