import { unzipSync } from "fflate";

const MAX_ZIP_ENTRIES = 200;
const MAX_ZIP_BYTES = 5 * 1024 * 1024;
const UTF8_FLAG = 0x0800;

export type ZipInspectionErrorCode =
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

  constructor(code: ZipInspectionErrorCode, details: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

export interface ImportedZipFile {
  readonly path: string;
  readonly data: Buffer;
}

interface ZipEntry {
  readonly rawName: string;
  readonly rawNameBytes: Buffer;
  readonly path: string;
  readonly directory: boolean;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
  readonly localOffset: number;
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

function portableKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
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
  if (withoutSlash.length === 0 || parts.some((part) => part === "" || part === "." || part === "..")) {
    failure("ZIP_PATH_TRAVERSAL");
  }
  return { path: parts.join("/"), directory };
}

function validatePortablePath(
  value: string,
  directory: boolean,
  files: Map<string, string>,
  directories: Map<string, string>
): void {
  const parts = value.split("/");
  const ancestors = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
  for (const ancestor of ancestors) {
    const key = portableKey(ancestor);
    const previousDirectory = directories.get(key);
    if (files.has(key) || (previousDirectory !== undefined && previousDirectory !== ancestor)) {
      failure("ZIP_PATH_CONFLICT", { path: ancestor });
    }
    directories.set(key, ancestor);
  }
  const key = portableKey(value);
  if (directory) {
    const previous = directories.get(key);
    if (files.has(key) || (previous !== undefined && previous !== value)) {
      failure("ZIP_PATH_CONFLICT", { path: value });
    }
    directories.set(key, value);
  } else {
    if (files.has(key) || directories.has(key)) {
      failure("ZIP_PATH_CONFLICT", { path: value });
    }
    files.set(key, value);
  }
}

function validateEocd(data: Buffer, eocd: number): {
  entryCount: number;
  centralOffset: number;
} {
  const disk = data.readUInt16LE(eocd + 4);
  const centralDisk = data.readUInt16LE(eocd + 6);
  const diskEntries = data.readUInt16LE(eocd + 8);
  const entryCount = data.readUInt16LE(eocd + 10);
  const centralBytes = data.readUInt32LE(eocd + 12);
  const centralOffset = data.readUInt32LE(eocd + 16);
  const commentBytes = data.readUInt16LE(eocd + 20);
  if (
    disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount
    || entryCount === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff
    || eocd + 22 + commentBytes !== data.length || centralOffset + centralBytes !== eocd
  ) {
    failure("INVALID_ZIP");
  }
  return { entryCount, centralOffset };
}

function parseCentralEntry(data: Buffer, cursor: number, centralEnd: number): {
  entry: ZipEntry;
  next: number;
} {
  if (cursor + 46 > centralEnd || data.readUInt32LE(cursor) !== 0x02014b50) {
    failure("INVALID_ZIP");
  }
  const madeByOs = data.readUInt16LE(cursor + 4) >>> 8;
  const flags = data.readUInt16LE(cursor + 8);
  const method = data.readUInt16LE(cursor + 10);
  const crc = data.readUInt32LE(cursor + 16);
  const compressedBytes = data.readUInt32LE(cursor + 20);
  const uncompressedBytes = data.readUInt32LE(cursor + 24);
  const nameBytes = data.readUInt16LE(cursor + 28);
  const extraBytes = data.readUInt16LE(cursor + 30);
  const commentBytes = data.readUInt16LE(cursor + 32);
  const disk = data.readUInt16LE(cursor + 34);
  const externalAttributes = data.readUInt32LE(cursor + 38);
  const localOffset = data.readUInt32LE(cursor + 42);
  const next = cursor + 46 + nameBytes + extraBytes + commentBytes;
  if (
    next > centralEnd || disk !== 0 || extraBytes !== 0
    || compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff || localOffset === 0xffffffff
    || (flags & ~UTF8_FLAG) !== 0 || (method !== 0 && method !== 8)
  ) {
    failure("INVALID_ZIP");
  }
  const rawNameBytes = Buffer.from(data.subarray(cursor + 46, cursor + 46 + nameBytes));
  const rawName = decodeZipName(rawNameBytes);
  const safe = safeZipPath(rawName);
  const unixMode = (madeByOs === 3 || madeByOs === 19) ? externalAttributes >>> 16 : 0;
  const fileType = unixMode & 0o170000;
  if (fileType === 0o120000) {
    failure("ZIP_SYMLINK_REJECTED");
  }
  if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
    failure("ZIP_NON_REGULAR_ENTRY");
  }
  if (
    (safe.directory && fileType !== 0 && fileType !== 0o040000)
    || (!safe.directory && fileType === 0o040000)
  ) {
    failure("INVALID_ZIP");
  }
  if (safe.directory && (compressedBytes !== 0 || uncompressedBytes !== 0 || crc !== 0 || method !== 0)) {
    if (uncompressedBytes > MAX_ZIP_BYTES) {
      failure("ZIP_TOO_LARGE", { limit_bytes: MAX_ZIP_BYTES });
    }
    failure("INVALID_ZIP");
  }
  return {
    entry: {
      rawName, rawNameBytes, path: safe.path, directory: safe.directory,
      flags, method, crc, compressedBytes, uncompressedBytes, localOffset
    },
    next
  };
}

