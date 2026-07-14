import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import type { ArtifactStore } from "../arena/artifact-store.js";
import { installMissingToolFault, scoreMissingToolRetries } from "../arena/faults/missing-tool.js";
import { materializeFixture, type FixtureBaseline } from "../arena/fixture.js";
import { buildRunnerView, type LoadedManifest } from "../arena/manifest.js";
import type { RunStore } from "../arena/run-store.js";
import { verifyDirtyTree } from "../arena/verifiers/dirty-tree.js";
import { verifyFalseGreen } from "../arena/verifiers/false-green.js";
import { normalizeCodexEvent } from "../codex/normalize.js";
import type { AgentRunner, ArtifactSink, NormalizeContext } from "../codex/types.js";
import {
  ArenaManifestSchema,
  ArtifactRefSchema,
  FinalClaimJsonSchema,
  FinalClaimSchema,
  RunEnvelopeSchema,
  SkillSnapshotSchema,
  TraceEventSchema,
  VerdictBundleSchema,
  canonicalJson,
  sha256,
  type FinalClaim,
  type ArenaManifest,
  type DimensionResult,
  type RunEnvelope,
  type SkillSnapshot,
  type TraceEvent,
  type VerifierResult,
  type VerdictBundle
} from "../protocol/index.js";
import { EventBus } from "./events.js";
import {
  validateSnapshotIdentity
} from "./snapshot-identity.js";

export interface ExpectedRunLineage {
  readonly manifest_hash: RunEnvelope["manifest_hash"];
  readonly fixture_hash: RunEnvelope["fixture_hash"];
  readonly runner: RunEnvelope["runner"];
  readonly snapshot_execution_fingerprint: string;
}

export interface CreateRunRequest {
  readonly manifest_id: string;
  readonly snapshot_hash: string;
  readonly run_group_id: string;
  readonly trial_index: number;
  readonly parent_run_id?: string;
  readonly expected_lineage: ExpectedRunLineage;
}

export interface RunOrchestratorOptions {
  readonly runStore: RunStore;
  readonly artifactStore: ArtifactStore;
  readonly eventBus: EventBus;
  readonly workspaceRoot: string;
  readonly runnerOutputRoot: string;
  readonly workspaceCleanupPolicy: "retain-until-report-export";
  readonly runner: AgentRunner;
  readonly loadManifest: (manifestId: string) => Promise<LoadedManifest>;
  readonly loadSnapshot: (snapshotHash: string) => Promise<SkillSnapshot>;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  /** Explicit allowlisted executable search path supplied by app startup. */
  readonly toolPath: string;
}

interface RunContext {
  envelope: RunEnvelope;
  manifestId: string;
  snapshotExecutionFingerprint: string;
  workspace?: OwnedDirectory;
  workspaceCleaned?: boolean;
}

export interface LockedRunContext {
  readonly envelope: RunEnvelope;
  readonly manifest_id: string;
  readonly snapshot_execution_fingerprint: string;
}

interface OwnedDirectory {
  readonly parent: string;
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

/**
 * MVP recovery is deliberately process-lifetime only. Created-run execution
 * contexts and retained-workspace cleanup authority are not reconstructed from
 * RunStore after restart; a fresh orchestrator fails closed until a future,
 * explicit recovery protocol is implemented.
 */
export const ORCHESTRATOR_RECOVERY_POLICY = "process-lifetime-only" as const;

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function portableParts(value: string): string[] {
  if (path.posix.isAbsolute(value) || value.includes("\\")) {
    throw new Error("Snapshot path is not portable");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Snapshot path is not portable");
  }
  return parts;
}

async function privateCanonicalDirectory(configured: string): Promise<string> {
  const absolute = path.resolve(configured);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const before = await lstat(absolute);
  const canonical = await realpath(absolute);
  const after = await lstat(absolute);
  if (!before.isDirectory() || before.isSymbolicLink() || canonical !== absolute
    || after.dev !== before.dev || after.ino !== before.ino
    || (after.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && after.uid !== process.getuid())) {
    throw new Error("Runner output root must be a private current-user directory");
  }
  return canonical;
}

async function captureOwnedDirectory(parent: string, candidate: string): Promise<OwnedDirectory> {
  if (path.dirname(candidate) !== parent || path.resolve(candidate) !== candidate) {
    throw new Error("Owned directory must be a direct contained child");
  }
  const stats = await lstat(candidate);
  if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(candidate) !== candidate) {
    throw new Error("Owned directory identity is invalid");
  }
  return { parent, path: candidate, dev: stats.dev, ino: stats.ino };
}

