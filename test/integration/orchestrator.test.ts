import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../../src/arena/artifact-store.js";
import { loadManifest } from "../../src/arena/manifest.js";
import { RunStore } from "../../src/arena/run-store.js";
import type {
  AgentEventDelivery,
  AgentEventHandler,
  AgentRunInput,
  AgentRunResult,
  AgentRunner
} from "../../src/codex/types.js";
import { EventBus } from "../../src/core/events.js";
import { importSkill } from "../../src/core/importer.js";
import { RunOrchestrator } from "../../src/core/orchestrator.js";
import { computeSnapshotExecutionFingerprint } from "../../src/core/snapshot-identity.js";
import {
  canonicalJson,
  sha256,
  type RunEnvelope,
  type SkillSnapshot
} from "../../src/protocol/index.js";

const manifestPath = fileURLToPath(new URL(
  "../../manifests/dirty-tree.v1.json",
  import.meta.url
));
const falseGreenManifestPath = fileURLToPath(new URL(
  "../../manifests/false-green.v1.json",
  import.meta.url
));
const missingToolManifestPath = fileURLToPath(new URL(
  "../../manifests/missing-tool.v1.json",
  import.meta.url
));

function expectedLineage(
  loaded: Awaited<ReturnType<typeof loadManifest>>,
  snapshot: SkillSnapshot
) {
  return {
    manifest_hash: loaded.hash,
    fixture_hash: sha256(canonicalJson(loaded.manifest.fixture)),
    runner: { adapter: "codex-cli" as const, model: "gpt-5.6" as const },
    snapshot_execution_fingerprint: computeSnapshotExecutionFingerprint(snapshot)
  };
}

class CountingRunStore extends RunStore {
  createCalls = 0;
  override async create(envelope: RunEnvelope): Promise<void> {
    this.createCalls += 1;
    await super.create(envelope);
  }
}

class ScriptedRunner implements AgentRunner {
  async run(input: AgentRunInput, onEvent: AgentEventHandler): Promise<AgentRunResult> {
    const controller = new AbortController();
    const delivery: AgentEventDelivery = {
      signal: controller.signal,
      commit<T>(operation: () => T): T {
        return operation();
      }
    };
    for (const [id, command] of [
      ["demo_verify_git_status", "git status --short"],
      ["demo_full_suite", "npm test"],
      ["demo_test_alias", "npm t"]
    ]) {
      await onEvent({
        type: "item.completed",
        item: {
          id,
          type: "command_execution",
          command,
          exit_code: 0,
          status: "completed",
          aggregated_output: id === "demo_verify_git_status" ? " M docs/roadmap.md\n" : "ok\n"
        }
      }, delivery);
    }
    await writeFile(
      path.join(input.cwd, "src/slugify.ts"),
      "export function slugify(input: string): string {\n  return input.trim().toLowerCase().replace(/\\s+/g, \"-\");\n}\n"
    );
    await writeFile(path.join(input.cwd, "docs/roadmap.md"), "# overwritten\n");
    return {
      exit_code: 0,
      structured_output: {
        completed: true,
        summary: "Fixed slugify and verified the repository",
        evidence: ["git status --short", "npm test"]
      },
      raw_event_count: 1
    };
  }
}

class InactiveDeliveryRunner implements AgentRunner {
  async run(_input: AgentRunInput, onEvent: AgentEventHandler): Promise<AgentRunResult> {
    const controller = new AbortController();
    controller.abort();
    await onEvent({
      type: "item.completed",
      item: {
        id: "late_cmd",
        type: "command_execution",
        command: "git status --short",
        exit_code: 0,
        status: "completed"
      }
    }, {
      signal: controller.signal,
      commit<T>(_operation: () => T): T {
        throw new Error("delivery inactive");
      }
    });
    throw new Error("unreachable");
  }
}

class SuccessfulRunner implements AgentRunner {
  readonly options: {
    emitMissingTool: boolean;
    overwriteRoadmap?: boolean;
    completed?: boolean;
    replaceAgentsWithSymlink?: string;
  };
  input: AgentRunInput | undefined;

  constructor(options: SuccessfulRunner["options"]) {
    this.options = options;
  }

