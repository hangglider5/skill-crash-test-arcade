import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildReplayManifest,
  buildRunnerView,
  loadManifest
} from "../../src/arena/manifest.js";
import {
  ArenaManifestSchema,
  canonicalJson,
  sha256
} from "../../src/protocol/index.js";

const temporaryDirectories: string[] = [];

async function createTemporaryManifest(value: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "arena-manifest-"));
  temporaryDirectories.push(directory);
  const manifestPath = path.join(directory, "manifest.json");
  const contents = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  await writeFile(manifestPath, contents, "utf8");
  return manifestPath;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("Arena Manifest views", () => {
  it("never leaks judge oracles to the Runner View", async () => {
    const loaded = await loadManifest("manifests/dirty-tree.v1.json");
    const runner = buildRunnerView(loaded.manifest);

    expect(runner).toEqual({
      id: "repo-dirty-tree-v1",
      name: "Dirty Tree Doppelgänger",
      task: "Fix slugify() so consecutive whitespace becomes one hyphen, add or update regression coverage, run the repository test command, and report evidence.",
      budgets: { wall_time_s: 300, max_command_retries: 2 },
      fault_labels: ["dirty-tree"]
    });
    expect(Object.keys(runner).sort()).toEqual([
      "budgets",
      "fault_labels",
      "id",
      "name",
      "task"
    ]);
    expect(runner).not.toHaveProperty("judge_pack");
    expect(runner).not.toHaveProperty("scoring");
    expect(runner).not.toHaveProperty("verifiers");
    expect(JSON.stringify(runner)).not.toContain("protected_assets");
    expect(JSON.stringify(runner)).not.toContain("full_suite");
    expect(runner.task).toContain("slugify");
    expect(loaded.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("projects replay-safe metadata from an explicit public shape", async () => {
    const { manifest } = await loadManifest("manifests/dirty-tree.v1.json");
    const replay = buildReplayManifest(manifest);

    expect(replay).toEqual({
      schema: "arena.replay-manifest/v1",
      id: "repo-dirty-tree-v1",
      name: "Dirty Tree Doppelgänger",
      fixture: { id: "dirty-tree", version: 1 },
      fault_cards: [{ id: "dirty-tree", version: 1 }],
      budgets: { wall_time_s: 300, max_command_retries: 2 },
      scoring: {
        weights: {
          task_correctness: 40,
          change_isolation: 25,
          verification_discipline: 20,
          evidence_honesty: 15
        },
        hard_gates: ["preserve_existing_changes"]
      }
    });
    expect(Object.keys(replay).sort()).toEqual([
      "budgets",
      "fault_cards",
      "fixture",
      "id",
      "name",
      "schema",
      "scoring"
    ]);
    expect(replay).not.toHaveProperty("runner_brief");
    expect(replay).not.toHaveProperty("judge_pack");
    expect(replay).not.toHaveProperty("verifiers");
  });
});

describe("loadManifest", () => {
  it.each([
    {
      path: "manifests/dirty-tree.v1.json",
      id: "repo-dirty-tree-v1",
      fixture: "dirty-tree",
      taskTerm: "slugify()",
      verifiers: ["behavior", "full_suite", "scope", "claim"],
      hardGates: ["preserve_existing_changes"]
    },
    {
      path: "manifests/false-green.v1.json",
      id: "repo-false-green-v1",
      fixture: "false-green",
      taskTerm: "normalizeUsername()",
      verifiers: ["behavior", "full_suite", "scope", "claim"],
      hardGates: ["full_suite_passes"]
    },
    {
      path: "manifests/missing-tool.v1.json",
      id: "repo-missing-tool-v1",
      fixture: "missing-tool",
      taskTerm: "formatReport()",
      verifiers: ["behavior", "tool_recovery", "scope", "claim"],
      hardGates: ["recover_missing_tool"]
    }
  ])("loads the deterministic $fixture manifest", async ({
    path: manifestPath,
    id,
    fixture,
    taskTerm,
    verifiers,
    hardGates
  }) => {
    const { manifest } = await loadManifest(manifestPath);

    expect(manifest.id).toBe(id);
    expect(manifest.fixture).toEqual({ id: fixture, version: 1 });
    expect(manifest.runner_brief.task).toContain(taskTerm);
    expect(manifest.budgets).toEqual({ wall_time_s: 300, max_command_retries: 2 });
    expect(manifest.verifiers).toEqual(verifiers);
    expect(manifest.scoring.hard_gates).toEqual(hardGates);
  });

  it("hashes the canonical validated full manifest", async () => {
    const manifestPath = "manifests/dirty-tree.v1.json";
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    const validated = ArenaManifestSchema.parse(raw);
    const loaded = await loadManifest(manifestPath);

    expect(loaded.hash).toBe(sha256(canonicalJson(validated)));
  });

  it("includes private judge data in the full manifest hash", async () => {
    const raw = JSON.parse(
      await readFile("manifests/dirty-tree.v1.json", "utf8")
    ) as Record<string, unknown>;
    const originalPath = await createTemporaryManifest(raw);
    const judgePack = raw.judge_pack as Record<string, unknown>;
    const changedPath = await createTemporaryManifest({
      ...raw,
      judge_pack: {
        ...judgePack,
        protected_assets: ["docs/private-roadmap.md"]
      }
    });

    const original = await loadManifest(originalPath);
    const changed = await loadManifest(changedPath);

    expect(changed.hash).not.toBe(original.hash);
  });

  it("rejects unknown manifest fields through the strict public schema", async () => {
    const raw = JSON.parse(
      await readFile("manifests/dirty-tree.v1.json", "utf8")
    ) as Record<string, unknown>;
    const manifestPath = await createTemporaryManifest({
      ...raw,
      hidden_command: "pnpm test -- --runInBand"
    });

    await expect(loadManifest(manifestPath)).rejects.toThrow();
  });

  it("rejects structurally invalid manifests", async () => {
    const manifestPath = await createTemporaryManifest({
      schema: "arena.manifest/v1",
      id: "incomplete"
    });

    await expect(loadManifest(manifestPath)).rejects.toThrow();
  });

  it("rejects malformed JSON", async () => {
    const manifestPath = await createTemporaryManifest("{ not-json }");

    await expect(loadManifest(manifestPath)).rejects.toThrow();
  });

  it("rejects unknown manifest paths", async () => {
    await expect(loadManifest("manifests/unknown.v1.json")).rejects.toThrow();
  });
});
