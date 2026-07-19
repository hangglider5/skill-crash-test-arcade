import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import open from "open";

import { ArtifactStore } from "../arena/artifact-store.js";
import { buildReplayManifest, loadManifest } from "../arena/manifest.js";
import { RunStore } from "../arena/run-store.js";
import {
  executePreflightCommand,
  runPreflight,
  type PreflightExecutor
} from "../codex/preflight.js";
import { CodexProcessRunner } from "../codex/process.js";
import { CodexStructuredModel } from "../codex/structured.js";
import type { ArtifactRef, Diagnosis, SkillSnapshot, VerdictBundle } from "../protocol/index.js";
import { canonicalJson, sha256 } from "../protocol/index.js";
import { compileSkillContract } from "./contract.js";
import { RunDiagnosisService } from "./diagnosis.js";
import { EventBus } from "./events.js";
import { importSkill } from "./importer.js";
import { RunOrchestrator } from "./orchestrator.js";
import { RepairCoordinator } from "./repair.js";
import {
  readSampleReplay,
  ScriptedRunner,
  ScriptedStructuredModel
} from "./scripted-runner.js";
import {
  createServer,
  ensurePrivateDirectory,
  type ServerDependencies
} from "./server.js";
import { computeSnapshotExecutionFingerprint } from "./snapshot-identity.js";

const INSTALLATION_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

interface CliServer {
  listen(options: { readonly host: string; readonly port: number }): Promise<unknown>;
}

export interface CliRuntime {
  readonly createDependencies: (appData: string) => Promise<ServerDependencies>;
  readonly createServer: (
    dependencies: ServerDependencies,
    options: Parameters<typeof createServer>[1]
  ) => Promise<CliServer>;
  readonly randomBytes: (size: number) => Buffer;
  readonly openBrowser: (url: string) => Promise<unknown>;
  readonly writeLine: (value: string) => void;
}

interface CliOptions {
  readonly port: number;
  readonly appData: string;
  readonly token: string | undefined;
  readonly noOpen: boolean;
}

type RunnerMode = "codex" | "scripted";

export function runnerModeForEnvironment(
  nodeEnv: string | undefined,
  requested: string | undefined
): RunnerMode {
  return requested === "scripted" && (nodeEnv === "development" || nodeEnv === "test")
    ? "scripted"
    : "codex";
}

export async function runScriptedPreflight(
  appData: string,
  gitExecutor?: PreflightExecutor
): ReturnType<typeof runPreflight> {
  const result = await runPreflight({
    appDataDir: appData,
    execute: async (command, args, limits, signal) => {
      if (command === "codex" && args[0] === "--version") {
        return { exit_code: 0, stdout: "codex-cli 0.144.2\n", stderr: "" };
      }
      if (command === "codex" && args[0] === "login") {
        return { exit_code: 0, stdout: "Logged in\n", stderr: "" };
      }
      return gitExecutor === undefined
        ? executePreflightCommand(command, args, limits, signal)
        : gitExecutor(command, args, limits, signal);
    }
  });
  const checks = result.checks.map((check) => check.id === "codex-version"
    ? { ...check, message: "Scripted demo adapter (no Codex process)" }
    : check.id === "codex-login"
      ? { ...check, message: "Codex login is not required by the scripted demo adapter" }
      : check);
  return { ...result, ok: checks.every(({ ok }) => ok), checks };
}