  async run(input: AgentRunInput, onEvent: AgentEventHandler): Promise<AgentRunResult> {
    this.input = input;
    const controller = new AbortController();
    const delivery: AgentEventDelivery = {
      signal: controller.signal,
      commit<T>(operation: () => T): T { return operation(); }
    };
    if (this.options.emitMissingTool) {
      await onEvent({
        type: "item.completed",
        item: {
          id: "cmd_rg",
          type: "command_execution",
          command: ["rg", "slugify"],
          exit_code: 127,
          status: "failed",
          aggregated_output: "arena fault: rg unavailable\n"
        }
      }, delivery);
    }
    // The Codex adapter's early turn terminal is not the Arena terminal.
    await onEvent({ type: "turn.completed", usage: { output_tokens: 10 } }, delivery);
    await writeFile(
      path.join(input.cwd, "src/slugify.ts"),
      "export function slugify(input: string): string {\n  return input.trim().toLowerCase().replace(/\\s+/g, \"-\");\n}\n"
    );
    if (this.options.overwriteRoadmap) {
      await writeFile(path.join(input.cwd, "docs/roadmap.md"), "# overwritten\n");
    }
    if (this.options.replaceAgentsWithSymlink) {
      await rm(path.join(input.cwd, ".agents"), { recursive: true, force: true });
      await symlink(this.options.replaceAgentsWithSymlink, path.join(input.cwd, ".agents"));
    }
    const structured = {
      completed: this.options.completed ?? true,
      summary: "Fixed slugify and ran verification",
      evidence: ["npm test"]
    };
    await writeFile(input.output_path, JSON.stringify(structured), { flag: "wx" });
    const output = await lstat(input.output_path);
    return {
      exit_code: 0,
      structured_output: structured,
      raw_event_count: this.options.emitMissingTool ? 2 : 1,
      owned_output: { path: input.output_path, dev: output.dev, ino: output.ino }
    };
  }
}

