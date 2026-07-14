import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";

import type { ReplayManifest } from "../arena/manifest.js";
import type { EventBus } from "./events.js";
import type { ImportRequest } from "./importer.js";
import type {
  CreateRunRequest,
  ExpectedRunLineage,
  LockedRunContext
} from "./orchestrator.js";
import {
  DiagnosisSchema,
  RunEnvelopeSchema,
  SkillSnapshotSchema,
  TraceEventSchema,
  VerdictBundleSchema,
  canonicalJson,
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
    approveAndRerun(repairId: string): Promise<RunEnvelope>;
  };
  readonly loadVerdict: (runId: string) => Promise<VerdictBundle>;
  readonly loadDiagnosis: (runId: string) => Promise<Diagnosis | undefined>;
  readonly loadRepair: (runId: string) => Promise<unknown | undefined>;
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
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const before = await lstat(absolute);
  const uid = process.getuid?.();
  if (!before.isDirectory() || before.isSymbolicLink()
    || uid === undefined || before.uid !== uid) {
    throw new Error("Private directory identity is invalid");
  }
  if ((before.mode & 0o777) !== 0o700) await chmod(absolute, 0o700);
  const canonical = await realpath(absolute);
  const after = await lstat(absolute);
  if (canonical !== absolute
    || !after.isDirectory()
    || after.isSymbolicLink()
    || after.uid !== uid
    || after.dev !== before.dev
    || after.ino !== before.ino
    || (after.mode & 0o777) !== 0o700) {
    throw new Error("Private directory identity changed");
  }
  return canonical;
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

function reportRepair(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const keys = [
    "schema",
    "repair_id",
    "run_id",
    "status",
    "snapshot_hash",
    "created_at",
    "changed_paths",
    "patch_ref",
    "child_run_id",
    "new_snapshot_hash"
  ] as const;
  const output: Record<string, unknown> = {};
  for (const key of keys) if (input[key] !== undefined) output[key] = input[key];
  if (typeof input.error === "object" && input.error !== null
    && typeof (input.error as Record<string, unknown>).code === "string") {
    output.error = { code: (input.error as Record<string, unknown>).code };
  }
  return output;
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
      || (parsedRepair?.run_id !== undefined && parsedRepair.run_id !== runId)) {
      throw new Error("Report record membership mismatch");
    }
    for (const [index, event] of parsedTrace.entries()) {
      if (event.run_id !== runId || event.seq !== index) {
        throw new Error("Report Trace membership mismatch");
      }
    }
    const reportSecrets = [
      options.sessionToken,
      parsedSnapshot.imported_path,
      parsedSnapshot.source.uri
    ];
    const report = sanitize({
      schema: "arena.report/v1",
      run: parsedRun,
      manifest_id: context.manifest_id,
      snapshot: reportSnapshot(parsedSnapshot),
      verdict: reportVerdict(parsedVerdict),
      ...(parsedDiagnosis === undefined ? {} : { diagnosis: parsedDiagnosis }),
      ...(parsedRepair === undefined ? {} : { repair: parsedRepair }),
      trace: parsedTrace.map(reportTrace)
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
