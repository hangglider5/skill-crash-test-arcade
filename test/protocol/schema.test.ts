import { describe, expect, it } from "vitest";
import {
  RunEnvelopeSchema,
  TraceEventSchema,
  VerdictBundleSchema
} from "../../src/protocol/index.js";

describe("public protocol", () => {
  it("accepts an append-only process event", () => {
    const event = TraceEventSchema.parse({
      v: 1,
      run_id: "run_01",
      seq: 12,
      phase: "preflight",
      kind: "process.exited",
      actor: "codex",
      span_id: "cmd_003",
      data: { argv: ["git", "status", "--short"], exit_code: 0 },
      artifacts: []
    });
    expect(event.seq).toBe(12);
  });

  it("keeps infrastructure error distinct from defeat", () => {
    const verdict = VerdictBundleSchema.parse({
      schema: "arena.verdict/v1",
      run_id: "run_01",
      status: "error",
      error: { code: "RUNNER_TIMEOUT", message: "Codex timed out" },
      hard_gate_failures: [],
      dimensions: [],
      verifier_results: [],
      evidence: []
    });
    expect(verdict.status).toBe("error");
  });

  it("preserves run group and trial identity", () => {
    const run = RunEnvelopeSchema.parse({
      schema: "arena.run/v1",
      run_id: "run_01",
      run_group_id: "group_01",
      trial_index: 0,
      manifest_hash: "a".repeat(64),
      snapshot_hash: "b".repeat(64),
      fixture_hash: "c".repeat(64),
      runner: { adapter: "codex-cli", model: "gpt-5.6" },
      state: "created",
      started_at: "2026-07-14T08:00:00.000Z"
    });
    expect(run.trial_index).toBe(0);
  });
});
