import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { strToU8, zipSync, type Zippable } from "fflate";
import { describe, expect, it } from "vitest";

import {
  ImportInspectionError,
  importSkill,
  sanitizeGitProvenance
} from "../../src/core/importer.js";

const exec = promisify(execFile);
const MiB = 1024 * 1024;

async function temporaryRoot(prefix = "scta-import-"): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function mkdirSkill(
  source: string,
  body = "---\nname: test-skill\ndescription: Use when testing imports.\n---\n\n# Test\n"
): Promise<void> {
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), body);
}

async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, {
    cwd: repository,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "author@example.test",
      GIT_COMMITTER_NAME: "Test Committer",
      GIT_COMMITTER_EMAIL: "committer@example.test"
    }
  });
  return result.stdout.trim();
}

async function createRepository(root: string): Promise<{
  repository: string;
  firstRevision: string;
  secondRevision: string;
}> {
  const repository = path.join(root, "repository");
  await mkdirSkill(repository, "# First\n");
  await git(repository, "init", "-q");
  await git(repository, "add", "SKILL.md");
  await git(repository, "commit", "-qm", "first");
  const firstRevision = await git(repository, "rev-parse", "HEAD");
  await writeFile(path.join(repository, "SKILL.md"), "# Second\n");
  await git(repository, "commit", "-qam", "second");
  const secondRevision = await git(repository, "rev-parse", "HEAD");
  return { repository, firstRevision, secondRevision };
}

function replaceAllAscii(archive: Uint8Array, from: string, to: string): Uint8Array {
  if (from.length !== to.length) {
    throw new Error("ZIP test replacement names must have equal lengths");
  }
  const output = Buffer.from(archive);
  const needle = Buffer.from(from);
  let offset = 0;
  while ((offset = output.indexOf(needle, offset)) !== -1) {
    output.set(Buffer.from(to), offset);
    offset += needle.length;
  }
  return output;
}

async function writeZip(
  root: string,
  entries: Zippable,
  name = "skill.zip"
): Promise<string> {
  const archive = path.join(root, name);
  await writeFile(archive, zipSync(entries));
  return archive;
}

function zipOffsets(archive: Uint8Array): { central: number; local: number } {
  const bytes = Buffer.from(archive);
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const local = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (central < 0 || local < 0) {
    throw new Error("expected ZIP headers");
  }
  return { central, local };
}

async function writeMutatedZip(
  root: string,
  mutate: (bytes: Buffer, offsets: { central: number; local: number }) => void,
  name: string
): Promise<string> {
  const bytes = Buffer.from(zipSync({ "SKILL.md": strToU8("# Skill\n") }));
  mutate(bytes, zipOffsets(bytes));
  const archive = path.join(root, name);
  await writeFile(archive, bytes);
  return archive;
}

