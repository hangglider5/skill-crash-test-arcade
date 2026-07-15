import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ArenaReportSchema } from "../apps/web/src/api.js";
import { createDefaultServerDependencies } from "../src/core/cli.js";
import { createServer } from "../src/core/server.js";
import {
  RunEnvelopeSchema,
  SkillContractSchema,
  SkillSnapshotSchema,
  canonicalJson
} from "../src/protocol/index.js";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const APP_DATA = path.join(PROJECT_ROOT, ".arena", "live-smoke");
const TOKEN = "live-smoke-local-session";
const TERMINAL_TIMEOUT_MS = 10 * 60_000;

export type LiveSmokeStage =
  | "preflight"
  | "import"
  | "contract"
  | "run_start"
  | "run_poll"
  | "report"
  | "report_write";

function stageCode(stage: LiveSmokeStage): string {
  return stage.toUpperCase();
}

export class LiveSmokeRequestError extends Error {
  readonly stage: LiveSmokeStage;
  readonly code: string;

  constructor(stage: LiveSmokeStage, code: string) {
    super(`Live smoke ${stage} request failed safely`);
    this.name = "LiveSmokeRequestError";
    this.stage = stage;
    this.code = code;
  }
}

export async function requestLiveSmokeJson(
  fetchImpl: typeof fetch,
  stage: LiveSmokeStage,
  url: string,
  init: RequestInit = {}
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new LiveSmokeRequestError(stage, `LIVE_${stageCode(stage)}_REQUEST_FAILED`);
  }
  if (!response.ok) {
    throw new LiveSmokeRequestError(stage, `LIVE_${stageCode(stage)}_HTTP_${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new LiveSmokeRequestError(stage, `LIVE_${stageCode(stage)}_RESPONSE_INVALID`);
  }
}

async function parseStage<T>(
  stage: LiveSmokeStage,
  operation: () => T | Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof LiveSmokeRequestError) throw error;
    throw new LiveSmokeRequestError(stage, `LIVE_${stageCode(stage)}_SCHEMA_INVALID`);
  }
}

async function request(
  stage: LiveSmokeStage,
  url: string,
  init: RequestInit = {}
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("x-arena-token", TOKEN);
  return requestLiveSmokeJson(fetch, stage, url, { ...init, headers });
}

async function jsonRequest(
  stage: LiveSmokeStage,
  url: string,
  value: unknown
): Promise<unknown> {
  return request(stage, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value)
  });
}

export async function smokeLiveCodex(): Promise<void> {
  // Production mode is an explicit defense against selecting the scripted demo adapter.
  process.env.NODE_ENV = "production";
  await mkdir(APP_DATA, { recursive: true, mode: 0o700 });
  const dependencies = await createDefaultServerDependencies(APP_DATA);
  const app = await createServer(dependencies, { appData: APP_DATA, sessionToken: TOKEN });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const health = await parseStage("preflight", async () => (
      await request("preflight", `${address}/api/health`)
    ) as {
        ok: boolean;
        checks: Array<{ id: string; ok: boolean }>;
      });
    const required = new Set(["codex-version", "codex-login", "git-version", "app-data"]);
    if (!health.ok || health.checks.some((check) => required.has(check.id) && !check.ok)
      || [...required].some((id) => !health.checks.some((check) => check.id === id))) {
      throw new LiveSmokeRequestError("preflight", "LIVE_PREFLIGHT_BLOCKED");
    }

    const snapshot = await parseStage("import", async () => SkillSnapshotSchema.parse(
      await jsonRequest("import", `${address}/api/imports`, {
        kind: "sample",
        id: "repo-bugfix"
      })
    ));
    await parseStage("contract", async () => SkillContractSchema.parse(
      await jsonRequest("contract", `${address}/api/contracts`, {
        snapshot_hash: snapshot.source_hash
      })
    ));
    let run = await parseStage("run_start", async () => RunEnvelopeSchema.parse(
      await jsonRequest("run_start", `${address}/api/runs`, {
        manifest_id: "repo-dirty-tree-v1",
        snapshot_hash: snapshot.source_hash
      })
    ));
    const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
    while (run.state !== "completed" && run.state !== "errored" && run.state !== "cancelled") {
      if (Date.now() >= deadline) {
        throw new LiveSmokeRequestError("run_poll", "LIVE_RUN_POLL_TIMEOUT");
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      run = await parseStage("run_poll", async () => RunEnvelopeSchema.parse(
        await request("run_poll", `${address}/api/runs/${encodeURIComponent(run.run_id)}`)
      ));
    }
    const report = await parseStage("report", async () => ArenaReportSchema.parse(
      await request("report", `${address}/api/runs/${encodeURIComponent(run.run_id)}/report`)
    ));
    const reportDirectory = path.join(APP_DATA, "reports");
    const reportPath = path.join(reportDirectory, `${run.run_id}.json`);
    const tracePath = path.join(APP_DATA, "runs", run.run_id, "trace.jsonl");
    try {
      await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
      await writeFile(reportPath, `${canonicalJson(report)}\n`, { mode: 0o600 });
    } catch {
      throw new LiveSmokeRequestError("report_write", "LIVE_REPORT_WRITE_FAILED");
    }
    process.stdout.write(`run_id: ${run.run_id}\n`);
    process.stdout.write(`terminal status: ${report.verdict.status}\n`);
    if (report.verdict.status !== "error") process.stdout.write(`score: ${report.verdict.score}\n`);
    process.stdout.write(`Trace path: ${tracePath}\n`);
    process.stdout.write(`report path: ${reportPath}\n`);
    if (report.verdict.status === "error") process.exitCode = 1;
  } finally {
    await app.close();
  }
}

if (process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void smokeLiveCodex().catch((error: unknown) => {
    const code = error instanceof LiveSmokeRequestError && /^[A-Z0-9_]{1,96}$/u.test(error.code)
      ? error.code
      : "LIVE_SMOKE_FAILED";
    process.stderr.write(`Live Codex smoke failed: ${code}\n`);
    process.exitCode = 1;
  });
}
