import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ArtifactStore } from "../src/arena/artifact-store.js";
import { loadManifest } from "../src/arena/manifest.js";
import { RunStore } from "../src/arena/run-store.js";
import type { StructuredModel, StructuredRunRequest } from "../src/codex/structured.js";
import { RunDiagnosisService } from "../src/core/diagnosis.js";
import { EventBus } from "../src/core/events.js";
import { importSkill } from "../src/core/importer.js";
import { RunOrchestrator } from "../src/core/orchestrator.js";
import {
  SampleReplaySchema,
  ScriptedRunner,
  sanitizeRecordedArtifact,
  type SampleReplay
} from "../src/core/scripted-runner.js";
import { computeSnapshotExecutionFingerprint } from "../src/core/snapshot-identity.js";
import {
  ArtifactRefSchema,
  canonicalJson,
  sha256,
  type Diagnosis,
  type EvidenceRef
} from "../src/protocol/index.js";

const INSTALLATION_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const FIXED_NOW = new Date("2026-07-15T00:00:00.000Z");
const SECRET_KEY = /(?:^|_)(?:token|secret|password|api_?key|codex_home)(?:$|_)/iu;
const SECRET_VALUE = /(?:OPENAI_API_KEY|CODEX_HOME|sk-[A-Za-z0-9_-]+)/u;
const FILE_URI = /file:\/\/[^\s"'`,;)\]}]*/u;
const EMBEDDED_ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9._/-])\/(?!\/)[^\s"'`,;)\]}]+/u;

export interface GenerateSampleReplayOptions {
  readonly appData: string;
  readonly output: string;
}

class FakeDiagnosisModel implements StructuredModel {
  readonly #runId: string;
  readonly #evidence: EvidenceRef;

  constructor(runId: string, evidence: EvidenceRef) {
    this.#runId = runId;
    this.#evidence = evidence;
  }

  async run<T>(request: StructuredRunRequest<T>): Promise<T> {
    return request.parse({
      schema: "arena.diagnosis/v1",
      run_id: this.#runId,
      model: "gpt-5.6",
      observed_failure: "The target bug was fixed, but the pre-existing roadmap draft was overwritten.",
      likely_skill_gap: "The Skill lacks an explicit rule to preserve unrelated pre-existing changes.",
      retry_analysis: "No meaningless retry occurred; the failure is a workflow policy gap.",
      suggested_changes: [
        "Inspect the dirty tree before editing and preserve every unrelated pre-existing change.",
        "Report full-suite and protected-file preservation evidence."
      ],
      evidence_refs: [this.#evidence]
    });
  }
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue;
      output[key] = sanitize(child);
    }
    return output;
  }
  if (typeof value === "string" && (SECRET_VALUE.test(value)
    || path.isAbsolute(value) || FILE_URI.test(value) || EMBEDDED_ABSOLUTE_PATH.test(value))) {
    return "[REDACTED]";
  }
  return value;
}

async function bundleRecordedArtifacts(
  replay: SampleReplay,
  artifactStore: ArtifactStore
): Promise<unknown> {
  const orderedRefs = [...new Set([
    ...replay.verdict.evidence,
    ...replay.verdict.dimensions.flatMap(({ evidence }) => evidence),
    ...replay.verdict.verifier_results.flatMap(({ evidence }) => evidence),
    ...replay.diagnosis.evidence_refs,
    ...replay.trace.flatMap(({ artifacts }) => artifacts)
  ].filter((ref): ref is `sha256:${string}` => ArtifactRefSchema.safeParse(ref).success))];
  const replacement = new Map<string, string>();
  const records = new Map<string, {
    ref: string;
    mime: string;
    redacted: true;
    encoding: "base64";
    data: string;
  }>();
  for (const ref of orderedRefs) {
    const [record, original] = await Promise.all([
      artifactStore.stat(ref),
      artifactStore.read(ref)
    ]);
    const sanitized = sanitizeRecordedArtifact(record, original);
    const bytes = sanitized.bytes;
    const nextRef = `sha256:${sha256(bytes)}`;
    replacement.set(ref, nextRef);
    records.set(nextRef, {
      ref: nextRef,
      mime: sanitized.mime,
      redacted: true,
      encoding: "base64",
      data: bytes.toString("base64")
    });
  }
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
    }
    return typeof value === "string" ? replacement.get(value) ?? value : value;
  };
  const replaced = replace(replay) as SampleReplay;
  const verifierIndex = replaced.trace.findIndex(({ kind }) => kind === "verifier.completed");
  if (verifierIndex < 0) throw new Error("Recorded Replay is missing verifier evidence");
  return {
    ...replaced,
    trace: replaced.trace.map((event, index) => index === verifierIndex
      ? { ...event, data: { ...event.data, recorded_artifacts: [...records.values()] } }
      : event)
  };
}

async function privateDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const stats = await lstat(absolute);
  const canonical = await realpath(absolute);
  if (!stats.isDirectory() || stats.isSymbolicLink() || canonical !== absolute) {
    throw new Error("Sample generation directory must be canonical");
  }
  return canonical;
}