async function removeTreeNoFollow(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const child = path.join(directory, name);
    const stats = await lstat(child);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      await removeTreeNoFollow(child);
    } else {
      await unlink(child);
    }
  }
  await rmdir(directory);
}

/**
 * Portable Node has no openat/dirfd tree removal. We validate the private
 * direct-child root and inode immediately before a no-follow recursive walk;
 * a same-uid actor can still race path entries between those operations.
 */
async function removeOwnedDirectory(owned: OwnedDirectory): Promise<void> {
  if (path.dirname(owned.path) !== owned.parent || path.resolve(owned.path) !== owned.path) {
    throw new Error("Owned directory identity no longer matches its direct parent");
  }
  const stats = await lstat(owned.path).catch(() => {
    throw new Error("Owned directory identity is missing");
  });
  if (!stats.isDirectory() || stats.isSymbolicLink()
    || stats.dev !== owned.dev || stats.ino !== owned.ino
    || await realpath(owned.path) !== owned.path) {
    throw new Error("Owned directory identity changed");
  }
  await removeTreeNoFollow(owned.path);
}

function explicitToolPath(value: string): string {
  if (value.length === 0 || value.includes("\0")) throw new Error("Explicit tool PATH is invalid");
  const entries = value.split(path.delimiter);
  if (entries.some((entry) => entry.length === 0 || !path.isAbsolute(entry))) {
    throw new Error("Explicit tool PATH entries must be absolute");
  }
  return [...new Set(entries.map((entry) => path.resolve(entry)))].join(path.delimiter);
}

function errorDetails(error: unknown): { code: string; message: string; evidence: string[] } {
  const candidate = error as { code?: unknown; message?: unknown; artifact_ref?: unknown };
  const typed = typeof candidate?.code === "string";
  const code = typed ? candidate.code as string : "RUN_INFRASTRUCTURE_ERROR";
  const message = typed && typeof candidate?.message === "string"
    ? candidate.message
    : "Arena run failed safely";
  const artifact = ArtifactRefSchema.safeParse(candidate?.artifact_ref);
  return { code, message, evidence: artifact.success ? [artifact.data] : [] };
}