export function createProcessRepairRegistry(
  coordinator: Pick<RepairCoordinator, "createRepairFork" | "readCandidatePatch" | "rejectRepair" | "approveAndRerun">
): Pick<ServerDependencies, "repairs" | "loadRepair"> {
  const records = new Map<string, Record<string, unknown>>();
  const activeByRun = new Map<string, string>();
  const activeRecord = (repairId: string): { runId: string; record: Record<string, unknown> } => {
    const record = records.get(repairId);
    const runId = typeof record?.run_id === "string" ? record.run_id : undefined;
    if (record === undefined || runId === undefined || activeByRun.get(runId) !== repairId) {
      throw new Error(`Repair is not active: ${repairId}`);
    }
    return { runId, record };
  };
  return {
    repairs: {
      async createRepairFork(runId) {
        const value = await coordinator.createRepairFork(runId);
        if (value.run_id !== runId) throw new Error("Repair membership drifted");
        const previousId = activeByRun.get(runId);
        const previous = previousId === undefined ? undefined : records.get(previousId);
        if (previous !== undefined && previous.status === "pending") {
          records.set(previousId!, {
            ...previous,
            status: "rejected",
            reason: { code: "SUPERSEDED" }
          });
        }
        records.set(value.repair_id, { schema: "arena.repair/v1", ...value });
        activeByRun.set(runId, value.repair_id);
        return value;
      },
      async readCandidatePatch(repairId) {
        const { record } = activeRecord(repairId);
        if (record.status !== "pending") throw new Error("Candidate patch is unavailable");
        const candidate = await coordinator.readCandidatePatch(repairId);
        const { record: current } = activeRecord(repairId);
        if (current !== record || current.status !== "pending") {
          throw new Error("Candidate patch is unavailable");
        }
        if (candidate.repair_id !== repairId || candidate.patch_ref !== record.patch_ref) {
          throw new Error("Candidate patch is unavailable");
        }
        return candidate;
      },
      async rejectRepair(repairId) {
        const { record } = activeRecord(repairId);
        if (record.status !== "pending") throw new Error(`Repair is not pending: ${repairId}`);
        await coordinator.rejectRepair(repairId);
        const { record: current } = activeRecord(repairId);
        if (current !== record || current.status !== "pending") {
          throw new Error(`Repair is not pending: ${repairId}`);
        }
        const rejected = { ...record, status: "rejected", reason: { code: "USER_REJECTED" } };
        records.set(repairId, rejected);
        return rejected;
      },
      async approveAndRerun(repairId) {
        const { record: existing } = activeRecord(repairId);
        if (existing.status !== "pending") {
          throw new Error(`Repair is not pending: ${repairId}`);
        }
        let child;
        try {
          child = await coordinator.approveAndRerun(repairId);
        } catch (error) {
          const current = records.get(repairId);
          const runId = typeof current?.run_id === "string" ? current.run_id : undefined;
          if (current === existing && runId !== undefined
            && activeByRun.get(runId) === repairId && current.status === "pending") {
            const { error: _error, child_run_id: _child, new_snapshot_hash: _snapshot, ...base }
              = current;
            records.set(repairId, {
              ...base,
              status: "failed",
              error: { code: "REPAIR_APPROVAL_FAILED" }
            });
          }
          throw error;
        }
        const { record: current } = activeRecord(repairId);
        if (current !== existing || current.status !== "pending") {
          throw new Error(`Repair is not active: ${repairId}`);
        }
        const { error: _error, child_run_id: _child, new_snapshot_hash: _snapshot, ...base }
          = current;
        records.set(repairId, {
          ...base,
          status: "approved",
          child_run_id: child.run_id,
          new_snapshot_hash: child.snapshot_hash,
          reviewed_patch_ref: current.patch_ref
        });
        return child;
      }
    },
    loadRepair: async (runId) => {
      const repairId = activeByRun.get(runId);
      return repairId === undefined ? undefined : records.get(repairId);
    }
  };
}

