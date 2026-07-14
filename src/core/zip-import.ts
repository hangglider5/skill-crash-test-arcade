import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";

import { unzipSync } from "fflate";

const MAX_ZIP_FILES = 200;
const MAX_ZIP_BYTES = 5 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;

export type ZipInspectionErrorCode =
  | "SOURCE_UNAVAILABLE"
  | "SYMLINK_REJECTED"
  | "INVALID_ZIP"
  | "ZIP_PATH_TRAVERSAL"
  | "ZIP_PATH_CONFLICT"
  | "ZIP_SYMLINK_REJECTED"
  | "ZIP_NON_REGULAR_ENTRY"
  | "ZIP_TOO_MANY_FILES"
  | "ZIP_TOO_LARGE";

export class ZipInspectionError extends Error {
  readonly code: ZipInspectionErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ZipInspectionErrorCode,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

export interface ImportedZipFile {
  readonly path: string;
  readonly data: Buffer;
}

export interface ImportedZip {
  readonly canonicalArchive: string;
  readonly files: readonly ImportedZipFile[];
}

interface ZipEntry {
  readonly rawName: string;
  readonly path: string;
  readonly directory: boolean;
  readonly uncompressedBytes: number;
}

function failure(
  code: ZipInspectionErrorCode,
  details: Readonly<Record<string, unknown>> = {}
): never {
  throw new ZipInspectionError(code, details);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readArchive(archivePath: string): Promise<{
  canonicalArchive: string;
  data: Buffer;
}> {
  let before;
  let canonicalArchive;
  try {
    before = await lstat(archivePath);
    if (before.isSymbolicLink()) {
      failure("SYMLINK_REJECTED");
    }
    if (!before.isFile() || before.size > MAX_ARCHIVE_BYTES) {
      failure("SOURCE_UNAVAILABLE");
    }
    canonicalArchive = await realpath(archivePath);
  } catch (error) {
    if (error instanceof ZipInspectionError) {
      throw error;
    }
    failure("SOURCE_UNAVAILABLE");
  }

  let handle;
  try {
    handle = await open(canonicalArchive, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size > MAX_ARCHIVE_BYTES
    ) {
      failure("SOURCE_UNAVAILABLE");
    }
    const data = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || data.byteLength !== opened.size) {
      failure("SOURCE_UNAVAILABLE");
    }
    return { canonicalArchive, data };
  } catch (error) {
    if (error instanceof ZipInspectionError) {
      throw error;
    }
    failure("SOURCE_UNAVAILABLE");
  } finally {
    await handle?.close();
  }
  failure("SOURCE_UNAVAILABLE");
}

function findEndOfCentralDirectory(data: Buffer): number {
  const minimum = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= minimum; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  failure("INVALID_ZIP");
}

function decodeZipName(data: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    failure("INVALID_ZIP");
  }
}

function safeZipPath(rawName: string): { path: string; directory: boolean } {
  if (
    rawName.length === 0
    || rawName.includes("\0")
    || rawName.includes("\\")
    || rawName.startsWith("/")
    || /^[A-Za-z]:/.test(rawName)
  ) {
    failure("ZIP_PATH_TRAVERSAL");
  }
  const directory = rawName.endsWith("/");
  const withoutSlash = directory ? rawName.slice(0, -1) : rawName;
  const parts = withoutSlash.split("/");
  if (
    withoutSlash.length === 0
    || parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    failure("ZIP_PATH_TRAVERSAL");
  }
  return { path: parts.join("/"), directory };
}

