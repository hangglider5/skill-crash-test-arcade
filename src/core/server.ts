import { randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import { z } from "zod";

import type { ReplayManifest } from "../arena/manifest.js";
import {
  ArtifactRecordSchema,
  type ArtifactRecord
} from "../arena/artifact-store.js";
import type { EventBus } from "./events.js";
import type { ImportRequest } from "./importer.js";
import type {
  CreateRunRequest,
  ExpectedRunLineage,
  LockedRunContext
} from "./orchestrator.js";
import {
  ArtifactRefSchema,
  DiagnosisSchema,
  HashSchema,
  RunEnvelopeSchema,
  SkillSnapshotSchema,
  TraceEventSchema,
  VerdictBundleSchema,
  canonicalJson,
  type ArtifactRef,
  type Diagnosis,
  type RunEnvelope,
  type SkillContract,
  type SkillSnapshot,
  type TraceEvent,
  type VerdictBundle
} from "../protocol/index.js";
import type { PreflightResult } from "../codex/types.js";
import { validateSnapshotIdentity } from "./snapshot-identity.js";

const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_CANDIDATE_PATCH_BYTES = 5 * 1024 * 1024;
const TERMINAL_EVENTS = new Set<TraceEvent["kind"]>(["run.finished", "run.errored"]);

export interface ServerDependencies {
  readonly preflight: () => Promise<PreflightResult>;
  readonly importSkill: (request: ImportRequest, importsRoot: string) => Promise<SkillSnapshot>;
  readonly loadSnapshot: (hash: string) => Promise<SkillSnapshot>;
  readonly compileContract: (snapshot: SkillSnapshot) => Promise<SkillContract>;
  readonly listManifests: () => Promise<readonly ReplayManifest[]>;
  readonly resolveRunLineage: (
    manifestId: string,
    snapshotHash: string
  ) => Promise<ExpectedRunLineage>;
  readonly orchestrator: {
    createRun(request: CreateRunRequest): Promise<RunEnvelope>;
    execute(runId: string): Promise<VerdictBundle>;
    getRunContext(runId: string): LockedRunContext;
    finalizeWorkspace(
      runId: string,
      options: { readonly report_exported: true }
    ): Promise<unknown>;
  };
  readonly runStore: { readEvents(runId: string): Promise<TraceEvent[]> };
  readonly eventBus: EventBus;
  readonly diagnosis: { diagnoseRun(runId: string): Promise<Diagnosis> };
  readonly repairs: {
    createRepairFork(runId: string): Promise<unknown>;
    readCandidatePatch(repairId: string): Promise<unknown>;
    approveAndRerun(repairId: string): Promise<RunEnvelope>;
  };
  readonly loadVerdict: (runId: string) => Promise<VerdictBundle>;
  readonly loadDiagnosis: (runId: string) => Promise<Diagnosis | undefined>;
  readonly loadRepair: (runId: string) => Promise<unknown | undefined>;
  readonly loadArtifactRecord: (ref: ArtifactRef) => Promise<unknown>;
}

export interface ServerOptions {
  readonly sessionToken: string;
  readonly appData: string;
  readonly webDist?: string | undefined;
  readonly idFactory?: (() => string) | undefined;
}

export async function ensurePrivateDirectory(
  configured: string,
  directParent?: string
): Promise<string> {
  const absolute = path.resolve(configured);
  if (directParent !== undefined) {
    const parent = path.resolve(directParent);
    if (path.dirname(absolute) !== parent || path.basename(absolute).length === 0) {
      throw new Error("Private directory must be a direct child");
    }
  }
  const { root } = path.parse(absolute);
  const parts = absolute.slice(root.length).split(path.sep).filter((part) => part.length > 0);
  let cursor = root;
  let before = await lstat(root);
  // Portable Node has no openat-style component walk. Validate every lexical
  // component before descending; a same-uid actor can still race path entries
  // between checks, so the final directory is also opened no-follow and
  // inode-checked around descriptor-based chmod.
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try {
      before = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(cursor, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      before = await lstat(cursor);
    }
    if (!before.isDirectory() || before.isSymbolicLink()
      || await realpath(cursor) !== cursor) {
      throw new Error("Private directory ancestor is invalid");
    }
  }
  const uid = process.getuid?.();
  if (!before.isDirectory() || before.isSymbolicLink()
    || uid === undefined || before.uid !== uid) {
    throw new Error("Private directory identity is invalid");
  }
  const handle = await open(
    absolute,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.uid !== uid
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("Private directory identity changed");
    }
    if ((opened.mode & 0o777) !== 0o700) await handle.chmod(0o700);
    const [afterHandle, afterPath, canonical] = await Promise.all([
      handle.stat(),
      lstat(absolute),
      realpath(absolute)
    ]);
    if (canonical !== absolute
      || !afterPath.isDirectory()
      || afterPath.isSymbolicLink()
      || afterPath.uid !== uid
      || afterPath.dev !== opened.dev
      || afterPath.ino !== opened.ino
      || afterHandle.dev !== opened.dev
      || afterHandle.ino !== opened.ino
      || (afterHandle.mode & 0o777) !== 0o700) {
      throw new Error("Private directory identity changed");
    }
  } finally {
    await handle.close();
  }
  return absolute;
}

