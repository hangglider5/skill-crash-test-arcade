import { describe, expect, it, vi } from "vitest";

import { ApiError, ArenaApi } from "../../apps/web/src/api.js";

const hashA = "a".repeat(64);
const artifactRef = `sha256:${"b".repeat(64)}`;

function terminalReport(artifact: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "arena.report/v1",
    run: {
      schema: "arena.run/v1",
      run_id: "run_01",
      run_group_id: "group_01",
      trial_index: 0,
      manifest_hash: hashA,
      snapshot_hash: hashA,
      fixture_hash: hashA,
      runner: { adapter: "codex-cli", model: "gpt-5.6" },
      state: "completed",
      started_at: "2026-07-15T00:00:00.000Z",
      ended_at: "2026-07-15T00:01:00.000Z"
    },
    manifest_id: "repo-dirty-tree-v1",
    snapshot: {
      schema: "arena.skill-snapshot/v1",
      source: { kind: "sample" },
      entrypoint: "SKILL.md",
      license: "MIT",
      files: [{ path: "SKILL.md", bytes: 8, sha256: hashA }],
      source_hash: hashA
    },
    verdict: {
      schema: "arena.verdict/v1",
      run_id: "run_01",
      status: "defeat",
      score: 58,
      hard_gate_failures: [],
      dimensions: [],
      verifier_results: [],
      evidence: [artifactRef]
    },
    trace: [],
    artifacts: [artifact]
  };
}

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: artifactRef,
    kind: "diff",
    label: "Diff artifact",
    summary: "18 bytes · text/x-diff · redacted",
    mime: "text/x-diff",
    bytes: 18,
    redacted: true,
    ...overrides
  };
}

function apiFor(payload: unknown): ArenaApi {
  return new ArenaApi("session-token", {
    fetch: vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    }))
  });
}

describe("Arena report artifact metadata", () => {
  it("accepts bounded metadata summaries for an actual diff without artifact bytes", async () => {
    const report = await apiFor(terminalReport(metadata())).report("run_01");

    expect(report.artifacts).toEqual([metadata()]);
    expect(report.artifacts[0]).not.toHaveProperty("content");
  });

  it("rejects extra raw fields and a fabricated diff kind", async () => {
    const cases = [
      metadata({ content: "raw private patch" }),
      metadata({ mime: "application/json" })
    ];

    for (const artifact of cases) {
      await expect(apiFor(terminalReport(artifact)).report("run_01"))
        .rejects.toMatchObject({ code: "INVALID_RESPONSE" } satisfies Partial<ApiError>);
    }
  });

  it("rejects missing or non-member artifact summaries", async () => {
    const missing = terminalReport(metadata());
    missing.artifacts = [];
    const rogue = terminalReport(metadata({ ref: `sha256:${"c".repeat(64)}` }));

    for (const report of [missing, rogue]) {
      await expect(apiFor(report).report("run_01"))
        .rejects.toMatchObject({ code: "INVALID_RESPONSE" } satisfies Partial<ApiError>);
    }
  });
});
