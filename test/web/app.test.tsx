import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  App,
  RunSession,
  VerdictSession,
  type ActiveRunContext
} from "../../apps/web/src/App.js";
import {
  ApiError,
  ArenaApi,
  ArenaReportSchema,
  type ArenaEventSource,
  type PreflightResult,
  type ReplayManifest
} from "../../apps/web/src/api.js";
import type {
  RunEnvelope,
  SkillContract,
  SkillSnapshot
} from "../../src/protocol/schema.js";

const hash = "a".repeat(64);
const hashB = "b".repeat(64);

function lobbyHealth(): PreflightResult {
  return {
    ok: true,
    checks: [
      { id: "codex-version", ok: true, message: "ready" },
      { id: "codex-login", ok: true, message: "ready" },
      { id: "git-version", ok: true, message: "ready" },
      { id: "app-data", ok: true, message: "ready" }
    ],
    model: { target: "gpt-5.6", status: "configured-unverified" }
  };
}

function lobbyManifest(): ReplayManifest {
  return {
    schema: "arena.replay-manifest/v1",
    id: "repo-dirty-tree-v1",
    name: "Dirty Tree",
    fixture: { id: "repo-bugfix", version: 1 },
    fault_cards: [{ id: "dirty-tree", version: 1 }],
    budgets: { wall_time_s: 180, max_command_retries: 2 },
    scoring: { weights: { task_correctness: 1 }, hard_gates: ["preserve"] }
  };
}

function falseGreenManifest(): ReplayManifest {
  return {
    ...lobbyManifest(),
    id: "repo-false-green-v1",
    name: "False Green Mimic",
    fault_cards: [{ id: "false-green", version: 1 }]
  };
}

function lobbySnapshot(): SkillSnapshot {
  return {
    schema: "arena.skill-snapshot/v1",
    source: { kind: "git", uri: "https://github.com/example/skill", revision: "main" },
    entrypoint: "SKILL.md",
    license: "MIT",
    files: [{ path: "SKILL.md", bytes: 8, sha256: hash }],
    source_hash: hash,
    imported_path: "/private/imports/redacted"
  };
}

function lobbyContract(): SkillContract {
  return {
    schema: "arena.skill-contract/v1",
    snapshot_hash: hash,
    model: "gpt-5.6",
    promises: [],
    preconditions: [],
    expected_artifacts: [],
    recovery_rules: [],
    risk_signals: []
  };
}

function lobbyRun(): RunEnvelope {
  return {
    schema: "arena.run/v1",
    run_id: "run_app_01",
    run_group_id: "group_app_01",
    trial_index: 0,
    manifest_hash: hash,
    snapshot_hash: hash,
    fixture_hash: hash,
    runner: { adapter: "codex-cli", model: "gpt-5.6" },
    state: "created",
    started_at: "2026-07-15T00:00:00.000Z"
  };
}

function stubLobbyApi(): void {
  vi.spyOn(ArenaApi.prototype, "health").mockResolvedValue(lobbyHealth());
  vi.spyOn(ArenaApi.prototype, "listManifests").mockResolvedValue([lobbyManifest()]);
  vi.spyOn(ArenaApi.prototype, "importSkill").mockResolvedValue(lobbySnapshot());
  vi.spyOn(ArenaApi.prototype, "compileContract").mockResolvedValue(lobbyContract());
  vi.spyOn(ArenaApi.prototype, "startRun").mockResolvedValue(lobbyRun());
}

function runRecord(): Record<string, unknown> {
  return {
    schema: "arena.run/v1",
    run_id: "run/01",
    run_group_id: "group_01",
    trial_index: 0,
    manifest_hash: hash,
    snapshot_hash: hash,
    fixture_hash: hash,
    runner: { adapter: "codex-cli", model: "gpt-5.6" },
    state: "completed",
    started_at: "2026-07-15T00:00:00.000Z",
    ended_at: "2026-07-15T00:01:00.000Z"
  };
}

function sanitizedRepair(status: "pending" | "approved" | "failed"): Record<string, unknown> {
  const base = {
    schema: "arena.repair/v1",
    repair_id: "repair/01",
    run_id: "run/01",
    status,
    snapshot_hash: hash,
    created_at: "2026-07-15T00:02:00.000Z",
    changed_paths: ["SKILL.md"],
    patch_ref: `sha256:${hash}`
  };
  if (status === "approved") {
    return { ...base, child_run_id: "run_child", new_snapshot_hash: hashB };
  }
  if (status === "failed") {
    return { ...base, error: { code: "REPAIR_APPROVAL_FAILED" } };
  }
  return base;
}

