import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
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
  startCli
} from "../../src/core/cli.js";
import type {
  Diagnosis,
  RunEnvelope,
  SkillContract,
  SkillSnapshot,
  TraceEvent,
  VerdictBundle
} from "../../src/protocol/index.js";

const roots: string[] = [];
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const secretSource = "/Users/alice/private/source";

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-server-")));
  roots.push(root);
  return root;
}

function snapshot(): SkillSnapshot {
  return {
    schema: "arena.skill-snapshot/v1",
    source: { kind: "local", uri: `file://${secretSource}` },
    entrypoint: "SKILL.md",
    license: "MIT",
    files: [{ path: "SKILL.md", bytes: 8, sha256: hashA }],
    source_hash: hashB,
    imported_path: secretSource
  };
}

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

function dependencies(overrides: Partial<ServerDependencies> = {}): ServerDependencies {
  const bus = new EventBus();
  const created = envelope("created");
  const base: ServerDependencies = {
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
        snapshot_execution_fingerprint: "trusted-fingerprint"
      };
    },
    orchestrator: {
      async createRun(request) {
        expect(request.expected_lineage.snapshot_execution_fingerprint)
          .toBe("trusted-fingerprint");
        return created;
      },
      async execute() { return verdict(); },
      getRunContext() {
        return {
          envelope: envelope(),
          manifest_id: "repo-dirty-tree-v1",
          snapshot_execution_fingerprint: "trusted-fingerprint"
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
      async approveAndRerun() { return { ...created, parent_run_id: "run_01" }; }
    },
    async loadVerdict() { return verdict(); },
    async loadDiagnosis() { return diagnosis(); },
    async loadRepair() { return { schema: "arena.repair/v1", status: "pending" }; }
  };
  return { ...base, ...overrides };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Loopback API", () => {
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

  it("exports an allowlisted recursively redacted report before finalizing the retained workspace", async () => {
    const root = await temporaryRoot();
    const order: string[] = [];
    const finalizeWorkspace = vi.fn(async () => {
      order.push("finalize");
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

    const response = await app.inject({
      method: "GET", url: "/api/runs/run_01/report",
      headers: { "x-arena-token": "test-token" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ schema: "arena.report/v1" });
    expect(response.body).not.toContain(secretSource);
    expect(response.body).not.toContain("CODEX_HOME");
    expect(response.body).not.toContain("OPENAI_API_KEY");
    expect(response.body).not.toContain("sk-test-secret");
    expect(response.body).not.toContain("test-token");
    expect(order).toEqual(["events", "finalize"]);
    expect(finalizeWorkspace).toHaveBeenCalledWith("run_01", { report_exported: true });
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
