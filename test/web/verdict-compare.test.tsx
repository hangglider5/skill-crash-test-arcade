import { StrictMode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  VerdictCompare,
  type CandidateRepairView,
  type LockedResultView
} from "../../apps/web/src/components/VerdictCompare.js";
import type { Diagnosis, EvidenceRef, RunEnvelope } from "../../src/protocol/schema.js";
import type { SanitizedVerdict } from "../../apps/web/src/api.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const artifactRef = `sha256:${hashA}` as const;

function run(overrides: Partial<RunEnvelope> = {}): RunEnvelope {
  return {
    schema: "arena.run/v1",
    run_id: "run_baseline",
    run_group_id: "group_quick",
    trial_index: 0,
    manifest_hash: hashA,
    snapshot_hash: hashA,
    fixture_hash: hashB,
    runner: { adapter: "codex-cli", model: "gpt-5.6-sol" },
    state: "completed",
    started_at: "2026-07-15T00:00:00.000Z",
    ended_at: "2026-07-15T00:01:00.000Z",
    ...overrides
  };
}

function verdict(status: "victory" | "defeat" | "error" = "defeat"): SanitizedVerdict {
  const common = {
    schema: "arena.verdict/v1" as const,
    run_id: "run_baseline",
    hard_gate_failures: status === "defeat" ? ["preserve_existing_changes"] : [],
    dimensions: [
      { id: "task_correctness", earned: 30, possible: 40, evidence: ["event:31" as const] },
      { id: "change_isolation", earned: 0, possible: 25, evidence: ["event:37" as const] },
      { id: "verification_quality", earned: 18, possible: 20, evidence: [artifactRef] },
      { id: "recovery_discipline", earned: 10, possible: 15, evidence: ["event:25" as const] }
    ],
    verifier_results: [{
      id: "preserve_existing_changes",
      passed: status === "victory",
      hard_gate: true,
      message: status === "victory" ? "Protected draft preserved" : "Protected draft changed",
      evidence: ["event:37" as const]
    }],
    evidence: ["event:37" as const]
  };
  return status === "error"
    ? { ...common, status, error: { code: "VERIFIER_CRASH" } }
    : { ...common, status, score: status === "victory" ? 91 : 58 };
}

function baseline(status: "victory" | "defeat" | "error" = "defeat"): LockedResultView {
  return {
    run: run(status === "error" ? { state: "errored" } : {}),
    verdict: verdict(status),
    redaction_complete: true,
    failed_verifier_evidence: status === "defeat" ? [
      { label: "Protected draft existed before the run", evidence_refs: ["event:4"] },
      { label: "Repair step changed docs/roadmap.md", evidence_refs: ["event:37", artifactRef] },
      { label: "Hard gate locked the defeat", evidence_refs: ["event:38"] }
    ] : []
  };
}

function diagnosis(): Diagnosis {
  return {
    schema: "arena.diagnosis/v1",
    run_id: "run_baseline",
    model: "gpt-5.6-sol",
    observed_failure: "A protected pre-existing change was overwritten.",
    likely_skill_gap: "The Skill lacks a preservation check before patching.",
    retry_analysis: "No bounded recovery followed the mutation.",
    suggested_changes: ["Add an explicit protected-change check."],
    evidence_refs: ["event:37", artifactRef]
  };
}

function repair(status: "pending" | "approved" = "pending"): CandidateRepairView {
  const proposal = status === "approved" ? {
    schema: "arena.repair/v1" as const,
    repair_id: "repair_01",
    run_id: "run_baseline",
    status,
    snapshot_hash: hashA,
    created_at: "2026-07-15T00:02:00.000Z",
    changed_paths: ["SKILL.md"],
    patch_ref: artifactRef,
    reviewed_patch_ref: artifactRef,
    child_run_id: "run_child",
    new_snapshot_hash: hashB
  } : {
    schema: "arena.repair/v1" as const,
    repair_id: "repair_01",
    run_id: "run_baseline",
    status,
    snapshot_hash: hashA,
    created_at: "2026-07-15T00:02:00.000Z",
    changed_paths: ["SKILL.md"],
    patch_ref: artifactRef
  };
  return {
    proposal,
    patch: {
      repair_id: "repair_01",
      patch_ref: artifactRef,
      mime: "text/x-diff",
      bytes: 108,
      redacted: false,
      export_ready: false,
      text: "diff --git a/SKILL.md b/SKILL.md\n--- a/SKILL.md\n+++ b/SKILL.md\n+Preserve existing changes before editing.\n"
    }
  };
}