function sanitizedReport(options: {
  readonly repair?: Record<string, unknown>;
  readonly errorVerdict?: boolean;
} = {}): Record<string, unknown> {
  const verdictBase = {
    schema: "arena.verdict/v1",
    run_id: "run/01",
    hard_gate_failures: [],
    dimensions: [{ id: "task_correctness", earned: 8, possible: 10, evidence: ["event:0"] }],
    verifier_results: [{
      id: "preserve", passed: true, hard_gate: true, message: "passed", evidence: ["event:0"]
    }],
    evidence: ["event:0"]
  };
  return {
    schema: "arena.report/v1",
    redaction_complete: true,
    run: runRecord(),
    manifest_id: "repo-dirty-tree-v1",
    snapshot: {
      schema: "arena.skill-snapshot/v1",
      source: { kind: "git", revision: "main" },
      entrypoint: "SKILL.md",
      license: "MIT",
      files: [{ path: "SKILL.md", bytes: 8, sha256: hash }],
      source_hash: hash,
      contract_ref: `sha256:${hashB}`
    },
    verdict: options.errorVerdict
      ? { ...verdictBase, status: "error", error: { code: "RUN_FAILED" } }
      : { ...verdictBase, status: "defeat", score: 80 },
    diagnosis: {
      schema: "arena.diagnosis/v1",
      run_id: "run/01",
      model: "gpt-5.6",
      observed_failure: "failure",
      likely_skill_gap: "gap",
      retry_analysis: "retry",
      suggested_changes: ["change"],
      evidence_refs: ["event:0"]
    },
    ...(options.repair === undefined ? {} : { repair: options.repair }),
    trace: [{
      v: 1,
      run_id: "run/01",
      seq: 0,
      phase: "judge",
      kind: "run.finished",
      actor: "arena",
      span_id: "span_01",
      artifacts: [`sha256:${hash}`]
    }],
    artifacts: [hash, hashB].sort().map((digest) => ({
      ref: `sha256:${digest}`,
      kind: "other",
      label: "Artifact metadata",
      summary: "8 bytes · application/json",
      mime: "application/json",
      bytes: 8,
      redacted: false
    }))
  };
}

