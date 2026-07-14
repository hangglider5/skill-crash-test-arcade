import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import {
  ArtifactRefSchema,
  canonicalJson,
  sha256,
  type ArtifactRef
} from "../protocol/index.js";

export interface ArtifactMetadata {
  mime: string;
  redacted: boolean;
}

export interface ArtifactRecord extends ArtifactMetadata {
  ref: ArtifactRef;
  sha256: string;
  bytes: number;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function writeAtomically(
  destination: string,
  data: string | Uint8Array
): Promise<void> {
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, data, { flag: "wx" });
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export class ArtifactStore {
  readonly #root: string;
  readonly #writeLocks = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  async put(
    data: Uint8Array,
    metadata: ArtifactMetadata
  ): Promise<ArtifactRecord> {
    const bytes = Buffer.from(data);
    const digest = sha256(bytes);
    const ref = ArtifactRefSchema.parse(`sha256:${digest}`);

    return this.#withWriteLock(digest, async () => {
      await mkdir(this.#root, { recursive: true });

      const artifactPath = path.join(this.#root, digest);
      const metadataPath = path.join(this.#root, `${digest}.json`);
      const record: ArtifactRecord = {
        ref,
        sha256: digest,
        bytes: bytes.byteLength,
        mime: metadata.mime,
        redacted: metadata.redacted
      };

      if (!(await pathExists(artifactPath))) {
        await writeAtomically(artifactPath, bytes);
      }

      if (await pathExists(metadataPath)) {
        const existing = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
        if (canonicalJson(existing) !== canonicalJson(record)) {
          throw new Error(`Artifact metadata mismatch for ${ref}`);
        }
      } else {
        await writeAtomically(metadataPath, `${canonicalJson(record)}\n`);
      }

      return record;
    });
  }

  async read(ref: ArtifactRef): Promise<Buffer> {
    const parsed = ArtifactRefSchema.safeParse(ref);
    if (!parsed.success) {
      throw new Error(`Invalid artifact reference: ${String(ref)}`);
    }

    const digest = parsed.data.slice("sha256:".length);
    return readFile(path.join(this.#root, digest));
  }

  async #withWriteLock<T>(digest: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#writeLocks.get(digest) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.#writeLocks.set(digest, tail);

    try {
      return await result;
    } finally {
      if (this.#writeLocks.get(digest) === tail) {
        this.#writeLocks.delete(digest);
      }
    }
  }
}
