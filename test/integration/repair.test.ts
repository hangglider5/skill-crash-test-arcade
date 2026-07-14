import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { RunStore } from "../../src/arena/run-store.js";
import { ArtifactStore } from "../../src/arena/artifact-store.js";
import type {
  StructuredModel,
  StructuredRunRequest
} from "../../src/codex/structured.js";
import { RunDiagnosisService } from "../../src/core/diagnosis.js";
import { importSkill } from "../../src/core/importer.js";
import { RepairCoordinator } from "../../src/core/repair.js";
import type { AgentRunInput, AgentRunner } from "../../src/codex/types.js";
import type {
  RunEnvelope,
  SkillSnapshot,
  TraceEvent,
  VerdictBundle
} from "../../src/protocol/index.js";

const roots: string[] = [];
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const artifactRef = `sha256:${"d".repeat(64)}` as const;
const exec = promisify(execFile);

class CapturingModel implements StructuredModel {
  request: StructuredRunRequest<unknown> | undefined;
  constructor(readonly output: unknown) {}

  async run<T>(request: StructuredRunRequest<T>): Promise<T> {
    this.request = request as StructuredRunRequest<unknown>;
    return request.parse(this.output);
  }
}

class BypassModel implements StructuredModel {
  constructor(readonly output: unknown) {}
  async run<T>(_request: StructuredRunRequest<T>): Promise<T> {
    return this.output as T;
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-repair-")));
  roots.push(root);
  return root;
}

function envelope(runId = "run_baseline"): RunEnvelope {
  return {
    schema: "arena.run/v1",
    run_id: runId,
    run_group_id: "group_01",
    trial_index: 0,
    manifest_hash: hashA,
    snapshot_hash: hashB,
    fixture_hash: hashC,
    runner: { adapter: "codex-cli", model: "gpt-5.6" },
    state: "completed",
    started_at: "2026-07-14T08:00:00.000Z",
    ended_at: "2026-07-14T08:01:00.000Z"
  };
}

function event(seq: number): TraceEvent {
  return {
    v: 1,
    run_id: "run_baseline",
    seq,
    phase: "judge",
    kind: seq === 0 ? "test.completed" : "verifier.completed",
    actor: seq === 0 ? "codex" : "verifier",
    data: { private_raw_output: "DO_NOT_DISCLOSE" },
    artifacts: seq === 1 ? [artifactRef] : []
  };
}

function verdict(): VerdictBundle {
  return {
    schema: "arena.verdict/v1",
    run_id: "run_baseline",
    status: "defeat",
    score: 25,
    hard_gate_failures: ["full_suite"],
    dimensions: [{ id: "correctness", earned: 0, possible: 80, evidence: ["event:0"] }],
    verifier_results: [{
      id: "full_suite",
      passed: false,
      hard_gate: true,
      message: "The complete suite failed",
      evidence: ["event:1", artifactRef]
    }],
    evidence: ["event:0", "event:1", artifactRef]
  };
}

function snapshot(importedPath: string): SkillSnapshot {
  return {
    schema: "arena.skill-snapshot/v1",
    source: { kind: "local", uri: "redacted:source" },
    entrypoint: "SKILL.md",
    license: "MIT",
    files: [{ path: "SKILL.md", bytes: 10, sha256: hashA }],
    source_hash: hashB,
    imported_path: importedPath
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    for (const snapshotName of await readdir(path.join(root, "imports")).catch(() => [])) {
      await chmod(path.join(root, "imports", snapshotName), 0o700).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }));
});

async function fixture(modelOutput: unknown) {
  const root = await temporaryRoot();
  const runStore = new RunStore(path.join(root, "runs"));
  const baseline = envelope();
  const lockedVerdict = verdict();
  await runStore.create(baseline);
  await runStore.appendEvent(baseline.run_id, event(0));
  await runStore.appendEvent(baseline.run_id, event(1));
  await runStore.writeRecord(baseline.run_id, "verdict.json", lockedVerdict);
  const verdictPath = path.join(root, "runs", baseline.run_id, "verdict.json");
  const verdictBefore = await readFile(verdictPath, "utf8");
  const model = new CapturingModel(modelOutput);
  const service = new RunDiagnosisService({
    runStore,
    model,
    async loadRunContext() {
      return { envelope: baseline, manifest_id: "repo-false-green-v1" };
    },
    async loadVerdict() { return lockedVerdict; },
    async loadSnapshot() { return snapshot("/private/secret/source"); },
    async loadArtifactSummary(ref) {
      return { ref, mime: "text/plain", bytes: 12, redacted: true };
    },
    modelCwd: root,
    timeoutMs: 5_000
  });
  return { root, runStore, service, model, verdictPath, verdictBefore };
}