function safeEqual(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.byteLength === expectedBytes.byteLength
    && timingSafeEqual(actualBytes, expectedBytes);
}

function headerToken(request: FastifyRequest): string | undefined {
  const value = request.headers["x-arena-token"];
  return Array.isArray(value) ? undefined : value;
}

function queryToken(request: FastifyRequest): string | undefined {
  const value = (request.query as { token?: unknown }).token;
  return typeof value === "string" ? value : undefined;
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({
    error: { code: "UNAUTHORIZED", message: "Authentication required" }
  });
}

function objectBody(request: FastifyRequest): Record<string, unknown> {
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    throw new TypeError("Request body must be an object");
  }
  return request.body as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`Invalid ${key}`);
  }
  return value;
}

function importRequest(body: Record<string, unknown>): ImportRequest {
  switch (body.kind) {
    case "local":
      return {
        kind: "local",
        path: requiredString(body, "path"),
        ...(typeof body.entrypoint === "string" ? { entrypoint: body.entrypoint } : {})
      };
    case "git":
      return {
        kind: "git",
        url: requiredString(body, "url"),
        ...(typeof body.revision === "string" ? { revision: body.revision } : {}),
        ...(typeof body.entrypoint === "string" ? { entrypoint: body.entrypoint } : {})
      };
    case "sample":
      if (body.id !== "repo-bugfix") throw new TypeError("Invalid sample id");
      return { kind: "sample", id: body.id };
    default:
      throw new TypeError("Unsupported import kind");
  }
}

function terminal(event: TraceEvent): boolean {
  return TERMINAL_EVENTS.has(event.kind);
}

function sendEvent(reply: FastifyReply, event: TraceEvent): void {
  reply.raw.write(`id: ${event.seq}\ndata: ${canonicalJson(sanitize(event, []))}\n\n`);
}

const SENSITIVE_KEY = /(?:^|_)(?:token|secret|password|api_?key|codex_home)(?:$|_)/iu;
const SECRET_VALUE = /(?:OPENAI_API_KEY|CODEX_HOME|sk-[A-Za-z0-9_-]+)/u;
const EMBEDDED_ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9._/-])\/(?!\/)[^\s"'`,;)\]}]+/u;
const FILE_URI = /file:\/\/[^\s"'`,;)\]}]*/u;

/** Report/SSE data is a strict JSON projection; suspicious keys are removed recursively. */
function sanitize(value: unknown, exactSecrets: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((child) => sanitize(child, exactSecrets));
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) continue;
      output[key] = sanitize(child, exactSecrets);
    }
    return output;
  }
  if (typeof value === "string") {
    if (exactSecrets.some((secret) => secret.length > 0 && value.includes(secret))
      || SECRET_VALUE.test(value)
      || path.isAbsolute(value)
      || FILE_URI.test(value)
      || EMBEDDED_ABSOLUTE_PATH.test(value)) {
      return "[REDACTED]";
    }
  }
  return value;
}

