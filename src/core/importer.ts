import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  SkillSnapshotSchema,
  canonicalJson,
  sha256,
  type FileRecord,
  type SkillSnapshot
} from "../protocol/index.js";
import {
  ZipInspectionError,
  inspectZipArchive
} from "./zip-import.js";

const exec = promisify(execFile);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_FILES = 200;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const EXCLUDED_NAMES = new Set([".git", "node_modules", ".arena"]);
const SAMPLE_IDS = new Set(["repo-bugfix"]);

export type ImportRequest =
  | { kind: "local"; path: string; entrypoint?: string }
  | { kind: "git"; url: string; revision?: string; entrypoint?: string }
  | { kind: "zip"; path: string; entrypoint?: string }
  | { kind: "sample"; id: "repo-bugfix" };

export type ImportInspectionErrorCode =
  | "SOURCE_UNAVAILABLE"
  | "SYMLINK_REJECTED"
  | "NON_REGULAR_FILE"
  | "FILE_TOO_LARGE"
  | "TOO_MANY_FILES"
  | "IMPORT_TOO_LARGE"
  | "PATH_COLLISION"
  | "GIT_IMPORT_FAILED"
  | "INVALID_ZIP"
  | "ZIP_PATH_TRAVERSAL"
  | "ZIP_PATH_CONFLICT"
  | "ZIP_SYMLINK_REJECTED"
  | "ZIP_NON_REGULAR_ENTRY"
  | "ZIP_TOO_MANY_FILES"
  | "ZIP_TOO_LARGE"
  | "UNKNOWN_SAMPLE"
  | "ENTRYPOINT_REQUIRED"
  | "INVALID_ENTRYPOINT"
  | "IMPORTS_ROOT_INVALID"
  | "SNAPSHOT_MISMATCH"
  | "PUBLICATION_FAILED";

export class ImportInspectionError extends Error {
  readonly code: ImportInspectionErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ImportInspectionErrorCode,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    super(`Skill import inspection failed (${code})`);
    this.name = "ImportInspectionError";
    this.code = code;
    this.details = details;
  }
}

interface AcceptedFile {
  readonly path: string;
  readonly data: Buffer;
}

interface Inspection {
  readonly source: SkillSnapshot["source"];
  readonly identity: Readonly<Record<string, unknown>>;
  readonly files: readonly AcceptedFile[];
  readonly requestedEntrypoint?: string;
}

function failure(
  code: ImportInspectionErrorCode,
  details: Readonly<Record<string, unknown>> = {}
): never {
  throw new ImportInspectionError(code, details);
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function relativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertStableDirectory(
  directory: string,
  code: "SNAPSHOT_MISMATCH" | "PUBLICATION_FAILED"
): Promise<void> {
  try {
    const directoryStats = await lstat(directory);
    const canonical = await realpath(directory);
    if (
      directoryStats.isSymbolicLink()
      || !directoryStats.isDirectory()
      || canonical !== directory
    ) {
      failure(code);
    }
  } catch (error) {
    if (error instanceof ImportInspectionError) {
      throw error;
    }
    failure(code);
  }
}

async function canonicalDirectory(
  configuredPath: string,
  errorCode: "SOURCE_UNAVAILABLE" | "IMPORTS_ROOT_INVALID",
  create: boolean
): Promise<string> {
  const absolute = path.resolve(configuredPath);
  const parsed = path.parse(absolute);
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  try {
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index]!);
      let stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        if (!create || !isErrno(error, "ENOENT")) {
          throw error;
        }
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if (!isErrno(mkdirError, "EEXIST")) {
            throw mkdirError;
          }
        }
        stats = await lstat(current);
      }
      if (stats.isSymbolicLink()) {
        failure(errorCode === "SOURCE_UNAVAILABLE" ? "SYMLINK_REJECTED" : errorCode);
      }
      if (!stats.isDirectory()) {
        failure(errorCode);
      }
    }
    const canonical = await realpath(absolute);
    return canonical;
  } catch (error) {
    if (error instanceof ImportInspectionError) {
      throw error;
    }
    failure(errorCode);
  }
}