describe("RunDiagnosisService", () => {
  it("persists a strict evidence-linked diagnosis from a sanitized bundle", async () => {
    const output = {
      schema: "arena.diagnosis/v1",
      run_id: "run_baseline",
      model: "gpt-5.6",
      observed_failure: "The complete suite failed",
      likely_skill_gap: "The Skill trusted a focused test",
      retry_analysis: "An unchanged retry would repeat the failure",
      suggested_changes: ["Require the complete suite"],
      evidence_refs: ["event:0", "event:1", artifactRef]
    } as const;
    const { root, service, model, verdictPath, verdictBefore } = await fixture(output);

    await expect(service.diagnoseRun("run_baseline")).resolves.toEqual(output);
    expect(JSON.parse(await readFile(
      path.join(root, "runs", "run_baseline", "diagnosis.json"),
      "utf8"
    ))).toEqual(output);
    expect(await readFile(verdictPath, "utf8")).toBe(verdictBefore);
    expect(model.request).toMatchObject({ model: "gpt-5.6", timeout_ms: 5_000 });
    expect(model.request?.schema).toBeDefined();
    expect(model.request?.prompt).toContain('"manifest_id":"repo-false-green-v1"');
    expect(model.request?.prompt).toContain('"ref":"event:0"');
    expect(model.request?.prompt).not.toContain("DO_NOT_DISCLOSE");
    expect(model.request?.prompt).not.toContain("/private/secret/source");
  });

  it("rejects fabricated evidence references without persisting", async () => {
    const { root, service } = await fixture({
      schema: "arena.diagnosis/v1",
      run_id: "run_baseline",
      model: "gpt-5.6",
      observed_failure: "Failure",
      likely_skill_gap: "Gap",
      retry_analysis: "Retry",
      suggested_changes: ["Change"],
      evidence_refs: ["event:999"]
    });

    await expect(service.diagnoseRun("run_baseline"))
      .rejects.toThrow("Diagnosis references unavailable evidence: event:999");
    await expect(access(path.join(root, "runs", "run_baseline", "diagnosis.json")))
      .rejects.toThrow();
  });

  it("revalidates a StructuredModel result that bypasses the supplied parser", async () => {
    const fixtureValue = await fixture({});
    const bypass = new BypassModel({
      schema: "arena.diagnosis/v1", run_id: "run_baseline", model: "gpt-5.6",
      observed_failure: "Failure", likely_skill_gap: "Gap", retry_analysis: "Retry",
      suggested_changes: ["Change"], evidence_refs: ["event:999"]
    });
    const service = new RunDiagnosisService({
      runStore: fixtureValue.runStore,
      model: bypass,
      async loadRunContext() { return { envelope: envelope(), manifest_id: "repo-false-green-v1" }; },
      async loadVerdict() { return verdict(); },
      async loadSnapshot() { return snapshot("/private/secret/source"); },
      async loadArtifactSummary(ref) { return { ref, mime: "text/plain", bytes: 12, redacted: true }; },
      modelCwd: fixtureValue.root,
      timeoutMs: 5_000
    });
    await expect(service.diagnoseRun("run_baseline"))
      .rejects.toThrow("Diagnosis references unavailable evidence: event:999");
  });
});

class EditingRunner implements AgentRunner {
  input: AgentRunInput | undefined;
  constructor(
    readonly edit: (cwd: string) => Promise<void>,
    readonly outputRoot: string
  ) {}
  async run(input: AgentRunInput) {
    this.input = input;
    if (path.dirname(input.output_schema_path) !== this.outputRoot
      || path.dirname(input.output_path) !== this.outputRoot) {
      throw new Error("RUNNER_OUTPUT_PATH_INVALID");
    }
    await this.edit(input.cwd);
    return { exit_code: 0 as const, structured_output: { summary: "Updated the Skill" }, raw_event_count: 0 };
  }
}