function validateLocalHeaders(data: Buffer, entries: readonly ZipEntry[], centralOffset: number): void {
  const regions: Array<{ start: number; end: number }> = [];
  for (const entry of entries) {
    const offset = entry.localOffset;
    if (offset + 30 > centralOffset || data.readUInt32LE(offset) !== 0x04034b50) {
      failure("INVALID_ZIP");
    }
    const nameBytes = data.readUInt16LE(offset + 26);
    const extraBytes = data.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + nameBytes + extraBytes;
    const dataEnd = dataStart + entry.compressedBytes;
    const localName = data.subarray(offset + 30, offset + 30 + nameBytes);
    if (
      extraBytes !== 0 || dataEnd > centralOffset
      || data.readUInt16LE(offset + 6) !== entry.flags
      || data.readUInt16LE(offset + 8) !== entry.method
      || data.readUInt32LE(offset + 14) !== entry.crc
      || data.readUInt32LE(offset + 18) !== entry.compressedBytes
      || data.readUInt32LE(offset + 22) !== entry.uncompressedBytes
      || !localName.equals(entry.rawNameBytes)
    ) {
      failure("INVALID_ZIP");
    }
    regions.push({ start: offset, end: dataEnd });
  }
  regions.sort((left, right) => left.start - right.start);
  for (let index = 1; index < regions.length; index += 1) {
    if (regions[index]!.start < regions[index - 1]!.end) {
      failure("INVALID_ZIP");
    }
  }
}

function preflightZip(data: Buffer): ZipEntry[] {
  if (data.length < 22) {
    failure("INVALID_ZIP");
  }
  const eocd = findEndOfCentralDirectory(data);
  const { entryCount, centralOffset } = validateEocd(data, eocd);
  if (entryCount > MAX_ZIP_ENTRIES) {
    failure("ZIP_TOO_MANY_FILES", { limit: MAX_ZIP_ENTRIES });
  }
  const entries: ZipEntry[] = [];
  const files = new Map<string, string>();
  const directories = new Map<string, string>();
  let totalBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    const parsed = parseCentralEntry(data, cursor, eocd);
    const entry = parsed.entry;
    totalBytes += entry.uncompressedBytes;
    if (totalBytes > MAX_ZIP_BYTES) {
      failure("ZIP_TOO_LARGE", { limit_bytes: MAX_ZIP_BYTES });
    }
    validatePortablePath(entry.path, entry.directory, files, directories);
    entries.push(entry);
    cursor = parsed.next;
  }
  if (cursor !== eocd) {
    failure("INVALID_ZIP");
  }
  validateLocalHeaders(data, entries, centralOffset);
  return entries;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function inspectZipArchive(data: Buffer): readonly ImportedZipFile[] {
  const entries = preflightZip(data);
  let expanded: Record<string, Uint8Array>;
  try {
    expanded = unzipSync(data);
  } catch {
    failure("INVALID_ZIP");
  }
  return entries.flatMap((entry): ImportedZipFile[] => {
    if (entry.directory) {
      return [];
    }
    const value = expanded[entry.rawName];
    if (
      value === undefined || value.byteLength !== entry.uncompressedBytes
      || crc32(value) !== entry.crc
    ) {
      failure("INVALID_ZIP");
    }
    return [{ path: entry.path, data: Buffer.from(value) }];
  }).sort((left, right) => comparePaths(left.path, right.path));
}