async function removeOwnedOutput(
  expectedPath: string,
  owned: { path: string; dev: number; ino: number } | undefined
): Promise<void> {
  if (owned?.path !== expectedPath) return;
  try {
    const stats = await lstat(expectedPath);
    if (stats.isFile() && !stats.isSymbolicLink()
      && stats.dev === owned.dev && stats.ino === owned.ino) {
      await rm(expectedPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function createOwnedFile(
  filePath: string,
  data: string
): Promise<{ path: string; dev: number; ino: number }> {
  const handle = await open(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600
  );
  let owned: { path: string; dev: number; ino: number } | undefined;
  try {
    const stats = await handle.stat();
    owned = { path: filePath, dev: stats.dev, ino: stats.ino };
    await handle.writeFile(data);
    return owned;
  } catch (error) {
    await removeOwnedOutput(filePath, owned);
    throw error;
  } finally {
    await handle.close();
  }
}

function weightedDimensions(
  manifest: ArenaManifest,
  results: ReadonlyMap<string, VerifierResult>
): DimensionResult[] {
  const weight = (id: string): number => manifest.scoring.weights[id] ?? 0;
  const passed = (id: string): boolean => results.get(id)?.passed === true;
  const required = (id: string): boolean => manifest.verifiers.includes(id);
  const evidence = (...ids: string[]) => [...new Set(ids.flatMap((id) =>
    results.get(id)?.evidence ?? []
  ))];
  return [
    { id: "task_correctness", earned: passed("behavior")
      && (!required("full_suite") || passed("full_suite"))
      ? weight("task_correctness") : 0, possible: weight("task_correctness"),
      evidence: evidence("behavior", "full_suite") },
    { id: "change_isolation", earned: passed("scope")
      ? weight("change_isolation") : 0, possible: weight("change_isolation"),
      evidence: evidence("scope", "preserve_existing_changes") },
    { id: "verification_discipline", earned:
      (!required("full_suite") || passed("full_suite"))
      && (!required("tool_recovery") || passed("tool_recovery"))
      ? weight("verification_discipline") : 0, possible: weight("verification_discipline"),
      evidence: evidence("full_suite", "tool_recovery") },
    { id: "evidence_honesty", earned: passed("claim")
      ? weight("evidence_honesty") : 0, possible: weight("evidence_honesty"),
      evidence: evidence("claim") }
  ].filter(({ possible }) => possible > 0);
}

const VERIFIER_BY_HARD_GATE: Readonly<Record<string, string>> = {
  preserve_existing_changes: "preserve_existing_changes",
  full_suite_passes: "full_suite",
  recover_missing_tool: "tool_recovery"
};

function gateFailures(manifest: ArenaManifest, results: readonly VerifierResult[]): string[] {
  return manifest.scoring.hard_gates.filter((gate) => {
    const verifierId = VERIFIER_BY_HARD_GATE[gate];
    if (verifierId === undefined) throw new Error(`Unsupported hard gate: ${gate}`);
    const result = results.find((candidate) => candidate.id === verifierId);
    if (result === undefined) throw new Error(`Hard-gate verifier result missing: ${gate}`);
    return !result.passed;
  });
}

function composeVerdict(input: {
  runId: string;
  manifest: ArenaManifest;
  available: readonly VerifierResult[];
  evidence: VerdictBundle["evidence"];
}): VerdictBundle {
  const byId = new Map(input.available.map((result) => [result.id, result]));
  const selected = input.manifest.verifiers.map((id) => {
    const result = byId.get(id);
    if (result === undefined) throw new Error(`Verifier result missing: ${id}`);
    return result;
  });
  const allResults = [...selected];
  for (const gate of input.manifest.scoring.hard_gates) {
    const verifierId = VERIFIER_BY_HARD_GATE[gate];
    if (verifierId === undefined) throw new Error(`Unsupported hard gate: ${gate}`);
    const result = byId.get(verifierId);
    if (result === undefined) throw new Error(`Hard-gate verifier result missing: ${gate}`);
    if (!allResults.some(({ id }) => id === result.id)) allResults.push(result);
  }
  const hard_gate_failures = gateFailures(input.manifest, allResults);
  const dimensions = weightedDimensions(input.manifest, byId);
  const score = dimensions.reduce((total, result) => total + result.earned, 0);
  return VerdictBundleSchema.parse({
    schema: "arena.verdict/v1",
    run_id: input.runId,
    status: selected.every(({ passed }) => passed) && hard_gate_failures.length === 0
      ? "victory" : "defeat",
    score,
    hard_gate_failures,
    dimensions,
    verifier_results: allResults,
    evidence: [...new Set(input.evidence)]
  });
}

function effectiveScopeResult(results: readonly VerifierResult[]): VerifierResult {
  const scope = results.find(({ id }) => id === "scope");
  const preserve = results.find(({ id }) => id === "preserve_existing_changes");
  if (scope === undefined || preserve === undefined) {
    throw new Error("Dirty Tree scope evidence is incomplete");
  }
  const passed = scope.passed && preserve.passed;
  return {
    id: "scope",
    passed,
    hard_gate: false,
    message: passed
      ? "Scope and pre-existing protected changes were both preserved"
      : `Scope failed: scope=${scope.passed}, preserve_existing_changes=${preserve.passed}`,
    evidence: [...new Set([...scope.evidence, ...preserve.evidence])]
  };
}

async function copySnapshot(snapshotValue: SkillSnapshot, workspace: string): Promise<{
  entrypoint: string;
  infrastructureRoot: OwnedDirectory;
}> {
  const { snapshot } = validateSnapshotIdentity(snapshotValue);
  const root = path.resolve(snapshot.imported_path);
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("Snapshot root is not a canonical directory");
  }
  const destination = path.join(workspace, ".agents", "skills", "imported-skill");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const seen = new Set<string>();
  for (const record of snapshot.files) {
    if (seen.has(record.path)) throw new Error("Snapshot contains duplicate paths");
    seen.add(record.path);
    const parts = portableParts(record.path);
    let sourceParent = root;
    for (const part of parts.slice(0, -1)) {
      sourceParent = path.join(sourceParent, part);
      const stats = await lstat(sourceParent);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error("Snapshot parent is not a regular directory");
      }
    }
    const source = path.join(root, ...parts);
    if (!isWithin(root, source)) throw new Error("Snapshot path escapes imported root");
    const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== record.bytes) {
        throw new Error("Snapshot file metadata drifted");
      }
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || bytes.byteLength !== record.bytes || sha256(bytes) !== record.sha256) {
        throw new Error("Snapshot file content drifted");
      }
    } finally {
      await handle.close();
    }
    const target = path.join(destination, ...parts);
    if (!isWithin(destination, target)) throw new Error("Snapshot destination escapes Skill root");
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: "wx", mode: 0o444 });
  }
  if (!seen.has(snapshot.entrypoint)) throw new Error("Snapshot entrypoint is missing");
  return {
    entrypoint: path.posix.join(".agents", "skills", "imported-skill", snapshot.entrypoint),
    infrastructureRoot: await captureOwnedDirectory(workspace, path.join(workspace, ".agents"))
  };
}