async function canonicalRegularFile(configuredPath: string): Promise<{
  canonical: string;
  stats: Awaited<ReturnType<typeof lstat>>;
}> {
  const absolute = path.resolve(configuredPath);
  const parsed = path.parse(absolute);
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  try {
    let stats = await lstat(current);
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index]!);
      stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        failure("SYMLINK_REJECTED");
      }
      if (index < components.length - 1 && !stats.isDirectory()) {
        failure("SOURCE_UNAVAILABLE");
      }
    }
    if (!stats.isFile()) {
      failure("SOURCE_UNAVAILABLE");
    }
    return { canonical: await realpath(absolute), stats };
  } catch (error) {
    if (error instanceof ImportInspectionError) {
      throw error;
    }
    failure("SOURCE_UNAVAILABLE");
  }
}

async function assertNoSymlinkDescendants(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    failure("SOURCE_UNAVAILABLE");
  }
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    let childStats;
    try {
      childStats = await lstat(child);
    } catch {
      failure("SOURCE_UNAVAILABLE");
    }
    if (childStats.isSymbolicLink()) {
      failure("SYMLINK_REJECTED", { path: relativePath(entry.name) });
    }
    if (childStats.isDirectory()) {
      await assertNoSymlinkDescendants(child);
    }
  }
}

async function securelyReadFile(
  filePath: string,
  safePath: string,
  expected: Awaited<ReturnType<typeof lstat>>,
  acceptedBytes: number
): Promise<Buffer> {
  if (expected.size > MAX_FILE_BYTES) {
    failure("FILE_TOO_LARGE", { path: safePath, limit_bytes: MAX_FILE_BYTES });
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== expected.dev
      || opened.ino !== expected.ino
      || opened.size !== expected.size
    ) {
      failure("SOURCE_UNAVAILABLE", { path: safePath });
    }
    if (opened.size > MAX_FILE_BYTES) {
      failure("FILE_TOO_LARGE", { path: safePath, limit_bytes: MAX_FILE_BYTES });
    }
    if (acceptedBytes + opened.size > MAX_IMPORT_BYTES) {
      failure("IMPORT_TOO_LARGE", { limit_bytes: MAX_IMPORT_BYTES });
    }
    const data = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < data.byteLength) {
      const { bytesRead } = await handle.read(data, offset, data.byteLength - offset, offset);
      if (bytesRead === 0) {
        failure("SOURCE_UNAVAILABLE", { path: safePath });
      }
      offset += bytesRead;
    }
    const eofProbe = Buffer.alloc(1);
    if ((await handle.read(eofProbe, 0, 1, opened.size)).bytesRead !== 0) {
      failure("SOURCE_UNAVAILABLE", { path: safePath });
    }
    const after = await handle.stat();
    if (
      !after.isFile()
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.mode !== opened.mode
      || after.nlink !== opened.nlink
      || after.uid !== opened.uid
      || after.gid !== opened.gid
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      failure("SOURCE_UNAVAILABLE", { path: safePath });
    }
    return data;
  } catch (error) {
    if (error instanceof ImportInspectionError) {
      throw error;
    }
    if (isErrno(error, "ELOOP")) {
      failure("SYMLINK_REJECTED", { path: safePath });
    }
    failure("SOURCE_UNAVAILABLE", { path: safePath });
  } finally {
    await handle?.close().catch(() => undefined);
  }
  failure("SOURCE_UNAVAILABLE", { path: safePath });
}

