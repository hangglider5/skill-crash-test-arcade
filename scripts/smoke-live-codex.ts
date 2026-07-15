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

async function request(url: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("x-arena-token", TOKEN);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
}

async function jsonRequest(url: string, value: unknown): Promise<unknown> {
  return request(url, {
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
    const health = await fetch(`${address}/api/health`).then(async (response) => {
      if (!response.ok) throw new Error(`PREFLIGHT_HTTP_${response.status}`);
      return response.json() as Promise<{
        ok: boolean;
        checks: Array<{ id: string; ok: boolean }>;
      }>;
    });
    const required = new Set(["codex-version", "codex-login", "git-version", "app-data"]);
    if (!health.ok || health.checks.some((check) => required.has(check.id) && !check.ok)
      || [...required].some((id) => !health.checks.some((check) => check.id === id))) {
      throw new Error("PREFLIGHT_BLOCKED");
    }

    const snapshot = SkillSnapshotSchema.parse(await jsonRequest(`${address}/api/imports`, {
      kind: "sample",
      id: "repo-bugfix"
    }));
    SkillContractSchema.parse(await jsonRequest(`${address}/api/contracts`, {
      snapshot_hash: snapshot.source_hash
    }));
    let run = RunEnvelopeSchema.parse(await jsonRequest(`${address}/api/runs`, {
      manifest_id: "repo-dirty-tree-v1",
      snapshot_hash: snapshot.source_hash
    }));
    const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
    while (run.state !== "completed" && run.state !== "errored" && run.state !== "cancelled") {
      if (Date.now() >= deadline) throw new Error("RUN_TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, 500));
      run = RunEnvelopeSchema.parse(await request(`${address}/api/runs/${encodeURIComponent(run.run_id)}`));
    }
    const report = ArenaReportSchema.parse(
      await request(`${address}/api/runs/${encodeURIComponent(run.run_id)}/report`)
    );
    const reportDirectory = path.join(APP_DATA, "reports");
    const reportPath = path.join(reportDirectory, `${run.run_id}.json`);
    const tracePath = path.join(APP_DATA, "runs", run.run_id, "trace.jsonl");
    await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
    await writeFile(reportPath, `${canonicalJson(report)}\n`, { mode: 0o600 });
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
    const code = error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)
      ? error.message
      : "LIVE_SMOKE_FAILED";
    process.stderr.write(`Live Codex smoke failed: ${code}\n`);
    process.exitCode = 1;
  });
}
