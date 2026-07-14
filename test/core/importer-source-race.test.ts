import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  target: "",
  appendBytes: Buffer.alloc(0),
  triggered: false
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stats = await actual.lstat(...args);
      if (!race.triggered && String(args[0]) === race.target) {
        race.triggered = true;
        await actual.appendFile(race.target, race.appendBytes);
      }
      return stats;
    }
  };
});

import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { importSkill } from "../../src/core/importer.js";

const MiB = 1024 * 1024;

async function makeDirectoriesRemovable(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await makeDirectoriesRemovable(path.join(directory, entry.name));
    }
  }
  await chmod(directory, 0o700).catch(() => undefined);
}

afterEach(async () => {
  race.target = "";
  race.appendBytes = Buffer.alloc(0);
  race.triggered = false;
});

describe("stable bounded local file reads", () => {
  it("rejects growth between traversal lstat and descriptor open before exceeding the aggregate cap", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-source-race-")));
    const source = path.join(root, "source");
    try {
      await mkdir(source);
      const skill = "# Skill\n";
      await writeFile(path.join(source, "SKILL.md"), skill);
      await writeFile(path.join(source, "a.bin"), Buffer.alloc(2 * MiB));
      await writeFile(path.join(source, "b.bin"), Buffer.alloc(2 * MiB));
      const changing = path.join(source, "c.bin");
      await writeFile(changing, Buffer.alloc(MiB - Buffer.byteLength(skill) - 1));

      race.target = changing;
      race.appendBytes = Buffer.alloc(2);

      await expect(importSkill({ kind: "local", path: source }, path.join(root, "imports")))
        .rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE", details: { path: "c.bin" } });
      expect(race.triggered).toBe(true);
    } finally {
      await makeDirectoriesRemovable(root);
      await rm(root, { recursive: true, force: true });
    }
  });
});
