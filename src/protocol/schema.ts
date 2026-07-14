import { z } from "zod";

export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ArtifactRefSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const EventRefSchema = z.string().regex(/^event:[0-9]+$/);
export const EvidenceRefSchema = z.union([ArtifactRefSchema, EventRefSchema]);

export const PhaseSchema = z.enum([
  "import",
  "preflight",
  "inspect",
  "patch",
  "verify",
  "claim",
  "judge",
  "repair"
]);

export const TraceKindSchema = z.enum([
  "run.started",
  "run.finished",
  "run.errored",
  "phase.entered",
  "process.started",
  "process.exited",
  "file.changed",
  "test.completed",
  "agent.claimed",
  "verifier.completed",
  "runner.raw"
]);

export const TraceEventSchema = z.object({
  v: z.literal(1),
  run_id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  phase: PhaseSchema,
  kind: TraceKindSchema,
  actor: z.enum(["arena", "codex", "verifier", "gpt-5.6"]),
  span_id: z.string().min(1).optional(),
  data: z.record(z.string(), z.unknown()).default({}),
  artifacts: z.array(ArtifactRefSchema).default([])
}).strict();

export const DimensionResultSchema = z.object({
  id: z.string().min(1),
  earned: z.number().nonnegative(),
  possible: z.number().positive(),
  evidence: z.array(EvidenceRefSchema)
}).strict();

export const VerifierResultSchema = z.object({
  id: z.string().min(1),
  passed: z.boolean(),
  hard_gate: z.boolean(),
  message: z.string(),
  evidence: z.array(EvidenceRefSchema)
}).strict();

const LockedVerdictFields = {
  schema: z.literal("arena.verdict/v1"),
  run_id: z.string().min(1),
  hard_gate_failures: z.array(z.string()),
  dimensions: z.array(DimensionResultSchema),
  verifier_results: z.array(VerifierResultSchema),
  evidence: z.array(EvidenceRefSchema)
};

export const VerdictBundleSchema = z.discriminatedUnion("status", [
  z.object({
    ...LockedVerdictFields,
    status: z.enum(["victory", "defeat"]),
    score: z.number().min(0).max(100)
  }).strict(),
  z.object({
    ...LockedVerdictFields,
    status: z.literal("error"),
    error: z.object({ code: z.string(), message: z.string() }).strict()
  }).strict()
]);

export const RunEnvelopeSchema = z.object({
  schema: z.literal("arena.run/v1"),
  run_id: z.string().min(1),
  run_group_id: z.string().min(1),
  trial_index: z.number().int().nonnegative(),
  parent_run_id: z.string().min(1).optional(),
  manifest_hash: HashSchema,
  snapshot_hash: HashSchema,
  fixture_hash: HashSchema,
  runner: z.object({
    adapter: z.literal("codex-cli"),
    model: z.literal("gpt-5.6")
  }).strict(),
  state: z.enum([
    "created",
    "running",
    "judging",
    "completed",
    "errored",
    "cancelled"
  ]),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().optional()
}).strict();

export const FileRecordSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: HashSchema
}).strict();

export const SkillSnapshotSchema = z.object({
  schema: z.literal("arena.skill-snapshot/v1"),
  source: z.object({
    kind: z.enum(["local", "git", "zip", "sample"]),
    uri: z.string().min(1),
    revision: z.string().optional()
  }).strict(),
  entrypoint: z.string().min(1),
  license: z.string().min(1),
  files: z.array(FileRecordSchema).min(1),
  source_hash: HashSchema,
  imported_path: z.string().min(1),
  contract_ref: ArtifactRefSchema.optional()
}).strict();

export const SkillContractSchema = z.object({
  schema: z.literal("arena.skill-contract/v1"),
  snapshot_hash: HashSchema,
  model: z.literal("gpt-5.6"),
  promises: z.array(z.object({
    statement: z.string().min(1),
    evidence: z.string().min(1),
    confidence: z.number().min(0).max(1)
  }).strict()),
  preconditions: z.array(z.string()),
  expected_artifacts: z.array(z.string()),
  recovery_rules: z.array(z.string()),
  risk_signals: z.array(z.string())
}).strict();

export const DiagnosisSchema = z.object({
  schema: z.literal("arena.diagnosis/v1"),
  run_id: z.string().min(1),
  model: z.literal("gpt-5.6"),
  observed_failure: z.string().min(1),
  likely_skill_gap: z.string().min(1),
  retry_analysis: z.string().min(1),
  suggested_changes: z.array(z.string()).min(1),
  evidence_refs: z.array(EvidenceRefSchema).min(1)
}).strict();

export const ArenaManifestSchema = z.object({
  schema: z.literal("arena.manifest/v1"),
  id: z.string().min(1),
  name: z.string().min(1),
  fixture: z.object({
    id: z.string().min(1),
    version: z.number().int().positive()
  }).strict(),
  runner_brief: z.object({ task: z.string().min(1) }).strict(),
  judge_pack: z.object({
    protected_assets: z.array(z.string()),
    allowed_paths: z.array(z.string()),
    oracles: z.array(z.string())
  }).strict(),
  fault_cards: z.array(z.object({
    id: z.string().min(1),
    version: z.number().int().positive()
  }).strict()),
  budgets: z.object({
    wall_time_s: z.number().int().positive(),
    max_command_retries: z.number().int().nonnegative()
  }).strict(),
  scoring: z.object({
    weights: z.record(z.string(), z.number().nonnegative()),
    hard_gates: z.array(z.string())
  }).strict(),
  verifiers: z.array(z.string())
}).strict();

export const FinalClaimSchema = z.object({
  completed: z.boolean(),
  summary: z.string().min(1),
  evidence: z.array(z.string()).default([])
}).strict();

export type Hash = z.infer<typeof HashSchema>;
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type EventRef = z.infer<typeof EventRefSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type Phase = z.infer<typeof PhaseSchema>;
export type TraceKind = z.infer<typeof TraceKindSchema>;
export type TraceEvent = z.infer<typeof TraceEventSchema>;
export type DimensionResult = z.infer<typeof DimensionResultSchema>;
export type VerifierResult = z.infer<typeof VerifierResultSchema>;
export type VerdictBundle = z.infer<typeof VerdictBundleSchema>;
export type RunEnvelope = z.infer<typeof RunEnvelopeSchema>;
export type FileRecord = z.infer<typeof FileRecordSchema>;
export type SkillSnapshot = z.infer<typeof SkillSnapshotSchema>;
export type SkillContract = z.infer<typeof SkillContractSchema>;
export type Diagnosis = z.infer<typeof DiagnosisSchema>;
export type ArenaManifest = z.infer<typeof ArenaManifestSchema>;
export type FinalClaim = z.infer<typeof FinalClaimSchema>;
