import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256, type ArtifactRef } from "../../src/protocol/index.js";
import { ArtifactStore } from "../../src/arena/artifact-store.js";

const temporaryRoots: string[] = [];

async function createTemporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("ArtifactStore", () => {
  it("stores identical content once by sha256", async () => {
    const root = await createTemporaryRoot("scta-artifacts-");
    const store = new ArtifactStore(root);
    const first = await store.put(Buffer.from("evidence"), {
      mime: "text/plain",
      redacted: true
    });
    const second = await store.put(Buffer.from("evidence"), {
      mime: "text/plain",
      redacted: true
    });

    expect(first.ref).toBe(second.ref);
    expect((await store.read(first.ref)).toString()).toBe("evidence");

    const digest = sha256("evidence");
    expect(first).toEqual({
      ref: `sha256:${digest}`,
      sha256: digest,
      bytes: 8,
      mime: "text/plain",
      redacted: true
    });
    expect((await readdir(root)).sort()).toEqual([
      digest,
      `${digest}.json`
    ]);
    expect(JSON.parse(await readFile(path.join(root, `${digest}.json`), "utf8")))
      .toEqual(first);
  });

  it("deduplicates concurrent writes without leaving temporary files", async () => {
    const root = await createTemporaryRoot("scta-artifacts-");
    const store = new ArtifactStore(root);

    const records = await Promise.all(Array.from({ length: 4 }, async () => {
      return store.put(Buffer.from("shared"), {
        mime: "text/plain",
        redacted: false
      });
    }));

    expect(new Set(records.map(({ ref }) => ref))).toEqual(
      new Set([`sha256:${sha256("shared")}`])
    );
    expect((await readdir(root)).sort()).toEqual([
      sha256("shared"),
      `${sha256("shared")}.json`
    ]);
  });

  it("rejects conflicting metadata for immutable content", async () => {
    const root = await createTemporaryRoot("scta-artifacts-");
    const store = new ArtifactStore(root);
    const data = Buffer.from("evidence");
    const first = await store.put(data, { mime: "text/plain", redacted: true });

    await expect(store.put(data, { mime: "text/plain", redacted: false }))
      .rejects.toThrow(`metadata mismatch for ${first.ref}`);
  });

  it("rejects malformed references before resolving a filesystem path", async () => {
    const root = await createTemporaryRoot("scta-artifacts-");
    const store = new ArtifactStore(root);
    const malformed = "sha256:../outside" as ArtifactRef;

    await expect(store.read(malformed)).rejects.toThrow("Invalid artifact reference");
  });
});
