import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { ArenaReportSchema } from "../apps/web/src/api.js";
import { canonicalJson } from "../src/protocol/index.js";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const LIVE_REPORT_ROOT = path.join(PROJECT_ROOT, ".arena", "live-smoke", "reports");
const PUBLIC_PROOF_ROOT = path.join(PROJECT_ROOT, "proofs", "live", "gpt-5.6-sol");
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_PUBLIC_TEXT = [
  /\/Users\//u,
  /\/private\//u,
  /file:\/\//iu,
  /OPENAI_API_KEY|CODEX_HOME|live-smoke-local-session/u,
  /sk-[A-Za-z0-9_-]{8,}/u
] as const;

export interface PublishedLiveProof {
  readonly schema: "arena.live-proof/v1";
  readonly execution: "live";
  readonly attestation: "project-generated";
  readonly source_command: "pnpm smoke:live";
  readonly report_file: "report.json";
  readonly report_sha256: string;
  readonly sanitized_trace_file: "trace.sanitized.jsonl";
  readonly sanitized_trace_sha256: string;
  readonly publication_cli_version: string;
  readonly run_id: string;
  readonly completed_at: string;
  readonly model: "gpt-5.6-sol";
  readonly status: "victory" | "defeat";
  readonly score: number;
  readonly verifier_passed: number;
  readonly verifier_total: number;
  readonly sanitized_trace_events: number;
  readonly redaction_complete: true;
  readonly note: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertPublicText(value: string): void {
  for (const pattern of FORBIDDEN_PUBLIC_TEXT) {
    if (pattern.test(value)) throw new Error("Live proof contains non-public text");
  }
}

async function codexVersion(): Promise<string> {
  const result = await execFileAsync("codex", ["--version"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 10_000
  });
  const value = result.stdout.trim();
  if (!/^codex-cli [0-9A-Za-z.+-]+$/u.test(value)) {
    throw new Error("Codex CLI version is unavailable");
  }
  return value;
}

export async function publishLiveProof(reportInput: string): Promise<{
  readonly directory: string;
  readonly proof: PublishedLiveProof;
}> {
  const configured = path.resolve(reportInput);
  const [reportRoot, reportPath] = await Promise.all([
    realpath(LIVE_REPORT_ROOT),
    realpath(configured)
  ]);
  if (path.dirname(reportPath) !== reportRoot || path.extname(reportPath) !== ".json") {
    throw new Error("Proof source must be a direct live-smoke report");
  }
  const raw = await readFile(reportPath, "utf8");
  if (Buffer.byteLength(raw) > MAX_REPORT_BYTES) throw new Error("Live report is too large");
  assertPublicText(raw);

  const report = ArenaReportSchema.parse(JSON.parse(raw));
  if (report.redaction_complete !== true
    || report.run.state !== "completed"
    || report.run.runner.adapter !== "codex-cli"
    || report.run.runner.model !== "gpt-5.6-sol"
    || report.verdict.status === "error"
    || report.run.ended_at === undefined) {
    throw new Error("Live report is not publishable");
  }
  if (report.trace.some((event, index) =>
    event.run_id !== report.run.run_id || event.seq !== index)) {
    throw new Error("Live report Trace is not contiguous");
  }

  const reportText = `${canonicalJson(report)}\n`;
  const traceText = `${report.trace.map((event) => canonicalJson(event)).join("\n")}\n`;
  assertPublicText(reportText);
  assertPublicText(traceText);
  const verifierPassed = report.verdict.verifier_results
    .filter(({ passed }) => passed).length;
  const proof: PublishedLiveProof = {
    schema: "arena.live-proof/v1",
    execution: "live",
    attestation: "project-generated",
    source_command: "pnpm smoke:live",
    report_file: "report.json",
    report_sha256: sha256(reportText),
    sanitized_trace_file: "trace.sanitized.jsonl",
    sanitized_trace_sha256: sha256(traceText),
    publication_cli_version: await codexVersion(),
    run_id: report.run.run_id,
    completed_at: report.run.ended_at,
    model: "gpt-5.6-sol",
    status: report.verdict.status,
    score: report.verdict.score,
    verifier_passed: verifierPassed,
    verifier_total: report.verdict.verifier_results.length,
    sanitized_trace_events: report.trace.length,
    redaction_complete: true,
    note: "Project-generated provenance metadata, not a third-party attestation. The report contains sanitized event headers and artifact metadata; raw operational evidence remains local."
  };
  const proofText = `${canonicalJson(proof)}\n`;
  assertPublicText(proofText);

  const directory = path.join(PUBLIC_PROOF_ROOT, report.run.run_id);
  await mkdir(directory, { recursive: true, mode: 0o755 });
  await Promise.all([
    writeFile(path.join(directory, "report.json"), reportText, { mode: 0o644 }),
    writeFile(path.join(directory, "proof.json"), proofText, { mode: 0o644 }),
    writeFile(path.join(directory, "trace.sanitized.jsonl"), traceText, { mode: 0o644 })
  ]);
  return { directory, proof };
}

if (process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const input = process.argv.slice(2).find((value) => value !== "--");
  if (input === undefined) {
    process.stderr.write("Usage: pnpm proof:publish -- <.arena/live-smoke/reports/run-id.json>\n");
    process.exitCode = 1;
  } else {
    void publishLiveProof(input).then(
      ({ directory, proof }) => {
        process.stdout.write(`published live proof: ${path.relative(PROJECT_ROOT, directory)}\n`);
        process.stdout.write(`report sha256: ${proof.report_sha256}\n`);
      },
      () => {
        process.stderr.write("Live proof publication failed safely\n");
        process.exitCode = 1;
      }
    );
  }
}
