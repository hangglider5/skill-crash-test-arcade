import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  ArtifactRefSchema,
  HashSchema,
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

export const ArtifactRecordSchema: z.ZodType<ArtifactRecord> = z.object({
  ref: ArtifactRefSchema,
  sha256: HashSchema,
  bytes: z.number().int().nonnegative(),
  mime: z.string().min(1).max(256),
  redacted: z.boolean()
}).strict();

async function readRegularFile(filePath: string): Promise<Buffer> {
  const stats = await lstat(filePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Artifact path must not be a symbolic link: ${filePath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Artifact path must be a regular file: ${filePath}`);
  }

  return readFile(filePath);
}

async function readSidecarFromSingleDescriptor(filePath: string): Promise<Buffer> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`Artifact metadata must be a regular file: ${filePath}`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || BigInt(bytes.byteLength) !== before.size) {
      throw new Error(`Artifact metadata identity changed while reading: ${filePath}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function directChild(root: string, name: string): string {
  const child = path.resolve(root, name);
  if (path.dirname(child) !== root || path.basename(child) !== name) {
    throw new Error(`Artifact path escapes configured root: ${name}`);
  }

  return child;
}

async function publishExclusively(
  destination: string,
  data: string | Uint8Array
): Promise<boolean> {
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, data, { flag: "wx" });
    try {
      await link(temporaryPath, destination);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export class ArtifactStore {
  readonly #configuredRoot: string;
  #canonicalRoot: Promise<string> | undefined;
  readonly #writeLocks = new Map<string, Promise<void>>();
  readonly #authorizedRecords = new Map<string, ArtifactRecord>();

  constructor(root: string) {
    this.#configuredRoot = path.resolve(root);
  }

  async put(
    data: Uint8Array,
    metadata: ArtifactMetadata
  ): Promise<ArtifactRecord> {
    const bytes = Buffer.from(data);
    const digest = sha256(bytes);
    const ref = ArtifactRefSchema.parse(`sha256:${digest}`);
    const record = ArtifactRecordSchema.parse({
      ref,
      sha256: digest,
      bytes: bytes.byteLength,
      mime: metadata.mime,
      redacted: metadata.redacted
    });

    return this.#withWriteLock(digest, async () => {
      const root = await this.#rootDirectory();

      const artifactPath = directChild(root, digest);
      const metadataPath = directChild(root, `${digest}.json`);

      await publishExclusively(artifactPath, bytes);
      await this.#readVerifiedArtifact(artifactPath, digest);

      await publishExclusively(metadataPath, `${canonicalJson(record)}\n`);
      const existing = JSON.parse(
        (await readSidecarFromSingleDescriptor(metadataPath)).toString("utf8")
      ) as unknown;
      if (canonicalJson(existing) !== canonicalJson(record)) {
        throw new Error(`Artifact metadata mismatch for ${ref}`);
      }

      this.#authorizedRecords.set(digest, Object.freeze({ ...record }));
      return record;
    });
  }

  async read(ref: ArtifactRef): Promise<Buffer> {
    const parsed = ArtifactRefSchema.safeParse(ref);
    if (!parsed.success) {
      throw new Error(`Invalid artifact reference: ${String(ref)}`);
    }

    const digest = parsed.data.slice("sha256:".length);
    const root = await this.#rootDirectory();
    return this.#readVerifiedArtifact(directChild(root, digest), digest);
  }

  async stat(ref: ArtifactRef): Promise<ArtifactRecord> {
    const parsed = ArtifactRefSchema.safeParse(ref);
    if (!parsed.success) {
      throw new Error(`Invalid artifact reference: ${String(ref)}`);
    }

    const digest = parsed.data.slice("sha256:".length);
    const authorized = this.#authorizedRecords.get(digest);
    if (authorized === undefined) {
      throw new Error(`Artifact metadata is not authorized by this store instance: ${parsed.data}`);
    }
    const root = await this.#rootDirectory();
    const record = ArtifactRecordSchema.parse(JSON.parse(
      (await readSidecarFromSingleDescriptor(directChild(root, `${digest}.json`)))
        .toString("utf8")
    ));
    if (record.ref !== parsed.data
      || record.sha256 !== digest
      || canonicalJson(record) !== canonicalJson(authorized)) {
      throw new Error(`Artifact metadata mismatch for ${parsed.data}`);
    }
    const bytes = await this.#readVerifiedArtifact(directChild(root, digest), digest);
    if (record.bytes !== bytes.byteLength) {
      throw new Error(`Artifact metadata byte count mismatch for ${parsed.data}`);
    }
    return record;
  }

  async #rootDirectory(): Promise<string> {
    this.#canonicalRoot ??= (async () => {
      await mkdir(this.#configuredRoot, { recursive: true });
      const root = await realpath(this.#configuredRoot);
      const stats = await lstat(root);
      if (!stats.isDirectory()) {
        throw new Error(`Artifact root is not a directory: ${root}`);
      }
      return root;
    })();

    return this.#canonicalRoot;
  }

  async #readVerifiedArtifact(
    artifactPath: string,
    expectedDigest: string
  ): Promise<Buffer> {
    const bytes = await readRegularFile(artifactPath);
    const actualDigest = sha256(bytes);
    if (actualDigest !== expectedDigest) {
      throw new Error(
        `Artifact digest mismatch: expected ${expectedDigest}, received ${actualDigest}`
      );
    }

    return bytes;
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
