import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ArenaReportSchema } from "../../apps/web/src/api.js";
import {
  LiveProofSchema,
  verifyLiveProof
} from "../../apps/web/src/live-proof.js";
import { assertPublicText } from "../../scripts/publish-live-proof.js";
import { canonicalJson } from "../../src/protocol/index.js";

const root = path.resolve(
  "proofs/live/gpt-5.6-sol/run_d8e70569-2c6e-4473-904e-0350adddbf9e"
);

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("published GPT-5.6 Sol live proof", () => {
  it("is canonical, internally locked, and free of local operational text", async () => {
    const [proofText, reportText, traceText] = await Promise.all([
      readFile(path.join(root, "proof.json"), "utf8"),
      readFile(path.join(root, "report.json"), "utf8"),
      readFile(path.join(root, "trace.sanitized.jsonl"), "utf8")
    ]);
    const proof = LiveProofSchema.parse(JSON.parse(proofText));
    const report = ArenaReportSchema.parse(JSON.parse(reportText));
    expect(verifyLiveProof(proof, report)).toEqual({ proof, report });
    expect(reportText).toBe(`${canonicalJson(report)}\n`);
    expect(digest(reportText)).toBe(proof.report_sha256);
    expect(digest(traceText)).toBe(proof.sanitized_trace_sha256);
    expect(traceText).toBe(`${report.trace.map((event) => canonicalJson(event)).join("\n")}\n`);
    expect(report.verdict.hard_gate_failures).toEqual([]);
    expect(report.verdict.verifier_results).toHaveLength(5);
    expect(report.verdict.verifier_results.every(({ passed }) => passed)).toBe(true);
    expect(report.trace.map(({ seq }) => seq)).toEqual(
      Array.from({ length: 24 }, (_, index) => index)
    );
    assertPublicText(proofText);
    assertPublicText(reportText);
    assertPublicText(traceText);
  });

  it("rejects fake live provenance, membership drift, and sensitive paths", async () => {
    const [proofText, reportText] = await Promise.all([
      readFile(path.join(root, "proof.json"), "utf8"),
      readFile(path.join(root, "report.json"), "utf8")
    ]);
    const verified = {
      proof: LiveProofSchema.parse(JSON.parse(proofText)),
      report: ArenaReportSchema.parse(JSON.parse(reportText))
    };
    expect(() => verifyLiveProof(
      { ...verified.proof, execution: "scripted" },
      verified.report
    )).toThrow();
    expect(() => verifyLiveProof(
      { ...verified.proof, run_id: "run_other" },
      verified.report
    )).toThrow("membership drifted");
    expect(() => assertPublicText("/Users/example/private/repo")).toThrow(
      "non-public text"
    );
    expect(() => assertPublicText("OPENAI_API_KEY=secret")).toThrow(
      "non-public text"
    );
  });
});
