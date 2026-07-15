import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../../src/core/events.js";
import {
  createServer,
  type ServerDependencies
} from "../../src/core/server.js";
import {
  createDefaultServerDependencies,
  createProcessRepairRegistry,
  startCli
} from "../../src/core/cli.js";
import type { RepairProposal } from "../../src/core/repair.js";
import {
  computeSnapshotExecutionFingerprint,
  computeSnapshotSourceHash
} from "../../src/core/snapshot-identity.js";
import type {
  ArtifactRef,
  Diagnosis,
  RunEnvelope,
  SkillContract,
  SkillSnapshot,
  TraceEvent,
  VerdictBundle
} from "../../src/protocol/index.js";

const roots: string[] = [];
const hashA = "a".repeat(64);
const hashC = "c".repeat(64);
const secretSource = "/Users/alice/private/source";
const snapshotSource = { kind: "local" as const, uri: `file://${secretSource}` };
const snapshotFiles = [{ path: "SKILL.md", bytes: 8, sha256: hashA }];
const hashB = computeSnapshotSourceHash({ source: snapshotSource, files: snapshotFiles });

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-server-")));
  roots.push(root);
  return root;
}

function snapshot(): SkillSnapshot {
  return {
    schema: "arena.skill-snapshot/v1",
    source: snapshotSource,
    entrypoint: "SKILL.md",
    license: "MIT",
    files: snapshotFiles,
    source_hash: hashB,
    imported_path: secretSource
  };
}

const trustedFingerprint = computeSnapshotExecutionFingerprint(snapshot());

function envelope(state: RunEnvelope["state"] = "completed"): RunEnvelope {
  return {
    schema: "arena.run/v1",
    run_id: "run_01",
    run_group_id: "group_server",
    trial_index: 0,
    manifest_hash: hashA,
    snapshot_hash: hashB,
    fixture_hash: hashC,
    runner: { adapter: "codex-cli", model: "gpt-5.6" },
    state,
    started_at: "2026-07-15T00:00:00.000Z",
    ...(state === "created" || state === "running" || state === "judging"
      ? {}
      : { ended_at: "2026-07-15T00:01:00.000Z" })
  };
}

function verdict(): VerdictBundle {
  return {
    schema: "arena.verdict/v1",
    run_id: "run_01",
    status: "defeat",
    score: 58,
    hard_gate_failures: ["preserve_existing_changes"],
    dimensions: [],
    verifier_results: [],
    evidence: []
  };
}

function diagnosis(): Diagnosis {
  return {
    schema: "arena.diagnosis/v1",
    run_id: "run_01",
    model: "gpt-5.6",
    observed_failure: "Protected draft changed",
    likely_skill_gap: "Preservation rule missing",
    retry_analysis: "No safe retry",
    suggested_changes: ["Preserve unrelated changes"],
    evidence_refs: ["event:0"]
  };
}

function event(seq: number, kind: TraceEvent["kind"] = "phase.entered"): TraceEvent {
  return {
    v: 1,
    run_id: "run_01",
    seq,
    phase: kind === "run.finished" ? "judge" : "inspect",
    kind,
    actor: "arena",
    data: {
      status: kind === "run.finished" ? "defeat" : "running",
      source_path: secretSource,
      CODEX_HOME: "/secret/codex",
      OPENAI_API_KEY: "sk-test-secret",
      token: "test-token"
    },
    artifacts: []
  };
}

function contract(): SkillContract {
  return {
    schema: "arena.skill-contract/v1",
    snapshot_hash: hashB,
    model: "gpt-5.6",
    promises: [],
    preconditions: [],
    expected_artifacts: [],
    recovery_rules: [],
    risk_signals: []
  };
}

function repairRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "arena.repair/v1",
    repair_id: "repair_01",
    run_id: "run_01",
    status: "pending",
    snapshot_hash: hashB,
    created_at: "2026-07-15T00:02:00.000Z",
    changed_paths: ["SKILL.md"],
    patch_ref: `sha256:${"d".repeat(64)}`,
    ...overrides
  };
}

function repairProposal(): RepairProposal {
  return {
    repair_id: "repair_01",
    run_id: "run_01",
    status: "pending",
    snapshot_hash: hashB,
    created_at: "2026-07-15T00:02:00.000Z",
    changed_paths: ["SKILL.md"],
    patch_ref: `sha256:${"d".repeat(64)}`
  };
}