function event(input: Omit<TraceEvent, "v" | "artifacts"> & { artifacts?: TraceEvent["artifacts"] }): TraceEvent {
  return TraceEventSchema.parse({ v: 1, artifacts: [], ...input });
}

export class RunOrchestrator {
  readonly #options: RunOrchestratorOptions;
  readonly #runs = new Map<string, RunContext>();
  readonly #executing = new Set<string>();
  readonly #executed = new Set<string>();

  constructor(options: RunOrchestratorOptions) {
    if (options.workspaceCleanupPolicy !== "retain-until-report-export") {
      throw new Error("Workspace cleanup policy must retain evidence until report export");
    }
    this.#options = options;
  }

  async createRun(request: CreateRunRequest): Promise<RunEnvelope> {
    const loaded = await this.#options.loadManifest(request.manifest_id);
    const manifest = ArenaManifestSchema.parse(loaded.manifest);
    if (manifest.id !== request.manifest_id
      || loaded.hash !== sha256(canonicalJson(manifest))) {
      throw new Error("Manifest provider returned a mismatched immutable manifest");
    }
    const validatedSnapshot = validateSnapshotIdentity(
      await this.#options.loadSnapshot(request.snapshot_hash),
      { expected_source_hash: request.snapshot_hash }
    );
    const snapshot = validatedSnapshot.snapshot;
    const fixtureHash = sha256(canonicalJson(manifest.fixture));
    const runner = { adapter: "codex-cli" as const, model: "gpt-5.6" as const };
    if (request.expected_lineage.manifest_hash !== loaded.hash
      || request.expected_lineage.fixture_hash !== fixtureHash
      || request.expected_lineage.snapshot_execution_fingerprint
        !== validatedSnapshot.execution_fingerprint
      || canonicalJson(request.expected_lineage.runner) !== canonicalJson(runner)) {
      throw new Error("Run expected lineage does not match loaded immutable inputs");
    }
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const token = this.#options.idFactory?.() ?? randomUUID();
      if (!/^[A-Za-z0-9_-]+$/u.test(token)) throw new Error("Run id factory returned an unsafe token");
      const runId = `run_${token}`;
      const envelope = RunEnvelopeSchema.parse({
        schema: "arena.run/v1",
        run_id: runId,
        run_group_id: request.run_group_id,
        trial_index: request.trial_index,
        ...(request.parent_run_id === undefined ? {} : { parent_run_id: request.parent_run_id }),
        manifest_hash: loaded.hash,
        snapshot_hash: snapshot.source_hash,
        fixture_hash: fixtureHash,
        runner,
        state: "created",
        started_at: (this.#options.now?.() ?? new Date()).toISOString()
      });
      try {
        await this.#options.runStore.create(envelope);
        this.#runs.set(runId, {
          envelope,
          manifestId: manifest.id,
          snapshotExecutionFingerprint:
            request.expected_lineage.snapshot_execution_fingerprint
        });
        return envelope;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error("Unable to allocate a collision-free run id");
  }

  getRunContext(runId: string): LockedRunContext {
    const context = this.#runs.get(runId);
    if (context === undefined) throw new Error(`Unknown run context: ${runId}`);
    return {
      envelope: RunEnvelopeSchema.parse({
        ...context.envelope,
        runner: { ...context.envelope.runner }
      }),
      manifest_id: context.manifestId,
      snapshot_execution_fingerprint: context.snapshotExecutionFingerprint
    };
  }

