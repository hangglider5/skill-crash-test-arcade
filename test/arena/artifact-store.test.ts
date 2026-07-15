import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
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

  it("reads the verified metadata record without exposing artifact bytes", async () => {
    const root = await createTemporaryRoot("scta-artifacts-");
    const store = new ArtifactStore(root);
    const stored = await store.put(Buffer.from("private diff bytes"), {
      mime: "text/x-diff",
      redacted: true
    });

    await expect(store.stat(stored.ref)).resolves.toEqual(stored);
  });

  it("rejects sidecar MIME and redaction tampering despite intact identity fields", async () => {
    const root = await createTemporaryRoot("scta-artifacts-");
    const store = new ArtifactStore(root);
    const stored = await store.put(Buffer.from("private diff bytes"), {
      mime: "text/x-diff",
      redacted: true
    });
    await writeFile(path.join(root, `${stored.sha256}.json`), JSON.stringify({
      ...stored,
      mime: "text/plain",
      redacted: false
    }));

    await expect(store.stat(stored.ref)).rejects.toThrow(/metadata.*mismatch/i);
  });

  it("rejects a sidecar replaced by a symbolic link", async () => {
    const root = await createTemporaryRoot("scta-artifacts-");
    const outside = await createTemporaryRoot("scta-artifacts-outside-");
    const store = new ArtifactStore(root);
    const stored = await store.put(Buffer.from("private diff bytes"), {
      mime: "text/x-diff",
      redacted: true
    });
    const sidecar = path.join(root, `${stored.sha256}.json`);
    const outsideSidecar = path.join(outside, "metadata.json");
    await writeFile(outsideSidecar, JSON.stringify(stored));
    await rm(sidecar);
    await symlink(outsideSidecar, sidecar);

    await expect(store.stat(stored.ref)).rejects.toThrow();
  });

  it("does not let a fresh store instance claim authority from an old sidecar", async () => {
    const root = await createTemporaryRoot("scta-artifacts-");
    const writer = new ArtifactStore(root);
    const stored = await writer.put(Buffer.from("private diff bytes"), {
      mime: "text/x-diff",
      redacted: true
    });

    await expect(new ArtifactStore(root).stat(stored.ref))
      .rejects.toThrow(/not authorized/i);
    await expect(writer.stat(stored.ref)).resolves.toEqual(stored);
  });

  it("rejects unbounded metadata before publishing artifact bytes", async () => {
    const root = await createTemporaryRoot("scta-artifacts-");
    const store = new ArtifactStore(root);

    await expect(store.put(Buffer.from("evidence"), {
      mime: "x".repeat(257),
      redacted: false
    })).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
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

  it("atomically chooses one metadata record across store instances", async () => {
    const root = await createTemporaryRoot("scta-artifacts-");
    const data = Buffer.from("shared across instances");
    const attempts = await Promise.allSettled([
      new ArtifactStore(root).put(data, {
        mime: "text/plain",
        redacted: false
      }),
      new ArtifactStore(root).put(data, {
        mime: "application/octet-stream",
        redacted: true
      })
    ]);

    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const winner = fulfilled[0];
    expect(winner?.status).toBe("fulfilled");
    if (winner?.status !== "fulfilled") {
      throw new Error("Expected one metadata writer to succeed");
    }
    const digest = sha256(data);
    expect(JSON.parse(await readFile(path.join(root, `${digest}.json`), "utf8")))
      .toEqual(winner.value);
  });

  it("rejects malformed references before resolving a filesystem path", async () => {
    const root = await createTemporaryRoot("scta-artifacts-");
    const store = new ArtifactStore(root);
    const malformed = "sha256:../outside" as ArtifactRef;

    await expect(store.read(malformed)).rejects.toThrow("Invalid artifact reference");
  });

  it("rejects a digest path that is a symbolic link", async () => {
    const root = await createTemporaryRoot("scta-artifacts-");
    const outside = await createTemporaryRoot("scta-artifacts-outside-");
    const data = Buffer.from("outside evidence");
    const digest = sha256(data);
    const outsidePath = path.join(outside, "evidence.txt");
    await writeFile(outsidePath, data);
    await symlink(outsidePath, path.join(root, digest));
    const store = new ArtifactStore(root);

    await expect(store.read(`sha256:${digest}`)).rejects.toThrow(/symbolic link/i);
  });

  it("rejects a symbolic-link artifact on put instead of trusting its bytes", async () => {
    const root = await createTemporaryRoot("scta-artifacts-");
    const outside = await createTemporaryRoot("scta-artifacts-outside-");
    const data = Buffer.from("expected evidence");
    const digest = sha256(data);
    const outsidePath = path.join(outside, "replacement.txt");
    await writeFile(outsidePath, "replacement");
    await symlink(outsidePath, path.join(root, digest));
    const store = new ArtifactStore(root);

    await expect(store.put(data, { mime: "text/plain", redacted: true }))
      .rejects.toThrow(/symbolic link/i);
  });

  it("rejects corrupted stored bytes when reading an artifact", async () => {
    const root = await createTemporaryRoot("scta-artifacts-");
    const store = new ArtifactStore(root);
    const record = await store.put(Buffer.from("original"), {
      mime: "text/plain",
      redacted: false
    });
    await writeFile(path.join(root, record.sha256), "tampered");

    await expect(store.read(record.ref)).rejects.toThrow(/digest mismatch/i);
  });

  it("rejects corrupted stored bytes on a repeated put", async () => {
    const root = await createTemporaryRoot("scta-artifacts-");
    const store = new ArtifactStore(root);
    const data = Buffer.from("original");
    const record = await store.put(data, {
      mime: "text/plain",
      redacted: false
    });
    await writeFile(path.join(root, record.sha256), "tampered");

    await expect(store.put(data, { mime: "text/plain", redacted: false }))
      .rejects.toThrow(/digest mismatch/i);
  });
});