async function repairFixture(edit: (cwd: string) => Promise<void>) {
  const root = await temporaryRoot();
  const source = path.join(root, "source-skill");
  await mkdir(source);
  await writeFile(path.join(source, "SKILL.md"), "# Skill\n\nSee [Guide](guide.md).\n");
  await writeFile(path.join(source, "guide.md"), "# Guide\n");
  await writeFile(path.join(source, "unrelated.txt"), "unchanged\n");
  const importsRoot = path.join(root, "imports");
  const original = await importSkill({ kind: "local", path: source }, importsRoot);
  const baseline: RunEnvelope = {
    ...envelope(),
    snapshot_hash: original.source_hash
  };
  const runStore = new RunStore(path.join(root, "runs"));
  await runStore.create(baseline);
  await runStore.appendEvent(baseline.run_id, event(0));
  await runStore.appendEvent(baseline.run_id, event(1));
  const lockedDiagnosis = {
    schema: "arena.diagnosis/v1" as const,
    run_id: baseline.run_id,
    model: "gpt-5.6" as const,
    observed_failure: "The locked full suite failed",
    likely_skill_gap: "The Skill trusted a focused test",
    retry_analysis: "An unchanged retry repeats the failure",
    suggested_changes: ["Require the complete suite"],
    evidence_refs: ["event:0" as const]
  };
  await runStore.writeRecord(baseline.run_id, "diagnosis.json", lockedDiagnosis);
  const artifactStore = new ArtifactStore(path.join(root, "artifacts"));
  const runnerOutputRoot = path.join(root, "runner-output");
  await mkdir(runnerOutputRoot, { mode: 0o700 });
  const collisionSentinel = path.join(runnerOutputRoot, "repair-collision1.schema.json");
  await writeFile(collisionSentinel, "sentinel", { mode: 0o600 });
  const outputIds = ["collision1", "safe0001"];
  const runner = new EditingRunner(edit, runnerOutputRoot);
  const childRequests: Array<{
    manifest_id: string;
    snapshot_hash: string;
    run_group_id: string;
    trial_index: number;
    parent_run_id?: string;
  }> = [];
  const executed: string[] = [];
  const coordinator = new RepairCoordinator({
    runStore,
    artifactStore,
    runner,
    repairsRoot: path.join(root, "repairs"),
    importsRoot,
    runnerOutputRoot,
    toolPath: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    timeoutMs: 5_000,
    idFactory: () => "repair_01",
    outputIdFactory: () => outputIds.shift()!,
    async loadRunContext() {
      return { envelope: baseline, manifest_id: "repo-false-green-v1" };
    },
    async loadSnapshot() { return original; },
    async loadVerdict() { return verdict(); },
    async loadDiagnosis() { return lockedDiagnosis; },
    async createChildRun(request) {
      childRequests.push(request);
      return {
        ...baseline,
        run_id: "run_child",
        parent_run_id: baseline.run_id,
        snapshot_hash: request.snapshot_hash,
        trial_index: request.trial_index,
        state: "created",
        ended_at: undefined
      };
    },
    async executeChildRun(runId) { executed.push(runId); },
    async listRunsForGroup() { return [baseline]; }
  });
  return {
    root, original, baseline, coordinator, runner, artifactStore,
    childRequests, executed, collisionSentinel
  };
}