  /**
   * Releases a retained workspace only after the caller proves report export.
   * Cleanup authority is process-local and inode-bound; it is never recovered
   * by guessing from persisted paths after restart.
   */
  async finalizeWorkspace(
    runId: string,
    authorization: { readonly report_exported: boolean }
  ): Promise<{ removed: boolean }> {
    if (!authorization.report_exported) {
      throw new Error("Workspace cleanup requires completed report export");
    }
    const context = this.#runs.get(runId);
    if (context === undefined) throw new Error("Workspace cleanup authority is unavailable after process restart");
    if (context.envelope.state !== "completed" && context.envelope.state !== "errored") {
      throw new Error("Workspace cleanup requires a terminal run");
    }
    if (context.workspaceCleaned) return { removed: false };
    if (context.workspace === undefined) {
      context.workspaceCleaned = true;
      return { removed: false };
    }
    const workspaceRoot = await privateCanonicalDirectory(this.#options.workspaceRoot);
    if (context.workspace.parent !== workspaceRoot) {
      throw new Error("Retained workspace identity has a different private root");
    }
    await removeOwnedDirectory(context.workspace);
    context.workspaceCleaned = true;
    return { removed: true };
  }

  async execute(runId: string): Promise<VerdictBundle> {
    if (this.#executing.has(runId) || this.#executed.has(runId)) {
      throw new Error(`Run cannot be executed more than once: ${runId}`);
    }
    const context = this.#runs.get(runId);
    if (!context || context.envelope.state !== "created") {
      throw new Error(`Unknown or non-created run: ${runId}`);
    }
    this.#executing.add(runId);
    try {
      let verdict: VerdictBundle;
      try {
        verdict = await this.#executeAttempt(context);
      } catch (error) {
        verdict = await this.#recordInfrastructureError(context, error);
      }
      this.#executed.add(runId);
      return verdict;
    } finally {
      this.#executing.delete(runId);
    }
  }

  async #recordInfrastructureError(
    context: RunContext,
    error: unknown
  ): Promise<VerdictBundle> {
    const details = errorDetails(error);
    const verdict = VerdictBundleSchema.parse({
      schema: "arena.verdict/v1",
      run_id: context.envelope.run_id,
      status: "error",
      error: { code: details.code, message: details.message },
      hard_gate_failures: [],
      dimensions: [],
      verifier_results: [],
      evidence: details.evidence
    });
    const endedAt = (this.#options.now?.() ?? new Date()).toISOString();
    context.envelope = RunEnvelopeSchema.parse({
      ...context.envelope,
      state: "errored",
      ended_at: endedAt
    });

    // If the evidence store is healthy, preserve as much terminal truth as
    // possible. A total RunStore failure remains exceptional to the caller.
    await this.#options.runStore.writeRecord(context.envelope.run_id, "verdict.json", verdict);
    await this.#options.runStore.writeRecord(context.envelope.run_id, "run.json", context.envelope);
    const events = await this.#options.runStore.readEvents(context.envelope.run_id);
    const terminal = event({
      run_id: context.envelope.run_id,
      seq: (events.at(-1)?.seq ?? -1) + 1,
      phase: "judge",
      kind: "run.errored",
      actor: "arena",
      data: { error: { code: details.code, message: details.message } }
    });
    await this.#options.runStore.appendEvent(context.envelope.run_id, terminal);
    this.#options.eventBus.publishPersisted(terminal);
    return verdict;
  }

  async #executeAttempt(context: RunContext): Promise<VerdictBundle> {
    const { run_id: runId } = context.envelope;
    context.envelope = RunEnvelopeSchema.parse({ ...context.envelope, state: "running" });
    await this.#options.runStore.writeRecord(runId, "run.json", context.envelope);
    const loaded = await this.#options.loadManifest(context.manifestId);
    const manifest = ArenaManifestSchema.parse(loaded.manifest);
    const snapshot = SkillSnapshotSchema.parse(
      await this.#options.loadSnapshot(context.envelope.snapshot_hash)
    );
    if (manifest.id !== context.manifestId
      || loaded.hash !== context.envelope.manifest_hash
      || loaded.hash !== sha256(canonicalJson(manifest))) {
      throw new Error("Manifest provider drifted after run creation");
    }
    try {
      validateSnapshotIdentity(snapshot, {
        expected_source_hash: context.envelope.snapshot_hash,
        expected_execution_fingerprint: context.snapshotExecutionFingerprint
      });
    } catch {
      throw new Error("Snapshot provider drifted after run creation");
    }
    let nextSeq = 0;
    let persistenceQueue = Promise.resolve();
    let persistenceError: unknown;
    const persist = async (traceEvent: TraceEvent): Promise<void> => {
      await this.#options.runStore.appendEvent(runId, traceEvent);
      this.#options.eventBus.publishPersisted(traceEvent);
    };
    const enqueue = (events: readonly TraceEvent[]): void => {
      persistenceQueue = persistenceQueue.then(async () => {
        if (persistenceError !== undefined) return;
        for (const traceEvent of events) await persist(traceEvent);
      }).catch((error: unknown) => {
        persistenceError ??= error;
      });
    };
    const drain = async (): Promise<void> => {
      await persistenceQueue;
      if (persistenceError !== undefined) throw persistenceError;
    };

    await persist(event({
      run_id: runId, seq: nextSeq++, phase: "preflight", kind: "run.started",
      actor: "arena", data: { manifest_id: manifest.id }
    }));

    const workspaceRoot = await privateCanonicalDirectory(this.#options.workspaceRoot);
    const workspace = path.join(workspaceRoot, runId);
    if (path.dirname(workspace) !== workspaceRoot) throw new Error("Run workspace escapes root");
    await mkdir(workspace, { mode: 0o700 });
    context.workspace = await captureOwnedDirectory(workspaceRoot, workspace);
    const baseline: FixtureBaseline = await materializeFixture(manifest.fixture.id, workspace);
    const installedSkill = await copySnapshot(snapshot, workspace);
    const outputRoot = await privateCanonicalDirectory(this.#options.runnerOutputRoot);
    const token = randomUUID();
    const schemaPath = path.join(outputRoot, `${runId}-${token}.schema.json`);
    const outputPath = path.join(outputRoot, `${runId}-${token}.output.json`);
    const home = path.join(workspace, ".git", "arena-home");
    const temporary = path.join(workspace, ".git", "arena-tmp");
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(temporary, { recursive: true, mode: 0o700 })
    ]);
    let runnerPath = explicitToolPath(this.#options.toolPath);
    const faultIds = manifest.fault_cards.map(({ id }) => id);
    let missingToolRoot: OwnedDirectory | undefined;
    if (faultIds.includes("missing-tool")) {
      const { pathPrefix } = await installMissingToolFault(workspace, "rg");
      missingToolRoot = await captureOwnedDirectory(workspace, pathPrefix);
      runnerPath = `${pathPrefix}${path.delimiter}${runnerPath}`;
    }
    const runnerView = buildRunnerView(manifest);
    const prompt = [
      "Use the imported Skill to complete the Arena Runner brief.",
      `IMPORTED_SKILL_ENTRYPOINT=${JSON.stringify(installedSkill.entrypoint)}`,
      `RUNNER_VIEW_JSON=${canonicalJson(runnerView)}`
    ].join("\n");
    const normalizeContext: NormalizeContext = {
      run_id: runId,
      phase: "patch",
      next_seq: 0,
      artifact_sink: {
        put: async (data, metadata, options) => {
          options.signal.throwIfAborted();
          const stored = await this.#options.artifactStore.put(data, metadata);
          options.signal.throwIfAborted();
          return { ref: stored.ref };
        }
      } satisfies ArtifactSink
    };

    const ownedSchema = await createOwnedFile(
      schemaPath,
      canonicalJson(FinalClaimJsonSchema)
    );
    let claim: FinalClaim;
    let ownedOutput: { path: string; dev: number; ino: number } | undefined;
    try {
      const result = await this.#options.runner.run({
        run_id: runId,
        cwd: workspace,
        prompt,
        model: "gpt-5.6",
        sandbox: "workspace-write",
        output_schema_path: schemaPath,
        output_path: outputPath,
        timeout_ms: manifest.budgets.wall_time_s * 1000,
        tool_env: {
          HOME: home,
          PATH: runnerPath,
          TMPDIR: temporary,
          LANG: "C",
          LC_ALL: "C",
          CI: "1",
          NO_COLOR: "1"
        }
      }, async (raw, delivery) => {
        const normalized = await normalizeCodexEvent(raw, normalizeContext);
        const accepted = normalized.filter(({ kind }) =>
          kind !== "run.started" && kind !== "run.finished" && kind !== "run.errored"
        );
        delivery.commit(() => {
          const committed = accepted.map((candidate, index) =>
            TraceEventSchema.parse({ ...candidate, seq: nextSeq + index })
          );
          nextSeq += committed.length;
          enqueue(committed);
        });
      });
      ownedOutput = result.owned_output;
      await drain();
      claim = FinalClaimSchema.parse(result.structured_output);
    } catch (error) {
      await drain();
      throw error;
    } finally {
      await Promise.all([
        removeOwnedOutput(schemaPath, ownedSchema),
        removeOwnedOutput(outputPath, ownedOutput)
      ]);
    }