async function collectLocalFiles(root: string): Promise<AcceptedFile[]> {
  const files: AcceptedFile[] = [];
  let totalBytes = 0;

  async function visit(directory: string): Promise<void> {
    let directoryRealPath;
    let entries;
    try {
      directoryRealPath = await realpath(directory);
      if (!contained(root, directoryRealPath)) {
        failure("SYMLINK_REJECTED");
      }
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof ImportInspectionError) {
        throw error;
      }
      failure("SOURCE_UNAVAILABLE");
    }

    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const safePath = relativePath(path.relative(root, absolutePath));
      let entryStats;
      try {
        entryStats = await lstat(absolutePath);
      } catch {
        failure("SOURCE_UNAVAILABLE", { path: safePath });
      }
      if (entryStats.isSymbolicLink()) {
        failure("SYMLINK_REJECTED", { path: safePath });
      }
      if (EXCLUDED_NAMES.has(entry.name)) {
        if (entryStats.isDirectory()) {
          await assertNoSymlinkDescendants(absolutePath);
        }
        continue;
      }
      if (entryStats.isDirectory()) {
        await visit(absolutePath);
      } else if (entryStats.isFile()) {
        if (files.length >= MAX_IMPORT_FILES) {
          failure("TOO_MANY_FILES", { limit: MAX_IMPORT_FILES });
        }
        const data = await securelyReadFile(absolutePath, safePath, entryStats, totalBytes);
        totalBytes += data.byteLength;
        files.push({
          path: safePath,
          data
        });
      } else {
        failure("NON_REGULAR_FILE", { path: safePath });
      }
    }
  }

  await visit(root);
  return files.sort((left, right) => comparePaths(left.path, right.path));
}

function portableKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function validatePortableFiles(
  files: readonly AcceptedFile[],
  code: "PATH_COLLISION" | "ZIP_PATH_CONFLICT"
): void {
  const acceptedFiles = new Map<string, string>();
  const directories = new Map<string, string>();
  for (const file of files) {
    const parts = file.path.split("/");
    const ancestors = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
    for (const ancestor of ancestors) {
      const key = portableKey(ancestor);
      const previous = directories.get(key);
      if (acceptedFiles.has(key) || (previous !== undefined && previous !== ancestor)) {
        failure(code, { path: ancestor });
      }
      directories.set(key, ancestor);
    }
    const key = portableKey(file.path);
    if (acceptedFiles.has(key) || directories.has(key)) {
      failure(code, { path: file.path });
    }
    acceptedFiles.set(key, file.path);
  }
}

async function inspectLocal(
  sourcePath: string,
  entrypoint?: string
): Promise<Inspection> {
  const root = await canonicalDirectory(sourcePath, "SOURCE_UNAVAILABLE", false);
  const source = { kind: "local" as const, uri: pathToFileURL(root).href };
  return {
    source,
    identity: source,
    files: await collectLocalFiles(root),
    ...(entrypoint === undefined ? {} : { requestedEntrypoint: entrypoint })
  };
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => (
      !name.startsWith("GIT_") && !name.startsWith("SSH_")
    ))
  );
  return {
    ...environment,
    GIT_ALLOW_PROTOCOL: "file:http:https:git:ssh",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0"
  };
}

const GIT_SAFE_CONFIG = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "credential.helper=",
  "-c", "protocol.ext.allow=never",
  "-c", "submodule.recurse=false",
  "-c", "filter.lfs.smudge=",
  "-c", "filter.lfs.required=false"
];

