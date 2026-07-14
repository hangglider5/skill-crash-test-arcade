import { randomBytes } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import open from "open";

import { ArtifactStore } from "../arena/artifact-store.js";
import { buildReplayManifest, loadManifest } from "../arena/manifest.js";
import { RunStore } from "../arena/run-store.js";
import { runPreflight } from "../codex/preflight.js";
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
import { createServer, type ServerDependencies } from "./server.js";
import { computeSnapshotExecutionFingerprint } from "./snapshot-identity.js";

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
    repairs: path.join(appData, "repairs")
  };
  await mkdir(appData, { recursive: true, mode: 0o700 });
  await Promise.all(Object.values(directories).map(async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }));

  const manifestFiles = ["dirty-tree.v1.json", "false-green.v1.json", "missing-tool.v1.json"];
  const loaded = await Promise.all(manifestFiles.map(async (name) => {
    return loadManifest(path.resolve("manifests", name));
  }));
  const manifests = new Map(loaded.map((value) => [value.manifest.id, value]));
  const snapshots = new Map<string, SkillSnapshot>();
  const verdicts = new Map<string, VerdictBundle>();
  const diagnoses = new Map<string, Diagnosis>();
  const repairs = new Map<string, unknown>();
  const repairOwners = new Map<string, string>();
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
  const runner = new CodexProcessRunner({
    ownedOutputRoot: directories.runner,
    artifactSink
  });
  const model = new CodexStructuredModel({ runner, tempRoot: directories.runner });
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
    loadArtifactSummary: async (ref: ArtifactRef) => ({
      ref,
      mime: "application/octet-stream",
      bytes: (await artifactStore.read(ref)).byteLength,
      redacted: true
    }),
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

  return {
    preflight: async () => runPreflight({ appDataDir: appData }),
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
        runner: { adapter: "codex-cli", model: "gpt-5.6" },
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
    repairs: {
      async createRepairFork(runId) {
        const value = await repairCoordinator.createRepairFork(runId);
        repairs.set(runId, value);
        repairOwners.set(value.repair_id, runId);
        return value;
      },
      async approveAndRerun(repairId) {
        const child = await repairCoordinator.approveAndRerun(repairId);
        const runId = repairOwners.get(repairId);
        const existing = runId === undefined ? undefined : repairs.get(runId);
        if (runId !== undefined && typeof existing === "object" && existing !== null) {
          repairs.set(runId, {
            ...existing,
            status: "approved",
            child_run_id: child.run_id,
            new_snapshot_hash: child.snapshot_hash
          });
        }
        return child;
      }
    },
    loadVerdict: async (runId) => {
      const value = verdicts.get(runId);
      if (value === undefined) throw new Error(`Verdict is unavailable: ${runId}`);
      return value;
    },
    loadDiagnosis: async (runId) => diagnoses.get(runId),
    loadRepair: async (runId) => repairs.get(runId)
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
  const candidate = path.resolve("dist/web");
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