describe("RepairCoordinator", () => {
  it("repairs only the Skill entrypoint and reruns with exact child lineage", async () => {
    const fixture = await repairFixture(async (cwd) => {
      await writeFile(path.join(cwd, "SKILL.md"), "# Skill\n\nRun the protected full suite.\n");
    });
    const originalBefore = await readFile(path.join(fixture.original.imported_path, "SKILL.md"), "utf8");

    const proposal = await fixture.coordinator.createRepairFork("run_baseline");

    expect(proposal.changed_paths).toEqual(["SKILL.md"]);
    expect(await readFile(path.join(fixture.original.imported_path, "SKILL.md"), "utf8"))
      .toBe(originalBefore);
    expect(fixture.runner.input).toMatchObject({
      model: "gpt-5.6",
      sandbox: "workspace-write",
      timeout_ms: 5_000
    });
    expect(fixture.runner.input?.prompt).toContain("SKILL.md");
    expect(fixture.runner.input?.prompt).toContain("The locked full suite failed");
    expect(fixture.runner.input?.prompt).not.toContain(fixture.root);
    expect(fixture.runner.input?.tool_env?.PATH).toBeDefined();
    expect(fixture.runner.input?.tool_env).not.toHaveProperty("OPENAI_API_KEY");
    expect(await readFile(fixture.collisionSentinel, "utf8")).toBe("sentinel");
    await expect(exec("git", ["-C", proposal.fork_path, "rev-parse", "--verify", "HEAD"]))
      .rejects.toThrow();
    expect((await fixture.artifactStore.read(proposal.patch_ref)).toString())
      .toContain("Run the protected full suite");
    const persisted = JSON.parse(await readFile(
      path.join(fixture.root, "runs", "run_baseline", "repair.json"), "utf8"
    ));
    expect(JSON.stringify(persisted)).not.toContain(fixture.root);

    const child = await fixture.coordinator.approveAndRerun(proposal.repair_id);

    expect(child).toMatchObject({
      parent_run_id: "run_baseline",
      manifest_hash: fixture.baseline.manifest_hash,
      fixture_hash: fixture.baseline.fixture_hash,
      run_group_id: fixture.baseline.run_group_id,
      trial_index: 0
    });
    expect(child.snapshot_hash).not.toBe(fixture.baseline.snapshot_hash);
    expect(fixture.childRequests[0]).toMatchObject({
      manifest_id: "repo-false-green-v1",
      parent_run_id: "run_baseline",
      trial_index: 0
    });
    expect(fixture.executed).toEqual(["run_child"]);
    expect(JSON.parse(await readFile(
      path.join(fixture.root, "runs", "run_baseline", "repair.json"), "utf8"
    ))).toMatchObject({ status: "approved", child_run_id: "run_child", new_snapshot_hash: child.snapshot_hash });
    await expect(fixture.coordinator.approveAndRerun(proposal.repair_id))
      .rejects.toThrow("Repair is not pending");
  });

  it("rejects a fork changed after review and persists a safe failed status", async () => {
    const fixture = await repairFixture(async (cwd) => {
      await writeFile(path.join(cwd, "SKILL.md"), "# Reviewed repair\n");
    });
    const proposal = await fixture.coordinator.createRepairFork("run_baseline");
    await writeFile(path.join(proposal.fork_path, "SKILL.md"), "# Tampered after review\n");

    await expect(fixture.coordinator.approveAndRerun(proposal.repair_id))
      .rejects.toThrow(/changed after review|reviewed repair/u);
    const record = JSON.parse(await readFile(
      path.join(fixture.root, "runs", "run_baseline", "repair.json"), "utf8"
    ));
    expect(record).toMatchObject({ status: "failed", error: { code: "REPAIR_APPROVAL_FAILED" } });
    expect(JSON.stringify(record)).not.toContain(fixture.root);
  });

  it("allows an existing Markdown file explicitly linked by the entrypoint", async () => {
    const fixture = await repairFixture(async (cwd) => {
      await writeFile(path.join(cwd, "guide.md"), "# Guide\n\nRun the full suite.\n");
    });
    await expect(fixture.coordinator.createRepairFork("run_baseline"))
      .resolves.toMatchObject({ changed_paths: ["guide.md"] });
  });

  it.each([
    ["untracked", async (cwd: string) => writeFile(path.join(cwd, "extra.md"), "no")],
    ["outside", async (cwd: string) => writeFile(path.join(cwd, "unrelated.txt"), "changed")],
    ["empty", async (_cwd: string) => undefined],
    ["delete", async (cwd: string) => rm(path.join(cwd, "SKILL.md"))],
    ["rename", async (cwd: string) => rename(
      path.join(cwd, "SKILL.md"),
      path.join(cwd, "MOVED.md")
    )],
    ["mode", async (cwd: string) => chmod(path.join(cwd, "SKILL.md"), 0o755)],
    ["oversize", async (cwd: string) => writeFile(
      path.join(cwd, "SKILL.md"),
      Buffer.alloc(2 * 1024 * 1024 + 1, 0x61)
    )],
    ["symlink", async (cwd: string) => {
      await rm(path.join(cwd, "SKILL.md"));
      await symlink("guide.md", path.join(cwd, "SKILL.md"));
    }]
  ])("rejects %s repair mutations", async (_name, edit) => {
    const fixture = await repairFixture(edit);
    await expect(fixture.coordinator.createRepairFork("run_baseline"))
      .rejects.toThrow(/repair mutation|allowed path|symbolic link|empty patch|unchanged-mode|size limit/iu);
  });
});