function parseArgs(argv: readonly string[]): CliOptions {
  let port = 4317;
  let appData = path.resolve(".arena");
  let token: string | undefined;
  let noOpen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--no-open") {
      noOpen = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${argument}`);
    switch (argument) {
      case "--port": {
        if (!/^[0-9]+$/u.test(value)) throw new Error("Port must be an integer");
        port = Number(value);
        if (port < 1 || port > 65_535) throw new Error("Port is out of range");
        break;
      }
      case "--app-data":
        appData = path.resolve(value);
        break;
      case "--dev-token":
        if (value.length === 0 || value.includes("\0")) throw new Error("Invalid dev token");
        token = value;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
    index += 1;
  }
  return { port, appData, token, noOpen };
}

export async function createDefaultServerDependencies(
  configuredAppData: string
): Promise<ServerDependencies> {
  // The orchestrator, snapshot catalog, verdicts, diagnoses, and repair
  // authority intentionally share the existing process-lifetime-only MVP
  // recovery policy. Restart does not reconstruct executable run authority.
  const appData = path.resolve(configuredAppData);
  const directories = {
    imports: path.join(appData, "imports"),
    runs: path.join(appData, "runs"),
    artifacts: path.join(appData, "artifacts"),
    workspaces: path.join(appData, "workspaces"),
    runner: path.join(appData, "runner-output"),
    repairs: path.join(appData, "repairs"),
    uploads: path.join(appData, "uploads")
  };
  await ensurePrivateDirectory(appData);
  for (const directory of Object.values(directories)) {
    await ensurePrivateDirectory(directory, appData);
  }

  const manifestFiles = ["dirty-tree.v1.json", "false-green.v1.json", "missing-tool.v1.json"];
  const loaded = await Promise.all(manifestFiles.map(async (name) => {
    return loadManifest(path.join(INSTALLATION_ROOT, "manifests", name));
  }));
  const manifests = new Map(loaded.map((value) => [value.manifest.id, value]));
  const snapshots = new Map<string, SkillSnapshot>();
  const verdicts = new Map<string, VerdictBundle>();
  const diagnoses = new Map<string, Diagnosis>();
  const runIds = new Set<string>();
  const runStore = new RunStore(directories.runs);
  const artifactStore = new ArtifactStore(directories.artifacts);
  const eventBus = new EventBus();
  const artifactSink = {
    async put(
      data: Uint8Array,
      metadata: { mime: string; redacted: boolean },
      options: { signal: AbortSignal }
    ) {
      if (options.signal.aborted) throw new Error("Artifact write aborted");
      return artifactStore.put(data, metadata);
    }
  };
  const runnerMode = runnerModeForEnvironment(process.env.NODE_ENV, process.env.SCTA_RUNNER);
  const runner = runnerMode === "scripted"
    ? new ScriptedRunner()
    : new CodexProcessRunner({ ownedOutputRoot: directories.runner, artifactSink });
  const model = runnerMode === "scripted"
    ? new ScriptedStructuredModel()
    : new CodexStructuredModel({ runner, tempRoot: directories.runner });
  const toolPath = [
    path.dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ].join(path.delimiter);
  const requireManifest = async (id: string) => {
    const manifest = manifests.get(id);
    if (manifest === undefined) throw new Error(`Unknown manifest: ${id}`);
    return manifest;
  };
  const requireSnapshot = async (hash: string): Promise<SkillSnapshot> => {
    const snapshot = snapshots.get(hash);
    if (snapshot === undefined) throw new Error(`Unknown snapshot: ${hash}`);
    return snapshot;
  };
  const orchestrator = new RunOrchestrator({
    runStore,
    artifactStore,
    eventBus,
    workspaceRoot: directories.workspaces,
    runnerOutputRoot: directories.runner,
    workspaceCleanupPolicy: "retain-until-report-export",
    runner,
    loadManifest: requireManifest,
    loadSnapshot: requireSnapshot,
    toolPath
  });
  const execute = async (runId: string): Promise<VerdictBundle> => {
    const value = await orchestrator.execute(runId);
    verdicts.set(runId, value);
    return value;
  };
  const createRun = async (request: Parameters<RunOrchestrator["createRun"]>[0]) => {
    const value = await orchestrator.createRun(request);
    runIds.add(value.run_id);
    return value;
  };
  const diagnosisService = new RunDiagnosisService({
    runStore,
    model,
    loadRunContext: async (runId) => orchestrator.getRunContext(runId),
    loadVerdict: async (runId) => {
      const value = verdicts.get(runId);
      if (value === undefined) throw new Error(`Verdict is unavailable: ${runId}`);
      return value;
    },
    loadSnapshot: requireSnapshot,
    loadArtifactSummary: async (ref: ArtifactRef) => {
      const record = await artifactStore.stat(ref);
      return {
        ref: record.ref,
        mime: record.mime,
        bytes: record.bytes,
        redacted: record.redacted
      };
    },
    modelCwd: directories.runner,
    timeoutMs: 120_000
  });
  const repairCoordinator = new RepairCoordinator({
    runStore,
    artifactStore,
    runner,
    repairsRoot: directories.repairs,
    importsRoot: directories.imports,
    runnerOutputRoot: directories.runner,
    trialCoordinationDomain: appData,
    toolPath,
    timeoutMs: 300_000,
    diagnosisService,
    loadRunContext: async (runId) => orchestrator.getRunContext(runId),
    loadVerdict: async (runId) => {
      const value = verdicts.get(runId);
      if (value === undefined) throw new Error(`Verdict is unavailable: ${runId}`);
      return value;
    },
    loadSnapshot: requireSnapshot,
    loadDiagnosis: async (runId) => {
      const value = diagnoses.get(runId);
      if (value === undefined) throw new Error(`Diagnosis is unavailable: ${runId}`);
      return value;
    },
    importRepairedSnapshot: async (sourcePath, original) => {
      const value = await importSkill({
        kind: "local",
        path: sourcePath,
        entrypoint: original.entrypoint
      }, directories.imports);
      snapshots.set(value.source_hash, value);
      return value;
    },
    listRunsForGroup: async (runGroupId) => [...runIds]
      .map((runId) => orchestrator.getRunContext(runId).envelope)
      .filter((run) => run.run_group_id === runGroupId),
    createChildRun: createRun,
    executeChildRun: execute
  });
  const repairRegistry = createProcessRepairRegistry(repairCoordinator);

  return {
    loadSampleReplay: async (id) => {
      if (id !== "dirty-tree") throw new Error(`Unknown Recorded Replay: ${id}`);
      return readSampleReplay(path.join(
        INSTALLATION_ROOT,
        "samples",
        "replays",
        "dirty-tree"
      ));
    },
    preflight: async () => runnerMode === "scripted"
      ? runScriptedPreflight(appData)
      : runPreflight({ appDataDir: appData }),
    importSkill: async (request, root) => {
      const value = await importSkill(request, root);
      snapshots.set(value.source_hash, value);
      return value;
    },
    loadSnapshot: requireSnapshot,
    compileContract: async (snapshot) => compileSkillContract(snapshot, model),
    listManifests: async () => loaded.map(({ manifest }) => buildReplayManifest(manifest)),
    resolveRunLineage: async (manifestId, snapshotHash) => {
      const [{ manifest, hash }, snapshot] = await Promise.all([
        requireManifest(manifestId),
        requireSnapshot(snapshotHash)
      ]);
      return {
        manifest_hash: hash,
        fixture_hash: sha256(canonicalJson(manifest.fixture)),
        runner: { adapter: "codex-cli", model: "gpt-5.6-sol" },
        snapshot_execution_fingerprint: computeSnapshotExecutionFingerprint(snapshot)
      };
    },
    orchestrator: {
      createRun,
      execute,
      getRunContext: (runId) => orchestrator.getRunContext(runId),
      finalizeWorkspace: async (runId, authorization) => {
        return orchestrator.finalizeWorkspace(runId, authorization);
      }
    },
    runStore,
    eventBus,
    diagnosis: {
      async diagnoseRun(runId) {
        const value = await diagnosisService.diagnoseRun(runId);
        diagnoses.set(runId, value);
        return value;
      }
    },
    repairs: repairRegistry.repairs,
    loadVerdict: async (runId) => {
      const value = verdicts.get(runId);
      if (value === undefined) throw new Error(`Verdict is unavailable: ${runId}`);
      return value;
    },
    loadDiagnosis: async (runId) => diagnoses.get(runId),
    loadRepair: repairRegistry.loadRepair,
    loadArtifactRecord: async (ref) => artifactStore.stat(ref)
  };
}

const defaultRuntime: CliRuntime = {
  createDependencies: createDefaultServerDependencies,
  createServer,
  randomBytes,
  async openBrowser(url) { await open(url); },
  writeLine(value) { process.stdout.write(`${value}\n`); }
};

async function productionWebDist(): Promise<string | undefined> {
  const candidate = path.join(INSTALLATION_ROOT, "dist", "web");
  try {
    return (await stat(candidate)).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export async function startCli(
  argv: readonly string[],
  runtime: CliRuntime = defaultRuntime
): Promise<void> {
  const parsed = parseArgs(argv);
  const token = parsed.token ?? runtime.randomBytes(32).toString("hex");
  const dependencies = await runtime.createDependencies(parsed.appData);
  const app = await runtime.createServer(dependencies, {
    sessionToken: token,
    appData: parsed.appData,
    webDist: await productionWebDist()
  });
  await app.listen({ host: "127.0.0.1", port: parsed.port });
  const url = `http://localhost:${parsed.port}/?token=${encodeURIComponent(token)}`;
  runtime.writeLine(url);
  if (!parsed.noOpen) await runtime.openBrowser(url);
}

if (process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void startCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Arena startup failed"}\n`);
    process.exitCode = 1;
  });
}