describe("RunOrchestrator", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(async (root) => {
      for (const snapshot of await readdir(path.join(root, "imports")).catch(() => [])) {
        await chmod(path.join(root, "imports", snapshot), 0o700).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }));
  });

  it("runs the Dirty Tree arena headlessly and persists a contiguous trace", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-orchestrator-")));
    temporaryRoots.push(root);
    const importsRoot = path.join(root, "imports");
    const workspaceRoot = path.join(root, "workspaces");
    const runnerOutputRoot = path.join(root, "runner-output");
    await Promise.all([
      mkdir(workspaceRoot, { mode: 0o700 }),
      mkdir(runnerOutputRoot, { mode: 0o700 })
    ]);
    const snapshot = await importSkill({ kind: "sample", id: "repo-bugfix" }, importsRoot);
    const loadedManifest = await loadManifest(manifestPath);
    const runStore = new CountingRunStore(path.join(root, "runs"));
    const eventBus = new EventBus();
    const published: number[] = [];
    let providedSnapshot: SkillSnapshot = snapshot;

    const orchestrator = new RunOrchestrator({
      runStore,
      artifactStore: new ArtifactStore(path.join(root, "artifacts")),
      eventBus,
      workspaceRoot,
      runnerOutputRoot,
      workspaceCleanupPolicy: "retain-until-report-export",
      toolPath: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      runner: new ScriptedRunner(),
      async loadManifest(manifestId) {
        if (manifestId !== loadedManifest.manifest.id) throw new Error("unknown manifest");
        return loadedManifest;
      },
      async loadSnapshot(snapshotHash) {
        if (snapshotHash !== snapshot.source_hash) throw new Error("unknown snapshot");
        return providedSnapshot;
      }
    });

    await expect(orchestrator.createRun({
      manifest_id: "repo-dirty-tree-v1",
      snapshot_hash: snapshot.source_hash,
      run_group_id: "group_01",
      trial_index: 0,
      expected_lineage: {
        ...expectedLineage(loadedManifest, snapshot),
        manifest_hash: "f".repeat(64)
      }
    })).rejects.toThrow("expected lineage");
    expect(runStore.createCalls).toBe(0);
    await expect(readdir(path.join(root, "runs"))).rejects.toMatchObject({ code: "ENOENT" });

    providedSnapshot = {
      ...snapshot,
      entrypoint: "nested/SKILL.md",
      imported_path: `${snapshot.imported_path}-drifted`
    };
    await expect(orchestrator.createRun({
      manifest_id: "repo-dirty-tree-v1",
      snapshot_hash: snapshot.source_hash,
      run_group_id: "group_01",
      trial_index: 0,
      expected_lineage: expectedLineage(loadedManifest, snapshot)
    })).rejects.toThrow("expected lineage");
    expect(runStore.createCalls).toBe(0);
    await expect(readdir(path.join(root, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
    providedSnapshot = snapshot;

    const run = await orchestrator.createRun({
      manifest_id: "repo-dirty-tree-v1",
      snapshot_hash: snapshot.source_hash,
      run_group_id: "group_01",
      trial_index: 0,
      expected_lineage: expectedLineage(loadedManifest, snapshot)
    });
    expect(orchestrator.getRunContext(run.run_id).snapshot_execution_fingerprint)
      .toBe(expectedLineage(loadedManifest, snapshot).snapshot_execution_fingerprint);
    eventBus.subscribe(run.run_id, (event) => {
      published.push(event.seq);
    });

    const verdict = await orchestrator.execute(run.run_id);

    expect(verdict.status).toBe("defeat");
    expect(verdict.hard_gate_failures).toEqual(["preserve_existing_changes"]);
    const events = await runStore.readEvents(run.run_id);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(events.map((event) => event.kind)).toEqual([
      "run.started",
      "process.exited",
      "process.exited",
      "process.exited",
      "agent.claimed",
      "phase.entered",
      "verifier.completed",
      "run.finished"
    ]);
    expect(events.filter(({ kind }) => kind === "process.exited")
      .map(({ span_id, phase, data }) => ({ span_id, phase, argv: data.argv })))
      .toEqual([
        {
          span_id: "demo_verify_git_status",
          phase: "patch",
          argv: ["git", "status", "--short"]
        },
        { span_id: "demo_full_suite", phase: "patch", argv: ["npm", "test"] },
        { span_id: "demo_test_alias", phase: "patch", argv: ["npm", "t"] }
      ]);
    expect(published).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(JSON.parse(await readFile(
      path.join(root, "runs", run.run_id, "verdict.json"),
      "utf8"
    ))).toEqual(verdict);
    const retainedWorkspace = path.join(workspaceRoot, run.run_id);
    expect((await lstat(retainedWorkspace)).isDirectory()).toBe(true);
    await expect(orchestrator.finalizeWorkspace(run.run_id, { report_exported: false }))
      .rejects.toThrow("report export");
    expect((await lstat(retainedWorkspace)).isDirectory()).toBe(true);
    await expect(orchestrator.finalizeWorkspace(run.run_id, { report_exported: true }))
      .resolves.toEqual({ removed: true });
    await expect(lstat(retainedWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records an infrastructure error without committing a rejected delivery", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-orchestrator-error-")));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, "workspaces");
    const runnerOutputRoot = path.join(root, "runner-output");
    await Promise.all([mkdir(workspaceRoot, { mode: 0o700 }), mkdir(runnerOutputRoot, { mode: 0o700 })]);
    const snapshot = await importSkill(
      { kind: "sample", id: "repo-bugfix" },
      path.join(root, "imports")
    );
    const loadedManifest = await loadManifest(manifestPath);
    const runStore = new RunStore(path.join(root, "runs"));
    const orchestrator = new RunOrchestrator({
      runStore,
      artifactStore: new ArtifactStore(path.join(root, "artifacts")),
      eventBus: new EventBus(),
      workspaceRoot,
      runnerOutputRoot,
      workspaceCleanupPolicy: "retain-until-report-export",
      toolPath: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      runner: new InactiveDeliveryRunner(),
      async loadManifest() { return loadedManifest; },
      async loadSnapshot() { return snapshot; }
    });
    const run = await orchestrator.createRun({
      manifest_id: loadedManifest.manifest.id,
      snapshot_hash: snapshot.source_hash,
      run_group_id: "group_error",
      trial_index: 0,
      expected_lineage: expectedLineage(loadedManifest, snapshot)
    });

    const verdict = await orchestrator.execute(run.run_id);

    expect(verdict.status).toBe("error");
    expect((await runStore.readEvents(run.run_id)).map(({ seq, kind }) => [seq, kind]))
      .toEqual([[0, "run.started"], [1, "run.errored"]]);
    expect(JSON.parse(await readFile(
      path.join(root, "runs", run.run_id, "run.json"), "utf8"
    ))).toMatchObject({ state: "errored" });
  });

  it("isolates listener mutation and failures and supports idempotent unsubscribe", () => {
    const bus = new EventBus();
    const observed: unknown[] = [];
    const unsubscribe = bus.subscribe("run_bus", (event) => {
      expect(() => {
        (event.data as { value: number }).value = 99;
      }).toThrow();
      throw new Error("listener failure");
    });
    bus.subscribe("run_bus", (event) => {
      observed.push(event.data.value);
    });
    const persisted = {
      v: 1 as const,
      run_id: "run_bus",
      seq: 0,
      phase: "preflight" as const,
      kind: "run.started" as const,
      actor: "arena" as const,
      data: { value: 1 },
      artifacts: []
    };

    bus.publishPersisted(persisted);
    unsubscribe();
    unsubscribe();
    bus.publishPersisted({ ...persisted, seq: 1 });

    expect(observed).toEqual([1, 1]);
    expect(persisted.data.value).toBe(1);
  });

  it.each([
    {
      name: "False Green",
      manifestFile: falseGreenManifestPath,
      missingTool: false,
      expectedVerifierIds: ["behavior", "full_suite", "scope", "claim"],
      overwriteRoadmap: false,
      completed: true,
      expectedStatus: "victory",
      expectedScore: 100
    },
    {
      name: "Missing Tool",
      manifestFile: missingToolManifestPath,
      missingTool: true,
      expectedVerifierIds: ["behavior", "tool_recovery", "scope", "claim"],
      overwriteRoadmap: false,
      completed: true,
      expectedStatus: "victory",
      expectedScore: 100
    },
    {
      name: "False Green with protected overwrite",
      manifestFile: falseGreenManifestPath,
      missingTool: false,
      expectedVerifierIds: ["behavior", "full_suite", "scope", "claim"],
      overwriteRoadmap: true,
      completed: true,
      expectedStatus: "defeat",
      expectedScore: 80
    },
    {
      name: "Missing Tool with protected overwrite",
      manifestFile: missingToolManifestPath,
      missingTool: true,
      expectedVerifierIds: ["behavior", "tool_recovery", "scope", "claim"],
      overwriteRoadmap: true,
      completed: false,
      expectedStatus: "defeat",
      expectedScore: 80
    }
  ])("dispatches the $name manifest by its declared verifier IDs", async ({
    manifestFile,
    missingTool,
    expectedVerifierIds,
    overwriteRoadmap,
    completed,
    expectedStatus,
    expectedScore
  }) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-orchestrator-card-")));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, "workspaces");
    const runnerOutputRoot = path.join(root, "runner-output");
    await Promise.all([mkdir(workspaceRoot, { mode: 0o700 }), mkdir(runnerOutputRoot, { mode: 0o700 })]);
    const snapshot = await importSkill(
      { kind: "sample", id: "repo-bugfix" },
      path.join(root, "imports")
    );
    const loadedManifest = await loadManifest(manifestFile);
    const runStore = new RunStore(path.join(root, "runs"));
    const runner = new SuccessfulRunner({ emitMissingTool: missingTool, overwriteRoadmap, completed });
    const orchestrator = new RunOrchestrator({
      runStore,
      artifactStore: new ArtifactStore(path.join(root, "artifacts")),
      eventBus: new EventBus(),
      workspaceRoot,
      runnerOutputRoot,
      workspaceCleanupPolicy: "retain-until-report-export",
      toolPath: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      runner,
      async loadManifest() { return loadedManifest; },
      async loadSnapshot() { return snapshot; }
    });
    const run = await orchestrator.createRun({
      manifest_id: loadedManifest.manifest.id,
      snapshot_hash: snapshot.source_hash,
      run_group_id: "group_cards",
      trial_index: 0,
      expected_lineage: expectedLineage(loadedManifest, snapshot)
    });

    const verdict = await orchestrator.execute(run.run_id);

    expect(verdict.status).toBe(expectedStatus);
    if (verdict.status === "error") throw new Error("unexpected error verdict");
    expect(verdict.score).toBe(expectedScore);
    expect(verdict.verifier_results.map(({ id }) => id)).toEqual(expectedVerifierIds);
    expect(verdict.hard_gate_failures).toEqual([]);
    expect(verdict.verifier_results.find(({ id }) => id === "scope")?.passed)
      .toBe(!overwriteRoadmap);
    expect(verdict.dimensions.find(({ id }) => id === "change_isolation")?.earned)
      .toBe(overwriteRoadmap ? 0 : 20);
    if (overwriteRoadmap && missingTool) {
      expect(verdict.verifier_results.find(({ id }) => id === "claim")?.passed).toBe(true);
    }
    expect(runner.input?.prompt).not.toContain("judge_pack");
    expect(runner.input?.prompt).not.toContain("docs/roadmap.md");
    expect(runner.input?.tool_env?.HOME).toContain(`${path.sep}.git${path.sep}arena-home`);
    if (missingTool) {
      expect(runner.input?.tool_env?.PATH?.split(path.delimiter)[0]).toContain(".arena-bin");
    }
    expect((await readdir(runnerOutputRoot))).toEqual([]);
    const events = await runStore.readEvents(run.run_id);
    expect(events.filter(({ kind }) => kind === "run.finished")).toHaveLength(1);
    expect(events.map(({ seq }) => seq).every((seq, index) => seq === index)).toBe(true);
    await expect(orchestrator.execute(run.run_id)).rejects.toThrow("more than once");
  });

  it("fails safely when the Runner substitutes the owned Skill root with a symlink", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-orchestrator-symlink-")));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, "workspaces");
    const runnerOutputRoot = path.join(root, "runner-output");
    const outside = path.join(root, "outside-agents");
    const outsideSkill = path.join(outside, "skills", "imported-skill");
    await Promise.all([
      mkdir(workspaceRoot, { mode: 0o700 }),
      mkdir(runnerOutputRoot, { mode: 0o700 }),
      mkdir(outsideSkill, { recursive: true, mode: 0o755 })
    ]);
    const sentinel = path.join(outsideSkill, "sentinel.txt");
    await writeFile(sentinel, "outside-owned\n");
    const beforeMode = (await lstat(outsideSkill)).mode & 0o777;
    const snapshot = await importSkill(
      { kind: "sample", id: "repo-bugfix" }, path.join(root, "imports")
    );
    const loadedManifest = await loadManifest(manifestPath);
    const orchestrator = new RunOrchestrator({
      runStore: new RunStore(path.join(root, "runs")),
      artifactStore: new ArtifactStore(path.join(root, "artifacts")),
      eventBus: new EventBus(),
      workspaceRoot,
      runnerOutputRoot,
      workspaceCleanupPolicy: "retain-until-report-export",
      toolPath: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      runner: new SuccessfulRunner({ emitMissingTool: false, replaceAgentsWithSymlink: outside }),
      async loadManifest() { return loadedManifest; },
      async loadSnapshot() { return snapshot; }
    });
    const run = await orchestrator.createRun({
      manifest_id: loadedManifest.manifest.id,
      snapshot_hash: snapshot.source_hash,
      run_group_id: "group_symlink",
      trial_index: 0,
      expected_lineage: expectedLineage(loadedManifest, snapshot)
    });

    const verdict = await orchestrator.execute(run.run_id);

    expect(verdict.status).toBe("error");
    expect((await lstat(outsideSkill)).mode & 0o777).toBe(beforeMode);
    expect(await readFile(sentinel, "utf8")).toBe("outside-owned\n");
  });

  it("refuses cleanup authority after a retained workspace is replaced by a symlink", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-orchestrator-cleanup-")));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, "workspaces");
    const runnerOutputRoot = path.join(root, "runner-output");
    await Promise.all([
      mkdir(workspaceRoot, { mode: 0o700 }),
      mkdir(runnerOutputRoot, { mode: 0o700 })
    ]);
    const snapshot = await importSkill(
      { kind: "sample", id: "repo-bugfix" }, path.join(root, "imports")
    );
    const loadedManifest = await loadManifest(manifestPath);
    const orchestrator = new RunOrchestrator({
      runStore: new RunStore(path.join(root, "runs")),
      artifactStore: new ArtifactStore(path.join(root, "artifacts")),
      eventBus: new EventBus(),
      workspaceRoot,
      runnerOutputRoot,
      workspaceCleanupPolicy: "retain-until-report-export",
      toolPath: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      runner: new SuccessfulRunner({ emitMissingTool: false }),
      async loadManifest() { return loadedManifest; },
      async loadSnapshot() { return snapshot; }
    });
    const run = await orchestrator.createRun({
      manifest_id: loadedManifest.manifest.id,
      snapshot_hash: snapshot.source_hash,
      run_group_id: "group_cleanup",
      trial_index: 0,
      expected_lineage: expectedLineage(loadedManifest, snapshot)
    });
    expect((await orchestrator.execute(run.run_id)).status).toBe("victory");
    const workspace = path.join(workspaceRoot, run.run_id);
    const outside = path.join(root, "outside-workspace");
    await mkdir(outside);
    const sentinel = path.join(outside, "sentinel.txt");
    await writeFile(sentinel, "preserve\n");
    await rm(workspace, { recursive: true, force: true });
    await symlink(outside, workspace);

    await expect(orchestrator.finalizeWorkspace(run.run_id, { report_exported: true }))
      .rejects.toThrow("identity");
    expect(await readFile(sentinel, "utf8")).toBe("preserve\n");
  });

  it("retries run-id collisions and fails closed on execute-time provider drift", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-orchestrator-drift-")));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, "workspaces");
    const runnerOutputRoot = path.join(root, "runner-output");
    await Promise.all([mkdir(workspaceRoot, { mode: 0o700 }), mkdir(runnerOutputRoot, { mode: 0o700 })]);
    const snapshot = await importSkill(
      { kind: "sample", id: "repo-bugfix" },
      path.join(root, "imports")
    );
    const loadedManifest = await loadManifest(manifestPath);
    const runStore = new RunStore(path.join(root, "runs"));
    const ids = ["same", "same", "next"];
    let drift = false;
    const runner = new SuccessfulRunner({ emitMissingTool: false });
    const commonOptions = {
      runStore,
      artifactStore: new ArtifactStore(path.join(root, "artifacts")),
      eventBus: new EventBus(),
      workspaceRoot,
      runnerOutputRoot,
      workspaceCleanupPolicy: "retain-until-report-export" as const,
      toolPath: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      runner,
      async loadManifest() { return loadedManifest; },
      async loadSnapshot() {
        return drift ? { ...snapshot, entrypoint: "nested/SKILL.md" } : snapshot;
      }
    };
    const orchestrator = new RunOrchestrator({
      ...commonOptions,
      idFactory: () => ids.shift() ?? "fallback",
    });
    const request = {
      manifest_id: loadedManifest.manifest.id,
      snapshot_hash: snapshot.source_hash,
      run_group_id: "group_collision",
      trial_index: 0,
      expected_lineage: expectedLineage(loadedManifest, snapshot)
    };
    const first = await orchestrator.createRun(request);
    const second = await orchestrator.createRun({ ...request, trial_index: 1 });
    expect([first.run_id, second.run_id]).toEqual(["run_same", "run_next"]);

    const restarted = new RunOrchestrator(commonOptions);
    await expect(restarted.execute(first.run_id)).rejects.toThrow("Unknown or non-created run");
    expect(await runStore.readEvents(first.run_id)).toEqual([]);
    expect(JSON.parse(await readFile(
      path.join(root, "runs", first.run_id, "run.json"), "utf8"
    ))).toMatchObject({ state: "created" });

    drift = true;
    const verdict = await orchestrator.execute(second.run_id);
    expect(verdict.status).toBe("error");
    expect(runner.input).toBeUndefined();
    expect((await runStore.readEvents(second.run_id)).map(({ seq, kind }) => [seq, kind]))
      .toEqual([[0, "run.errored"]]);
    expect(JSON.parse(await readFile(
      path.join(root, "runs", second.run_id, "run.json"), "utf8"
    ))).toMatchObject({ state: "errored" });
  });
});