function preflightZip(data: Buffer): ZipEntry[] {
  if (data.length < 22) {
    failure("INVALID_ZIP");
  }
  const eocd = findEndOfCentralDirectory(data);
  const disk = data.readUInt16LE(eocd + 4);
  const centralDisk = data.readUInt16LE(eocd + 6);
  const diskEntries = data.readUInt16LE(eocd + 8);
  const entryCount = data.readUInt16LE(eocd + 10);
  const centralBytes = data.readUInt32LE(eocd + 12);
  const centralOffset = data.readUInt32LE(eocd + 16);
  const commentBytes = data.readUInt16LE(eocd + 20);
  if (
    disk !== 0
    || centralDisk !== 0
    || diskEntries !== entryCount
    || entryCount === 0xffff
    || centralBytes === 0xffffffff
    || centralOffset === 0xffffffff
    || eocd + 22 + commentBytes !== data.length
    || centralOffset + centralBytes !== eocd
  ) {
    failure("INVALID_ZIP");
  }

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  const files = new Set<string>();
  const directories = new Set<string>();
  let totalBytes = 0;
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || data.readUInt32LE(cursor) !== 0x02014b50) {
      failure("INVALID_ZIP");
    }
    const madeByOs = data.readUInt16LE(cursor + 4) >>> 8;
    const flags = data.readUInt16LE(cursor + 8);
    const compressedBytes = data.readUInt32LE(cursor + 20);
    const uncompressedBytes = data.readUInt32LE(cursor + 24);
    const nameBytes = data.readUInt16LE(cursor + 28);
    const extraBytes = data.readUInt16LE(cursor + 30);
    const commentBytesForEntry = data.readUInt16LE(cursor + 32);
    const externalAttributes = data.readUInt32LE(cursor + 38);
    const next = cursor + 46 + nameBytes + extraBytes + commentBytesForEntry;
    if (
      next > eocd
      || compressedBytes === 0xffffffff
      || uncompressedBytes === 0xffffffff
      || (flags & 1) !== 0
    ) {
      failure("INVALID_ZIP");
    }
    const rawName = decodeZipName(data.subarray(cursor + 46, cursor + 46 + nameBytes));
    const safe = safeZipPath(rawName);
    const unixMode = (madeByOs === 3 || madeByOs === 19) ? externalAttributes >>> 16 : 0;
    const fileType = unixMode & 0o170000;
    if (fileType === 0o120000) {
      failure("ZIP_SYMLINK_REJECTED");
    }
    if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
      failure("ZIP_NON_REGULAR_ENTRY");
    }
    if (seen.has(safe.path)) {
      failure("ZIP_PATH_CONFLICT", { path: safe.path });
    }
    seen.add(safe.path);

    const components = safe.path.split("/");
    const ancestors = components.slice(0, -1).map((_, ancestorIndex) => (
      components.slice(0, ancestorIndex + 1).join("/")
    ));
    if (safe.directory) {
      if (files.has(safe.path)) {
        failure("ZIP_PATH_CONFLICT", { path: safe.path });
      }
      directories.add(safe.path);
    } else {
      if (directories.has(safe.path) || ancestors.some((ancestor) => files.has(ancestor))) {
        failure("ZIP_PATH_CONFLICT", { path: safe.path });
      }
      files.add(safe.path);
      totalBytes += uncompressedBytes;
      if (files.size > MAX_ZIP_FILES) {
        failure("ZIP_TOO_MANY_FILES", { limit: MAX_ZIP_FILES });
      }
      if (totalBytes > MAX_ZIP_BYTES) {
        failure("ZIP_TOO_LARGE", { limit_bytes: MAX_ZIP_BYTES });
      }
    }
    for (const ancestor of ancestors) {
      if (files.has(ancestor)) {
        failure("ZIP_PATH_CONFLICT", { path: ancestor });
      }
      directories.add(ancestor);
    }
    entries.push({
      rawName,
      path: safe.path,
      directory: safe.directory,
      uncompressedBytes
    });
    cursor = next;
  }
  if (cursor !== eocd) {
    failure("INVALID_ZIP");
  }
  return entries;
}

export async function inspectZipArchive(archivePath: string): Promise<ImportedZip> {
  const { canonicalArchive, data } = await readArchive(archivePath);
  const entries = preflightZip(data);
  let expanded: Record<string, Uint8Array>;
  try {
    expanded = unzipSync(data);
  } catch {
    failure("INVALID_ZIP");
  }
  const files = entries.flatMap((entry): ImportedZipFile[] => {
    if (entry.directory) {
      return [];
    }
    const value = expanded[entry.rawName];
    if (value === undefined || value.byteLength !== entry.uncompressedBytes) {
      failure("INVALID_ZIP");
    }
    return [{ path: entry.path, data: Buffer.from(value) }];
  }).sort((left, right) => comparePaths(left.path, right.path));
  return { canonicalArchive, files };
}
