import { z } from "zod";

import {
  ArtifactRefSchema,
  DiagnosisSchema,
  DimensionResultSchema,
  EvidenceRefSchema,
  FileRecordSchema,
  HashSchema,
  PhaseSchema,
  RunEnvelopeSchema,
  isLockedTerminalResult,
  SkillContractSchema,
  SkillSnapshotSchema,
  TraceKindSchema,
  VerifierResultSchema,
  type Diagnosis,
  type RunEnvelope,
  type SkillContract,
  type SkillSnapshot
} from "../../../src/protocol/schema.js";

export interface ArenaEventSource {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export type BrowserImportRequest =
  | { readonly kind: "local"; readonly path: string; readonly entrypoint?: string }
  | {
    readonly kind: "git";
    readonly url: string;
    readonly revision?: string;
    readonly entrypoint?: string;
  }
  | { readonly kind: "sample"; readonly id: "repo-bugfix" }
  | { readonly kind: "zip"; readonly file: File };

const PreflightResultSchema = z.object({
  ok: z.boolean(),
  checks: z.array(z.object({
    id: z.enum(["codex-version", "codex-login", "git-version", "app-data"]),
    ok: z.boolean(),
    message: z.string()
  }).strict()),
  model: z.object({
    target: z.literal("gpt-5.6"),
    status: z.literal("configured-unverified")
  }).strict()
}).strict();

const ReplayManifestSchema = z.object({
  schema: z.literal("arena.replay-manifest/v1"),
  id: z.string().min(1),
  name: z.string().min(1),
  fixture: z.object({ id: z.string().min(1), version: z.number().int().positive() }).strict(),
  fault_cards: z.array(z.object({
    id: z.string().min(1), version: z.number().int().positive()
  }).strict()),
  budgets: z.object({
    wall_time_s: z.number().int().positive(),
    max_command_retries: z.number().int().nonnegative()
  }).strict(),
  scoring: z.object({
    weights: z.record(z.string(), z.number().nonnegative()),
    hard_gates: z.array(z.string())
  }).strict()
}).strict();

const RepairProposalSchema = z.object({
  repair_id: z.string().min(1),
  run_id: z.string().min(1),
  status: z.literal("pending"),
  snapshot_hash: HashSchema,
  created_at: z.string().datetime(),
  changed_paths: z.array(z.string().min(1)),
  patch_ref: ArtifactRefSchema
}).strict();

export const CandidatePatchSchema = z.object({
  repair_id: z.string().min(1),
  patch_ref: ArtifactRefSchema,
  mime: z.literal("text/x-diff"),
  bytes: z.number().int().nonnegative().max(5 * 1024 * 1024),
  redacted: z.literal(false),
  export_ready: z.literal(false),
  text: z.string().max(5 * 1024 * 1024)
}).strict().superRefine((patch, context) => {
  if (new TextEncoder().encode(patch.text).byteLength !== patch.bytes) {
    context.addIssue({ code: "custom", path: ["bytes"], message: "Patch byte count mismatch" });
  }
});

export const SanitizedSnapshotSchema = z.object({
  schema: z.literal("arena.skill-snapshot/v1"),
  source: z.object({
    kind: z.enum(["local", "git", "zip", "sample"]),
    revision: z.string().optional()
  }).strict(),
  entrypoint: z.string().min(1),
  license: z.string().min(1),
  files: z.array(FileRecordSchema).min(1),
  source_hash: HashSchema,
  contract_ref: ArtifactRefSchema.optional()
}).strict();

const SanitizedVerdictBase = {
  schema: z.literal("arena.verdict/v1"),
  run_id: z.string().min(1),
  hard_gate_failures: z.array(z.string()),
  dimensions: z.array(DimensionResultSchema),
  verifier_results: z.array(VerifierResultSchema),
  evidence: z.array(EvidenceRefSchema)
};

export const SanitizedVerdictSchema = z.discriminatedUnion("status", [
  z.object({
    ...SanitizedVerdictBase,
    status: z.enum(["victory", "defeat"]),
    score: z.number().min(0).max(100)
  }).strict(),
  z.object({
    ...SanitizedVerdictBase,
    status: z.literal("error"),
    error: z.object({ code: z.string() }).strict()
  }).strict()
]);

export const SanitizedTraceSchema = z.object({
  v: z.literal(1),
  run_id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  phase: PhaseSchema,
  kind: TraceKindSchema,
  actor: z.enum(["arena", "codex", "verifier", "gpt-5.6"]),
  span_id: z.string().min(1).optional(),
  artifacts: z.array(ArtifactRefSchema)
}).strict();

const DIFF_MIMES = new Set(["text/x-diff", "text/x-patch"]);
const BrowserArtifactRefSchema = ArtifactRefSchema.transform(
  (ref) => ref as `sha256:${string}`
);

export const ArtifactSummarySchema = z.object({
  ref: BrowserArtifactRefSchema,
  kind: z.enum(["diff", "process", "test", "verifier", "other"]),
  label: z.string().min(1).max(80),
  summary: z.string().min(1).max(320),
  mime: z.string().min(1).max(256),
  bytes: z.number().int().nonnegative(),
  redacted: z.boolean()
}).strict().superRefine((artifact, context) => {
  if (artifact.kind === "diff" && !DIFF_MIMES.has(artifact.mime.toLowerCase())) {
    context.addIssue({
      code: "custom",
      path: ["kind"],
      message: "Diff artifacts require an actual diff MIME type"
    });
  }
});

const PortableRepairPathSchema = z.string().min(1).refine((value) => {
  if (value.startsWith("/") || value.includes("\\")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}, "Repair changed path must be portable");

const SanitizedRepairBase = {
  schema: z.literal("arena.repair/v1"),
  repair_id: z.string().min(1),
  run_id: z.string().min(1),
  snapshot_hash: HashSchema,
  created_at: z.string().datetime(),
  changed_paths: z.array(PortableRepairPathSchema),
  patch_ref: ArtifactRefSchema
};

export const SanitizedRepairSchema = z.discriminatedUnion("status", [
  z.object({ ...SanitizedRepairBase, status: z.literal("pending") }).strict(),
  z.object({
    ...SanitizedRepairBase,
    status: z.literal("approved"),
    child_run_id: z.string().min(1),
    new_snapshot_hash: HashSchema,
    reviewed_patch_ref: ArtifactRefSchema
  }).strict(),
  z.object({
    ...SanitizedRepairBase,
    status: z.literal("rejected"),
    reason: z.object({ code: z.enum(["USER_REJECTED", "SUPERSEDED"]) }).strict()
  }).strict(),
  z.object({
    ...SanitizedRepairBase,
    status: z.literal("failed"),
    error: z.object({ code: z.string().min(1) }).strict()
  }).strict()
]).superRefine((repair, context) => {
  if (repair.status === "approved" && repair.reviewed_patch_ref !== repair.patch_ref) {
    context.addIssue({
      code: "custom",
      path: ["reviewed_patch_ref"],
      message: "Approved repair must name the reviewed patch"
    });
  }
});

export const ArenaReportSchema = z.object({
  schema: z.literal("arena.report/v1"),
  redaction_complete: z.boolean(),
  run: RunEnvelopeSchema,
  manifest_id: z.string().min(1),
  snapshot: SanitizedSnapshotSchema,
  verdict: SanitizedVerdictSchema,
  diagnosis: DiagnosisSchema.optional(),
  repair: SanitizedRepairSchema.optional(),
  trace: z.array(SanitizedTraceSchema),
  artifacts: z.array(ArtifactSummarySchema).max(128)
}).strict().superRefine((report, context) => {
  if (!isLockedTerminalResult(report.run, report.verdict)) {
    context.addIssue({
      code: "custom",
      path: ["verdict"],
      message: "Run and verdict do not form a locked terminal result"
    });
  }
  const members = new Set<string>();
  const add = (candidate: unknown): void => {
    const parsed = ArtifactRefSchema.safeParse(candidate);
    if (parsed.success) members.add(parsed.data);
  };
  add(report.snapshot.contract_ref);
  for (const ref of report.verdict.evidence) add(ref);
  for (const dimension of report.verdict.dimensions) {
    for (const ref of dimension.evidence) add(ref);
  }
  for (const verifier of report.verdict.verifier_results) {
    for (const ref of verifier.evidence) add(ref);
  }
  for (const ref of report.diagnosis?.evidence_refs ?? []) add(ref);
  add(report.repair?.patch_ref);
  for (const event of report.trace) {
    for (const ref of event.artifacts) add(ref);
  }

  const summaries = new Set<string>();
  for (const [index, artifact] of report.artifacts.entries()) {
    if (summaries.has(artifact.ref)) {
      context.addIssue({
        code: "custom",
        path: ["artifacts", index, "ref"],
        message: "Artifact summary references must be unique"
      });
    }
    summaries.add(artifact.ref);
    if (!members.has(artifact.ref)) {
      context.addIssue({
        code: "custom",
        path: ["artifacts", index, "ref"],
        message: "Artifact summary is not a member of this report"
      });
    }
  }
  for (const ref of members) {
    if (!summaries.has(ref)) {
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: `Artifact metadata is unavailable for ${ref}`
      });
    }
  }
});

const SafeErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }).strict()
}).strict();

const SAFE_ERROR_MESSAGES = new Map<string, string>([
  ["UNAUTHORIZED", "Authentication required"],
  ["NOT_FOUND", "Resource not found"],
  ["PAYLOAD_TOO_LARGE", "Request payload is too large"],
  ["INTERNAL_ERROR", "Request failed safely"]
]);

export type PreflightResult = z.infer<typeof PreflightResultSchema>;
export type ReplayManifest = z.infer<typeof ReplayManifestSchema>;
export type RepairProposal = z.infer<typeof RepairProposalSchema>;
export type CandidatePatch = z.infer<typeof CandidatePatchSchema>;
export type SanitizedSnapshot = z.infer<typeof SanitizedSnapshotSchema>;
export type SanitizedVerdict = z.infer<typeof SanitizedVerdictSchema>;
export type SanitizedTrace = z.infer<typeof SanitizedTraceSchema>;
export type ArtifactSummary = z.infer<typeof ArtifactSummarySchema>;
export type SanitizedRepair = z.infer<typeof SanitizedRepairSchema>;
export type ArenaReport = z.infer<typeof ArenaReportSchema>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface ArenaApiDependencies {
  readonly fetch?: typeof fetch;
  readonly eventSource?: (url: string) => ArenaEventSource;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function jsonBody(value: unknown): Pick<RequestInit, "body" | "headers"> {
  return {
    body: JSON.stringify(value),
    headers: { "content-type": "application/json" }
  };
}

export class ArenaApi {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly eventSourceFactory: (url: string) => ArenaEventSource;

  constructor(token: string, dependencies: ArenaApiDependencies = {}) {
    if (token.length === 0) throw new Error("Arena session token is required");
    this.token = token;
    this.fetchImpl = dependencies.fetch ?? window.fetch.bind(window);
    this.eventSourceFactory = dependencies.eventSource
      ?? ((url) => new EventSource(url));
  }

  private async request<T>(
    url: string,
    schema: z.ZodType<T>,
    init: RequestInit = {}
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("x-arena-token", this.token);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, headers });
    } catch {
      throw new ApiError(0, "REQUEST_FAILED", "Request failed safely");
    }
    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        try {
          const parsed = SafeErrorSchema.safeParse(await response.json());
          if (parsed.success) {
            const safeMessage = SAFE_ERROR_MESSAGES.get(parsed.data.error.code);
            if (safeMessage === parsed.data.error.message) {
              throw new ApiError(response.status, parsed.data.error.code, safeMessage);
            }
          }
        } catch (error) {
          if (error instanceof ApiError) throw error;
        }
      }
      throw new ApiError(response.status, "REQUEST_FAILED", "Request failed safely");
    }
    try {
      return schema.parse(await response.json());
    } catch {
      throw new ApiError(response.status, "INVALID_RESPONSE", "Invalid response from Arena");
    }
  }

  health(): Promise<PreflightResult> {
    return this.request("/api/health", PreflightResultSchema);
  }

  importSkill(request: BrowserImportRequest): Promise<SkillSnapshot> {
    if (request.kind === "zip") {
      const body = new FormData();
      body.append("file", request.file, request.file.name);
      return this.request("/api/imports", SkillSnapshotSchema, { method: "POST", body });
    }
    return this.request("/api/imports", SkillSnapshotSchema, {
      method: "POST",
      ...jsonBody(request)
    });
  }

  getImport(hash: string): Promise<SkillSnapshot> {
    return this.request(`/api/imports/${encoded(hash)}`, SkillSnapshotSchema);
  }

  compileContract(snapshotHash: string): Promise<SkillContract> {
    return this.request("/api/contracts", SkillContractSchema, {
      method: "POST",
      ...jsonBody({ snapshot_hash: snapshotHash })
    });
  }

  listManifests(): Promise<ReplayManifest[]> {
    return this.request("/api/manifests", z.array(ReplayManifestSchema));
  }

  startRun(manifestId: string, snapshotHash: string): Promise<RunEnvelope> {
    return this.request("/api/runs", RunEnvelopeSchema, {
      method: "POST",
      ...jsonBody({ manifest_id: manifestId, snapshot_hash: snapshotHash })
    });
  }

  getRun(runId: string): Promise<RunEnvelope> {
    return this.request(`/api/runs/${encoded(runId)}`, RunEnvelopeSchema);
  }

  diagnose(runId: string): Promise<Diagnosis> {
    return this.request(`/api/runs/${encoded(runId)}/diagnose`, DiagnosisSchema, {
      method: "POST"
    });
  }

  createRepair(runId: string): Promise<RepairProposal> {
    return this.request(`/api/runs/${encoded(runId)}/repairs`, RepairProposalSchema, {
      method: "POST"
    });
  }

  candidatePatch(repairId: string): Promise<CandidatePatch> {
    return this.request(
      `/api/repairs/${encoded(repairId)}/patch`,
      CandidatePatchSchema
    );
  }

  rerun(repairId: string): Promise<RunEnvelope> {
    return this.request(`/api/repairs/${encoded(repairId)}/rerun`, RunEnvelopeSchema, {
      method: "POST"
    });
  }

  rejectRepair(repairId: string): Promise<SanitizedRepair> {
    return this.request(`/api/repairs/${encoded(repairId)}/reject`, SanitizedRepairSchema, {
      method: "POST"
    });
  }

  report(runId: string): Promise<ArenaReport> {
    return this.request(`/api/runs/${encoded(runId)}/report`, ArenaReportSchema);
  }

  openRunStream(runId: string): ArenaEventSource {
    const query = new URLSearchParams({ token: this.token });
    return this.eventSourceFactory(`/api/runs/${encoded(runId)}/events?${query.toString()}`);
  }
}