async function writeReplay(output: string, replay: SampleReplay): Promise<void> {
  const root = await privateDirectory(output);
  const files = {
    "run.json": `${canonicalJson(replay.run)}\n`,
    "verdict.json": `${canonicalJson(replay.verdict)}\n`,
    "diagnosis.json": `${canonicalJson(replay.diagnosis)}\n`,
    "trace.jsonl": `${replay.trace.map((event) => canonicalJson(event)).join("\n")}\n`
  } as const;
  await Promise.all(Object.entries(files).map(async ([name, contents]) => {
    const target = path.join(root, name);
    if (path.dirname(target) !== root) throw new Error("Sample output path escaped its root");
    await writeFile(target, contents, { mode: 0o600 });
  }));
}

export async function generateSampleReplay(
  options: GenerateSampleReplayOptions
): Promise<SampleReplay> {
  const appData = await privateDirectory(options.appData);
  const directories = {
    imports: await privateDirectory(path.join(appData, "imports")),
    workspaces: await privateDirectory(path.join(appData, "workspaces")),
    runner: await privateDirectory(path.join(appData, "runner")),
    runs: await privateDirectory(path.join(appData, "runs")),
    artifacts: await privateDirectory(path.join(appData, "artifacts"))
  };
  const [manifest, snapshot] = await Promise.all([
    loadManifest(path.join(INSTALLATION_ROOT, "manifests", "dirty-tree.v1.json")),
    importSkill({ kind: "sample", id: "repo-bugfix" }, directories.imports)
  ]);
  const runStore = new RunStore(directories.runs);
  const artifactStore = new ArtifactStore(directories.artifacts);
  const orchestrator = new RunOrchestrator({
    runStore,
    artifactStore,
    eventBus: new EventBus(),
    workspaceRoot: directories.workspaces,
    runnerOutputRoot: directories.runner,
    workspaceCleanupPolicy: "retain-until-report-export",
    runner: new ScriptedRunner(),
    loadManifest: async (id) => {
      if (id !== manifest.manifest.id) throw new Error("Unknown sample manifest");
      return manifest;
    },
    loadSnapshot: async (hash) => {
      if (hash !== snapshot.source_hash) throw new Error("Unknown sample snapshot");
      return snapshot;
    },
    now: () => FIXED_NOW,
    idFactory: () => "sample_dirty_tree",
    toolPath: [
      path.dirname(process.execPath),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin"
    ].join(path.delimiter)
  });
  const run = await orchestrator.createRun({
    manifest_id: manifest.manifest.id,
    snapshot_hash: snapshot.source_hash,
    run_group_id: "group_sample_dirty_tree",
    trial_index: 0,
    expected_lineage: {
      manifest_hash: manifest.hash,
      fixture_hash: sha256(canonicalJson(manifest.manifest.fixture)),
      runner: { adapter: "codex-cli", model: "gpt-5.6" },
      snapshot_execution_fingerprint: computeSnapshotExecutionFingerprint(snapshot)
    }
  });
  const verdict = await orchestrator.execute(run.run_id);
  if (verdict.status !== "defeat" || verdict.evidence[0] === undefined) {
    throw new Error("Scripted baseline did not produce the expected judgeable defeat");
  }
  const diagnosisService = new RunDiagnosisService({
    runStore,
    model: new FakeDiagnosisModel(run.run_id, verdict.evidence[0]),
    loadRunContext: async (runId) => orchestrator.getRunContext(runId),
    loadVerdict: async (runId) => {
      if (runId !== run.run_id) throw new Error("Unknown sample verdict");
      return verdict;
    },
    loadSnapshot: async (hash) => {
      if (hash !== snapshot.source_hash) throw new Error("Unknown sample snapshot");
      return snapshot;
    },
    loadArtifactSummary: async (ref) => {
      const record = await artifactStore.stat(ref);
      return {
        ref: record.ref,
        mime: record.mime,
        bytes: record.bytes,
        redacted: record.redacted
      };
    },
    modelCwd: directories.runner,
    timeoutMs: 10_000
  });
  const diagnosis: Diagnosis = await diagnosisService.diagnoseRun(run.run_id);
  const lockedRun = orchestrator.getRunContext(run.run_id).envelope;
  const trace = await runStore.readEvents(run.run_id);
  const sanitized = sanitize({
    schema: "arena.sample-replay/v1",
    run: lockedRun,
    trace,
    verdict,
    diagnosis
  }) as SampleReplay;
  const replay = SampleReplaySchema.parse(
    await bundleRecordedArtifacts(sanitized, artifactStore)
  ) as SampleReplay;
  await writeReplay(options.output, replay);
  return replay;
}

if (process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void (async () => {
    const appData = await realpath(await mkdtemp(path.join(tmpdir(), "scta-sample-generation-")));
    try {
      const replay = await generateSampleReplay({
        appData,
        output: path.join(INSTALLATION_ROOT, "samples", "replays", "dirty-tree")
      });
      process.stdout.write(`${replay.verdict.status} ${replay.verdict.status === "error" ? "error" : replay.verdict.score}\n`);
    } finally {
      const makeDirectoriesWritable = async (directory: string): Promise<void> => {
        const stats = await lstat(directory).catch(() => undefined);
        if (stats?.isDirectory() !== true || stats.isSymbolicLink()) return;
        await chmod(directory, 0o700);
        await Promise.all((await readdir(directory)).map((name) =>
          makeDirectoriesWritable(path.join(directory, name))
        ));
      };
      await makeDirectoriesWritable(appData);
      await rm(appData, { recursive: true, force: true });
    }
  })().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Sample generation failed"}\n`);
    process.exitCode = 1;
  });
}
