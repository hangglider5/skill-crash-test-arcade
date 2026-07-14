import path from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  lstatTarget: "",
  descriptorTarget: "",
  appendBytes: Buffer.alloc(0),
  lstatTriggered: false,
  descriptorTriggered: false,
  readFileBytes: 0
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stats = await actual.lstat(...args);
      if (!race.lstatTriggered && String(args[0]) === race.lstatTarget) {
        race.lstatTriggered = true;
        await actual.appendFile(race.lstatTarget, race.appendBytes);
      }
      return stats;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]) !== race.descriptorTarget) {
        return handle;
      }
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "stat") {
            return async () => {
              const stats = await target.stat();
              if (!race.descriptorTriggered) {
                race.descriptorTriggered = true;
                await actual.appendFile(race.descriptorTarget, race.appendBytes);
              }
              return stats;
            };
          }
          if (property === "readFile") {
            return async () => {
              const data = await target.readFile();
              race.readFileBytes = data.byteLength;
              return data;
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
  };
});

import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
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
  race.lstatTarget = "";
  race.descriptorTarget = "";
  race.appendBytes = Buffer.alloc(0);
  race.lstatTriggered = false;
  race.descriptorTriggered = false;
  race.readFileBytes = 0;
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

      race.lstatTarget = changing;
      race.appendBytes = Buffer.alloc(2);

      await expect(importSkill({ kind: "local", path: source }, path.join(root, "imports")))
        .rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE", details: { path: "c.bin" } });
      expect(race.lstatTriggered).toBe(true);
    } finally {
      await makeDirectoriesRemovable(root);
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("stable bounded ZIP source reads", () => {
  it("rejects descriptor growth without reading beyond the initially opened size", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-zip-source-race-")));
    try {
      const archive = path.join(root, "skill.zip");
      const initial = Buffer.from(zipSync({ "SKILL.md": strToU8("# Skill\n") }));
      await writeFile(archive, initial);

      race.descriptorTarget = archive;
      race.appendBytes = Buffer.from("xyz");

      await expect(importSkill({ kind: "zip", path: archive }, path.join(root, "imports")))
        .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      expect(race.descriptorTriggered).toBe(true);
      expect((await stat(archive)).size).toBe(initial.byteLength + 3);
      expect(race.readFileBytes).toBe(0);
    } finally {
      await makeDirectoriesRemovable(root);
      await rm(root, { recursive: true, force: true });
    }
  });
});
