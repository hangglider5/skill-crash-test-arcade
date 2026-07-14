import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RunEnvelope, TraceEvent } from "../../src/protocol/index.js";
import { RunStore } from "../../src/arena/run-store.js";

const temporaryRoots: string[] = [];
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

async function createTemporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function validRunEnvelope(runId: string): RunEnvelope {
  return {
    schema: "arena.run/v1",
    run_id: runId,
    run_group_id: "group_01",
    trial_index: 0,
    manifest_hash: hashA,
    snapshot_hash: hashB,
    fixture_hash: hashC,
    runner: { adapter: "codex-cli", model: "gpt-5.6" },
    state: "created",
    started_at: "2026-07-14T08:00:00.000Z"
  };
}

function validEvent(runId: string, seq: number): TraceEvent {
  return {
    v: 1,
    run_id: runId,
    seq,
    phase: "preflight",
    kind: "phase.entered",
    actor: "arena",
    data: {},
    artifacts: []
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("RunStore", () => {
  it("creates the run envelope and an empty Trace on disk", async () => {
    const root = await createTemporaryRoot("scta-runs-");
    const store = new RunStore(root);
    const envelope = validRunEnvelope("run_01");

    await store.create(envelope);

    expect(JSON.parse(await readFile(path.join(root, "run_01", "run.json"), "utf8")))
      .toEqual(envelope);
    expect(await readFile(path.join(root, "run_01", "trace.jsonl"), "utf8"))
      .toBe("");
  });

  it("rejects a non-contiguous Trace sequence", async () => {
    const root = await createTemporaryRoot("scta-runs-");
    const store = new RunStore(root);
    await store.create(validRunEnvelope("run_01"));
    await store.appendEvent("run_01", validEvent("run_01", 0));

    await expect(store.appendEvent("run_01", validEvent("run_01", 2)))
      .rejects.toThrow("expected seq 1, received 2");
  });

  it("serializes concurrent appends and reads parsed events", async () => {
    const root = await createTemporaryRoot("scta-runs-");
    const store = new RunStore(root);
    await store.create(validRunEnvelope("run_01"));

    await Promise.all([
      store.appendEvent("run_01", validEvent("run_01", 0)),
      store.appendEvent("run_01", validEvent("run_01", 1))
    ]);

    expect((await store.readEvents("run_01")).map(({ seq }) => seq)).toEqual([0, 1]);
    const lines = (await readFile(path.join(root, "run_01", "trace.jsonl"), "utf8"))
      .trimEnd()
      .split("\n");
    expect(lines).toHaveLength(2);
  });

  it("rejects an event belonging to another run", async () => {
    const root = await createTemporaryRoot("scta-runs-");
    const store = new RunStore(root);
    await store.create(validRunEnvelope("run_01"));

    await expect(store.appendEvent("run_01", validEvent("run_02", 0)))
      .rejects.toThrow("event run_id run_02 does not match run_01");
  });

  it("writes only allowlisted JSON records under an existing run", async () => {
    const root = await createTemporaryRoot("scta-runs-");
    const store = new RunStore(root);
    await store.create(validRunEnvelope("run_01"));
    const diagnosis = { schema: "arena.diagnosis/v1", evidence_refs: ["event:0"] };

    await store.writeRecord("run_01", "diagnosis.json", diagnosis);

    expect(JSON.parse(
      await readFile(path.join(root, "run_01", "diagnosis.json"), "utf8")
    )).toEqual(diagnosis);
    await expect(store.writeRecord(
      "run_01",
      "../outside.json" as "verdict.json",
      {}
    )).rejects.toThrow("Unsupported run record: ../outside.json");
  });

  it("rejects run identifiers that escape the configured root", async () => {
    const root = await createTemporaryRoot("scta-runs-");
    const store = new RunStore(root);
    const escapedName = `${path.basename(root)}-escaped`;

    await expect(store.create(validRunEnvelope(`../${escapedName}`)))
      .rejects.toThrow("Invalid run id");
    await expect(access(path.join(root, "..", escapedName))).rejects.toThrow();
  });
});
