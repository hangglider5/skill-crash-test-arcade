import { z } from "zod";

import proofJson from "../../../proofs/live/gpt-5.6-sol/run_d8e70569-2c6e-4473-904e-0350adddbf9e/proof.json" with { type: "json" };
import reportJson from "../../../proofs/live/gpt-5.6-sol/run_d8e70569-2c6e-4473-904e-0350adddbf9e/report.json" with { type: "json" };
import { ArenaReportSchema, type ArenaReport } from "./api.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const LiveProofSchema = z.object({
  schema: z.literal("arena.live-proof/v1"),
  execution: z.literal("live"),
  attestation: z.literal("project-generated"),
  source_command: z.literal("pnpm smoke:live"),
  report_file: z.literal("report.json"),
  report_sha256: HashSchema,
  sanitized_trace_file: z.literal("trace.sanitized.jsonl"),
  sanitized_trace_sha256: HashSchema,
  publication_cli_version: z.string().regex(/^codex-cli [0-9A-Za-z.+-]+$/u),
  run_id: z.string().min(1),
  completed_at: z.string().datetime(),
  model: z.literal("gpt-5.6-sol"),
  status: z.enum(["victory", "defeat"]),
  score: z.number().min(0).max(100),
  verifier_passed: z.number().int().nonnegative(),
  verifier_total: z.number().int().nonnegative(),
  sanitized_trace_events: z.number().int().nonnegative(),
  redaction_complete: z.literal(true),
  note: z.string().min(1)
}).strict();

export type LiveProof = z.infer<typeof LiveProofSchema>;

export interface VerifiedLiveProof {
  readonly proof: LiveProof;
  readonly report: ArenaReport;
}

export function verifyLiveProof(
  proofValue: unknown,
  reportValue: unknown
): VerifiedLiveProof {
  const proof = LiveProofSchema.parse(proofValue);
  const report = ArenaReportSchema.parse(reportValue);
  if (report.redaction_complete !== true
    || report.run.run_id !== proof.run_id
    || report.run.ended_at !== proof.completed_at
    || report.run.runner.model !== proof.model
    || report.verdict.status !== proof.status
    || report.verdict.score !== proof.score
    || report.trace.length !== proof.sanitized_trace_events
    || report.verdict.verifier_results.length !== proof.verifier_total
    || report.verdict.verifier_results.filter(({ passed }) => passed).length
      !== proof.verifier_passed) {
    throw new Error("Committed live proof membership drifted");
  }
  return { proof, report };
}

export const VERIFIED_LIVE_PROOF = verifyLiveProof(proofJson, reportJson);