function dependencies(overrides: Partial<ServerDependencies> = {}): ServerDependencies {
  const bus = new EventBus();
  const created = envelope("created");
  const base: ServerDependencies = {
    async loadSampleReplay() {
      return {
        schema: "arena.sample-replay/v1",
        run: envelope(),
        trace: [event(0), event(1, "run.finished")],
        verdict: verdict(),
        diagnosis: diagnosis()
      };
    },
    async preflight() {
      return {
        ok: true,
        checks: [{ id: "app-data", ok: true, message: "ready" }],
        model: { target: "gpt-5.6", status: "configured-unverified" }
      };
    },
    async importSkill() { return snapshot(); },
    async loadSnapshot(value) {
      if (value !== hashB) throw new Error("snapshot missing");
      return snapshot();
    },
    async compileContract() { return contract(); },
    async listManifests() {
      return [{
        schema: "arena.replay-manifest/v1" as const,
        id: "repo-dirty-tree-v1",
        name: "Dirty Tree Doppelgänger",
        fixture: { id: "dirty-tree", version: 1 },
        fault_cards: [{ id: "dirty-tree", version: 1 }],
        budgets: { wall_time_s: 300, max_command_retries: 2 },
        scoring: { weights: { task_correctness: 40 }, hard_gates: ["preserve_existing_changes"] }
      }];
    },
    async resolveRunLineage(manifestId, snapshotHash) {
      expect(manifestId).toBe("repo-dirty-tree-v1");
      expect(snapshotHash).toBe(hashB);
      return {
        manifest_hash: hashA,
        fixture_hash: hashC,
        runner: { adapter: "codex-cli", model: "gpt-5.6" },
        snapshot_execution_fingerprint: trustedFingerprint
      };
    },
    orchestrator: {
      async createRun(request) {
        expect(request.expected_lineage.snapshot_execution_fingerprint)
          .toBe(trustedFingerprint);
        return created;
      },
      async execute() { return verdict(); },
      getRunContext() {
        return {
          envelope: envelope(),
          manifest_id: "repo-dirty-tree-v1",
          snapshot_execution_fingerprint: trustedFingerprint
        };
      },
      async finalizeWorkspace() { return { removed: true }; }
    },
    runStore: { async readEvents() { return [event(0), event(1, "run.finished")]; } },
    eventBus: bus,
    diagnosis: { async diagnoseRun() { return diagnosis(); } },
    repairs: {
      async createRepairFork() {
        return {
          repair_id: "repair_01",
          run_id: "run_01",
          status: "pending",
          snapshot_hash: hashB,
          created_at: "2026-07-15T00:02:00.000Z",
          changed_paths: ["SKILL.md"],
          patch_ref: `sha256:${"d".repeat(64)}`
        };
      },
      async readCandidatePatch(repairId) {
        return {
          repair_id: repairId,
          patch_ref: `sha256:${"d".repeat(64)}`,
          mime: "text/x-diff",
          bytes: 15,
          redacted: false,
          export_ready: false,
          text: "diff --git a b\n"
        };
      },
      async rejectRepair() { return repairRecord({ status: "rejected", reason: { code: "USER_REJECTED" } }); },
      async approveAndRerun() { return { ...created, parent_run_id: "run_01" }; }
    },
    async loadVerdict() { return verdict(); },
    async loadDiagnosis() { return diagnosis(); },
    async loadRepair() { return repairRecord(); },
    async loadArtifactRecord(ref: ArtifactRef) {
      const digest = ref.slice("sha256:".length);
      const diff = ref === `sha256:${"d".repeat(64)}`;
      return {
        ref,
        sha256: digest,
        bytes: 18,
        mime: diff ? "text/x-diff" : "application/octet-stream",
        redacted: diff
      };
    }
  };
  return { ...base, ...overrides };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Loopback API", () => {
  it("serves static UI assets without weakening API token rules", async () => {
    const root = await temporaryRoot();
    const webDist = path.join(root, "web");
    await mkdir(webDist, { mode: 0o700 });
    await mkdir(path.join(webDist, "api"), { mode: 0o700 });
    await writeFile(path.join(webDist, "index.html"), "<main>Arena UI</main>");
    await writeFile(path.join(webDist, "api", "leak.txt"), "must be protected");
    const app = await createServer(dependencies(), {
      sessionToken: "test-token", appData: root, webDist
    });

    const page = await app.inject({ method: "GET", url: "/?token=test-token" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Arena UI");
    expect((await app.inject({
      method: "GET", url: "/api/manifests?token=test-token"
    })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/leak.txt" })).statusCode).toBe(401);
    await app.close();
  });

  it("leaves health public and rejects every sensitive route without the header token", async () => {
    const root = await temporaryRoot();
    const app = await createServer(dependencies(), {
      sessionToken: "test-token",
      appData: root,
      webDist: undefined
    });

    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    const routes = [
      ["POST", "/api/imports"],
      ["GET", `/api/imports/${hashB}`],
      ["POST", "/api/contracts"],
      ["GET", "/api/manifests"],
      ["POST", "/api/runs"],
      ["GET", "/api/runs/run_01"],
      ["POST", "/api/runs/run_01/diagnose"],
      ["POST", "/api/runs/run_01/repairs"],
      ["GET", "/api/repairs/repair_01/patch"],
      ["POST", "/api/repairs/repair_01/reject"],
      ["POST", "/api/repairs/repair_01/rerun"],
      ["GET", "/api/runs/run_01/report"]
    ] as const;
    for (const [method, url] of routes) {
      const response = await app.inject({ method, url, query: { token: "test-token" } });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json()).toEqual({
        error: { code: "UNAUTHORIZED", message: "Authentication required" }
      });
    }
    expect((await app.inject({
      method: "GET",
      url: "/api/manifests",
      headers: { "x-arena-token": "wrong" }
    })).statusCode).toBe(401);
    await app.close();
  });

  it("exposes the complete authenticated JSON control surface and trusted run lineage", async () => {
    const root = await temporaryRoot();
    const execute = vi.fn(async () => verdict());
    const deps = dependencies({
      orchestrator: {
        ...dependencies().orchestrator,
        execute
      }
    });
    (deps.repairs as typeof deps.repairs & {
      readCandidatePatch(repairId: string): Promise<Record<string, unknown>>;
    }).readCandidatePatch = async (repairId) => ({
      repair_id: repairId,
      patch_ref: `sha256:${"d".repeat(64)}`,
      mime: "text/x-diff",
      bytes: 15,
      redacted: false,
      export_ready: false,
      text: "diff --git a b\n"
    });
    const app = await createServer(deps, {
      sessionToken: "test-token",
      appData: root,
      webDist: undefined,
      idFactory: () => "server-group"
    });
    const auth = { "x-arena-token": "test-token" };

    expect((await app.inject({
      method: "POST", url: "/api/imports", headers: auth,
      payload: { kind: "sample", id: "repo-bugfix" }
    })).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: `/api/imports/${hashB}`, headers: auth })).json())
      .toMatchObject({ source_hash: hashB });
    expect((await app.inject({
      method: "POST", url: "/api/contracts", headers: auth,
      payload: { snapshot_hash: hashB }
    })).json()).toMatchObject({ snapshot_hash: hashB });
    const manifests = (await app.inject({ method: "GET", url: "/api/manifests", headers: auth })).body;
    expect(manifests).not.toContain("judge_pack");
    expect(manifests).not.toContain("runner_brief");

    const created = await app.inject({
      method: "POST", url: "/api/runs", headers: auth,
      payload: {
        manifest_id: "repo-dirty-tree-v1",
        snapshot_hash: hashB,
        expected_lineage: { snapshot_execution_fingerprint: "attacker" }
      }
    });
    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({ run_id: "run_01", run_group_id: "group_server" });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith("run_01"));
    expect((await app.inject({ method: "GET", url: "/api/runs/run_01", headers: auth })).json())
      .toMatchObject({ run_id: "run_01", state: "completed" });
    expect((await app.inject({ method: "POST", url: "/api/runs/run_01/diagnose", headers: auth })).json())
      .toMatchObject({ schema: "arena.diagnosis/v1" });
    expect((await app.inject({ method: "POST", url: "/api/runs/run_01/repairs", headers: auth })).json())
      .toMatchObject({ repair_id: "repair_01" });
    expect((await app.inject({ method: "GET", url: "/api/repairs/repair_01/patch", headers: auth })).json())
      .toEqual({
        repair_id: "repair_01",
        patch_ref: `sha256:${"d".repeat(64)}`,
        mime: "text/x-diff",
        bytes: 15,
        redacted: false,
        export_ready: false,
        text: "diff --git a b\n"
      });
    expect((await app.inject({ method: "POST", url: "/api/repairs/repair_01/reject", headers: auth })).json())
      .toMatchObject({ repair_id: "repair_01", status: "rejected", reason: { code: "USER_REJECTED" } });
    expect((await app.inject({ method: "POST", url: "/api/repairs/repair_01/rerun", headers: auth })).json())
      .toMatchObject({ parent_run_id: "run_01" });
    await app.close();
  });

  it("accepts a bounded ZIP multipart import and removes the temporary upload", async () => {
    const root = await temporaryRoot();
    let observedPath = "";
    const app = await createServer(dependencies({
      async importSkill(request) {
        expect(request.kind).toBe("zip");
        if (request.kind === "zip") {
          observedPath = request.path;
          expect(await readFile(request.path)).toEqual(Buffer.from("zip-bytes"));
        }
        return snapshot();
      }
    }), { sessionToken: "test-token", appData: root, webDist: undefined });
    const boundary = "arena-boundary";
    const body = Buffer.from([
      `--${boundary}\r\n`,
      "Content-Disposition: form-data; name=\"file\"; filename=\"skill.zip\"\r\n",
      "Content-Type: application/zip\r\n\r\n",
      "zip-bytes\r\n",
      `--${boundary}--\r\n`
    ].join(""));

    const response = await app.inject({
      method: "POST", url: "/api/imports",
      headers: {
        "x-arena-token": "test-token",
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload: body
    });
    expect(response.statusCode).toBe(201);
    await expect(readFile(observedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await app.close();
  });

  it("rejects a symlinked upload root before writing any multipart bytes outside app-data", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, path.join(root, "uploads"));
    const importSkill = vi.fn(async () => snapshot());
    const app = await createServer(dependencies({ importSkill }), {
      sessionToken: "test-token", appData: root, webDist: undefined
    });
    const boundary = "arena-symlink-boundary";
    const body = Buffer.from([
      `--${boundary}\r\n`,
      "Content-Disposition: form-data; name=\"file\"; filename=\"skill.zip\"\r\n",
      "Content-Type: application/zip\r\n\r\n",
      "zip-bytes\r\n",
      `--${boundary}--\r\n`
    ].join(""));

    const response = await app.inject({
      method: "POST", url: "/api/imports",
      headers: {
        "x-arena-token": "test-token",
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload: body
    });
    expect(response.statusCode).toBe(500);
    expect(importSkill).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual([]);
    await app.close();
  });

  it("rejects oversized malformed JSON at the transport limit before parsing", async () => {
    const root = await temporaryRoot();
    const importSkill = vi.fn(async () => snapshot());
    const app = await createServer(dependencies({ importSkill }), {
      sessionToken: "test-token", appData: root, webDist: undefined
    });

    const response = await app.inject({
      method: "POST", url: "/api/imports",
      headers: {
        "x-arena-token": "test-token",
        "content-type": "application/json"
      },
      payload: `{${" ".repeat(6 * 1024 * 1024)}`
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request payload is too large" }
    });
    expect(importSkill).not.toHaveBeenCalled();
    await app.close();
  });

  it("allows multipart ZIP bodies above the JSON cap and below the archive cap", async () => {
    const root = await temporaryRoot();
    const payload = Buffer.alloc(6 * 1024 * 1024, 0x61);
    const importSkill = vi.fn(async (request) => {
      if (request.kind !== "zip") throw new Error("expected ZIP import");
      expect((await readFile(request.path)).byteLength).toBe(payload.byteLength);
      return snapshot();
    });
    const app = await createServer(dependencies({ importSkill }), {
      sessionToken: "test-token", appData: root, webDist: undefined
    });
    const boundary = "arena-large-boundary";
    const body = Buffer.concat([
      Buffer.from([
        `--${boundary}\r\n`,
        "Content-Disposition: form-data; name=\"file\"; filename=\"skill.zip\"\r\n",
        "Content-Type: application/zip\r\n\r\n"
      ].join("")),
      payload,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const response = await app.inject({
      method: "POST", url: "/api/imports",
      headers: {
        "x-arena-token": "test-token",
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload: body
    });
    expect(response.statusCode).toBe(201);
    expect(importSkill).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("buffers live SSE events before replay, deduplicates by seq, honors Last-Event-ID, and closes terminal streams", async () => {
    const root = await temporaryRoot();
    const bus = new EventBus();
    const live = event(1);
    const deps = dependencies({
      eventBus: bus,
      runStore: {
        async readEvents() {
          bus.publishPersisted(live);
          return [event(0), live, event(2, "run.finished")];
        }
      }
    });
    const app = await createServer(deps, {
      sessionToken: "test-token", appData: root, webDist: undefined
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/runs/run_01/events?token=test-token",
      headers: { "last-event-id": "0" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body.match(/^id: 1$/gmu)).toHaveLength(1);
    expect(response.body.match(/^id: 2$/gmu)).toHaveLength(1);
    expect(response.body).not.toMatch(/^id: 0$/mu);
    await app.close();
  });

  it("keeps SSE live events buffered until the ordered replay flush is complete", async () => {
    const root = await temporaryRoot();
    const bus = new EventBus();
    const duringSerialization = {
      ...event(1),
      get data() {
        bus.publishPersisted(event(2));
        return { status: "running" };
      }
    } as TraceEvent;
    const app = await createServer(dependencies({
      eventBus: bus,
      runStore: {
        async readEvents() {
          return [event(0), duringSerialization, event(3, "run.finished")];
        }
      }
    }), { sessionToken: "test-token", appData: root, webDist: undefined });

    const response = await app.inject({
      method: "GET",
      url: "/api/runs/run_01/events?token=test-token",
      headers: { "last-event-id": "0" }
    });
    expect(response.statusCode).toBe(200);
    expect([...response.body.matchAll(/^id: ([0-9]+)$/gmu)].map((match) => Number(match[1])))
      .toEqual([1, 2, 3]);
    await app.close();
  });

  it("returns a safe non-200 response and unsubscribes when persisted SSE replay fails", async () => {
    const root = await temporaryRoot();
    const bus = new EventBus();
    const originalSubscribe = bus.subscribe.bind(bus);
    const unsubscribe = vi.fn();
    vi.spyOn(bus, "subscribe").mockImplementation((runId, listener) => {
      const remove = originalSubscribe(runId, listener);
      return () => {
        unsubscribe();
        remove();
      };
    });
    const app = await createServer(dependencies({
      eventBus: bus,
      runStore: { async readEvents() { throw new Error("private replay failure"); } }
    }), { sessionToken: "test-token", appData: root, webDist: undefined });

    const response = await app.inject({
      method: "GET", url: "/api/runs/run_01/events?token=test-token"
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Request failed safely" }
    });
    expect(response.body).not.toContain("private replay failure");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("closes a terminal SSE replay even when Last-Event-ID skips the terminal event", async () => {
    const root = await temporaryRoot();
    const bus = new EventBus();
    const app = await createServer(dependencies({
      eventBus: bus,
      runStore: { async readEvents() { return [event(0), event(1, "run.finished")]; } }
    }), { sessionToken: "test-token", appData: root, webDist: undefined });

    const pending = app.inject({
      method: "GET",
      url: "/api/runs/run_01/events?token=test-token",
      headers: { "last-event-id": "1" }
    });
    const response = await Promise.race([
      pending,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 50))
    ]);
    expect(response, "known terminal replay must close immediately").toBeDefined();
    if (response === undefined) {
      bus.publishPersisted(event(2, "run.finished"));
      await pending;
      throw new Error("terminal replay remained open");
    }
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(/^id:/mu);
    await app.close();
  });

  it("treats an unsafe Last-Event-ID as absent and replays from sequence zero", async () => {
    const root = await temporaryRoot();
    const bus = new EventBus();
    const app = await createServer(dependencies({
      eventBus: bus,
      runStore: { async readEvents() { return [event(0, "run.finished")]; } }
    }), { sessionToken: "test-token", appData: root, webDist: undefined });

    const pending = app.inject({
      method: "GET",
      url: "/api/runs/run_01/events?token=test-token",
      headers: { "last-event-id": "9007199254740992" }
    });
    const response = await Promise.race([
      pending,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 50))
    ]);
    expect(response, "unsafe event IDs must not suppress replay").toBeDefined();
    if (response === undefined) {
      bus.publishPersisted(event(1, "run.finished"));
      await pending;
      throw new Error("unsafe Last-Event-ID suppressed terminal replay");
    }
    expect(response.body).toMatch(/^id: 0$/mu);
    await app.close();
  });

  it("delivers an allowlisted report without waiting for finish-triggered workspace cleanup", async () => {
    const root = await temporaryRoot();
    const order: string[] = [];
    let releaseCleanup!: () => void;
    const cleanupBlocked = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const finalizeWorkspace = vi.fn(async () => {
      order.push("finalize");
      await cleanupBlocked;
      return { removed: true };
    });
    const app = await createServer(dependencies({
      orchestrator: { ...dependencies().orchestrator, finalizeWorkspace },
      runStore: {
        async readEvents() {
          order.push("events");
          return [event(0), event(1, "run.finished")];
        }
      }
    }), { sessionToken: "test-token", appData: root, webDist: undefined });

    const responsePromise = app.inject({
      method: "GET", url: "/api/runs/run_01/report",
      headers: { "x-arena-token": "test-token" }
    });
    const response = await Promise.race([
      responsePromise,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 50))
    ]);
    expect(response, "response must finish before cleanup resolves").toBeDefined();
    if (response === undefined) {
      releaseCleanup();
      await responsePromise;
      throw new Error("report response waited for cleanup");
    }
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schema: "arena.report/v1",
      redaction_complete: true
    });
    expect(response.body).not.toContain(secretSource);
    expect(response.body).not.toContain("CODEX_HOME");
    expect(response.body).not.toContain("OPENAI_API_KEY");
    expect(response.body).not.toContain("sk-test-secret");
    expect(response.body).not.toContain("test-token");
    expect(order).toEqual(["events", "finalize"]);
    releaseCleanup();
    await vi.waitFor(() => {
      expect(finalizeWorkspace).toHaveBeenCalledWith("run_01", { report_exported: true });
    });
    await app.close();
  });

  it("runs finish-triggered cleanup once for concurrent successful report exports and retries failures", async () => {
    const root = await temporaryRoot();
    const finalizeWorkspace = vi.fn()
      .mockImplementationOnce(() => { throw new Error("cleanup failed"); })
      .mockResolvedValue({ removed: true });
    const app = await createServer(dependencies({
      orchestrator: { ...dependencies().orchestrator, finalizeWorkspace }
    }), { sessionToken: "test-token", appData: root, webDist: undefined });
    const request = () => app.inject({
      method: "GET", url: "/api/runs/run_01/report",
      headers: { "x-arena-token": "test-token" }
    });

    const firstPair = await Promise.all([request(), request()]);
    expect(firstPair.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
    await vi.waitFor(() => expect(finalizeWorkspace).toHaveBeenCalledTimes(1));
    expect((await request()).statusCode).toBe(200);
    await vi.waitFor(() => expect(finalizeWorkspace).toHaveBeenCalledTimes(2));
    expect((await request()).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finalizeWorkspace).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("projects report trace data away and sanitizes embedded paths and exact secrets", async () => {
    const root = await temporaryRoot();
    const unsafeVerdict: VerdictBundle = {
      schema: "arena.verdict/v1",
      run_id: "run_01",
      status: "error",
      hard_gate_failures: [],
      dimensions: [],
      verifier_results: [{
        id: "native-error",
        passed: false,
        hard_gate: false,
        message: "ENOENT: open '/Users/alice/private/source/SKILL.md'",
        evidence: ["event:0"]
      }],
      evidence: ["event:0"],
      error: {
        code: "RUN_FAILED",
        message: "git --work-tree=/Users/alice/private/source status"
      }
    };
    const unsafeDiagnosis: Diagnosis = {
      ...diagnosis(),
      observed_failure: "file:///Users/alice/private/source/SKILL.md",
      likely_skill_gap: "argv --work-tree=/Users/alice/private/source",
      retry_analysis: "session is test-token"
    };
    const app = await createServer(dependencies({
      orchestrator: {
        ...dependencies().orchestrator,
        getRunContext() {
          const context = dependencies().orchestrator.getRunContext("run_01");
          return { ...context, envelope: { ...context.envelope, state: "errored" as const } };
        }
      },
      async loadVerdict() { return unsafeVerdict; },
      async loadDiagnosis() { return unsafeDiagnosis; }
    }), { sessionToken: "test-token", appData: root, webDist: undefined });

    const response = await app.inject({
      method: "GET", url: "/api/runs/run_01/report",
      headers: { "x-arena-token": "test-token" }
    });
    expect(response.statusCode).toBe(200);
    const report = response.json() as { trace: Array<Record<string, unknown>> };
    expect(report.trace.every((item) => !("data" in item))).toBe(true);
    expect(response.body).not.toContain("/Users/alice");
    expect(response.body).not.toContain("file://");
    expect(response.body).not.toContain("test-token");
    await app.close();
  });

  it("enforces locked run/verdict invariants before emitting a report", async () => {
    const victory = (hard_gate_failures: string[] = []): VerdictBundle => ({
      ...verdict(),
      status: "victory",
      score: 91,
      hard_gate_failures
    });
    const invalid: Array<[string, RunEnvelope, VerdictBundle]> = [
      ["running victory", envelope("running"), victory()],
      ["errored victory", envelope("errored"), victory()],
      ["victory with hard gates", envelope("completed"), victory(["gate_01"])]
    ];
    for (const [label, run, value] of invalid) {
      const root = await temporaryRoot();
      const app = await createServer(dependencies({
        orchestrator: {
          ...dependencies().orchestrator,
          getRunContext() {
            const context = dependencies().orchestrator.getRunContext("run_01");
            return { ...context, envelope: run };
          }
        },
        async loadVerdict() { return value; }
      }), { sessionToken: "test-token", appData: root, webDist: undefined });
      const response = await app.inject({
        method: "GET", url: "/api/runs/run_01/report",
        headers: { "x-arena-token": "test-token" }
      });
      expect(response.statusCode, label).toBe(500);
      await app.close();
    }

    const root = await temporaryRoot();
    const errorVerdict: VerdictBundle = {
      schema: "arena.verdict/v1",
      run_id: "run_01",
      status: "error",
      hard_gate_failures: [],
      dimensions: [],
      verifier_results: [],
      evidence: [],
      error: { code: "RUN_FAILED", message: "bounded failure" }
    };
    const app = await createServer(dependencies({
      orchestrator: {
        ...dependencies().orchestrator,
        getRunContext() {
          const context = dependencies().orchestrator.getRunContext("run_01");
          return { ...context, envelope: envelope("errored") };
        }
      },
      async loadVerdict() { return errorVerdict; }
    }), { sessionToken: "test-token", appData: root, webDist: undefined });
    expect((await app.inject({
      method: "GET", url: "/api/runs/run_01/report",
      headers: { "x-arena-token": "test-token" }
    })).statusCode).toBe(200);
    await app.close();
  });

  it("exports bounded metadata summaries only for artifacts referenced by report records", async () => {
    const root = await temporaryRoot();
    const contractRef = `sha256:${"1".repeat(64)}` as const;
    const processRef = `sha256:${"2".repeat(64)}` as const;
    const verifierRef = `sha256:${"3".repeat(64)}` as const;
    const patchRef = `sha256:${"4".repeat(64)}` as const;
    const rogueRef = `sha256:${"5".repeat(64)}` as const;
    const records = new Map<ArtifactRef, {
      ref: ArtifactRef;
      sha256: string;
      bytes: number;
      mime: string;
      redacted: boolean;
    }>([
      [contractRef, { ref: contractRef, sha256: "1".repeat(64), bytes: 41, mime: "application/json", redacted: false }],
      [processRef, { ref: processRef, sha256: "2".repeat(64), bytes: 23, mime: "text/plain; charset=utf-8", redacted: false }],
      [verifierRef, { ref: verifierRef, sha256: "3".repeat(64), bytes: 17, mime: "application/json", redacted: true }],
      [patchRef, { ref: patchRef, sha256: "4".repeat(64), bytes: 18, mime: "text/x-diff", redacted: true }],
      [rogueRef, { ref: rogueRef, sha256: "5".repeat(64), bytes: 999, mime: "text/x-diff", redacted: true }]
    ]);
    const loadArtifactRecord = vi.fn(async (ref: ArtifactRef) => {
      const record = records.get(ref);
      if (record === undefined) throw new Error("artifact missing");
      return record;
    });
    const app = await createServer(dependencies({
      async loadSnapshot() { return { ...snapshot(), contract_ref: contractRef }; },
      async loadVerdict() {
        return {
          ...verdict(),
          verifier_results: [{
            id: "protected-tree",
            passed: false,
            hard_gate: true,
            message: "Protected tree changed",
            evidence: [verifierRef]
          }]
        };
      },
      async loadRepair() { return repairRecord({ patch_ref: patchRef }); },
      runStore: {
        async readEvents() {
          return [
            { ...event(0, "process.exited"), artifacts: [processRef] },
            event(1, "run.finished")
          ];
        }
      },
      loadArtifactRecord
    }), { sessionToken: "test-token", appData: root, webDist: undefined });

    const response = await app.inject({
      method: "GET", url: "/api/runs/run_01/report",
      headers: { "x-arena-token": "test-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      artifacts: [
        {
          ref: contractRef,
          kind: "other",
          label: "Artifact metadata",
          summary: "41 bytes · application/json",
          mime: "application/json",
          bytes: 41,
          redacted: false
        },
        {
          ref: processRef,
          kind: "process",
          label: "Process artifact",
          summary: "23 bytes · text/plain; charset=utf-8",
          mime: "text/plain; charset=utf-8",
          bytes: 23,
          redacted: false
        },
        {
          ref: verifierRef,
          kind: "verifier",
          label: "Verifier artifact",
          summary: "17 bytes · application/json · redacted",
          mime: "application/json",
          bytes: 17,
          redacted: true
        },
        {
          ref: patchRef,
          kind: "diff",
          label: "Diff artifact",
          summary: "18 bytes · text/x-diff · redacted",
          mime: "text/x-diff",
          bytes: 18,
          redacted: true
        }
      ]
    });
    expect(response.body).not.toContain("private diff bytes");
    expect(loadArtifactRecord.mock.calls.map(([ref]) => ref).sort()).toEqual([
      contractRef,
      patchRef,
      processRef,
      verifierRef
    ].sort());
    expect(loadArtifactRecord).not.toHaveBeenCalledWith(rogueRef);
    await app.close();
  });

  it("rejects report lineage or membership mismatches without cleanup", async () => {
    const cases: Array<[string, (base: ServerDependencies) => Partial<ServerDependencies>]> = [
      ["context run", (base) => ({
        orchestrator: {
          ...base.orchestrator,
          getRunContext: () => ({
            ...base.orchestrator.getRunContext("run_01"),
            envelope: { ...envelope(), run_id: "run_other" }
          })
        }
      })],
      ["snapshot fingerprint", (base) => ({
        orchestrator: {
          ...base.orchestrator,
          getRunContext: () => ({
            ...base.orchestrator.getRunContext("run_01"),
            snapshot_execution_fingerprint: "f".repeat(64)
          })
        }
      })],
      ["verdict run", () => ({ async loadVerdict() { return { ...verdict(), run_id: "run_other" }; } })],
      ["diagnosis run", () => ({ async loadDiagnosis() { return { ...diagnosis(), run_id: "run_other" }; } })],
      ["trace run", () => ({
        runStore: { async readEvents() { return [{ ...event(0), run_id: "run_other" }]; } }
      })],
      ["trace sequence", () => ({
        runStore: { async readEvents() { return [event(0), event(2, "run.finished")]; } }
      })],
      ["repair run", () => ({
        async loadRepair() { return repairRecord({ run_id: "run_other" }); }
      })]
    ];
    for (const [label, override] of cases) {
      const root = await temporaryRoot();
      const finalizeWorkspace = vi.fn();
      const base = dependencies();
      const app = await createServer(dependencies({
        ...override(base),
        orchestrator: {
          ...(override(base).orchestrator ?? base.orchestrator),
          finalizeWorkspace
        }
      }), { sessionToken: "test-token", appData: root, webDist: undefined });
      const response = await app.inject({
        method: "GET", url: "/api/runs/run_01/report",
        headers: { "x-arena-token": "test-token" }
      });
      expect(response.statusCode, label).toBe(500);
      expect(response.json(), label).toEqual({
        error: { code: "INTERNAL_ERROR", message: "Request failed safely" }
      });
      expect(finalizeWorkspace, label).not.toHaveBeenCalled();
      await app.close();
    }
  });

  it("rejects malformed or contradictory repair report records without cleanup", async () => {
    const cases: Array<[string, unknown]> = [
      ["primitive", "pending"],
      ["missing run id", (() => {
        const value = repairRecord();
        delete value.run_id;
        return value;
      })()],
      ["wrong snapshot", repairRecord({ snapshot_hash: hashC })],
      ["invalid status", repairRecord({ status: "unknown" })],
      ["wrong schema", repairRecord({ schema: "arena.repair/v0" })],
      ["contradictory pending child", repairRecord({
        child_run_id: "run_child",
        new_snapshot_hash: hashC
      })],
      ["approved missing child", repairRecord({ status: "approved" })],
      ["approved with failed error", repairRecord({
        status: "approved",
        child_run_id: "run_child",
        new_snapshot_hash: hashC,
        error: { code: "REPAIR_APPROVAL_FAILED" }
      })],
      ["approved with a different reviewed patch", repairRecord({
        status: "approved",
        child_run_id: "run_child",
        new_snapshot_hash: hashC,
        reviewed_patch_ref: `sha256:${"e".repeat(64)}`
      })],
      ["failed missing error", repairRecord({ status: "failed" })],
      ["failed with approved child", repairRecord({
        status: "failed",
        error: { code: "REPAIR_APPROVAL_FAILED" },
        child_run_id: "run_child",
        new_snapshot_hash: hashC
      })]
    ];
    for (const [label, value] of cases) {
      const root = await temporaryRoot();
      const finalizeWorkspace = vi.fn();
      const app = await createServer(dependencies({
        orchestrator: { ...dependencies().orchestrator, finalizeWorkspace },
        async loadRepair() { return value; }
      }), { sessionToken: "test-token", appData: root, webDist: undefined });
      const response = await app.inject({
        method: "GET", url: "/api/runs/run_01/report",
        headers: { "x-arena-token": "test-token" }
      });
      expect(response.statusCode, label).toBe(500);
      expect(response.json(), label).toEqual({
        error: { code: "INTERNAL_ERROR", message: "Request failed safely" }
      });
      expect(finalizeWorkspace, label).not.toHaveBeenCalled();
      await app.close();
    }
  });

  it("does not clean up when a report client disconnects before delivery finishes", async () => {
    const root = await temporaryRoot();
    let reportStarted!: () => void;
    const started = new Promise<void>((resolve) => { reportStarted = resolve; });
    let releaseVerdict!: (value: VerdictBundle) => void;
    const blockedVerdict = new Promise<VerdictBundle>((resolve) => { releaseVerdict = resolve; });
    const finalizeWorkspace = vi.fn();
    const app = await createServer(dependencies({
      orchestrator: { ...dependencies().orchestrator, finalizeWorkspace },
      async loadVerdict() {
        reportStarted();
        return blockedVerdict;
      }
    }), { sessionToken: "test-token", appData: root, webDist: undefined });
    let disconnect!: () => void;
    app.addHook("onRequest", (_request, reply, done) => {
      disconnect = () => reply.raw.destroy();
      done();
    });
    const pending = app.inject({
      method: "GET",
      url: "/api/runs/run_01/report",
      headers: { "x-arena-token": "test-token" }
    });
    await started;
    disconnect();
    releaseVerdict(verdict());
    await pending.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(finalizeWorkspace).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not clean up when successful report serialization fails during response sending", async () => {
    const root = await temporaryRoot();
    const finalizeWorkspace = vi.fn();
    const app = await createServer(dependencies({
      orchestrator: { ...dependencies().orchestrator, finalizeWorkspace }
    }), { sessionToken: "test-token", appData: root, webDist: undefined });
    app.addHook("onSend", async (request, reply, payload) => {
      if (request.url === "/api/runs/run_01/report" && reply.statusCode === 200) {
        throw new Error("simulated response serialization failure");
      }
      return payload;
    });

    const response = await app.inject({
      method: "GET", url: "/api/runs/run_01/report",
      headers: { "x-arena-token": "test-token" }
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("simulated response serialization failure");
    expect(finalizeWorkspace).not.toHaveBeenCalled();
    await app.close();
  });

  it("marks SSE closed and unsubscribes when the client disconnects during replay loading", async () => {
    const root = await temporaryRoot();
    const bus = new EventBus();
    const originalSubscribe = bus.subscribe.bind(bus);
    const unsubscribe = vi.fn();
    vi.spyOn(bus, "subscribe").mockImplementation((runId, listener) => {
      const remove = originalSubscribe(runId, listener);
      return () => {
        unsubscribe();
        remove();
      };
    });
    let replayStarted!: () => void;
    const started = new Promise<void>((resolve) => { replayStarted = resolve; });
    let releaseReplay!: (value: TraceEvent[]) => void;
    const blockedReplay = new Promise<TraceEvent[]>((resolve) => { releaseReplay = resolve; });
    const app = await createServer(dependencies({
      eventBus: bus,
      runStore: {
        async readEvents() {
          replayStarted();
          return blockedReplay;
        }
      }
    }), { sessionToken: "test-token", appData: root, webDist: undefined });
    let disconnect!: () => void;
    app.addHook("onRequest", (_request, reply, done) => {
      disconnect = () => reply.raw.destroy();
      done();
    });
    const pending = app.inject({
      method: "GET",
      url: "/api/runs/run_01/events?token=test-token"
    });
    await started;
    disconnect();
    releaseReplay([event(0)]);
    await pending.catch(() => undefined);
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
    await app.close();
  });

  it("does not finalize a workspace when report assembly fails", async () => {
    const root = await temporaryRoot();
    const finalizeWorkspace = vi.fn();
    const app = await createServer(dependencies({
      orchestrator: { ...dependencies().orchestrator, finalizeWorkspace },
      async loadVerdict() { throw new Error("secret internal failure"); }
    }), { sessionToken: "test-token", appData: root, webDist: undefined });

    const response = await app.inject({
      method: "GET", url: "/api/runs/run_01/report",
      headers: { "x-arena-token": "test-token" }
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Request failed safely" }
    });
    expect(response.body).not.toContain("secret internal failure");
    expect(finalizeWorkspace).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("startCli", () => {
  it("keys repair authority by exact id and keeps the newest repair active per run", async () => {
    const first = repairProposal();
    const second = {
      ...first,
      repair_id: "repair_02",
      patch_ref: `sha256:${"e".repeat(64)}` as const
    };
    const createRepairFork = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const readCandidatePatch = vi.fn(async (repairId: string) => ({
      repair_id: repairId,
      patch_ref: repairId === first.repair_id ? first.patch_ref : second.patch_ref,
      mime: "text/x-diff" as const,
      bytes: 0,
      redacted: false as const,
      export_ready: false as const,
      text: ""
    }));
    const rejectRepair = vi.fn(async (_repairId: string): Promise<void> => undefined);
    const approveAndRerun = vi.fn(async () => envelope("created"));
    const registry = createProcessRepairRegistry({
      createRepairFork,
      readCandidatePatch,
      rejectRepair,
      approveAndRerun
    });

    await registry.repairs.createRepairFork("run_01");
    await registry.repairs.createRepairFork("run_01");

    await expect(registry.repairs.readCandidatePatch(first.repair_id)).rejects.toThrow();
    await expect(registry.repairs.approveAndRerun(first.repair_id)).rejects.toThrow();
    await expect(registry.repairs.rejectRepair(first.repair_id)).rejects.toThrow();
    expect(readCandidatePatch).not.toHaveBeenCalledWith(first.repair_id);
    expect(approveAndRerun).not.toHaveBeenCalled();
    expect(rejectRepair).not.toHaveBeenCalled();
    await expect(registry.loadRepair("run_01")).resolves.toMatchObject({
      repair_id: second.repair_id,
      status: "pending",
      patch_ref: second.patch_ref
    });
    await expect(registry.repairs.readCandidatePatch(second.repair_id)).resolves.toMatchObject({
      repair_id: second.repair_id,
      patch_ref: second.patch_ref
    });
  });

  it("does not publish a stale approval when a newer repair becomes active during coordinator work", async () => {
    const first = repairProposal();
    const second = {
      ...first,
      repair_id: "repair_02",
      patch_ref: `sha256:${"e".repeat(64)}` as const
    };
    let createCount = 0;
    let releaseApproval!: (value: RunEnvelope) => void;
    const blockedApproval = new Promise<RunEnvelope>((resolve) => { releaseApproval = resolve; });
    const registry = createProcessRepairRegistry({
      async createRepairFork() {
        createCount += 1;
        return createCount === 1 ? first : second;
      },
      async readCandidatePatch() { throw new Error("unused"); },
      async rejectRepair() {},
      async approveAndRerun() { return blockedApproval; }
    });
    await registry.repairs.createRepairFork("run_01");
    const staleApproval = registry.repairs.approveAndRerun(first.repair_id);
    await registry.repairs.createRepairFork("run_01");
    releaseApproval({ ...envelope("created"), run_id: "run_child", parent_run_id: "run_01" });

    await expect(staleApproval).rejects.toThrow("not active");
    await expect(registry.loadRepair("run_01")).resolves.toMatchObject({
      repair_id: second.repair_id,
      status: "pending"
    });
  });

  it("allows approval to finish before a later repair becomes active", async () => {
    const first = repairProposal();
    const second = {
      ...first,
      repair_id: "repair_02",
      patch_ref: `sha256:${"e".repeat(64)}` as const
    };
    let createCount = 0;
    let releaseCreation!: () => void;
    const blockedCreation = new Promise<void>((resolve) => { releaseCreation = resolve; });
    let secondCreationEntered!: () => void;
    const creationEntered = new Promise<void>((resolve) => { secondCreationEntered = resolve; });
    const registry = createProcessRepairRegistry({
      async createRepairFork() {
        createCount += 1;
        if (createCount === 2) {
          secondCreationEntered();
          await blockedCreation;
        }
        return createCount === 1 ? first : second;
      },
      async readCandidatePatch() { throw new Error("unused"); },
      async rejectRepair() {},
      async approveAndRerun() {
        return { ...envelope("created"), run_id: "run_child", parent_run_id: "run_01" };
      }
    });
    await registry.repairs.createRepairFork("run_01");
    const creation = registry.repairs.createRepairFork("run_01");
    await creationEntered;
    await expect(registry.repairs.approveAndRerun(first.repair_id))
      .resolves.toMatchObject({ run_id: "run_child" });
    releaseCreation();
    await creation;
    await expect(registry.loadRepair("run_01")).resolves.toMatchObject({
      repair_id: second.repair_id,
      status: "pending"
    });
  });

  it("normalizes a real pending repair proposal for strict report export", async () => {
    const proposal = repairProposal();
    const registry = createProcessRepairRegistry({
      async createRepairFork() { return proposal; },
      async readCandidatePatch() { throw new Error("unused"); },
      async rejectRepair() {},
      async approveAndRerun() { return envelope("created"); }
    });

    const returned = await registry.repairs.createRepairFork("run_01");
    expect(returned).toBe(proposal);
    expect(returned).not.toHaveProperty("schema");
    expect(await registry.loadRepair("run_01")).toEqual({
      schema: "arena.repair/v1",
      ...proposal
    });

    const root = await temporaryRoot();
    const app = await createServer(dependencies({ loadRepair: registry.loadRepair }), {
      sessionToken: "test-token", appData: root, webDist: undefined
    });
    const response = await app.inject({
      method: "GET", url: "/api/runs/run_01/report",
      headers: { "x-arena-token": "test-token" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      repair: { schema: "arena.repair/v1", status: "pending" }
    });
    await app.close();
  });

  it("records a safe failed repair after approval rejects", async () => {
    const proposal = repairProposal();
    const registry = createProcessRepairRegistry({
      async createRepairFork() { return proposal; },
      async readCandidatePatch() { throw new Error("unused"); },
      async rejectRepair() {},
      async approveAndRerun() {
        throw new Error("ENOENT: '/Users/alice/private/repair'");
      }
    });

    await registry.repairs.createRepairFork("run_01");
    await expect(registry.repairs.approveAndRerun("repair_01")).rejects.toThrow();
    expect(await registry.loadRepair("run_01")).toEqual({
      schema: "arena.repair/v1",
      ...proposal,
      status: "failed",
      error: { code: "REPAIR_APPROVAL_FAILED" }
    });
    expect(JSON.stringify(await registry.loadRepair("run_01"))).not.toContain("/Users");
  });

  it("keeps an approved repair terminal and rejects repeated rerun without coordinator re-entry", async () => {
    const proposal = repairProposal();
    const child = { ...envelope("created"), run_id: "run_child", parent_run_id: "run_01" };
    const approveAndRerun = vi.fn(async () => child);
    const registry = createProcessRepairRegistry({
      async createRepairFork() { return proposal; },
      async readCandidatePatch() { throw new Error("unused"); },
      async rejectRepair() {},
      approveAndRerun
    });

    await registry.repairs.createRepairFork("run_01");
    await expect(registry.repairs.approveAndRerun("repair_01")).resolves.toEqual(child);
    const approved = await registry.loadRepair("run_01");
    await expect(registry.repairs.approveAndRerun("repair_01")).rejects.toThrow();
    expect(approveAndRerun).toHaveBeenCalledTimes(1);
    expect(await registry.loadRepair("run_01")).toEqual(approved);
    expect(approved).toMatchObject({
      schema: "arena.repair/v1",
      status: "approved",
      child_run_id: "run_child",
      new_snapshot_hash: hashB
    });

    const root = await temporaryRoot();
    const app = await createServer(dependencies({ loadRepair: registry.loadRepair }), {
      sessionToken: "test-token", appData: root, webDist: undefined
    });
    const response = await app.inject({
      method: "GET", url: "/api/runs/run_01/report",
      headers: { "x-arena-token": "test-token" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      repair: { schema: "arena.repair/v1", status: "approved" }
    });
    await app.close();
  });

  it("keeps a failed repair terminal and rejects repeated rerun without coordinator re-entry", async () => {
    const proposal = repairProposal();
    const approveAndRerun = vi.fn(async () => {
      throw new Error("first approval failed");
    });
    const registry = createProcessRepairRegistry({
      async createRepairFork() { return proposal; },
      async readCandidatePatch() { throw new Error("unused"); },
      async rejectRepair() {},
      approveAndRerun
    });

    await registry.repairs.createRepairFork("run_01");
    await expect(registry.repairs.approveAndRerun("repair_01")).rejects.toThrow();
    const failed = await registry.loadRepair("run_01");
    await expect(registry.repairs.approveAndRerun("repair_01")).rejects.toThrow();
    expect(approveAndRerun).toHaveBeenCalledTimes(1);
    expect(await registry.loadRepair("run_01")).toEqual(failed);
    expect(failed).toMatchObject({
      schema: "arena.repair/v1",
      status: "failed",
      error: { code: "REPAIR_APPROVAL_FAILED" }
    });
    expect(failed).not.toHaveProperty("child_run_id");
    expect(failed).not.toHaveProperty("new_snapshot_hash");

    const root = await temporaryRoot();
    const app = await createServer(dependencies({ loadRepair: registry.loadRepair }), {
      sessionToken: "test-token", appData: root, webDist: undefined
    });
    const response = await app.inject({
      method: "GET", url: "/api/runs/run_01/report",
      headers: { "x-arena-token": "test-token" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      repair: { schema: "arena.repair/v1", status: "failed" }
    });
    await app.close();
  });

  it("resolves manifests and production web assets from the installation root after chdir", async () => {
    const projectRoot = process.cwd();
    const webDist = path.join(projectRoot, "dist", "web");
    const appData = await temporaryRoot();
    await mkdir(webDist, { recursive: true });
    let observedWebDist: string | undefined;
    const previous = process.cwd();
    process.chdir(tmpdir());
    try {
      const deps = await createDefaultServerDependencies(appData);
      expect((await deps.listManifests()).map(({ id }) => id)).toHaveLength(3);
      await startCli(["--app-data", appData, "--no-open"], {
        async createDependencies() { return dependencies(); },
        async createServer(_dependencies, options) {
          observedWebDist = options.webDist;
          return { async listen() { return undefined; } };
        },
        randomBytes() { return Buffer.alloc(32, 0xcd); },
        async openBrowser() { throw new Error("must not open"); },
        writeLine() {}
      });
    } finally {
      process.chdir(previous);
      await rm(webDist, { recursive: true, force: true });
    }
    expect(observedWebDist).toBe(webDist);
  });

  it("creates and tightens every app-data directory while rejecting symlinked children", async () => {
    const root = await temporaryRoot();
    await chmod(root, 0o755);
    const deps = await createDefaultServerDependencies(root);
    expect(deps).toBeDefined();
    for (const name of [
      "",
      "imports",
      "runs",
      "artifacts",
      "workspaces",
      "runner-output",
      "repairs",
      "uploads"
    ]) {
      const stats = await lstat(path.join(root, name));
      expect(stats.isDirectory(), name).toBe(true);
      expect(stats.isSymbolicLink(), name).toBe(false);
      expect(stats.mode & 0o777, name).toBe(0o700);
      if (typeof process.getuid === "function") expect(stats.uid, name).toBe(process.getuid());
    }

    const badRoot = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, path.join(badRoot, "imports"));
    await expect(createDefaultServerDependencies(badRoot)).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects a symlinked existing ancestor without recursively creating outside it", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, path.join(root, "linked-parent"));
    const escapedAppData = path.join(root, "linked-parent", "escaped-child");

    await expect(createDefaultServerDependencies(escapedAppData)).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
    await expect(lstat(path.join(outside, "escaped-child"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("assembles the real process-local server dependencies without invoking Codex", async () => {
    const root = await temporaryRoot();
    const deps = await createDefaultServerDependencies(root);

    const manifests = await deps.listManifests();
    expect(manifests.map(({ id }) => id).sort()).toEqual([
      "repo-dirty-tree-v1",
      "repo-false-green-v1",
      "repo-missing-tool-v1"
    ]);
    expect(JSON.stringify(manifests)).not.toContain("runner_brief");
    expect(JSON.stringify(manifests)).not.toContain("judge_pack");
  });

  it("parses startup flags, generates a token, binds loopback, and opens only when enabled", async () => {
    const root = await temporaryRoot();
    const listen = vi.fn(async () => "http://127.0.0.1:4999");
    const openBrowser = vi.fn(async () => undefined);
    const output: string[] = [];
    const deps = dependencies();

    await startCli(["--port", "4999", "--app-data", root], {
      async createDependencies(appData) {
        expect(appData).toBe(root);
        return deps;
      },
      async createServer() {
        return { listen };
      },
      randomBytes() { return Buffer.alloc(32, 0xab); },
      openBrowser,
      writeLine(value) { output.push(value); }
    });

    expect(listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4999 });
    const expectedToken = "ab".repeat(32);
    expect(output).toEqual([`http://localhost:4999/?token=${expectedToken}`]);
    expect(openBrowser).toHaveBeenCalledWith(`http://localhost:4999/?token=${expectedToken}`);

    openBrowser.mockClear();
    await startCli(["--port", "5000", "--app-data", root, "--dev-token", "a b&c", "--no-open"], {
      async createDependencies() { return deps; },
      async createServer() { return { listen }; },
      randomBytes() { throw new Error("must not generate"); },
      openBrowser,
      writeLine() {}
    });
    expect(openBrowser).not.toHaveBeenCalled();
  });
});