function reportTrace(event: TraceEvent): Record<string, unknown> {
  return {
    v: event.v,
    run_id: event.run_id,
    seq: event.seq,
    phase: event.phase,
    kind: event.kind,
    actor: event.actor,
    ...(event.span_id === undefined ? {} : { span_id: event.span_id }),
    artifacts: event.artifacts
  };
}

function reportVerdict(verdict: VerdictBundle): Record<string, unknown> {
  const common = {
    schema: verdict.schema,
    run_id: verdict.run_id,
    status: verdict.status,
    hard_gate_failures: verdict.hard_gate_failures,
    dimensions: verdict.dimensions,
    verifier_results: verdict.verifier_results,
    evidence: verdict.evidence
  };
  return verdict.status === "error"
    ? { ...common, error: { code: verdict.error.code } }
    : { ...common, score: verdict.score };
}

function reportSnapshot(snapshot: SkillSnapshot): Record<string, unknown> {
  return {
    schema: snapshot.schema,
    source: {
      kind: snapshot.source.kind,
      ...("revision" in snapshot.source && snapshot.source.revision !== undefined
        ? { revision: snapshot.source.revision }
        : {})
    },
    entrypoint: snapshot.entrypoint,
    license: snapshot.license,
    files: snapshot.files,
    source_hash: snapshot.source_hash,
    ...(snapshot.contract_ref === undefined ? {} : { contract_ref: snapshot.contract_ref })
  };
}

