import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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

class ScriptedRunner implements AgentRunner {
  async run(input: AgentRunInput, onEvent: AgentEventHandler): Promise<AgentRunResult> {
    const controller = new AbortController();
    const delivery: AgentEventDelivery = {
      signal: controller.signal,
      commit<T>(operation: () => T): T {
        return operation();
      }
    };
    await onEvent({
      type: "item.completed",
      item: {
        id: "cmd_git_status",
        type: "command_execution",
        command: "git status --short",
        exit_code: 0,
        status: "completed",
        aggregated_output: " M docs/roadmap.md\n"
      }
    }, delivery);
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
  readonly emitMissingTool: boolean;
  input: AgentRunInput | undefined;

  constructor(emitMissingTool: boolean) {
    this.emitMissingTool = emitMissingTool;
  }

  async run(input: AgentRunInput, onEvent: AgentEventHandler): Promise<AgentRunResult> {
    this.input = input;
    const controller = new AbortController();
    const delivery: AgentEventDelivery = {
      signal: controller.signal,
      commit<T>(operation: () => T): T { return operation(); }
    };
    if (this.emitMissingTool) {
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
    const structured = {
      completed: true,
      summary: "Fixed slugify and ran verification",
      evidence: ["npm test"]
    };
    await writeFile(input.output_path, JSON.stringify(structured), { flag: "wx" });
    const output = await lstat(input.output_path);
    return {
      exit_code: 0,
      structured_output: structured,
      raw_event_count: this.emitMissingTool ? 2 : 1,
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
      mkdir(workspaceRoot),
      mkdir(runnerOutputRoot, { mode: 0o700 })
    ]);
    const snapshot = await importSkill({ kind: "sample", id: "repo-bugfix" }, importsRoot);
    const loadedManifest = await loadManifest(manifestPath);
    const runStore = new RunStore(path.join(root, "runs"));
    const eventBus = new EventBus();
    const published: number[] = [];

    const orchestrator = new RunOrchestrator({
      runStore,
      artifactStore: new ArtifactStore(path.join(root, "artifacts")),
      eventBus,
      workspaceRoot,
      runnerOutputRoot,
      toolPath: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      runner: new ScriptedRunner(),
      async loadManifest(manifestId) {
        if (manifestId !== loadedManifest.manifest.id) throw new Error("unknown manifest");
        return loadedManifest;
      },
      async loadSnapshot(snapshotHash) {
        if (snapshotHash !== snapshot.source_hash) throw new Error("unknown snapshot");
        return snapshot;
      }
    });

    const run = await orchestrator.createRun({
      manifest_id: "repo-dirty-tree-v1",
      snapshot_hash: snapshot.source_hash,
      run_group_id: "group_01",
      trial_index: 0
    });
    eventBus.subscribe(run.run_id, (event) => {
      published.push(event.seq);
    });

    const verdict = await orchestrator.execute(run.run_id);

    expect(verdict.status).toBe("defeat");
    expect(verdict.hard_gate_failures).toEqual(["preserve_existing_changes"]);
    const events = await runStore.readEvents(run.run_id);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(events.map((event) => event.kind)).toEqual([
      "run.started",
      "process.exited",
      "agent.claimed",
      "phase.entered",
      "verifier.completed",
      "run.finished"
    ]);
    expect(published).toEqual([0, 1, 2, 3, 4, 5]);
    expect(JSON.parse(await readFile(
      path.join(root, "runs", run.run_id, "verdict.json"),
      "utf8"
    ))).toEqual(verdict);
  });

