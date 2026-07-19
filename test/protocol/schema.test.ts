import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  ArenaManifestSchema,
  DiagnosisJsonSchema,
  DiagnosisSchema,
  FinalClaimJsonSchema,
  FinalClaimSchema,
  RunEnvelopeSchema,
  SkillContractJsonSchema,
  SkillContractSchema,
  SkillSnapshotSchema,
  TraceEventSchema,
  VerdictBundleSchema
} from "../../src/protocol/index.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

const validTraceEvent = {
  v: 1,
  run_id: "run_01",
  seq: 12,
  phase: "preflight",
  kind: "process.exited",
  actor: "codex",
  span_id: "cmd_003",
  data: { argv: ["git", "status", "--short"], exit_code: 0 },
  artifacts: []
} as const;

const validVerdict = {
  schema: "arena.verdict/v1",
  run_id: "run_01",
  status: "error",
  error: { code: "RUNNER_TIMEOUT", message: "Codex timed out" },
  hard_gate_failures: [],
  dimensions: [],
  verifier_results: [],
  evidence: []
} as const;

const validRunEnvelope = {
  schema: "arena.run/v1",
  run_id: "run_01",
  run_group_id: "group_01",
  trial_index: 0,
  manifest_hash: hashA,
  snapshot_hash: hashB,
  fixture_hash: hashC,
  runner: { adapter: "codex-cli", model: "gpt-5.6-sol" },
  state: "created",
  started_at: "2026-07-14T08:00:00.000Z"
} as const;

const validManifest = {
  schema: "arena.manifest/v1",
  id: "typescript-import",
  name: "TypeScript skill import",
  fixture: { id: "broken-typescript", version: 1 },
  runner_brief: { task: "Repair the fixture" },
  judge_pack: {
    protected_assets: ["test/oracle.test.ts"],
    allowed_paths: ["src/**"],
    oracles: ["pnpm test"]
  },
  fault_cards: [{ id: "wrong-entrypoint", version: 1 }],
  budgets: { wall_time_s: 300, max_command_retries: 2 },
  scoring: { weights: { correctness: 80, evidence: 20 }, hard_gates: ["tests"] },
  verifiers: ["unit-tests"]
} as const;

const validSnapshot = {
  schema: "arena.skill-snapshot/v1",
  source: { kind: "git", uri: "https://example.test/skill.git", revision: "abc123" },
  entrypoint: "SKILL.md",
  license: "MIT",
  files: [{ path: "SKILL.md", bytes: 128, sha256: hashA }],
  source_hash: hashB,
  imported_path: ".arena/imports/skill",
  contract_ref: `sha256:${hashC}`
} as const;

const validContract = {
  schema: "arena.skill-contract/v1",
  snapshot_hash: hashA,
  model: "gpt-5.6-sol",
  promises: [{
    statement: "Runs the focused test before completion",
    evidence: "SKILL.md:20",
    confidence: 0.9
  }],
  preconditions: ["pnpm is installed"],
  expected_artifacts: ["test output"],
  recovery_rules: ["inspect the first failure"],
  risk_signals: ["missing lockfile"]
} as const;

const validDiagnosis = {
  schema: "arena.diagnosis/v1",
  run_id: "run_01",
  model: "gpt-5.6-sol",
  observed_failure: "The focused test failed",
  likely_skill_gap: "The skill skipped dependency inspection",
  retry_analysis: "A retry without a patch would fail identically",
  suggested_changes: ["Inspect package engines before installation"],
  evidence_refs: ["event:12", `sha256:${hashA}`]
} as const;

const validFinalClaim = {
  completed: true,
  summary: "The fixture passes its focused tests",
  evidence: ["event:12"]
} as const;

describe("TraceEventSchema", () => {
  it("accepts an append-only process event", () => {
    expect(TraceEventSchema.parse(validTraceEvent).seq).toBe(12);
  });

  it("strictly rejects unknown event fields", () => {
    expect(TraceEventSchema.safeParse({ ...validTraceEvent, unexpected: true }).success)
      .toBe(false);
  });
});