function child(overrides: Partial<RunEnvelope> = {}): LockedResultView {
  return {
    run: run({
      run_id: "run_child",
      parent_run_id: "run_baseline",
      snapshot_hash: hashB,
      ...overrides
    }),
    verdict: { ...verdict("victory"), run_id: "run_child" },
    redaction_complete: true,
    failed_verifier_evidence: []
  };
}

function actions() {
  return {
    onDiagnose: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onCreateRepair: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onReject: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onApproveRerun: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onExportReport: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onEvidenceSelect: vi.fn<(ref: EvidenceRef) => void>()
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("VerdictCompare", () => {
  it.each([
    ["running victory", run({ state: "running", ended_at: undefined }), verdict("victory")],
    ["errored victory", run({ state: "errored" }), verdict("victory")],
    ["victory with hard-gate failures", run(), {
      ...verdict("victory"),
      hard_gate_failures: ["gate_01"]
    }]
  ])("does not present %s as a locked result", (_label, invalidRun, invalidVerdict) => {
    render(
      <VerdictCompare
        {...actions()}
        baseline={{
          run: invalidRun,
          verdict: invalidVerdict,
          redaction_complete: true,
          failed_verifier_evidence: []
        }}
      />
    );

    expect(screen.queryByText(/LOCKED/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\/ 100/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Diagnose|repair|Rerun|Export/i }))
      .not.toBeInTheDocument();
    expect(screen.getByText("Result unavailable")).toBeVisible();
  });

  it("renders a locked evidence-linked defeat and an explicit repair comparison", async () => {
    const user = userEvent.setup();
    const callbacks = actions();
    render(
      <VerdictCompare
        {...callbacks}
        baseline={baseline()}
        child={child()}
        diagnosis={diagnosis()}
        repair={repair("approved")}
      />
    );

    expect(screen.getByText("DEFEAT")).toBeVisible();
    expect(screen.getByText("58 / 100")).toBeVisible();
    expect(screen.getByText("preserve_existing_changes")).toBeVisible();
    expect(screen.getByText("ADVISORY")).toBeVisible();
    expect(screen.getByText("Original unchanged")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Failed verifier evidence" })).toBeVisible();
    expect(screen.queryByText(/consequential|failure chain/i)).not.toBeInTheDocument();
    expect(screen.getByText("Observed improvement")).toBeVisible();
    expect(screen.queryByText("Causal proof")).not.toBeInTheDocument();

    const dimensions = screen.getByRole("region", { name: "Dimension scores" });
    expect(within(dimensions).getByText("30 / 40")).toBeVisible();
    expect(within(dimensions).getByText("0 / 25")).toBeVisible();
    expect(screen.getByText("diff --git a/SKILL.md b/SKILL.md", { exact: false })).toBeVisible();
    expect(screen.getByText("SKILL.md")).toBeVisible();

    await user.click(screen.getAllByRole("button", { name: "event:37" })[0]!);
    expect(callbacks.onEvidenceSelect).toHaveBeenCalledWith("event:37");
    expect(screen.getByRole("button", { name: "Approve & Rerun" })).toBeDisabled();
  });

  it("does not compare or export a child that is not bound to the reviewed approved patch", () => {
    const { rerender } = render(
      <VerdictCompare
        {...actions()}
        baseline={baseline()}
        child={child()}
        repair={repair("pending")}
      />
    );

    expect(screen.getByText("Non-comparable result")).toBeVisible();
    expect(screen.queryByText("Observed improvement")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export report" })).toBeDisabled();

    const approved = repair("approved");
    if (approved.proposal.status !== "approved") throw new Error("test repair must be approved");
    rerender(
      <VerdictCompare
        {...actions()}
        baseline={baseline()}
        child={child()}
        repair={{
          ...approved,
          proposal: { ...approved.proposal, reviewed_patch_ref: `sha256:${hashB}` }
        }}
      />
    );
    expect(screen.getByText("Non-comparable result")).toBeVisible();
    expect(screen.queryByText("Observed improvement")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export report" })).toBeDisabled();
  });

  it("locks errors without a fabricated score and reports non-comparable lineage", () => {
    render(
      <VerdictCompare
        {...actions()}
        baseline={baseline("error")}
        child={child({ fixture_hash: hashA, parent_run_id: "run_other" })}
      />
    );

    expect(screen.getByText("ERROR")).toBeVisible();
    expect(screen.getByText("VERIFIER_CRASH")).toBeVisible();
    expect(screen.queryByText(/\/ 100/)).not.toBeInTheDocument();
    expect(screen.getByText("Non-comparable result")).toBeVisible();
    expect(screen.getByText("Fixture mismatch")).toBeVisible();
    expect(screen.getByText("Parent run mismatch")).toBeVisible();
    expect(screen.queryByText("Observed improvement")).not.toBeInTheDocument();
  });

  it("keeps export disabled unless redaction completeness is explicitly true", () => {
    const { rerender } = render(
      <VerdictCompare {...actions()} baseline={{ ...baseline(), redaction_complete: undefined }} />
    );
    expect(screen.getByRole("button", { name: "Export report" })).toBeDisabled();
    expect(screen.getByText("Export blocked: redaction completeness is unknown.")).toBeVisible();

    rerender(<VerdictCompare {...actions()} baseline={{ ...baseline(), redaction_complete: false }} />);
    expect(screen.getByRole("button", { name: "Export report" })).toBeDisabled();
    expect(screen.getByText("Export blocked: redaction is incomplete.")).toBeVisible();
  });

  it("never treats a candidate patch as publication-redacted and bounds rendered content", () => {
    const manyPaths = Array.from({ length: 80 }, (_, index) => `docs/path-${index}.md`);
    const longPatch = `diff --git a/SKILL.md b/SKILL.md\n${"+x\n".repeat(20_000)}`;
    const candidate = repair();
    const candidatePatch = candidate.patch!;
    render(
      <VerdictCompare
        {...actions()}
        baseline={baseline()}
        repair={{
          ...candidate,
          proposal: { ...candidate.proposal, changed_paths: manyPaths },
          patch: { ...candidatePatch, bytes: longPatch.length, text: longPatch }
        }}
      />
    );

    expect(screen.getByText("Local review only — not export-redacted")).toBeVisible();
    expect(screen.getByText("Showing 24 of 80 changed paths.")).toBeVisible();
    expect(screen.getByText("Patch preview truncated for safe rendering.")).toBeVisible();
  });

  it("survives StrictMode effect replay and releases a failed async action", async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const callbacks = actions();
    callbacks.onDiagnose.mockReturnValueOnce(pending.promise);
    render(
      <StrictMode>
        <VerdictCompare {...callbacks} baseline={baseline()} />
      </StrictMode>
    );

    await user.click(screen.getByRole("button", { name: "Diagnose locked defeat" }));
    await act(async () => pending.reject(new Error("private failure")));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Action failed safely. The locked verdict is unchanged."
    );
    expect(screen.getByRole("button", { name: "Diagnose locked defeat" })).toBeEnabled();
  });

  it("drops stale async completion after the baseline generation changes", async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const callbacks = actions();
    callbacks.onDiagnose.mockReturnValueOnce(pending.promise);
    const { rerender } = render(<VerdictCompare {...callbacks} baseline={baseline()} />);
    await user.click(screen.getByRole("button", { name: "Diagnose locked defeat" }));

    const next = baseline();
    rerender(
      <VerdictCompare
        {...callbacks}
        baseline={{
          ...next,
          run: { ...next.run, run_id: "run_next", run_group_id: "group_next" },
          verdict: { ...next.verdict, run_id: "run_next" }
        }}
      />
    );
    await act(async () => pending.reject(new Error("old private failure")));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Diagnose locked defeat" })).toBeEnabled();
  });

  it.each(["verdict membership", "terminal state"] as const)(
    "rejects a child with invalid %s from observed improvement",
    (mutation) => {
    const candidate = child();
    const { ended_at: _endedAt, ...unterminatedRun } = candidate.run;
    const invalid = mutation === "verdict membership" ? {
      ...candidate,
      verdict: { ...candidate.verdict, run_id: "run_other" }
    } : {
      ...candidate,
      run: {
        ...unterminatedRun,
        state: "running" as const
      }
    };
    render(<VerdictCompare {...actions()} baseline={baseline()} child={invalid} />);

    expect(screen.getByText("Non-comparable result")).toBeVisible();
    expect(screen.queryByText("Observed improvement")).not.toBeInTheDocument();
  });

  it("renders evidence as inert text without a selection action and bounds advisory text", () => {
    const advisory = diagnosis();
    render(
      <VerdictCompare
        {...actions()}
        baseline={baseline()}
        diagnosis={{
          ...advisory,
          observed_failure: `${"x".repeat(900)}VISIBLE_MARKER`,
          suggested_changes: ["same", "same"]
        }}
        onEvidenceSelect={undefined}
      />
    );

    expect(screen.getAllByText("event:37").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "event:37" })).not.toBeInTheDocument();
    expect(screen.queryByText(/VISIBLE_MARKER/u)).not.toBeInTheDocument();
    expect(screen.getAllByText("same")).toHaveLength(2);
  });
});