  it("records an infrastructure error without committing a rejected delivery", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-orchestrator-error-")));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, "workspaces");
    const runnerOutputRoot = path.join(root, "runner-output");
    await Promise.all([mkdir(workspaceRoot), mkdir(runnerOutputRoot, { mode: 0o700 })]);
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
      toolPath: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      runner: new InactiveDeliveryRunner(),
      async loadManifest() { return loadedManifest; },
      async loadSnapshot() { return snapshot; }
    });
    const run = await orchestrator.createRun({
      manifest_id: loadedManifest.manifest.id,
      snapshot_hash: snapshot.source_hash,
      run_group_id: "group_error",
      trial_index: 0
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
      expectedVerifierIds: ["behavior", "full_suite", "scope", "claim"]
    },
    {
      name: "Missing Tool",
      manifestFile: missingToolManifestPath,
      missingTool: true,
      expectedVerifierIds: ["behavior", "tool_recovery", "scope", "claim"]
    }
  ])("dispatches the $name manifest by its declared verifier IDs", async ({
    manifestFile,
    missingTool,
    expectedVerifierIds
  }) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-orchestrator-card-")));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, "workspaces");
    const runnerOutputRoot = path.join(root, "runner-output");
    await Promise.all([mkdir(workspaceRoot), mkdir(runnerOutputRoot, { mode: 0o700 })]);
    const snapshot = await importSkill(
      { kind: "sample", id: "repo-bugfix" },
      path.join(root, "imports")
    );
    const loadedManifest = await loadManifest(manifestFile);
    const runStore = new RunStore(path.join(root, "runs"));
    const runner = new SuccessfulRunner(missingTool);
    const orchestrator = new RunOrchestrator({
      runStore,
      artifactStore: new ArtifactStore(path.join(root, "artifacts")),
      eventBus: new EventBus(),
      workspaceRoot,
      runnerOutputRoot,
      toolPath: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      runner,
      async loadManifest() { return loadedManifest; },
      async loadSnapshot() { return snapshot; }
    });
    const run = await orchestrator.createRun({
      manifest_id: loadedManifest.manifest.id,
      snapshot_hash: snapshot.source_hash,
      run_group_id: "group_cards",
      trial_index: 0
    });

    const verdict = await orchestrator.execute(run.run_id);

    expect(verdict.status).toBe("victory");
    if (verdict.status === "error") throw new Error("unexpected error verdict");
    expect(verdict.score).toBe(100);
    expect(verdict.verifier_results.map(({ id }) => id)).toEqual(expectedVerifierIds);
    expect(verdict.hard_gate_failures).toEqual([]);
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

  it("retries run-id collisions and fails closed on execute-time provider drift", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-orchestrator-drift-")));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, "workspaces");
    const runnerOutputRoot = path.join(root, "runner-output");
    await Promise.all([mkdir(workspaceRoot), mkdir(runnerOutputRoot, { mode: 0o700 })]);
    const snapshot = await importSkill(
      { kind: "sample", id: "repo-bugfix" },
      path.join(root, "imports")
    );
    const loadedManifest = await loadManifest(manifestPath);
    const runStore = new RunStore(path.join(root, "runs"));
    const ids = ["same", "same", "next"];
    let drift = false;
    const orchestrator = new RunOrchestrator({
      runStore,
      artifactStore: new ArtifactStore(path.join(root, "artifacts")),
      eventBus: new EventBus(),
      workspaceRoot,
      runnerOutputRoot,
      toolPath: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      runner: new ScriptedRunner(),
      idFactory: () => ids.shift() ?? "fallback",
      async loadManifest() { return loadedManifest; },
      async loadSnapshot() {
        return drift ? { ...snapshot, source: { ...snapshot.source, uri: "drifted" } } : snapshot;
      }
    });
    const request = {
      manifest_id: loadedManifest.manifest.id,
      snapshot_hash: snapshot.source_hash,
      run_group_id: "group_collision",
      trial_index: 0
    };
    const first = await orchestrator.createRun(request);
    const second = await orchestrator.createRun({ ...request, trial_index: 1 });
    expect([first.run_id, second.run_id]).toEqual(["run_same", "run_next"]);

    drift = true;
    const verdict = await orchestrator.execute(second.run_id);
    expect(verdict.status).toBe("error");
    expect((await runStore.readEvents(second.run_id)).map(({ seq, kind }) => [seq, kind]))
      .toEqual([[0, "run.errored"]]);
    expect(JSON.parse(await readFile(
      path.join(root, "runs", second.run_id, "run.json"), "utf8"
    ))).toMatchObject({ state: "errored" });
  });
});