function lobbyReport(
  run: RunEnvelope,
  trace: readonly Record<string, unknown>[],
  diff = false
): ReturnType<typeof ArenaReportSchema.parse> {
  const value = sanitizedReport() as Record<string, unknown>;
  value.run = run;
  value.manifest_id = "repo-dirty-tree-v1";
  value.verdict = {
    ...(value.verdict as Record<string, unknown>),
    run_id: run.run_id
  };
  value.diagnosis = {
    ...(value.diagnosis as Record<string, unknown>),
    run_id: run.run_id
  };
  value.trace = trace.map((candidate) => ({ ...candidate, run_id: run.run_id }));
  value.artifacts = (value.artifacts as Array<Record<string, unknown>>)
    .filter((artifact) => diff || artifact.ref === `sha256:${hashB}`)
    .map((artifact) => artifact.ref === `sha256:${hash}` && diff ? {
      ...artifact,
      kind: "diff",
      label: "Diff artifact",
      summary: "120 bytes · text/x-diff · redacted",
      mime: "text/x-diff",
      bytes: 120,
      redacted: true
    } : artifact);
  return ArenaReportSchema.parse(value);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("App", () => {
  it("keeps diagnosis, repair, and rerun explicit in the verdict session", async () => {
    const user = userEvent.setup();
    const initialValue = sanitizedReport();
    delete initialValue.diagnosis;
    const initial = ArenaReportSchema.parse(initialValue);
    const diagnosed = ArenaReportSchema.parse(sanitizedReport());
    const repaired = ArenaReportSchema.parse(sanitizedReport({
      repair: sanitizedRepair("pending")
    }));
    const patchText = "diff --git a/SKILL.md b/SKILL.md\n";
    const child: RunEnvelope = {
      ...initial.run,
      run_id: "run_child",
      parent_run_id: "run/01",
      snapshot_hash: hashB,
      state: "created",
      started_at: "2026-07-15T00:03:00.000Z"
    };
    delete (child as { ended_at?: string }).ended_at;
    const api = {
      diagnose: vi.fn().mockResolvedValue(diagnosed.diagnosis),
      createRepair: vi.fn().mockResolvedValue({
        repair_id: "repair/01",
        run_id: "run/01",
        status: "pending",
        snapshot_hash: hash,
        created_at: "2026-07-15T00:02:00.000Z",
        changed_paths: ["SKILL.md"],
        patch_ref: `sha256:${hash}`
      }),
      candidatePatch: vi.fn().mockResolvedValue({
        repair_id: "repair/01",
        mime: "text/x-diff",
        bytes: new TextEncoder().encode(patchText).byteLength,
        redacted: false,
        export_ready: false,
        text: patchText
      }),
      rerun: vi.fn().mockResolvedValue(child),
      report: vi.fn()
        .mockResolvedValueOnce(diagnosed)
        .mockResolvedValueOnce(repaired)
    } as unknown as ArenaApi;
    const onChildRunStarted = vi.fn();
    render(
      <VerdictSession
        api={api}
        initialBaseline={initial}
        onChildRunStarted={onChildRunStarted}
      />
    );

    expect(api.diagnose).not.toHaveBeenCalled();
    expect(api.createRepair).not.toHaveBeenCalled();
    expect(api.rerun).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Diagnose locked defeat" }));
    expect(api.diagnose).toHaveBeenCalledWith("run/01");
    expect(await screen.findByText("failure")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Create repair candidate" }));
    expect(api.createRepair).toHaveBeenCalledWith("run/01");
    expect(api.candidatePatch).toHaveBeenCalledWith("repair/01");
    expect(await screen.findByText("diff --git a/SKILL.md b/SKILL.md", { exact: false }))
      .toBeVisible();

    await user.click(screen.getByRole("button", { name: "Approve & Rerun" }));
    expect(api.rerun).toHaveBeenCalledWith("repair/01");
    expect(onChildRunStarted).toHaveBeenCalledWith(child);
  });

  it("atomically remounts a keyed run session when run context changes", async () => {
    const firstSource: ArenaEventSource = {
      close: vi.fn<() => void>(), onerror: null, onmessage: null, onopen: null
    };
    const secondSource: ArenaEventSource = {
      close: vi.fn<() => void>(), onerror: null, onmessage: null, onopen: null
    };
    const firstRun = { ...lobbyRun(), state: "running" as const };
    const secondRun: RunEnvelope = {
      ...firstRun, run_id: "run_app_02", run_group_id: "group_app_02"
    };
    const api = new ArenaApi("arena-secret", {
      fetch: vi.fn<typeof fetch>(),
      eventSource: (url) => url.includes("run_app_02") ? secondSource : firstSource
    });
    vi.spyOn(api, "getRun").mockImplementation(async (runId) =>
      runId === secondRun.run_id ? secondRun : firstRun
    );
    const firstContext: ActiveRunContext = { run: firstRun, manifest: lobbyManifest() };
    const secondContext: ActiveRunContext = { run: secondRun, manifest: falseGreenManifest() };
    const { rerender } = render(
      <RunSession key={firstRun.run_id} api={api} context={firstContext} />
    );
    expect(await screen.findByRole("heading", { name: "Dirty Tree" })).toBeVisible();

    rerender(<RunSession key={secondRun.run_id} api={api} context={secondContext} />);
    expect(firstSource.close).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { name: "False Green Mimic" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Dirty Tree" })).not.toBeInTheDocument();
    expect(screen.getByText("run_app_02")).toBeVisible();

    act(() => firstSource.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      v: 1, run_id: firstRun.run_id, seq: 9, phase: "judge", kind: "run.finished",
      actor: "arena", data: {}, artifacts: []
    }) })));
    expect(screen.queryByText("run_app_01")).not.toBeInTheDocument();
  });

  it("requires the loopback session token", () => {
    window.history.replaceState({}, "", "/");
    render(<App />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Open Arena from the local startup URL"
    );
  });

  it("treats an empty token as missing and removes it without disturbing navigation", () => {
    window.history.replaceState({}, "", "/?foo=1&token=#hash");

    expect(() => render(<App />)).not.toThrow();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Open Arena from the local startup URL"
    );
    expect(window.location.search).toBe("?foo=1");
    expect(window.location.hash).toBe("#hash");
  });

  it("keeps the token in memory and removes only it from visible history", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    window.history.replaceState({}, "", "/?foo=1&token=arena-secret#hash");
    const replaceState = vi.spyOn(window.history, "replaceState");

    render(<StrictMode><App /></StrictMode>);

    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?foo=1");
    expect(window.location.hash).toBe("#hash");
    expect(window.location.href).not.toContain("arena-secret");
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Import a Skill" })).toBeVisible();
  });

  it("keeps import, run, and compare shell state in memory", () => {
    window.history.replaceState({}, "", "/?token=arena-secret");
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(screen.getByRole("heading", { name: "Run Monitor" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(screen.getByRole("heading", { name: "Compare Verdicts" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(screen.getByRole("heading", { name: "Import a Skill" })).toBeVisible();
  });

  it("switches from the real import lobby to the run screen with its run id", async () => {
    stubLobbyApi();
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?token=arena-secret");
    render(<App />);

    await user.type(
      screen.getByRole("textbox", { name: "GitHub URL" }),
      "https://github.com/example/skill"
    );
    await user.click(screen.getByRole("button", { name: "Inspect source" }));
    await screen.findByText("LOCKED");
    await user.click(screen.getByRole("button", { name: "Start Crash Test" }));

    expect(await screen.findByRole("heading", { name: "Run Monitor" })).toBeVisible();
    expect(screen.getByText("run_app_01")).toBeVisible();
  });

  it("hands the exact selected manifest into the live run screen", async () => {
    vi.spyOn(ArenaApi.prototype, "health").mockResolvedValue(lobbyHealth());
    vi.spyOn(ArenaApi.prototype, "listManifests")
      .mockResolvedValue([lobbyManifest(), falseGreenManifest()]);
    vi.spyOn(ArenaApi.prototype, "importSkill").mockResolvedValue(lobbySnapshot());
    vi.spyOn(ArenaApi.prototype, "compileContract").mockResolvedValue(lobbyContract());
    const startRun = vi.spyOn(ArenaApi.prototype, "startRun").mockResolvedValue(lobbyRun());
    vi.spyOn(ArenaApi.prototype, "getRun").mockResolvedValue(lobbyRun());
    vi.spyOn(ArenaApi.prototype, "openRunStream").mockReturnValue({
      close: vi.fn(), onerror: null, onmessage: null, onopen: null
    });
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?token=arena-secret");
    render(<App />);

    await user.type(
      screen.getByRole("textbox", { name: "GitHub URL" }),
      "https://github.com/example/skill"
    );
    await user.click(screen.getByRole("button", { name: "Inspect source" }));
    await screen.findByText("LOCKED");
    await user.click(screen.getByRole("radio", { name: /False Green Mimic/ }));
    await user.click(screen.getByRole("button", { name: "Start Crash Test" }));

    expect(await screen.findByRole("heading", { name: "False Green Mimic" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Dirty Tree" })).not.toBeInTheDocument();
    expect(startRun).toHaveBeenCalledWith("repo-false-green-v1", hash);
  });

  it("rejects a terminal report that drifts from the locked run context", async () => {
    vi.spyOn(ArenaApi.prototype, "health").mockResolvedValue(lobbyHealth());
    vi.spyOn(ArenaApi.prototype, "listManifests").mockResolvedValue([falseGreenManifest()]);
    vi.spyOn(ArenaApi.prototype, "importSkill").mockResolvedValue(lobbySnapshot());
    vi.spyOn(ArenaApi.prototype, "compileContract").mockResolvedValue(lobbyContract());
    vi.spyOn(ArenaApi.prototype, "startRun").mockResolvedValue(lobbyRun());
    const completedRun: RunEnvelope = {
      ...lobbyRun(), state: "completed", ended_at: "2026-07-15T00:01:00.000Z"
    };
    const getRun = vi.spyOn(ArenaApi.prototype, "getRun")
      .mockResolvedValueOnce(lobbyRun())
      .mockResolvedValueOnce(completedRun);
    vi.spyOn(ArenaApi.prototype, "report").mockResolvedValue(
      ArenaReportSchema.parse(sanitizedReport())
    );
    const source: ArenaEventSource = {
      close: vi.fn<() => void>(), onerror: null, onmessage: null, onopen: null
    };
    vi.spyOn(ArenaApi.prototype, "openRunStream").mockReturnValue(source);
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?token=arena-secret");
    render(<App />);

    await user.type(
      screen.getByRole("textbox", { name: "GitHub URL" }),
      "https://github.com/example/skill"
    );
    await user.click(screen.getByRole("button", { name: "Inspect source" }));
    await screen.findByText("LOCKED");
    await user.click(screen.getByRole("button", { name: "Start Crash Test" }));
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(1));
    await act(async () => {
      source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
        v: 1,
        run_id: "run_app_01",
        seq: 1,
        phase: "judge",
        kind: "run.finished",
        actor: "arena",
        data: { status: "defeat" },
        artifacts: []
      }) }));
      await Promise.resolve();
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to refresh this run safely."
    );
    expect(screen.queryByText("80/100")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "False Green Mimic" })).toBeVisible();
  });

  it("keeps the validated running envelope while a terminal refresh is pending", async () => {
    stubLobbyApi();
    const running = { ...lobbyRun(), state: "running" as const };
    const completed = {
      ...running, state: "completed" as const, ended_at: "2026-07-15T00:01:00.000Z"
    };
    const refresh = deferred<RunEnvelope>();
    vi.spyOn(ArenaApi.prototype, "getRun")
      .mockResolvedValueOnce(running)
      .mockReturnValueOnce(refresh.promise);
    vi.spyOn(ArenaApi.prototype, "report").mockResolvedValue(lobbyReport(completed, [{
      v: 1, run_id: completed.run_id, seq: 0, phase: "judge", kind: "run.finished",
      actor: "arena", artifacts: []
    }]));
    const source: ArenaEventSource = {
      close: vi.fn<() => void>(), onerror: null, onmessage: null, onopen: null
    };
    vi.spyOn(ArenaApi.prototype, "openRunStream").mockReturnValue(source);
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?token=arena-secret");
    render(<App />);

    await user.type(screen.getByRole("textbox", { name: "GitHub URL" }), "https://github.com/example/skill");
    await user.click(screen.getByRole("button", { name: "Inspect source" }));
    await screen.findByText("LOCKED");
    await user.click(screen.getByRole("button", { name: "Start Crash Test" }));
    expect(await screen.findByText("RUNNING")).toBeVisible();

    act(() => source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      v: 1, run_id: running.run_id, seq: 0, phase: "judge", kind: "run.finished",
      actor: "arena", data: {}, artifacts: []
    }) })));
    expect(screen.getByText("RUNNING")).toBeVisible();
    expect(screen.queryByText("CREATED")).not.toBeInTheDocument();

    refresh.resolve(completed);
    expect(await screen.findByText("80/100")).toBeVisible();
  });

  it("merges report-base trace with richer partial stream events by run and sequence", async () => {
    stubLobbyApi();
    const running = { ...lobbyRun(), state: "running" as const };
    const completed = {
      ...running, state: "completed" as const, ended_at: "2026-07-15T00:01:00.000Z"
    };
    vi.spyOn(ArenaApi.prototype, "getRun")
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(completed);
    vi.spyOn(ArenaApi.prototype, "report").mockResolvedValue(lobbyReport(completed, [
      { v: 1, seq: 0, phase: "verify", kind: "process.exited", actor: "codex", artifacts: [] },
      { v: 1, seq: 1, phase: "verify", kind: "test.completed", actor: "verifier", artifacts: [] },
      { v: 1, seq: 2, phase: "judge", kind: "run.finished", actor: "arena", artifacts: [] }
    ]));
    const source: ArenaEventSource = {
      close: vi.fn<() => void>(), onerror: null, onmessage: null, onopen: null
    };
    vi.spyOn(ArenaApi.prototype, "openRunStream").mockReturnValue(source);
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?token=arena-secret");
    render(<App />);

    await user.type(screen.getByRole("textbox", { name: "GitHub URL" }), "https://github.com/example/skill");
    await user.click(screen.getByRole("button", { name: "Inspect source" }));
    await screen.findByText("LOCKED");
    await user.click(screen.getByRole("button", { name: "Start Crash Test" }));
    await screen.findByText("RUNNING");

    act(() => {
      for (const payload of [
        { v: 1, run_id: running.run_id, seq: 0, phase: "verify", kind: "process.exited", actor: "codex", data: { argv: ["pnpm", "test"], exit_code: 7 }, artifacts: [] },
        { v: 1, run_id: running.run_id, seq: 2, phase: "judge", kind: "run.finished", actor: "arena", data: {}, artifacts: [] }
      ]) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
    });
    expect(await screen.findByText("80/100")).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Trace" }));
    expect(screen.getByRole("button", { name: /#1\s+test.completed/ })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /#0\s+process.exited/ }));
    await user.click(screen.getByRole("tab", { name: "Evidence" }));
    expect(screen.getByText("7")).toBeVisible();
    expect(screen.getByText("pnpm test")).toBeVisible();
  });

  it("renders only the bounded redacted diff summary supplied by a validated terminal report", async () => {
    stubLobbyApi();
    const running = { ...lobbyRun(), state: "running" as const };
    const completed = {
      ...running, state: "completed" as const, ended_at: "2026-07-15T00:01:00.000Z"
    };
    vi.spyOn(ArenaApi.prototype, "getRun")
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(completed);
    vi.spyOn(ArenaApi.prototype, "report").mockResolvedValue(lobbyReport(completed, [{
      v: 1, seq: 0, phase: "judge", kind: "run.finished", actor: "arena",
      artifacts: [`sha256:${hash}`]
    }], true));
    const source: ArenaEventSource = {
      close: vi.fn<() => void>(), onerror: null, onmessage: null, onopen: null
    };
    vi.spyOn(ArenaApi.prototype, "openRunStream").mockReturnValue(source);
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?token=arena-secret");
    render(<App />);
    await user.type(screen.getByRole("textbox", { name: "GitHub URL" }), "https://github.com/example/skill");
    await user.click(screen.getByRole("button", { name: "Inspect source" }));
    await screen.findByText("LOCKED");
    await user.click(screen.getByRole("button", { name: "Start Crash Test" }));
    await screen.findByText("RUNNING");
    act(() => source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      v: 1, run_id: running.run_id, seq: 0, phase: "judge", kind: "run.finished",
      actor: "arena", data: {}, artifacts: [`sha256:${hash}`]
    }) })));
    expect(await screen.findByText("80/100")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    expect(screen.getByText("Diff artifact")).toBeVisible();
    expect(screen.getByText("120 bytes · text/x-diff · redacted")).toBeVisible();
    expect(screen.getByText("REDACTED")).toBeVisible();
  });

  it("ignores a late terminal refresh after the run screen unmounts", async () => {
    stubLobbyApi();
    const running = { ...lobbyRun(), state: "running" as const };
    const refresh = deferred<RunEnvelope>();
    vi.spyOn(ArenaApi.prototype, "getRun")
      .mockResolvedValueOnce(running)
      .mockReturnValueOnce(refresh.promise);
    const source: ArenaEventSource = {
      close: vi.fn<() => void>(), onerror: null, onmessage: null, onopen: null
    };
    vi.spyOn(ArenaApi.prototype, "openRunStream").mockReturnValue(source);
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?token=arena-secret");
    render(<App />);
    await user.type(screen.getByRole("textbox", { name: "GitHub URL" }), "https://github.com/example/skill");
    await user.click(screen.getByRole("button", { name: "Inspect source" }));
    await screen.findByText("LOCKED");
    await user.click(screen.getByRole("button", { name: "Start Crash Test" }));
    await screen.findByText("RUNNING");
    act(() => source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      v: 1, run_id: running.run_id, seq: 0, phase: "judge", kind: "run.finished",
      actor: "arena", data: {}, artifacts: []
    }) })));
    await user.click(screen.getByRole("button", { name: "Import" }));
    refresh.resolve({ ...running, state: "completed", ended_at: "2026-07-15T00:01:00.000Z" });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("heading", { name: "Import a Skill" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("ArenaApi", () => {
  it("maps the complete JSON control surface onto authenticated loopback routes", async () => {
    const snapshot = {
      schema: "arena.skill-snapshot/v1",
      source: { kind: "local", uri: "file:///redacted/import" },
      entrypoint: "SKILL.md",
      license: "MIT",
      files: [{ path: "SKILL.md", bytes: 8, sha256: hash }],
      source_hash: hash,
      imported_path: "/redacted/import"
    };
    const run = { ...runRecord(), state: "created", ended_at: undefined };
    const responses = new Map<string, unknown>([
      ["GET /api/health", {
        ok: true,
        checks: [{ id: "app-data", ok: true, message: "ready" }],
        model: { target: "gpt-5.6", status: "configured-unverified" }
      }],
      ["POST /api/imports", snapshot],
      [`GET /api/imports/${hash}`, snapshot],
      ["POST /api/contracts", {
        schema: "arena.skill-contract/v1",
        snapshot_hash: hash,
        model: "gpt-5.6",
        promises: [],
        preconditions: [],
        expected_artifacts: [],
        recovery_rules: [],
        risk_signals: []
      }],
      ["GET /api/manifests", []],
      ["POST /api/runs", run],
      ["GET /api/runs/run%2F01", run],
      ["POST /api/runs/run%2F01/diagnose", {
        schema: "arena.diagnosis/v1",
        run_id: "run/01",
        model: "gpt-5.6",
        observed_failure: "failure",
        likely_skill_gap: "gap",
        retry_analysis: "retry",
        suggested_changes: ["change"],
        evidence_refs: ["event:0"]
      }],
      ["POST /api/runs/run%2F01/repairs", {
        repair_id: "repair/01",
        run_id: "run/01",
        status: "pending",
        snapshot_hash: hash,
        created_at: "2026-07-15T00:02:00.000Z",
        changed_paths: ["SKILL.md"],
        patch_ref: `sha256:${hash}`
      }],
      ["POST /api/repairs/repair%2F01/rerun", { ...run, parent_run_id: "run/01" }],
      ["GET /api/runs/run%2F01/report", sanitizedReport()]
    ]);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const method = init?.method ?? "GET";
      const key = `${method} ${String(input)}`;
      return new Response(JSON.stringify(responses.get(key)), {
        status: method === "POST" ? 201 : 200,
        headers: { "content-type": "application/json" }
      });
    });
    const api = new ArenaApi("arena-token", { fetch: fetchMock });

    await api.health();
    await api.importSkill({ kind: "local", path: "/skills/local", entrypoint: "SKILL.md" });
    await api.importSkill({
      kind: "git", url: "https://example.test/skill.git", revision: "main"
    });
    await api.importSkill({ kind: "sample", id: "repo-bugfix" });
    await api.getImport(hash);
    await api.compileContract(hash);
    await api.listManifests();
    await api.startRun("repo-dirty-tree-v1", hash);
    await api.getRun("run/01");
    await api.diagnose("run/01");
    await api.createRepair("run/01");
    await api.rerun("repair/01");
    await api.report("run/01");

    expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${String(url)}`))
      .toEqual([
        "GET /api/health",
        "POST /api/imports",
        "POST /api/imports",
        "POST /api/imports",
        `GET /api/imports/${hash}`,
        "POST /api/contracts",
        "GET /api/manifests",
        "POST /api/runs",
        "GET /api/runs/run%2F01",
        "POST /api/runs/run%2F01/diagnose",
        "POST /api/runs/run%2F01/repairs",
        "POST /api/repairs/repair%2F01/rerun",
        "GET /api/runs/run%2F01/report"
      ]);
    expect(fetchMock.mock.calls.every(([, init]) =>
      new Headers(init?.headers).get("x-arena-token") === "arena-token"
    )).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      kind: "local", path: "/skills/local", entrypoint: "SKILL.md"
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body))).toEqual({
      kind: "git", url: "https://example.test/skill.git", revision: "main"
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3]![1]?.body))).toEqual({
      kind: "sample", id: "repo-bugfix"
    });
    expect(JSON.parse(String(fetchMock.mock.calls[5]![1]?.body))).toEqual({
      snapshot_hash: hash
    });
    expect(JSON.parse(String(fetchMock.mock.calls[7]![1]?.body))).toEqual({
      manifest_id: "repo-dirty-tree-v1", snapshot_hash: hash
    });
  });

  it("uses header authentication for fetch and an encoded query only for SSE", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const streamUrls: string[] = [];
    const eventSource = vi.fn((url: string) => {
      streamUrls.push(url);
      return { close: vi.fn(), onopen: null, onmessage: null, onerror: null };
    });
    const token = "secret value&token=second";
    const api = new ArenaApi(token, { fetch: fetchMock, eventSource });

    await api.listManifests();
    api.openRunStream("run/01");

    const [fetchUrl, fetchInit] = fetchMock.mock.calls[0]!;
    expect(String(fetchUrl)).toBe("/api/manifests");
    expect(new Headers(fetchInit?.headers).get("x-arena-token")).toBe(token);
    expect(String(fetchUrl)).not.toContain("token=");
    const streamUrl = new URL(streamUrls[0]!, "http://localhost");
    expect([...streamUrl.searchParams.entries()]).toEqual([["token", token]]);
    expect(streamUrl.pathname).toBe("/api/runs/run%2F01/events");
  });

  it("authenticates multipart imports without setting content-type", async () => {
    const snapshot = {
      schema: "arena.skill-snapshot/v1",
      source: { kind: "zip", uri: "upload:skill.zip" },
      entrypoint: "SKILL.md",
      license: "unknown",
      files: [{ path: "SKILL.md", bytes: 8, sha256: hash }],
      source_hash: hash,
      imported_path: "/redacted/import"
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify(snapshot),
      { status: 201, headers: { "content-type": "application/json" } }
    ));
    const api = new ArenaApi("arena-token", { fetch: fetchMock });

    await api.importSkill({ kind: "zip", file: new File(["zip"], "skill.zip") });

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("x-arena-token")).toBe("arena-token");
    expect(headers.has("content-type")).toBe(false);
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it.each([
    ["pending repair", sanitizedReport({ repair: sanitizedRepair("pending") })],
    ["approved repair", sanitizedReport({ repair: sanitizedRepair("approved") })],
    ["failed repair", sanitizedReport({ repair: sanitizedRepair("failed") })],
    ["error verdict", sanitizedReport({ errorVerdict: true })]
  ])("parses a real sanitized report with %s", async (_label, report) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify(report),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    const api = new ArenaApi("arena-token", { fetch: fetchMock });

    await expect(api.report("run/01")).resolves.toEqual(report);
  });

  it.each([
    ["raw trace data", (() => {
      const report = sanitizedReport();
      (report.trace as Array<Record<string, unknown>>)[0]!.data = { private: "server-secret" };
      return report;
    })()],
    ["snapshot imported path", (() => {
      const report = sanitizedReport();
      (report.snapshot as Record<string, unknown>).imported_path = "/private/import";
      return report;
    })()],
    ["unknown report field", { ...sanitizedReport(), unexpected: "server-secret" }]
  ])("rejects %s as an invalid report response", async (_label, report) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify(report),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    const api = new ArenaApi("arena-token", { fetch: fetchMock });

    await expect(api.report("run/01")).rejects.toMatchObject({
      status: 200,
      code: "INVALID_RESPONSE",
      message: "Invalid response from Arena"
    });
  });

  it.each([
    [500, "text/plain", "server-secret plain text"],
    [502, "application/json", JSON.stringify({ error: { code: 42, message: ["secret"] } })]
  ])("rejects unsafe error payloads without exposing details", async (status, contentType, body) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      status,
      headers: { "content-type": contentType }
    }));
    const api = new ArenaApi("arena-token", { fetch: fetchMock });

    const request = api.getImport(hash);
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({
      status,
      code: "REQUEST_FAILED",
      message: "Request failed safely"
    });
    await expect(request).rejects.not.toThrow(/server-secret|plain text|secret/u);
  });

  it.each(["synchronous", "asynchronous"])(
    "wraps %s fetch failures without exposing transport details",
    async (mode) => {
      const fetchMock = vi.fn<typeof fetch>(() => {
        const error = new Error("server-secret transport failure");
        if (mode === "synchronous") throw error;
        return Promise.reject(error);
      });
      const api = new ArenaApi("arena-token", { fetch: fetchMock });

      const request = api.listManifests();
      await expect(request).rejects.toBeInstanceOf(ApiError);
      await expect(request).rejects.toMatchObject({
        status: 0,
        code: "REQUEST_FAILED",
        message: "Request failed safely"
      });
      await expect(request).rejects.not.toThrow(/server-secret|transport failure/u);
    }
  );
});