export function sanitizeGitProvenance(locator: string): string {
  try {
    const url = new URL(locator);
    if (url.protocol === "file:") {
      return url.href;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return locator
      .replace(/[?#].*$/, "")
      .replace(/^[^/@:]+@(?=[^/:]+:)/, "");
  }
}

async function canonicalGitProvenance(locator: string): Promise<string> {
  if (locator.startsWith("file:")) {
    const root = await canonicalDirectory(fileURLToPath(locator), "SOURCE_UNAVAILABLE", false);
    return pathToFileURL(root).href;
  }
  const candidate = path.resolve(locator);
  try {
    const stats = await lstat(candidate);
    if (stats.isDirectory() || stats.isSymbolicLink()) {
      const root = await canonicalDirectory(candidate, "SOURCE_UNAVAILABLE", false);
      return pathToFileURL(root).href;
    }
  } catch (error) {
    if (error instanceof ImportInspectionError) {
      throw error;
    }
  }
  return sanitizeGitProvenance(locator);
}

async function runGit(args: string[]): Promise<string> {
  try {
    const result = await exec("git", [...GIT_SAFE_CONFIG, ...args], {
      env: safeGitEnvironment(),
      maxBuffer: 4 * 1024 * 1024
    });
    return result.stdout.trim();
  } catch {
    failure("GIT_IMPORT_FAILED");
  }
}

async function inspectGit(request: Extract<ImportRequest, { kind: "git" }>): Promise<Inspection> {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "scta-git-import-")));
  const checkout = path.join(temporary, "checkout");
  try {
    const provenance = await canonicalGitProvenance(request.url);
    await runGit([
      "clone",
      "--no-checkout",
      "--no-recurse-submodules",
      "--no-hardlinks",
      "--template=",
      "--config=core.hooksPath=/dev/null",
      "--config=submodule.recurse=false",
      "--config=filter.lfs.smudge=",
      "--config=filter.lfs.required=false",
      "--",
      request.url,
      checkout
    ]);
    const revision = request.revision ?? "HEAD";
    if (revision.startsWith("-") || revision.includes("\0")) {
      failure("GIT_IMPORT_FAILED");
    }
    const resolvedRevision = await runGit([
      "-C", checkout, "rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`
    ]);
    await runGit(["-C", checkout, "checkout", "--detach", "--force", resolvedRevision]);
    const canonicalCheckout = await canonicalDirectory(checkout, "SOURCE_UNAVAILABLE", false);
    const source = {
      kind: "git" as const,
      uri: provenance,
      revision: resolvedRevision
    };
    return {
      source,
      identity: source,
      files: await collectLocalFiles(canonicalCheckout),
      ...(request.entrypoint === undefined ? {} : { requestedEntrypoint: request.entrypoint })
    };
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function inspectZip(
  archivePath: string,
  entrypoint?: string
): Promise<Inspection> {
  const archive = await canonicalRegularFile(archivePath);
  if (archive.stats.size > MAX_ARCHIVE_BYTES) {
    failure("SOURCE_UNAVAILABLE");
  }
  let handle;
  let data: Buffer;
  try {
    handle = await open(archive.canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile() || opened.dev !== archive.stats.dev || opened.ino !== archive.stats.ino
      || opened.size > MAX_ARCHIVE_BYTES
    ) {
      failure("SOURCE_UNAVAILABLE");
    }
    data = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || data.byteLength !== opened.size) {
      failure("SOURCE_UNAVAILABLE");
    }
  } catch (error) {
    if (error instanceof ImportInspectionError) {
      throw error;
    }
    failure("SOURCE_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  let files;
  try {
    files = inspectZipArchive(data);
  } catch (error) {
    if (error instanceof ZipInspectionError) {
      failure(error.code, error.details);
    }
    failure("INVALID_ZIP");
  }
  const source = {
    kind: "zip" as const,
    uri: pathToFileURL(archive.canonical).href
  };
  return {
    source,
    identity: source,
    files,
    ...(entrypoint === undefined ? {} : { requestedEntrypoint: entrypoint })
  };
}

async function inspectSample(request: Extract<ImportRequest, { kind: "sample" }>): Promise<Inspection> {
  if (!SAMPLE_IDS.has(request.id)) {
    failure("UNKNOWN_SAMPLE");
  }
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const sampleRoot = path.join(repositoryRoot, "samples", "skills", request.id);
  const canonicalSample = await canonicalDirectory(sampleRoot, "SOURCE_UNAVAILABLE", false);
  const source = { kind: "sample" as const, uri: request.id };
  return { source, identity: source, files: await collectLocalFiles(canonicalSample) };
}

function validateEntrypoint(files: readonly AcceptedFile[], requested?: string): string {
  const candidates = files
    .map((file) => file.path)
    .filter((filePath) => path.posix.basename(filePath) === "SKILL.md")
    .sort(comparePaths);
  if (requested === undefined) {
    if (candidates.length !== 1) {
      failure("ENTRYPOINT_REQUIRED", { candidates });
    }
    return candidates[0]!;
  }
  if (
    requested.length === 0
    || requested.includes("\\")
    || path.posix.isAbsolute(requested)
    || /^[A-Za-z]:/.test(requested)
    || requested.split("/").some((part) => part === "" || part === "." || part === "..")
    || path.posix.basename(requested) !== "SKILL.md"
    || !files.some((file) => file.path === requested)
  ) {
    failure("INVALID_ENTRYPOINT");
  }
  return requested;
}

function detectLicense(files: readonly AcceptedFile[]): string {
  const priorities = ["LICENSE", "LICENSE.md", "COPYING"];
  for (const name of priorities) {
    const match = files.find((file) => path.posix.basename(file.path) === name);
    if (match !== undefined) {
      return match.path;
    }
  }
  return "unknown";
}

async function assertSnapshotMatches(
  destination: string,
  manifest: readonly FileRecord[]
): Promise<void> {
  let destinationStats;
  try {
    destinationStats = await lstat(destination);
  } catch {
    failure("SNAPSHOT_MISMATCH");
  }
  if (destinationStats.isSymbolicLink() || !destinationStats.isDirectory()) {
    failure("SNAPSHOT_MISMATCH");
  }
  if (process.platform !== "win32" && (destinationStats.mode & 0o222) !== 0) {
    failure("SNAPSHOT_MISMATCH");
  }
  await assertStableDirectory(destination, "SNAPSHOT_MISMATCH");
  const expected = new Map(manifest.map((record) => [record.path, record]));
  const actualPaths: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relative = relativePath(path.relative(destination, absolutePath));
      const entryStats = await lstat(absolutePath);
      if (entryStats.isSymbolicLink()) {
        failure("SNAPSHOT_MISMATCH");
      }
      if (entryStats.isDirectory()) {
        if (process.platform !== "win32" && (entryStats.mode & 0o222) !== 0) {
          failure("SNAPSHOT_MISMATCH");
        }
        await visit(absolutePath);
      } else if (entryStats.isFile()) {
        actualPaths.push(relative);
        const record = expected.get(relative);
        if (
          record === undefined
          || entryStats.size !== record.bytes
          || (process.platform !== "win32" && (entryStats.mode & 0o222) !== 0)
          || sha256(await readFile(absolutePath)) !== record.sha256
        ) {
          failure("SNAPSHOT_MISMATCH");
        }
      } else {
        failure("SNAPSHOT_MISMATCH");
      }
    }
  }
  try {
    await visit(destination);
  } catch (error) {
    if (error instanceof ImportInspectionError) {
      throw error;
    }
    failure("SNAPSHOT_MISMATCH");
  }
  actualPaths.sort(comparePaths);
  if (canonicalJson(actualPaths) !== canonicalJson([...expected.keys()].sort())) {
    failure("SNAPSHOT_MISMATCH");
  }
}

async function writeStagingSnapshot(
  root: string,
  sourceHash: string,
  files: readonly AcceptedFile[]
): Promise<string> {
  const staging = path.join(root, `.stage-${sourceHash}-${randomUUID()}`);
  if (path.dirname(staging) !== root) {
    failure("PUBLICATION_FAILED");
  }
  try {
    await assertStableDirectory(root, "PUBLICATION_FAILED");
    await mkdir(staging, { mode: 0o700 });
    await assertStableDirectory(root, "PUBLICATION_FAILED");
    await assertStableDirectory(staging, "PUBLICATION_FAILED");
    for (const file of files) {
      const destination = path.resolve(staging, ...file.path.split("/"));
      if (!contained(staging, destination)) {
        failure("PUBLICATION_FAILED");
      }
      const parent = path.dirname(destination);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const canonicalParent = await realpath(parent);
      if (!contained(staging, canonicalParent)) {
        failure("PUBLICATION_FAILED");
      }
      await writeFile(destination, file.data, { flag: "wx", mode: 0o600 });
      const written = await lstat(destination);
      if (!written.isFile() || written.isSymbolicLink() || sha256(await readFile(destination)) !== sha256(file.data)) {
        failure("PUBLICATION_FAILED");
      }
      await chmod(destination, 0o444);
    }
    const directories: string[] = [];
    async function gather(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const child = path.join(directory, entry.name);
          await gather(child);
          directories.push(child);
        }
      }
    }
    await gather(staging);
    for (const directory of directories) {
      await chmod(directory, 0o555);
    }
    await chmod(staging, 0o555);
    return staging;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof ImportInspectionError) {
      throw error;
    }
    failure("PUBLICATION_FAILED");
  }
}

