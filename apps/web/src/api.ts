import { z } from "zod";

import {
  ArtifactRefSchema,
  DiagnosisSchema,
  HashSchema,
  RunEnvelopeSchema,
  SkillContractSchema,
  SkillSnapshotSchema,
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

const ArenaReportSchema = z.object({
  schema: z.literal("arena.report/v1"),
  run: RunEnvelopeSchema,
  manifest_id: z.string().min(1),
  snapshot: z.record(z.string(), z.unknown()),
  verdict: z.record(z.string(), z.unknown()),
  trace: z.array(z.record(z.string(), z.unknown()))
}).passthrough();

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

  rerun(repairId: string): Promise<RunEnvelope> {
    return this.request(`/api/repairs/${encoded(repairId)}/rerun`, RunEnvelopeSchema, {
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
