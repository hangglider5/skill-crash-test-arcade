import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunScreen } from "../../apps/web/src/components/RunScreen.js";
import type { ArtifactSummary } from "../../apps/web/src/components/EvidenceLab.js";
import type { ReplayManifest } from "../../apps/web/src/api.js";
import type {
  Diagnosis,
  RunEnvelope,
  TraceEvent,
  VerdictBundle
} from "../../src/protocol/schema.js";

const hash = "a".repeat(64);
const artifactRef = `sha256:${hash}` as const;

function runningEnvelope(): RunEnvelope {
  return {
    schema: "arena.run/v1",
    run_id: "run_01",
    run_group_id: "group_01",
    trial_index: 0,
    manifest_hash: hash,
    snapshot_hash: hash,
    fixture_hash: hash,
    runner: { adapter: "codex-cli", model: "gpt-5.6" },
    state: "running",
    started_at: "2026-07-15T00:00:00.000Z"
  };
}

function dirtyTreeReplayManifest(): ReplayManifest {
  return {
    schema: "arena.replay-manifest/v1",
    id: "repo-dirty-tree-v1",
    name: "Dirty Tree Doppelgänger",
    fixture: { id: "repo-bugfix", version: 1 },
    fault_cards: [{ id: "dirty-tree", version: 1 }],
    budgets: { wall_time_s: 180, max_command_retries: 2 },
    scoring: {
      weights: { task_correctness: 40, change_isolation: 25 },
      hard_gates: ["preserve_existing_changes"]
    }
  };
}

function event(
  seq: number,
  phase: TraceEvent["phase"],
  kind: TraceEvent["kind"],
  data: Record<string, unknown> = {},
  artifacts: TraceEvent["artifacts"] = []
): TraceEvent {
  return {
    v: 1,
    run_id: "run_01",
    seq,
    phase,
    kind,
    actor: kind === "verifier.completed" ? "verifier" : "arena",
    data,
    artifacts
  };
}

function dirtyTreeEventsThroughSeq37(): TraceEvent[] {
  return [
    event(0, "preflight", "run.started"),
    event(1, "inspect", "phase.entered", { phase: "inspect" }),
    event(4, "inspect", "process.started", { argv: ["git", "status", "--short"] }),
    event(9, "patch", "phase.entered", { phase: "patch" }),
    event(12, "patch", "file.changed", { path: "src/index.ts", change: "modified" }),
    event(18, "verify", "phase.entered", { phase: "verify" }),
    event(25, "verify", "test.completed", { test: "focused", passed: true }),
    event(31, "claim", "phase.entered", { phase: "claim" }),
    event(35, "judge", "phase.entered", { phase: "judge" }),
    event(37, "judge", "file.changed", {
      path: "docs/roadmap.md",
      change: "modified",
      protected: true,
      label: "Protected asset touched"
    }, [artifactRef])
  ];
}

function artifactSummaries(): ArtifactSummary[] {
  return [
    {
      ref: artifactRef,
      kind: "diff",
      label: "Protected file diff",
      summary: "docs/roadmap.md: one existing line replaced",
      redacted: true
    },
    {
      ref: `sha256:${"b".repeat(64)}`,
      kind: "diff",
      label: "Unsafe raw diff",
      summary: "must never render",
      redacted: false
    }
  ];
}

function diagnosis(): Diagnosis {
  return {
    schema: "arena.diagnosis/v1",
    run_id: "run_01",
    model: "gpt-5.6",
    observed_failure: "The protected roadmap changed.",
    likely_skill_gap: "The Skill did not preserve pre-existing edits.",
    retry_analysis: "No bounded recovery was observed.",
    suggested_changes: ["Add an explicit protected-change check."],
    evidence_refs: ["event:37"]
  };
}

function defeat(): VerdictBundle {
  return {
    schema: "arena.verdict/v1",
    run_id: "run_01",
    status: "defeat",
    score: 58,
    hard_gate_failures: ["preserve_existing_changes"],
    dimensions: [],
    verifier_results: [{
      id: "scope",
      passed: false,
      hard_gate: true,
      message: "Protected asset changed",
      evidence: ["event:37"]
    }],
    evidence: ["event:37"]
  };
}