async function publishSnapshot(
  root: string,
  sourceHash: string,
  files: readonly AcceptedFile[],
  manifest: readonly FileRecord[]
): Promise<string> {
  const destination = path.join(root, sourceHash);
  if (path.dirname(destination) !== root) {
    failure("PUBLICATION_FAILED");
  }
  await assertStableDirectory(root, "PUBLICATION_FAILED");
  try {
    await lstat(destination);
    await assertSnapshotMatches(destination, manifest);
    return destination;
  } catch (error) {
    if (error instanceof ImportInspectionError && error.code !== "SNAPSHOT_MISMATCH") {
      throw error;
    }
    if (!(error instanceof ImportInspectionError) && !isErrno(error, "ENOENT")) {
      failure("PUBLICATION_FAILED");
    }
    if (error instanceof ImportInspectionError) {
      throw error;
    }
  }

  const staging = await writeStagingSnapshot(root, sourceHash, files);
  try {
    await assertStableDirectory(root, "PUBLICATION_FAILED");
    await assertStableDirectory(staging, "PUBLICATION_FAILED");
    try {
      await rename(staging, destination);
    } catch (error) {
      // Node has no portable rename-no-replace operation for directories.
      // A concurrent winner is accepted only after full content verification.
      try {
        await lstat(destination);
      } catch {
        failure("PUBLICATION_FAILED");
      }
      await assertSnapshotMatches(destination, manifest);
      return destination;
    }
    await assertStableDirectory(root, "PUBLICATION_FAILED");
    await assertSnapshotMatches(destination, manifest);
    return destination;
  } finally {
    await chmod(staging, 0o700).catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function importSkill(
  request: ImportRequest,
  importsRoot: string
): Promise<SkillSnapshot> {
  let inspection: Inspection;
  switch (request.kind) {
    case "local":
      inspection = await inspectLocal(request.path, request.entrypoint);
      break;
    case "git":
      inspection = await inspectGit(request);
      break;
    case "zip":
      inspection = await inspectZip(request.path, request.entrypoint);
      break;
    case "sample":
      inspection = await inspectSample(request);
      break;
  }
  validatePortableFiles(
    inspection.files,
    request.kind === "zip" ? "ZIP_PATH_CONFLICT" : "PATH_COLLISION"
  );
  const root = await canonicalDirectory(importsRoot, "IMPORTS_ROOT_INVALID", true);

  if (inspection.files.length === 0) {
    failure("ENTRYPOINT_REQUIRED", { candidates: [] });
  }
  const entrypoint = validateEntrypoint(inspection.files, inspection.requestedEntrypoint);
  const manifest = inspection.files.map((file) => ({
    path: file.path,
    bytes: file.data.byteLength,
    sha256: sha256(file.data)
  }));
  const sourceHash = sha256(canonicalJson({
    source: inspection.identity,
    files: manifest
  }));
  const importedPath = await publishSnapshot(root, sourceHash, inspection.files, manifest);
  return SkillSnapshotSchema.parse({
    schema: "arena.skill-snapshot/v1",
    source: inspection.source,
    entrypoint,
    license: detectLicense(inspection.files),
    files: manifest,
    source_hash: sourceHash,
    imported_path: importedPath
  });
}