const PortableRepairPathSchema = z.string().min(1).refine((value) => {
  if (path.posix.isAbsolute(value) || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}, "Repair changed path must be portable");

const RepairReportBase = {
  schema: z.literal("arena.repair/v1"),
  repair_id: z.string().min(1),
  run_id: z.string().min(1),
  snapshot_hash: HashSchema,
  created_at: z.string().datetime(),
  changed_paths: z.array(PortableRepairPathSchema),
  patch_ref: ArtifactRefSchema
};

const RepairReportSchema = z.discriminatedUnion("status", [
  z.object({ ...RepairReportBase, status: z.literal("pending") }).strict(),
  z.object({
    ...RepairReportBase,
    status: z.literal("approved"),
    child_run_id: z.string().min(1),
    new_snapshot_hash: HashSchema
  }).strict(),
  z.object({
    ...RepairReportBase,
    status: z.literal("failed"),
    error: z.object({ code: z.string().min(1) }).strict()
  }).strict()
]);

const CandidatePatchSchema = z.object({
  repair_id: z.string().min(1),
  mime: z.literal("text/x-diff"),
  bytes: z.number().int().nonnegative().max(MAX_CANDIDATE_PATCH_BYTES),
  redacted: z.literal(false),
  export_ready: z.literal(false),
  text: z.string().max(MAX_CANDIDATE_PATCH_BYTES)
}).strict().superRefine((candidate, context) => {
  if (Buffer.byteLength(candidate.text, "utf8") !== candidate.bytes) {
    context.addIssue({ code: "custom", path: ["bytes"], message: "Patch byte count mismatch" });
  }
});

function reportRepair(value: unknown): z.infer<typeof RepairReportSchema> {
  return RepairReportSchema.parse(value);
}

type ReportArtifactKind = "diff" | "process" | "test" | "verifier" | "other";

const MAX_REPORT_ARTIFACTS = 128;
const DIFF_MIMES = new Set(["text/x-diff", "text/x-patch"]);
const ARTIFACT_LABELS: Record<ReportArtifactKind, string> = {
  diff: "Diff artifact",
  process: "Process artifact",
  test: "Test artifact",
  verifier: "Verifier artifact",
  other: "Artifact metadata"
};

function reportArtifactRefs(input: {
  readonly snapshot: SkillSnapshot;
  readonly verdict: VerdictBundle;
  readonly diagnosis?: Diagnosis;
  readonly repair?: z.infer<typeof RepairReportSchema>;
  readonly trace: readonly TraceEvent[];
}): Map<ArtifactRef, Set<ReportArtifactKind>> {
  const refs = new Map<ArtifactRef, Set<ReportArtifactKind>>();
  const add = (candidate: unknown, kind: ReportArtifactKind): void => {
    const parsed = ArtifactRefSchema.safeParse(candidate);
    if (!parsed.success) return;
    const kinds = refs.get(parsed.data) ?? new Set<ReportArtifactKind>();
    kinds.add(kind);
    refs.set(parsed.data, kinds);
  };

  add(input.snapshot.contract_ref, "other");
  for (const ref of input.verdict.evidence) add(ref, "other");
  for (const dimension of input.verdict.dimensions) {
    for (const ref of dimension.evidence) add(ref, "other");
  }
  for (const verifier of input.verdict.verifier_results) {
    for (const ref of verifier.evidence) add(ref, "verifier");
  }
  for (const ref of input.diagnosis?.evidence_refs ?? []) add(ref, "other");
  add(input.repair?.patch_ref, "other");
  for (const event of input.trace) {
    const kind: ReportArtifactKind = event.kind === "process.started"
      || event.kind === "process.exited"
      ? "process"
      : event.kind === "test.completed"
        ? "test"
        : event.kind === "verifier.completed"
          ? "verifier"
          : "other";
    for (const ref of event.artifacts) add(ref, kind);
  }
  if (refs.size > MAX_REPORT_ARTIFACTS) {
    throw new Error("Report artifact metadata exceeds the bounded summary limit");
  }
  return refs;
}

function reportArtifactKind(
  record: ArtifactRecord,
  memberships: ReadonlySet<ReportArtifactKind>
): ReportArtifactKind {
  if (DIFF_MIMES.has(record.mime.toLowerCase())) return "diff";
  for (const kind of ["verifier", "test", "process"] as const) {
    if (memberships.has(kind)) return kind;
  }
  return "other";
}

async function reportArtifactSummaries(
  dependencies: ServerDependencies,
  refs: ReadonlyMap<ArtifactRef, ReadonlySet<ReportArtifactKind>>
): Promise<Array<Record<string, unknown>>> {
  return Promise.all([...refs.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(async ([ref, memberships]) => {
      const record = ArtifactRecordSchema.parse(await dependencies.loadArtifactRecord(ref));
      if (record.ref !== ref || `sha256:${record.sha256}` !== ref) {
        throw new Error(`Report artifact metadata mismatch for ${ref}`);
      }
      const kind = reportArtifactKind(record, memberships);
      const summary = `${record.bytes} bytes · ${record.mime}${record.redacted ? " · redacted" : ""}`;
      return {
        ref,
        kind,
        label: ARTIFACT_LABELS[kind],
        summary: summary.slice(0, 320),
        mime: record.mime,
        bytes: record.bytes,
        redacted: record.redacted
      };
    }));
}

function lastEventId(request: FastifyRequest): number {
  const raw = request.headers["last-event-id"];
  if (Array.isArray(raw) || raw === undefined) return -1;
  if (!/^[0-9]+$/u.test(raw)) return -1;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

export async function createServer(
  dependencies: ServerDependencies,
  options: ServerOptions
): Promise<FastifyInstance> {
  if (options.sessionToken.length === 0) throw new Error("Session token is required");
  const appData = await ensurePrivateDirectory(options.appData);
  const app = fastify({ bodyLimit: MAX_ARCHIVE_BYTES, logger: false });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: MAX_JSON_BYTES },
    (_request, body, done) => {
      try {
        done(null, JSON.parse(typeof body === "string" ? body : body.toString("utf8")));
      } catch (error) {
        done(error as Error, undefined);
      }
    }
  );
  const cleanupAttempts = new Map<string, Promise<boolean>>();
  const scheduleCleanup = (runId: string): void => {
    if (cleanupAttempts.has(runId)) return;
    let attempt!: Promise<boolean>;
    attempt = Promise.resolve().then(async () => {
      await dependencies.orchestrator.finalizeWorkspace(
        runId,
        { report_exported: true }
      );
    }).then(
      () => true,
      () => {
        if (cleanupAttempts.get(runId) === attempt) cleanupAttempts.delete(runId);
        return false;
      }
    );
    cleanupAttempts.set(runId, attempt);
    void attempt;
  };
  await app.register(multipart, {
    limits: { files: 1, fields: 2, fileSize: MAX_ARCHIVE_BYTES }
  });
  if (options.webDist !== undefined) {
    await app.register(fastifyStatic, { root: path.resolve(options.webDist), prefix: "/" });
  }

  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (!pathname.startsWith("/api/") || pathname === "/api/health") return;
    const sse = /^\/api\/runs\/[^/]+\/events$/u.test(pathname);
    const supplied = headerToken(request) ?? (sse ? queryToken(request) : undefined);
    if (!safeEqual(supplied, options.sessionToken)) return unauthorized(reply);
  });

  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode === 413 ? 413 : 500;
    const code = status === 413 ? "PAYLOAD_TOO_LARGE" : "INTERNAL_ERROR";
    const message = status === 413 ? "Request payload is too large" : "Request failed safely";
    void reply.code(status).send({ error: { code, message } });
  });
  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ error: { code: "NOT_FOUND", message: "Resource not found" } });
  });

  app.get("/api/health", async () => dependencies.preflight());

  app.post("/api/imports", async (request, reply) => {
    const importsRoot = path.join(appData, "imports");
    let imported: SkillSnapshot;
    if (request.isMultipart()) {
      const uploadRoot = await ensurePrivateDirectory(path.join(appData, "uploads"), appData);
      const part = await request.file();
      if (part === undefined) throw new TypeError("ZIP upload is required");
      const bytes = await part.toBuffer();
      if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw Object.assign(new Error(), { statusCode: 413 });
      const uploadPath = path.join(uploadRoot, `${randomUUID()}.zip`);
      try {
        await writeFile(uploadPath, bytes, { flag: "wx", mode: 0o600 });
        imported = await dependencies.importSkill({ kind: "zip", path: uploadPath }, importsRoot);
      } finally {
        await rm(uploadPath, { force: true });
      }
    } else {
      const encoded = Buffer.byteLength(JSON.stringify(request.body ?? null));
      if (encoded > MAX_JSON_BYTES) throw Object.assign(new Error(), { statusCode: 413 });
      imported = await dependencies.importSkill(importRequest(objectBody(request)), importsRoot);
    }
    return reply.code(201).send(imported);
  });

  app.get("/api/imports/:hash", async (request) => {
    return dependencies.loadSnapshot((request.params as { hash: string }).hash);
  });

  app.post("/api/contracts", { bodyLimit: MAX_JSON_BYTES }, async (request) => {
    const hash = requiredString(objectBody(request), "snapshot_hash");
    return dependencies.compileContract(await dependencies.loadSnapshot(hash));
  });

  app.get("/api/manifests", async () => dependencies.listManifests());

  app.post("/api/runs", { bodyLimit: MAX_JSON_BYTES }, async (request, reply) => {
    const body = objectBody(request);
    const manifestId = requiredString(body, "manifest_id");
    const snapshotHash = requiredString(body, "snapshot_hash");
    const trustedLineage = await dependencies.resolveRunLineage(manifestId, snapshotHash);
    const suffix = (options.idFactory?.() ?? randomUUID()).replace(/[^A-Za-z0-9_-]/gu, "_");
    const created = await dependencies.orchestrator.createRun({
      manifest_id: manifestId,
      snapshot_hash: snapshotHash,
      run_group_id: `group_${suffix}`,
      trial_index: 0,
      expected_lineage: trustedLineage
    });
    void dependencies.orchestrator.execute(created.run_id).catch(() => undefined);
    return reply.code(202).send(created);
  });

  app.get("/api/runs/:id", async (request) => {
    return dependencies.orchestrator.getRunContext((request.params as { id: string }).id).envelope;
  });

  app.get("/api/runs/:id/events", async (request, reply) => {
    const runId = (request.params as { id: string }).id;
    const after = lastEventId(request);
    const buffered = new Map<number, TraceEvent>();
    let replaying = true;
    let ready = false;
    let closed = false;
    let terminalSeen = false;
    const sent = new Set<number>();
    let subscribed = true;
    const rawUnsubscribe = dependencies.eventBus.subscribe(runId, (value) => {
      const event = value as TraceEvent;
      const isTerminal = terminal(event);
      if (isTerminal) terminalSeen = true;
      if (closed) return;
      if (!ready || replaying) {
        if (event.seq > after) buffered.set(event.seq, event);
        return;
      }
      if (event.seq <= after || sent.has(event.seq)) {
        if (isTerminal) close();
        return;
      }
      sent.add(event.seq);
      sendEvent(reply, event);
      if (isTerminal) close();
    });
    const unsubscribe = (): void => {
      if (!subscribed) return;
      subscribed = false;
      rawUnsubscribe();
    };
    const close = (): void => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (ready && !reply.raw.writableEnded) reply.raw.end();
    };
    reply.raw.once("close", () => {
      closed = true;
      unsubscribe();
    });
    try {
      const persisted = (await dependencies.runStore.readEvents(runId))
        .map((event) => TraceEventSchema.parse(event));
      if (closed) return;
      for (const event of persisted) {
        if (terminal(event)) terminalSeen = true;
        if (event.seq > after && !buffered.has(event.seq)) buffered.set(event.seq, event);
      }
      reply.hijack();
      reply.raw.statusCode = 200;
      reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("cache-control", "no-cache, no-transform");
      reply.raw.setHeader("connection", "keep-alive");
      ready = true;
      // Stay in buffering mode through the complete replay flush. A synchronous
      // live publication caused while serializing an older event is drained on
      // the next pass and therefore cannot overtake the replay sequence.
      while (!closed) {
        const pending = [...buffered.values()]
          .filter((event) => !sent.has(event.seq))
          .sort((a, b) => a.seq - b.seq);
        if (pending.length === 0) break;
        const event = pending[0]!;
        sent.add(event.seq);
        sendEvent(reply, event);
        if (terminal(event)) {
          close();
          break;
        }
      }
      replaying = false;
      if (terminalSeen && !closed) close();
    } catch (error) {
      unsubscribe();
      if (ready) close();
      throw error;
    }
  });

  app.post("/api/runs/:id/diagnose", async (request) => {
    return dependencies.diagnosis.diagnoseRun((request.params as { id: string }).id);
  });

  app.post("/api/runs/:id/repairs", async (request, reply) => {
    const value = await dependencies.repairs.createRepairFork((request.params as { id: string }).id);
    return reply.code(201).send(value);
  });

  app.get("/api/repairs/:id/patch", async (request) => {
    const repairId = (request.params as { id: string }).id;
    const candidate = CandidatePatchSchema.parse(
      await dependencies.repairs.readCandidatePatch(repairId)
    );
    if (candidate.repair_id !== repairId) throw new Error("Candidate patch membership mismatch");
    return candidate;
  });

  app.post("/api/repairs/:id/rerun", async (request, reply) => {
    const value = await dependencies.repairs.approveAndRerun((request.params as { id: string }).id);
    return reply.code(202).send(value);
  });

  app.get("/api/runs/:id/report", async (request, reply) => {
    const runId = (request.params as { id: string }).id;
    let clientAborted = request.raw.aborted;
    let deliveryClosed = false;
    request.raw.once("aborted", () => { clientAborted = true; });
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) deliveryClosed = true;
    });
    const context = dependencies.orchestrator.getRunContext(runId);
    const [snapshot, verdict, diagnosis, repair, trace] = await Promise.all([
      dependencies.loadSnapshot(context.envelope.snapshot_hash),
      dependencies.loadVerdict(runId),
      dependencies.loadDiagnosis(runId),
      dependencies.loadRepair(runId),
      dependencies.runStore.readEvents(runId)
    ]);
    const parsedRun = RunEnvelopeSchema.parse(context.envelope);
    const parsedSnapshot = SkillSnapshotSchema.parse(snapshot);
    const parsedVerdict = VerdictBundleSchema.parse(verdict);
    const parsedDiagnosis = diagnosis === undefined ? undefined : DiagnosisSchema.parse(diagnosis);
    const parsedTrace = trace.map((event) => TraceEventSchema.parse(event));
    const parsedRepair = repair === undefined ? undefined : reportRepair(repair);
    if (parsedRun.run_id !== runId) throw new Error("Report run context mismatch");
    validateSnapshotIdentity(parsedSnapshot, {
      expected_source_hash: parsedRun.snapshot_hash,
      expected_execution_fingerprint: context.snapshot_execution_fingerprint
    });
    if (parsedVerdict.run_id !== runId
      || (parsedDiagnosis !== undefined && parsedDiagnosis.run_id !== runId)
      || (parsedRepair !== undefined && (parsedRepair.run_id !== runId
        || parsedRepair.snapshot_hash !== parsedRun.snapshot_hash))) {
      throw new Error("Report record membership mismatch");
    }
    for (const [index, event] of parsedTrace.entries()) {
      if (event.run_id !== runId || event.seq !== index) {
        throw new Error("Report Trace membership mismatch");
      }
    }
    const artifacts = await reportArtifactSummaries(dependencies, reportArtifactRefs({
      snapshot: parsedSnapshot,
      verdict: parsedVerdict,
      ...(parsedDiagnosis === undefined ? {} : { diagnosis: parsedDiagnosis }),
      ...(parsedRepair === undefined ? {} : { repair: parsedRepair }),
      trace: parsedTrace
    }));
    const reportSecrets = [
      options.sessionToken,
      parsedSnapshot.imported_path,
      parsedSnapshot.source.uri
    ];
    const report = sanitize({
      schema: "arena.report/v1",
      redaction_complete: true,
      run: parsedRun,
      manifest_id: context.manifest_id,
      snapshot: reportSnapshot(parsedSnapshot),
      verdict: reportVerdict(parsedVerdict),
      ...(parsedDiagnosis === undefined ? {} : { diagnosis: parsedDiagnosis }),
      ...(parsedRepair === undefined ? {} : { repair: parsedRepair }),
      trace: parsedTrace.map(reportTrace),
      artifacts
    }, reportSecrets);
    const serialized = canonicalJson(report);
    if (reportSecrets.some((secret) => secret.length > 0 && serialized.includes(secret))) {
      throw new Error("Report redaction failed");
    }
    reply.raw.once("finish", () => {
      if (!clientAborted && !deliveryClosed && !reply.raw.destroyed
        && reply.raw.statusCode === 200) {
        scheduleCleanup(runId);
      }
    });
    return reply.type("application/json").send(serialized);
  });

  return app;
}