describe("VerdictBundleSchema", () => {
  it("keeps infrastructure error distinct from defeat", () => {
    expect(VerdictBundleSchema.parse(validVerdict).status).toBe("error");
  });

  it("strictly rejects unknown verdict fields", () => {
    expect(VerdictBundleSchema.safeParse({ ...validVerdict, unexpected: true }).success)
      .toBe(false);
  });
});

describe("RunEnvelopeSchema", () => {
  it("preserves run group and trial identity", () => {
    expect(RunEnvelopeSchema.parse(validRunEnvelope).trial_index).toBe(0);
  });

  it("strictly rejects unknown nested runner fields", () => {
    expect(RunEnvelopeSchema.safeParse({
      ...validRunEnvelope,
      runner: { ...validRunEnvelope.runner, unexpected: true }
    }).success).toBe(false);
  });
});

describe("ArenaManifestSchema", () => {
  it("accepts a complete arena manifest", () => {
    expect(ArenaManifestSchema.parse(validManifest).budgets.wall_time_s).toBe(300);
  });

  it("rejects non-positive fixture versions", () => {
    expect(ArenaManifestSchema.safeParse({
      ...validManifest,
      fixture: { ...validManifest.fixture, version: 0 }
    }).success).toBe(false);
  });
});

describe("SkillSnapshotSchema", () => {
  it("accepts a content-addressed skill snapshot", () => {
    expect(SkillSnapshotSchema.parse(validSnapshot).files[0]?.sha256).toBe(hashA);
  });

  it("rejects negative file sizes", () => {
    expect(SkillSnapshotSchema.safeParse({
      ...validSnapshot,
      files: [{ ...validSnapshot.files[0], bytes: -1 }]
    }).success).toBe(false);
  });
});

describe("SkillContractSchema", () => {
  it("accepts contract promises with bounded confidence", () => {
    expect(SkillContractSchema.parse(validContract).promises[0]?.confidence).toBe(0.9);
  });

  it("rejects confidence above one", () => {
    expect(SkillContractSchema.safeParse({
      ...validContract,
      promises: [{ ...validContract.promises[0], confidence: 1.1 }]
    }).success).toBe(false);
  });
});

describe("DiagnosisSchema", () => {
  it("accepts a diagnosis backed by event and artifact evidence", () => {
    expect(DiagnosisSchema.parse(validDiagnosis).evidence_refs).toHaveLength(2);
  });

  it("rejects untyped evidence references", () => {
    expect(DiagnosisSchema.safeParse({
      ...validDiagnosis,
      evidence_refs: ["run.log"]
    }).success).toBe(false);
  });
});

describe("FinalClaimSchema", () => {
  it("defaults omitted evidence to an empty list", () => {
    expect(FinalClaimSchema.parse({
      completed: false,
      summary: "The repair is incomplete"
    }).evidence).toEqual([]);
  });

  it("rejects unknown final-claim fields", () => {
    expect(FinalClaimSchema.safeParse({ ...validFinalClaim, confidence: 1 }).success)
      .toBe(false);
  });
});

describe("generated JSON Schema exports", () => {
  it.each([
    {
      name: "skill contract",
      jsonSchema: SkillContractJsonSchema,
      valid: validContract,
      invalid: { ...validContract, model: "gpt-4.1" }
    },
    {
      name: "diagnosis",
      jsonSchema: DiagnosisJsonSchema,
      valid: validDiagnosis,
      invalid: { ...validDiagnosis, suggested_changes: [] }
    },
    {
      name: "final claim",
      jsonSchema: FinalClaimJsonSchema,
      valid: validFinalClaim,
      invalid: { ...validFinalClaim, unexpected: true }
    }
  ])("validates $name values with the generated schema", ({ jsonSchema, valid, invalid }) => {
    const reconstructedSchema = z.fromJSONSchema(jsonSchema);

    expect(jsonSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(reconstructedSchema.safeParse(valid).success).toBe(true);
    expect(reconstructedSchema.safeParse(invalid).success).toBe(false);
  });
});