describe("read-only local Skill import", () => {
  it("creates a stable read-only snapshot without changing source bytes, mode, or mtime", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source");
    const imports = path.join(root, "imports");
    await mkdirSkill(source);
    await chmod(path.join(source, "SKILL.md"), 0o751);
    const beforeBytes = await readFile(path.join(source, "SKILL.md"));
    const before = await stat(path.join(source, "SKILL.md"));

    const first = await importSkill({ kind: "local", path: source }, imports);
    const second = await importSkill({ kind: "local", path: source }, imports);

    const after = await stat(path.join(source, "SKILL.md"));
    expect(first.source_hash).toBe(second.source_hash);
    expect(first.files).toEqual([{ path: "SKILL.md", bytes: beforeBytes.length, sha256: expect.any(String) }]);
    expect(await readFile(path.join(source, "SKILL.md"))).toEqual(beforeBytes);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect((await stat(path.join(first.imported_path, "SKILL.md"))).mode & 0o777).toBe(0o444);
  });

  it("rejects a symlink source root and descendant, including excluded descendants", async () => {
    const root = await temporaryRoot();
    const real = path.join(root, "real");
    await mkdirSkill(real);
    await symlink(real, path.join(root, "linked-root"));
    await expect(importSkill(
      { kind: "local", path: path.join(root, "linked-root") },
      path.join(root, "imports-root")
    )).rejects.toMatchObject({ code: "SYMLINK_REJECTED" });

    await symlink(path.join(real, "SKILL.md"), path.join(real, "linked-file"));
    await expect(importSkill(
      { kind: "local", path: real },
      path.join(root, "imports-file")
    )).rejects.toMatchObject({ code: "SYMLINK_REJECTED" });

    await rm(path.join(real, "linked-file"));
    await mkdir(path.join(real, ".git"));
    await symlink(path.join(real, "SKILL.md"), path.join(real, ".git", "linked"));
    await expect(importSkill(
      { kind: "local", path: real },
      path.join(root, "imports-excluded")
    )).rejects.toMatchObject({ code: "SYMLINK_REJECTED" });
  });

  it("copies regular files only and applies exact exclusions", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source");
    await mkdirSkill(source);
    for (const excluded of [".git", "node_modules", ".arena"]) {
      await mkdir(path.join(source, excluded));
      await writeFile(path.join(source, excluded, "secret"), excluded);
    }
    await writeFile(path.join(source, "node_modules.txt"), "kept");
    await writeFile(path.join(source, "LICENSE"), "not an SPDX inference");

    const snapshot = await importSkill(
      { kind: "local", path: source },
      path.join(root, "imports")
    );

    expect(snapshot.files.map((file) => file.path)).toEqual([
      "LICENSE",
      "SKILL.md",
      "node_modules.txt"
    ]);
    expect(snapshot.license).toBe("LICENSE");
  });

  it("rejects non-regular files and files larger than 2 MiB", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source");
    await mkdirSkill(source);
    await writeFile(path.join(source, "large.bin"), Buffer.alloc(2 * MiB + 1));
    await expect(importSkill(
      { kind: "local", path: source }, path.join(root, "large-imports")
    )).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });

    await writeFile(path.join(source, "large.bin"), "small");
    const fifo = path.join(source, "pipe");
    await exec("mkfifo", [fifo]);
    await expect(importSkill(
      { kind: "local", path: source }, path.join(root, "fifo-imports")
    )).rejects.toMatchObject({ code: "NON_REGULAR_FILE" });
  });

  it("rejects a symlink in a local source ancestor", async () => {
    const root = await temporaryRoot();
    const actualParent = path.join(root, "actual-parent");
    await mkdirSkill(path.join(actualParent, "source"));
    await symlink(actualParent, path.join(root, "linked-parent"));
    await expect(importSkill(
      { kind: "local", path: path.join(root, "linked-parent", "source") },
      path.join(root, "imports")
    )).rejects.toMatchObject({ code: "SYMLINK_REJECTED" });
    await expect(lstat(path.join(root, "imports"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces portable collision keys when the local filesystem can represent them", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source");
    await mkdirSkill(source);
    await writeFile(path.join(source, "Portable.txt"), "upper");
    await writeFile(path.join(source, "portable.TXT"), "lower");
    const names = await readdir(source);
    if (names.includes("Portable.txt") && names.includes("portable.TXT")) {
      await expect(importSkill({ kind: "local", path: source }, path.join(root, "imports")))
        .rejects.toMatchObject({ code: "PATH_COLLISION" });
    }
  });

  it("caps local imports at 200 files and 5 MiB in aggregate", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source");
    const skill = "# Skill\n";
    await mkdirSkill(source, skill);
    for (let index = 0; index < 199; index += 1) {
      await writeFile(path.join(source, `file-${index}.txt`), "");
    }
    await expect(importSkill({ kind: "local", path: source }, path.join(root, "at-file-limit")))
      .resolves.toMatchObject({ source_hash: expect.any(String) });
    await writeFile(path.join(source, "one-too-many.txt"), "");
    await expect(importSkill({ kind: "local", path: source }, path.join(root, "over-file-limit")))
      .rejects.toMatchObject({ code: "TOO_MANY_FILES" });

    const bytesRoot = path.join(root, "bytes-source");
    await mkdirSkill(bytesRoot, skill);
    const remaining = 5 * MiB - Buffer.byteLength(skill);
    await writeFile(path.join(bytesRoot, "a.bin"), Buffer.alloc(2 * MiB));
    await writeFile(path.join(bytesRoot, "b.bin"), Buffer.alloc(2 * MiB));
    await writeFile(path.join(bytesRoot, "c.bin"), Buffer.alloc(remaining - 4 * MiB));
    await expect(importSkill({ kind: "local", path: bytesRoot }, path.join(root, "at-byte-limit")))
      .resolves.toMatchObject({ source_hash: expect.any(String) });
    await writeFile(path.join(bytesRoot, "over.bin"), "x");
    await expect(importSkill({ kind: "local", path: bytesRoot }, path.join(root, "over-byte-limit")))
      .rejects.toMatchObject({ code: "IMPORT_TOO_LARGE" });
  });
});

