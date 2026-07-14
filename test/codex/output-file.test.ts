import { appendFile, link, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  OutputFileError,
  readOwnedOutputFile,
  validateOwnedOutputPath
} from "../../src/codex/output-file.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("owned Codex output", () => {
  it("rejects an output hard-linked to the schema after ownership validation", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-output-")));
    roots.push(root);
    const schema = path.join(root, "schema.json");
    const output = path.join(root, "output.json");
    await writeFile(schema, "{}");
    const owned = await validateOwnedOutputPath(root, output, schema);
    await link(schema, output);
    await expect(readOwnedOutputFile(owned, 1024)).rejects.toBeInstanceOf(OutputFileError);
  });

  it("rejects a file that grows while its bounded descriptor is being read", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-output-")));
    roots.push(root);
    const schema = path.join(root, "schema.json");
    const output = path.join(root, "output.json");
    await writeFile(schema, "{}");
    const owned = await validateOwnedOutputPath(root, output, schema);
    await writeFile(output, Buffer.alloc(8 * 1024 * 1024, 32));

    let stopped = false;
    const append = async () => {
      while (!stopped) {
        await appendFile(output, "x");
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    const growing = append();
    try {
      await expect(readOwnedOutputFile(owned, 16 * 1024 * 1024)).rejects.toBeInstanceOf(OutputFileError);
    } finally {
      stopped = true;
      await growing;
    }
  });
});
