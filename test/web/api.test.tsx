import { describe, expect, it, vi } from "vitest";

import { ApiError, ArenaApi } from "../../apps/web/src/api.js";

const hashA = "a".repeat(64);
const artifactRef = `sha256:${"b".repeat(64)}`;

function terminalReport(artifact: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "arena.report/v1",
    redaction_complete: true,
    run: {
      schema: "arena.run/v1",
      run_id: "run_01",
      run_group_id: "group_01",
      trial_index: 0,
      manifest_hash: hashA,
      snapshot_hash: hashA,
      fixture_hash: hashA,
      runner: { adapter: "codex-cli", model: "gpt-5.6-sol" },
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

describe("Arena report locked-result invariants", () => {
  it.each([
    ["running victory", "running", "victory", []],
    ["errored victory", "errored", "victory", []],
    ["victory with hard-gate failures", "completed", "victory", ["gate_01"]]
  ])("rejects %s", async (_label, state, status, hardGateFailures) => {
    const report = terminalReport(metadata());
    report.run = { ...(report.run as object), state };
    report.verdict = {
      ...(report.verdict as object),
      status,
      score: 91,
      hard_gate_failures: hardGateFailures
    };

    await expect(apiFor(report).report("run_01"))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("accepts an ended errored run with an error verdict", async () => {
    const report = terminalReport(metadata());
    report.run = { ...(report.run as object), state: "errored" };
    report.verdict = {
      ...(report.verdict as object),
      status: "error",
      error: { code: "VERIFIER_CRASH" }
    };
    delete (report.verdict as Record<string, unknown>).score;

    await expect(apiFor(report).report("run_01")).resolves.toMatchObject({
      run: { state: "errored" },
      verdict: { status: "error" }
    });
  });
});

describe("Candidate patch API", () => {
  it("parses only bounded authenticated local-review patches", async () => {
    const text = "diff --git a/SKILL.md b/SKILL.md\n";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      repair_id: "repair/01",
      patch_ref: artifactRef,
      mime: "text/x-diff",
      bytes: new TextEncoder().encode(text).byteLength,
      redacted: false,
      export_ready: false,
      text
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const api = new ArenaApi("session-token", { fetch: fetchMock });

    await expect(api.candidatePatch("repair/01")).resolves.toMatchObject({
      repair_id: "repair/01",
      redacted: false,
      export_ready: false,
      text
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/repairs/repair%2F01/patch");
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("x-arena-token"))
      .toBe("session-token");
  });

  it.each([
    ["wrong MIME", { mime: "text/plain" }],
    ["pretend redacted", { redacted: true }],
    ["pretend export ready", { export_ready: true }],
    ["wrong byte count", { bytes: 1 }],
    ["extra field", { artifact_ref: artifactRef }]
  ])("rejects %s", async (_label, override) => {
    const text = "diff --git a b\n";
    await expect(apiFor({
      repair_id: "repair_01",
      patch_ref: artifactRef,
      mime: "text/x-diff",
      bytes: new TextEncoder().encode(text).byteLength,
      redacted: false,
      export_ready: false,
      text,
      ...override
    }).candidatePatch("repair_01")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("Repair review API", () => {
  it("posts an exact rejection and parses only the terminal rejected repair", async () => {
    const payload = {
      schema: "arena.repair/v1",
      repair_id: "repair/01",
      run_id: "run_01",
      status: "rejected",
      snapshot_hash: hashA,
      created_at: "2026-07-15T00:02:00.000Z",
      changed_paths: ["SKILL.md"],
      patch_ref: artifactRef,
      reason: { code: "USER_REJECTED" }
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const api = new ArenaApi("session-token", { fetch: fetchMock });

    await expect(api.rejectRepair("repair/01")).resolves.toEqual(payload);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/repairs/repair%2F01/reject");
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("POST");
  });
});