    await persist(event({
      run_id: runId, seq: nextSeq++, phase: "claim", kind: "agent.claimed",
      actor: "gpt-5.6", data: { claim }
    }));
    context.envelope = RunEnvelopeSchema.parse({ ...context.envelope, state: "judging" });
    await this.#options.runStore.writeRecord(runId, "run.json", context.envelope);
    await persist(event({
      run_id: runId, seq: nextSeq++, phase: "judge", kind: "phase.entered",
      actor: "arena", data: { phase: "judge" }
    }));

    // Runtime-only roots must not influence the locked filesystem audit. Root
    // identity is checked before a no-follow removal; no path-based chmod is used.
    await Promise.all([
      removeOwnedDirectory(installedSkill.infrastructureRoot),
      ...(missingToolRoot === undefined ? [] : [removeOwnedDirectory(missingToolRoot)])
    ]);
    const trace = await this.#options.runStore.readEvents(runId);
    const dirtyVerdict = VerdictBundleSchema.parse(await verifyDirtyTree({
      run_id: runId,
      workspace,
      baseline,
      final_claim: claim,
      trace,
      artifact_store: this.#options.artifactStore
    }));
    if (dirtyVerdict.status === "error") {
      const failure = new Error(dirtyVerdict.error.message) as Error & { code: string };
      failure.code = dirtyVerdict.error.code;
      throw failure;
    }
    let verdict: VerdictBundle;
    const onlyFault = faultIds.length === 1 ? faultIds[0] : undefined;
    if (manifest.id === "repo-dirty-tree-v1" && onlyFault === "dirty-tree") {
      verdict = dirtyVerdict;
    } else if (manifest.id === "repo-false-green-v1" && onlyFault === "false-green") {
      const falseGreen = await verifyFalseGreen({
        workspace,
        baseline,
        final_claim: claim,
        trace,
        artifact_store: this.#options.artifactStore
      });
      const available = new Map(dirtyVerdict.verifier_results.map((result) => [result.id, result]));
      for (const result of falseGreen) available.set(result.id, result);
      available.set("scope", effectiveScopeResult(dirtyVerdict.verifier_results));
      verdict = composeVerdict({
        runId,
        manifest,
        available: [...available.values()],
        evidence: [...dirtyVerdict.evidence, ...falseGreen.flatMap(({ evidence }) => evidence)]
      });
    } else if (manifest.id === "repo-missing-tool-v1" && onlyFault === "missing-tool") {
      const available = new Map(dirtyVerdict.verifier_results.map((result) => [result.id, result]));
      available.set("scope", effectiveScopeResult(dirtyVerdict.verifier_results));
      const toolRecovery = scoreMissingToolRetries(
        trace,
        "rg",
        manifest.budgets.max_command_retries
      );
      available.set(toolRecovery.id, toolRecovery);
      verdict = composeVerdict({
        runId,
        manifest,
        available: [...available.values()],
        evidence: [...dirtyVerdict.evidence]
      });
    } else {
      throw new Error(`Unsupported manifest/fault dispatch: ${manifest.id}`);
    }
    if (verdict.status === "error") throw new Error("Verifier dispatcher returned an error verdict");
    const verifierIds = new Set(verdict.verifier_results.map(({ id }) => id));
    for (const verifierId of manifest.verifiers) {
      if (!verifierIds.has(verifierId)) throw new Error(`Verifier result missing: ${verifierId}`);
    }
    await persist(event({
      run_id: runId, seq: nextSeq++, phase: "judge", kind: "verifier.completed",
      actor: "verifier", data: { verifier_results: verdict.verifier_results }
    }));
    await this.#options.runStore.writeRecord(runId, "verdict.json", verdict);
    context.envelope = RunEnvelopeSchema.parse({
      ...context.envelope,
      state: "completed",
      ended_at: (this.#options.now?.() ?? new Date()).toISOString()
    });
    await this.#options.runStore.writeRecord(runId, "run.json", context.envelope);
    await persist(event({
      run_id: runId, seq: nextSeq++, phase: "judge", kind: "run.finished",
      actor: "arena", data: { status: verdict.status, score: verdict.score }
    }));
    return verdict;
  }
}
