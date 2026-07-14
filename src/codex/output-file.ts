import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export class OutputFileError extends Error {
  constructor() {
    super("owned output file validation failed");
    this.name = "OutputFileError";
  }
}

export interface OwnedOutputPath {
  readonly root: string;
  readonly file: string;
}

export interface OwnedOutputRead {
  readonly data: Buffer;
  readonly identity: {
    readonly path: string;
    readonly dev: number;
    readonly ino: number;
  };
}

function invalid(): never {
  throw new OutputFileError();
}

async function assertCanonicalDirectory(root: string): Promise<void> {
  const stat = await lstat(root).catch(invalid);
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
  const canonical = await realpath(root).catch(invalid);
  if (canonical !== root) invalid();
}

/**
 * Establishes ownership before spawn. Portable Node has no openat/dirfd API, so
 * a same-user actor can still swap path entries between these checks and Codex.
 */
export async function validateOwnedOutputPath(
  ownedRoot: string,
  outputPath: string,
  schemaPath: string
): Promise<OwnedOutputPath> {
  if (![ownedRoot, outputPath, schemaPath].every(path.isAbsolute)) invalid();
  const root = path.resolve(ownedRoot);
  const file = path.resolve(outputPath);
  if (ownedRoot !== root || outputPath !== file) invalid();
  if (path.dirname(file) !== root || file === root || file === path.resolve(schemaPath)) invalid();
  await assertCanonicalDirectory(root);
  try {
    await lstat(file);
    invalid();
  } catch (error) {
    if (error instanceof OutputFileError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") invalid();
  }
  return { root, file };
}

export async function readOwnedOutputFileWithIdentity(
  owned: OwnedOutputPath,
  maxBytes: number
): Promise<OwnedOutputRead> {
  try {
    await assertCanonicalDirectory(owned.root);
    if (path.dirname(owned.file) !== owned.root) invalid();

    const before = await lstat(owned.file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !Number.isSafeInteger(before.size)
      || before.size < 0 || before.size > maxBytes) invalid();
    const canonicalFile = await realpath(owned.file);
    if (canonicalFile !== owned.file || path.dirname(canonicalFile) !== owned.root) invalid();

    const handle = await open(owned.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.size > maxBytes) invalid();

      const data = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < data.byteLength) {
        const { bytesRead } = await handle.read(data, offset, data.byteLength - offset, offset);
        if (bytesRead === 0) invalid();
        offset += bytesRead;
      }
      const extra = Buffer.alloc(1);
      if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) invalid();

      const after = await handle.stat();
      if (after.nlink !== 1 || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) invalid();
      return {
        data,
        identity: { path: owned.file, dev: opened.dev, ino: opened.ino }
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof OutputFileError) throw error;
    throw new OutputFileError();
  }
}

export async function readOwnedOutputFile(
  owned: OwnedOutputPath,
  maxBytes: number
): Promise<Buffer> {
  return (await readOwnedOutputFileWithIdentity(owned, maxBytes)).data;
}