describe("Git Skill import", () => {
  it("uses a detached optional revision without hooks, smudge, submodules, or source changes", async () => {
    const root = await temporaryRoot("scta-git-test-");
    const { repository, firstRevision } = await createRepository(root);
    const marker = path.join(root, "hook-ran");
    await mkdir(path.join(repository, ".githooks"));
    await writeFile(
      path.join(repository, ".githooks", "post-checkout"),
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`
    );
    await chmod(path.join(repository, ".githooks", "post-checkout"), 0o755);
    await writeFile(path.join(repository, ".gitattributes"), "payload filter=lfs\n");
    await writeFile(path.join(repository, "payload"), "version https://git-lfs.github.com/spec/v1\n");
    await git(repository, "add", ".githooks", ".gitattributes", "payload");
    await git(repository, "commit", "-qm", "malicious metadata");
    const sourceStatus = await git(repository, "status", "--porcelain=v1");

    const latest = await importSkill({
      kind: "git",
      url: repository
    }, path.join(root, "latest-imports"));
    const snapshot = await importSkill({
      kind: "git",
      url: repository,
      revision: firstRevision
    }, path.join(root, "imports"));

    expect(await readFile(path.join(latest.imported_path, "payload"), "utf8"))
      .toBe("version https://git-lfs.github.com/spec/v1\n");
    expect(snapshot.source.revision).toBe(firstRevision);
    expect(await readFile(path.join(snapshot.imported_path, "SKILL.md"), "utf8")).toBe("# First\n");
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repository, "status", "--porcelain=v1")).toBe(sourceStatus);
  });

  it("cleans clone temporary directories after a failed inspection", async () => {
    const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("scta-git-import-")));
    const root = await temporaryRoot("scta-git-failure-");
    const { repository } = await createRepository(root);
    await writeFile(path.join(repository, "SKILL.md"), "changed");
    await git(repository, "commit", "-qam", "remove metadata validity");
    await expect(importSkill({ kind: "git", url: repository, entrypoint: "missing/SKILL.md" }, path.join(root, "imports")))
      .rejects.toMatchObject({ code: "INVALID_ENTRYPOINT" });
    const after = (await readdir(tmpdir())).filter((name) => name.startsWith("scta-git-import-") && !before.has(name));
    expect(after).toEqual([]);
  });

  it("canonicalizes local Git locator variants and strips remote secrets", async () => {
    const root = await temporaryRoot("scta-git-provenance-");
    const { repository } = await createRepository(root);
    const requests = [repository, path.relative(process.cwd(), repository), pathToFileURL(repository).href];
    const snapshots = await Promise.all(requests.map((url, index) => importSkill(
      { kind: "git", url }, path.join(root, `imports-${index}`)
    )));
    const canonical = pathToFileURL(await realpath(repository)).href;
    expect(new Set(snapshots.map((snapshot) => snapshot.source_hash)))
      .toEqual(new Set([snapshots[0]!.source_hash]));
    expect(snapshots.map((snapshot) => snapshot.source.uri)).toEqual([canonical, canonical, canonical]);
    expect(sanitizeGitProvenance("https://user:password@example.test/repo.git?token=secret#private"))
      .toBe("https://example.test/repo.git");
    expect(sanitizeGitProvenance("ssh://user@example.test/repo.git?token=secret#private"))
      .toBe("ssh://example.test/repo.git");
  });
});

describe("bounded ZIP Skill import", () => {
  it("imports a valid ZIP without changing the archive", async () => {
    const root = await temporaryRoot("scta-zip-valid-");
    const archive = await writeZip(root, {
      "SKILL.md": strToU8("# ZIP Skill\n"),
      "docs/note.txt": strToU8("note")
    });
    const before = await readFile(archive);
    const snapshot = await importSkill({ kind: "zip", path: archive }, path.join(root, "imports"));
    expect(snapshot.files.map((file) => file.path)).toEqual(["SKILL.md", "docs/note.txt"]);
    expect(await readFile(path.join(snapshot.imported_path, "docs", "note.txt"), "utf8")).toBe("note");
    expect(await readFile(archive)).toEqual(before);
  });

  it.each([
    ["absolute", "/SKILL.md"],
    ["parent", "../SKILL.md"],
    ["backslash", "folder\\SKILL.md"],
    ["drive", "C:/SKILL.md"],
    ["empty component", "folder//SKILL.md"],
    ["dot component", "folder/./SKILL.md"]
  ])("rejects %s paths before publication", async (_label, invalidPath) => {
    const root = await temporaryRoot("scta-zip-path-");
    const archive = await writeZip(root, { [invalidPath]: strToU8("bad") });
    await expect(importSkill({ kind: "zip", path: archive }, path.join(root, "imports")))
      .rejects.toMatchObject({ code: "ZIP_PATH_TRAVERSAL" });
    const published = await readdir(path.join(root, "imports")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    expect(published).toEqual([]);
  });

  it("rejects duplicate names and file-directory conflicts", async () => {
    const root = await temporaryRoot("scta-zip-conflict-");
    const duplicate = replaceAllAscii(zipSync({
      "aa": strToU8("one"),
      "bb": strToU8("two"),
      "SKILL.md": strToU8("# Skill")
    }), "bb", "aa");
    const duplicatePath = path.join(root, "duplicate.zip");
    await writeFile(duplicatePath, duplicate);
    await expect(importSkill({ kind: "zip", path: duplicatePath }, path.join(root, "duplicate-imports")))
      .rejects.toMatchObject({ code: "ZIP_PATH_CONFLICT" });

    const conflictPath = await writeZip(root, {
      "a": strToU8("file"),
      "a/SKILL.md": strToU8("# Skill")
    }, "conflict.zip");
    await expect(importSkill({ kind: "zip", path: conflictPath }, path.join(root, "conflict-imports")))
      .rejects.toMatchObject({ code: "ZIP_PATH_CONFLICT" });
  });

  it("rejects Unix symlink metadata instead of materializing it", async () => {
    const root = await temporaryRoot("scta-zip-link-");
    const archive = await writeZip(root, {
      "SKILL.md": strToU8("# Skill"),
      "linked": [strToU8("target"), { os: 3, attrs: 0o120777 << 16 }]
    });
    await expect(importSkill({ kind: "zip", path: archive }, path.join(root, "imports")))
      .rejects.toMatchObject({ code: "ZIP_SYMLINK_REJECTED" });
  });

  it("preflights the 200-file and 5 MiB uncompressed limits", async () => {
    const root = await temporaryRoot("scta-zip-limits-");
    const manyEntries: Zippable = { "SKILL.md": strToU8("# Skill") };
    for (let index = 0; index < 200; index += 1) {
      manyEntries[`files/${index}.txt`] = strToU8("");
    }
    const many = await writeZip(root, manyEntries, "many.zip");
    await expect(importSkill({ kind: "zip", path: many }, path.join(root, "many-imports")))
      .rejects.toMatchObject({ code: "ZIP_TOO_MANY_FILES" });

    const bomb = await writeZip(root, {
      "SKILL.md": strToU8("# Skill"),
      "bomb.bin": new Uint8Array(5 * MiB)
    }, "bomb.zip");
    const bytes = Buffer.from(await readFile(bomb));
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThanOrEqual(0);
    bytes.writeUInt32LE(5 * MiB + 1, central + 24);
    await writeFile(bomb, bytes);
    await expect(importSkill({ kind: "zip", path: bomb }, path.join(root, "bomb-imports")))
      .rejects.toMatchObject({ code: "ZIP_TOO_LARGE" });
  });

  it("counts zero-size directory entries toward the 200-entry ZIP limit", async () => {
    const root = await temporaryRoot("scta-zip-entry-limit-");
    const atLimit: Zippable = { "SKILL.md": strToU8("# Skill\n") };
    for (let index = 0; index < 199; index += 1) {
      atLimit[`directories/${index}/`] = [strToU8(""), { level: 0 }];
    }
    const accepted = await writeZip(root, atLimit, "200-entries.zip");
    await expect(importSkill({ kind: "zip", path: accepted }, path.join(root, "accepted")))
      .resolves.toMatchObject({ files: [{ path: "SKILL.md" }] });

    const overLimit: Zippable = {
      ...atLimit,
      "directories/199/": [strToU8(""), { level: 0 }]
    };
    const rejected = await writeZip(root, overLimit, "201-entries.zip");
    await expect(importSkill({ kind: "zip", path: rejected }, path.join(root, "rejected")))
      .rejects.toMatchObject({ code: "ZIP_TOO_MANY_FILES", details: { limit: 200 } });
  });

  it("rejects case-folded and Unicode-normalized ZIP path conflicts", async () => {
    const root = await temporaryRoot("scta-zip-portable-conflict-");
    const caseConflict = await writeZip(root, {
      "Docs/SKILL.md": strToU8("# Skill"),
      "docs/note.txt": strToU8("note")
    }, "case.zip");
    await expect(importSkill({ kind: "zip", path: caseConflict }, path.join(root, "case-imports")))
      .rejects.toMatchObject({ code: "ZIP_PATH_CONFLICT" });
    const unicodeConflict = await writeZip(root, {
      "caf\u00e9/SKILL.md": strToU8("# Skill"),
      "cafe\u0301/note.txt": strToU8("note")
    }, "unicode.zip");
    await expect(importSkill({ kind: "zip", path: unicodeConflict }, path.join(root, "unicode-imports")))
      .rejects.toMatchObject({ code: "ZIP_PATH_CONFLICT" });
  });

  it("rejects unsupported ZIP flags and nonzero entry disks", async () => {
    const root = await temporaryRoot("scta-zip-features-");
    const cases: Array<[string, (bytes: Buffer, offsets: { central: number; local: number }) => void]> = [
      ["encrypted.zip", (bytes, { central, local }) => {
        bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 1, central + 8);
        bytes.writeUInt16LE(bytes.readUInt16LE(local + 6) | 1, local + 6);
      }],
      ["descriptor.zip", (bytes, { central, local }) => {
        bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 8, central + 8);
        bytes.writeUInt16LE(bytes.readUInt16LE(local + 6) | 8, local + 6);
      }],
      ["disk.zip", (bytes, { central }) => bytes.writeUInt16LE(1, central + 34)]
    ];
    for (const [name, mutate] of cases) {
      const archive = await writeMutatedZip(root, mutate, name);
      await expect(importSkill({ kind: "zip", path: archive }, path.join(root, `${name}-imports`)))
        .rejects.toMatchObject({ code: "INVALID_ZIP" });
    }
  });

  it("rejects local/central ZIP metadata mismatches before extraction", async () => {
    const root = await temporaryRoot("scta-zip-header-mismatch-");
    const cases: Array<[string, (bytes: Buffer, offsets: { central: number; local: number }) => void]> = [
      ["name.zip", (bytes, { local }) => { bytes[local + 30] = bytes[local + 30]! ^ 1; }],
      ["method.zip", (bytes, { local }) => {
        bytes.writeUInt16LE(bytes.readUInt16LE(local + 8) === 0 ? 8 : 0, local + 8);
      }],
      ["size.zip", (bytes, { local }) => {
        bytes.writeUInt32LE(bytes.readUInt32LE(local + 22) + 1, local + 22);
      }]
    ];
    for (const [name, mutate] of cases) {
      const archive = await writeMutatedZip(root, mutate, name);
      await expect(importSkill({ kind: "zip", path: archive }, path.join(root, `${name}-imports`)))
        .rejects.toMatchObject({ code: "INVALID_ZIP" });
    }
  });

  it("verifies extracted file CRC32 against the validated headers", async () => {
    const root = await temporaryRoot("scta-zip-crc-");
    const archive = await writeMutatedZip(root, (bytes, { central, local }) => {
      const wrongCrc = (bytes.readUInt32LE(central + 16) ^ 0xffffffff) >>> 0;
      bytes.writeUInt32LE(wrongCrc, central + 16);
      bytes.writeUInt32LE(wrongCrc, local + 14);
    }, "crc.zip");
    await expect(importSkill({ kind: "zip", path: archive }, path.join(root, "imports")))
      .rejects.toMatchObject({ code: "INVALID_ZIP" });
  });

  it("rejects a huge declared directory before decompression", async () => {
    const root = await temporaryRoot("scta-zip-directory-bomb-");
    const bytes = Buffer.from(zipSync({ "huge/": new Uint8Array(), "SKILL.md": strToU8("# Skill") }));
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThanOrEqual(0);
    bytes.writeUInt32LE(6 * MiB, central + 24);
    const archive = path.join(root, "directory-bomb.zip");
    await writeFile(archive, bytes);
    await expect(importSkill({ kind: "zip", path: archive }, path.join(root, "imports")))
      .rejects.toMatchObject({ code: "ZIP_TOO_LARGE" });
  });

  it("rejects a symlink in the ZIP source ancestor", async () => {
    const root = await temporaryRoot("scta-zip-ancestor-");
    const actualParent = path.join(root, "actual-parent");
    await mkdir(actualParent);
    const archive = await writeZip(actualParent, { "SKILL.md": strToU8("# Skill") });
    await symlink(actualParent, path.join(root, "linked-parent"));
    await expect(importSkill(
      { kind: "zip", path: path.join(root, "linked-parent", path.basename(archive)) },
      path.join(root, "imports")
    )).rejects.toMatchObject({ code: "SYMLINK_REJECTED" });
    await expect(lstat(path.join(root, "imports"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("entrypoint, identity, and publication", () => {
  it("allows only the repo-bugfix sample", async () => {
    const root = await temporaryRoot();
    const snapshot = await importSkill({ kind: "sample", id: "repo-bugfix" }, path.join(root, "imports"));
    expect(snapshot.source).toEqual({ kind: "sample", uri: "repo-bugfix" });
    expect(snapshot.entrypoint).toBe("SKILL.md");
    await expect(importSkill(
      { kind: "sample", id: "not-allowed" as "repo-bugfix" },
      path.join(root, "bad-imports")
    )).rejects.toMatchObject({ code: "UNKNOWN_SAMPLE" });
  });

  it("requires an unambiguous contained regular SKILL.md entrypoint", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source");
    await mkdirSkill(source);
    await mkdirSkill(path.join(source, "nested"), "# Nested\n");
    await expect(importSkill({ kind: "local", path: source }, path.join(root, "ambiguous")))
      .rejects.toMatchObject({
        code: "ENTRYPOINT_REQUIRED",
        details: { candidates: ["SKILL.md", "nested/SKILL.md"] }
      });
    const accepted = await importSkill(
      { kind: "local", path: source, entrypoint: "nested/SKILL.md" },
      path.join(root, "accepted")
    );
    expect(accepted.entrypoint).toBe("nested/SKILL.md");

    for (const entrypoint of ["../SKILL.md", "/SKILL.md", "nested", "nested\\SKILL.md", "missing/SKILL.md"]) {
      await expect(importSkill(
        { kind: "local", path: source, entrypoint },
        path.join(root, `invalid-${Math.random()}`)
      )).rejects.toMatchObject({ code: "INVALID_ENTRYPOINT" });
    }
  });

  it("uses unknown for missing license, sorted manifests, and content identity independent of publication root", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source");
    await mkdirSkill(source);
    await writeFile(path.join(source, "z.txt"), "z");
    await writeFile(path.join(source, "a.txt"), "a");
    const first = await importSkill({ kind: "local", path: source }, path.join(root, "imports-a"));
    const second = await importSkill({ kind: "local", path: source }, path.join(root, "imports-b"));
    expect(first.license).toBe("unknown");
    expect(first.files.map((file) => file.path)).toEqual(["SKILL.md", "a.txt", "z.txt"]);
    expect(first.source_hash).toBe(second.source_hash);
    expect(first).not.toHaveProperty("contract_ref");
  });

  it("publishes concurrently without clobbering and verifies an existing snapshot", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source");
    const imports = path.join(root, "imports");
    await mkdirSkill(source);
    const snapshots = await Promise.all(Array.from({ length: 6 }, () => (
      importSkill({ kind: "local", path: source }, imports)
    )));
    expect(new Set(snapshots.map((snapshot) => snapshot.source_hash)).size).toBe(1);
    expect(await readdir(imports)).toEqual([snapshots[0]!.source_hash]);

    await chmod(path.join(snapshots[0]!.imported_path, "SKILL.md"), 0o644);
    await writeFile(path.join(snapshots[0]!.imported_path, "SKILL.md"), "tampered");
    await expect(importSkill({ kind: "local", path: source }, imports))
      .rejects.toMatchObject({ code: "SNAPSHOT_MISMATCH" });
  });

  it("rejects an existing snapshot whose accepted files became writable", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source");
    const imports = path.join(root, "imports");
    await mkdirSkill(source);
    const snapshot = await importSkill({ kind: "local", path: source }, imports);
    await chmod(path.join(snapshot.imported_path, "SKILL.md"), 0o644);
    await expect(importSkill({ kind: "local", path: source }, imports))
      .rejects.toMatchObject({ code: "SNAPSHOT_MISMATCH" });
  });

  it("rejects a symlinked imports root", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source");
    const realImports = path.join(root, "real-imports");
    await mkdirSkill(source);
    await mkdir(realImports);
    await symlink(realImports, path.join(root, "linked-imports"));
    await expect(importSkill(
      { kind: "local", path: source }, path.join(root, "linked-imports")
    )).rejects.toMatchObject({ code: "IMPORTS_ROOT_INVALID" });
  });

  it("rejects a symlinked imports-root ancestor before creating descendants", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source");
    const actualParent = path.join(root, "actual-import-parent");
    await mkdirSkill(source);
    await mkdir(actualParent);
    await symlink(actualParent, path.join(root, "linked-import-parent"));
    await expect(importSkill(
      { kind: "local", path: source }, path.join(root, "linked-import-parent", "missing", "imports")
    )).rejects.toMatchObject({ code: "IMPORTS_ROOT_INVALID" });
    await expect(lstat(path.join(actualParent, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("wraps invalid roots and staging creation failures without leaking paths", async () => {
    const root = await temporaryRoot("private-publication-");
    const source = path.join(root, "source");
    await mkdirSkill(source);
    const invalidRoot = path.join(root, "invalid-root");
    await writeFile(invalidRoot, "not a directory");
    await expect(importSkill({ kind: "local", path: source }, invalidRoot))
      .rejects.toMatchObject({ code: "IMPORTS_ROOT_INVALID", details: {} });

    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const unwritableRoot = path.join(root, "unwritable-root");
      await mkdir(unwritableRoot, { mode: 0o555 });
      try {
        await expect(importSkill({ kind: "local", path: source }, unwritableRoot))
          .rejects.toMatchObject({ code: "PUBLICATION_FAILED", details: {} });
        expect((await readdir(unwritableRoot)).filter((name) => name.startsWith(".stage-"))).toEqual([]);
      } finally {
        await chmod(unwritableRoot, 0o755);
      }
    }
  });

  it("keeps ImportInspectionError details free of original absolute paths", async () => {
    const root = await temporaryRoot("private-source-name-");
    const missing = path.join(root, "secret", "missing");
    try {
      await importSkill({ kind: "local", path: missing }, path.join(root, "imports"));
      throw new Error("expected import to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ImportInspectionError);
      const inspectionError = error as ImportInspectionError;
      expect(inspectionError.code).toBe("SOURCE_UNAVAILABLE");
      expect(JSON.stringify(inspectionError.details)).not.toContain(root);
      expect(inspectionError.message).not.toContain(root);
    }
  });
});
