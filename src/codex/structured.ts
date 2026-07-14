import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../protocol/index.js";
import type { AgentRunner } from "./types.js";

export interface StructuredRunRequest<T> {
  cwd: string;
  prompt: string;
  model: "gpt-5.6";
  schema: Record<string, unknown>;
  parse(value: unknown): T;
  timeout_ms: number;
}

export interface StructuredModel {
  run<T>(request: StructuredRunRequest<T>): Promise<T>;
}

export interface CodexStructuredModelOptions {
  runner: AgentRunner;
  /** Must be the same private 0700 directory configured as the runner's owned output root. */
  tempRoot: string;
  idFactory?: () => string;
  maxAllocationAttempts?: number;
}

interface Allocation {
  id: string;
  schemaPath: string;
  outputPath: string;
  schemaIdentity: OwnedFileIdentity;
}

interface OwnedFileIdentity {
  path: string;
  dev: number;
  ino: number;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function safeId(value: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(value) ? value : undefined;
}

async function removeOwnedFile(identity: OwnedFileIdentity): Promise<void> {
  try {
    const stats = await lstat(identity.path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || stats.dev !== identity.dev || stats.ino !== identity.ino) return;
    await rm(identity.path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export class CodexStructuredModel implements StructuredModel {
  readonly #runner: AgentRunner;
  readonly #configuredRoot: string;
  readonly #idFactory: () => string;
  readonly #maxAllocationAttempts: number;

  constructor(options: CodexStructuredModelOptions) {
    this.#runner = options.runner;
    this.#configuredRoot = path.resolve(options.tempRoot);
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#maxAllocationAttempts = options.maxAllocationAttempts ?? 32;
  }

  async run<T>(request: StructuredRunRequest<T>): Promise<T> {
    if (request.model !== "gpt-5.6") {
      throw new TypeError("Structured model must be gpt-5.6");
    }
    const root = await this.#canonicalRoot();
    const allocation = await this.#allocateAndWriteSchema(root, request.schema);
    let outputIdentity: OwnedFileIdentity | undefined;
    try {
      const result = await this.#runner.run({
        run_id: `structured-${allocation.id}`,
        cwd: request.cwd,
        prompt: request.prompt,
        model: "gpt-5.6",
        sandbox: "read-only",
        output_schema_path: allocation.schemaPath,
        output_path: allocation.outputPath,
        timeout_ms: request.timeout_ms
      }, (_event, delivery) => {
        delivery.commit(() => undefined);
      });
      if (result.owned_output?.path === allocation.outputPath) {
        outputIdentity = result.owned_output;
      }
      return request.parse(result.structured_output);
    } finally {
      await removeOwnedFile(allocation.schemaIdentity);
      if (outputIdentity) await removeOwnedFile(outputIdentity);
    }
  }

  async #canonicalRoot(): Promise<string> {
    await mkdir(this.#configuredRoot, { recursive: true, mode: 0o700 });
    const stats = await lstat(this.#configuredRoot);
    const canonical = await realpath(this.#configuredRoot);
    const after = await lstat(this.#configuredRoot);
    const uid = process.getuid?.();
    if (!stats.isDirectory() || stats.isSymbolicLink() || canonical !== this.#configuredRoot
      || after.dev !== stats.dev || after.ino !== stats.ino
      || !after.isDirectory() || after.isSymbolicLink()
      || uid === undefined || after.uid !== uid || (after.mode & 0o077) !== 0) {
      throw new Error("Structured temporary root must be a private owner-only canonical directory");
    }
    return canonical;
  }

  async #allocateAndWriteSchema(
    root: string,
    schema: Record<string, unknown>
  ): Promise<Allocation> {
    for (let attempt = 0; attempt < this.#maxAllocationAttempts; attempt += 1) {
      const id = safeId(this.#idFactory());
      if (!id) continue;
      const schemaPath = path.join(root, `.structured-${id}.schema.json`);
      const outputPath = path.join(root, `.structured-${id}.output.json`);
      if (path.dirname(schemaPath) !== root || path.dirname(outputPath) !== root) continue;
      if (await exists(outputPath)) continue;
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0);
      let handle;
      try {
        handle = await open(schemaPath, flags, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      const openedStats = await handle.stat();
      const identity: OwnedFileIdentity = {
        path: schemaPath,
        dev: openedStats.dev,
        ino: openedStats.ino
      };
      try {
        await handle.writeFile(canonicalJson(schema), "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await removeOwnedFile(identity);
        throw error;
      } finally {
        await handle.close().catch(() => undefined);
      }
      return { id, schemaPath, outputPath, schemaIdentity: identity };
    }
    throw new Error("Unable to allocate structured model temporary files");
  }
}