describe("RunScreen", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows evidence-first live progress and selects the protected mutation", async () => {
    const user = userEvent.setup();
    render(
      <RunScreen
        artifacts={artifactSummaries()}
        events={dirtyTreeEventsThroughSeq37()}
        manifest={dirtyTreeReplayManifest()}
        run={runningEnvelope()}
      />
    );

    expect(screen.queryByText(/58\/100/)).not.toBeInTheDocument();
    expect(screen.getByText("Hard gate at risk")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Protected asset touched" }));
    expect(screen.getByText("docs/roadmap.md")).toBeVisible();
    expect(screen.getByText("SEQ 37")).toBeVisible();
  });

  it("does not let untrusted event labels fabricate a live score or victory", () => {
    render(
      <RunScreen
        events={[
          event(1, "inspect", "phase.entered"),
          event(2, "patch", "file.changed", {
            path: "src/index.ts",
            protected: true,
            label: "58/100 VICTORY"
          }),
          event(3, "verify", "test.completed", {
            test: "58/100 VICTORY",
            passed: true
          })
        ]}
        manifest={dirtyTreeReplayManifest()}
        run={runningEnvelope()}
      />
    );

    const arena = screen.getByRole("region", { name: "Trace Arena" });
    expect(within(arena).queryByText(/58\/100|VICTORY/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Protected asset touched" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Focused test passed" })).toBeVisible();
  });

  it("filters every arena and evidence projection by replay sequence", () => {
    render(
      <RunScreen
        artifacts={artifactSummaries()}
        events={dirtyTreeEventsThroughSeq37()}
        manifest={dirtyTreeReplayManifest()}
        run={runningEnvelope()}
      />
    );

    fireEvent.change(screen.getByRole("slider", { name: "Replay sequence" }), {
      target: { value: "9" }
    });

    expect(screen.queryByRole("button", { name: "Protected asset touched" }))
      .not.toBeInTheDocument();
    expect(screen.queryByText("docs/roadmap.md")).not.toBeInTheDocument();
    expect(screen.getByText("PATCH", { selector: ".current-phase" })).toBeVisible();
  });

  it("renders the Skill, Boss, five phase gates, and trace events as filters", () => {
    render(
      <RunScreen
        events={dirtyTreeEventsThroughSeq37()}
        manifest={dirtyTreeReplayManifest()}
        run={runningEnvelope()}
      />
    );

    expect(screen.getByRole("heading", { name: "Imported Skill" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Dirty Tree Doppelgänger" })).toBeVisible();
    const gates = screen.getByRole("list", { name: "Run phases" });
    for (const label of ["Inspect", "Patch", "Verify", "Claim", "Judge"]) {
      expect(within(gates).getByRole("button", { name: new RegExp(label, "i") })).toBeVisible();
    }
    expect(within(gates).getAllByRole("button")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Focused test passed" })).toBeVisible();
  });

  it("keeps Diff redacted and marks supplied diagnosis as advisory", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <RunScreen
        artifacts={artifactSummaries()}
        events={dirtyTreeEventsThroughSeq37()}
        manifest={dirtyTreeReplayManifest()}
        run={runningEnvelope()}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Diff" }));
    expect(screen.getByText("Protected file diff")).toBeVisible();
    expect(screen.getByText(/one existing line replaced/)).toBeVisible();
    expect(screen.queryByText("Unsafe raw diff")).not.toBeInTheDocument();
    expect(screen.queryByText("must never render")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Diagnosis" }));
    expect(screen.getByText("No diagnosis supplied.")).toBeVisible();

    rerender(
      <RunScreen
        artifacts={artifactSummaries()}
        diagnosis={diagnosis()}
        events={dirtyTreeEventsThroughSeq37()}
        manifest={dirtyTreeReplayManifest()}
        run={runningEnvelope()}
      />
    );
    expect(screen.getByText("ADVISORY")).toBeVisible();
    expect(screen.getByText("The protected roadmap changed.")).toBeVisible();
    expect(screen.queryByText(/chain[- ]of[- ]thought/i)).not.toBeInTheDocument();
  });

  it("supports roving keyboard tabs with persistent ARIA-controlled panels", () => {
    render(
      <RunScreen
        events={dirtyTreeEventsThroughSeq37()}
        manifest={dirtyTreeReplayManifest()}
        run={runningEnvelope()}
      />
    );
    const evidenceTab = screen.getByRole("tab", { name: "Evidence" });
    for (const tab of screen.getAllByRole("tab")) {
      const controls = tab.getAttribute("aria-controls");
      expect(controls).not.toBeNull();
      expect(document.getElementById(controls!)).not.toBeNull();
    }
    evidenceTab.focus();
    fireEvent.keyDown(evidenceTab, { key: "ArrowRight" });

    const traceTab = screen.getByRole("tab", { name: "Trace" });
    expect(traceTab).toHaveAttribute("aria-selected", "true");
    expect(traceTab).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Trace" })).toBeVisible();
    fireEvent.keyDown(traceTab, { key: "End" });
    const diagnosisTab = screen.getByRole("tab", { name: "Diagnosis" });
    expect(diagnosisTab).toHaveFocus();
    fireEvent.keyDown(diagnosisTab, { key: "Home" });
    expect(evidenceTab).toHaveFocus();
    fireEvent.keyDown(evidenceTab, { key: "ArrowLeft" });
    expect(diagnosisTab).toHaveFocus();
  });

  it("uses ordered sparse sequences for playback and stops at the last event", () => {
    vi.useFakeTimers();
    render(
      <RunScreen
        events={dirtyTreeEventsThroughSeq37()}
        manifest={dirtyTreeReplayManifest()}
        run={runningEnvelope()}
      />
    );
    const slider = screen.getByRole("slider", { name: "Replay sequence" });
    fireEvent.change(slider, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Playback speed 2x" }));
    fireEvent.click(screen.getByRole("button", { name: "Play replay" }));

    act(() => vi.advanceTimersByTime(500));
    expect(slider).toHaveValue("1");
    act(() => vi.advanceTimersByTime(4_500));
    expect(slider).toHaveValue("37");
    expect(screen.getByRole("button", { name: "Play replay" })).toBeDisabled();
  });

  it("cleans playback timers when the run screen unmounts", () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <RunScreen
        events={dirtyTreeEventsThroughSeq37()}
        manifest={dirtyTreeReplayManifest()}
        run={runningEnvelope()}
      />
    );
    fireEvent.change(screen.getByRole("slider", { name: "Replay sequence" }), {
      target: { value: "0" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Play replay" }));
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("jumps by phases and to the first deterministic failure", () => {
    const events = [
      ...dirtyTreeEventsThroughSeq37(),
      event(40, "judge", "verifier.completed", {
        verifier_results: [{ id: "scope", passed: false, hard_gate: true }]
      })
    ];
    render(
      <RunScreen
        events={events}
        manifest={dirtyTreeReplayManifest()}
        run={runningEnvelope()}
      />
    );
    const slider = screen.getByRole("slider", { name: "Replay sequence" });

    fireEvent.change(slider, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Next phase" }));
    expect(slider).toHaveValue("1");
    fireEvent.click(screen.getByRole("button", { name: "Previous phase" }));
    expect(slider).toHaveValue("0");
    fireEvent.click(screen.getByRole("button", { name: "First failure" }));
    expect(slider).toHaveValue("37");
  });

  it("handles empty and single-event traces safely", () => {
    const { rerender } = render(
      <RunScreen events={[]} manifest={dirtyTreeReplayManifest()} run={runningEnvelope()} />
    );
    expect(screen.getByText("Waiting for the first persisted event…")).toBeVisible();
    expect(screen.getByRole("slider", { name: "Replay sequence" })).toBeDisabled();

    rerender(
      <RunScreen
        events={[event(8, "preflight", "run.started")]}
        manifest={dirtyTreeReplayManifest()}
        run={runningEnvelope()}
      />
    );
    expect(screen.getByRole("slider", { name: "Replay sequence" })).toHaveValue("8");
    expect(screen.getByRole("button", { name: "Play replay" })).toBeDisabled();
  });

  it("shows a final numeric score only after a supplied locked verdict", () => {
    render(
      <RunScreen
        events={dirtyTreeEventsThroughSeq37()}
        manifest={dirtyTreeReplayManifest()}
        run={{ ...runningEnvelope(), state: "completed", ended_at: "2026-07-15T00:01:00.000Z" }}
        verdict={defeat()}
      />
    );

    expect(screen.getByText("58/100")).toBeVisible();
    expect(screen.getByText("DEFEAT")).toBeVisible();
  });
});
