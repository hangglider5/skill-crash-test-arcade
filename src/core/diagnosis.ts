import { z } from "zod";

import type { RunStore } from "../arena/run-store.js";
import type { StructuredModel } from "../codex/structured.js";
import {
  ArtifactRefSchema,
  DiagnosisJsonSchema,
  DiagnosisSchema,
  RunEnvelopeSchema,
  VerdictBundleSchema,
  canonicalJson,
  type ArtifactRef,
  type Diagnosis,
  type EvidenceRef,
  type RunEnvelope,
  type SkillSnapshot,
  type VerdictBundle
} from "../protocol/index.js";
import { validateSnapshotIdentity } from "./snapshot-identity.js";

const MAX_SELECTED_EVENTS = 128;
const MAX_ARTIFACT_SUMMARIES = 64;
const MAX_BUNDLE_BYTES = 256 * 1024;

const ArtifactSummarySchema = z.object({
  ref: ArtifactRefSchema,
  mime: z.string().min(1).max(256),
  bytes: z.number().int().nonnegative(),
  redacted: z.boolean()
}).strict();

export type ArtifactSummary = z.infer<typeof ArtifactSummarySchema>;

export interface DiagnosisRunContext {
  readonly envelope: RunEnvelope;
  readonly manifest_id: string;
  readonly snapshot_execution_fingerprint: string;
}

export interface RunDiagnosisServiceOptions {
  readonly runStore: RunStore;
  readonly model: StructuredModel;
  readonly loadRunContext: (runId: string) => Promise<DiagnosisRunContext>;
  readonly loadVerdict: (runId: string) => Promise<VerdictBundle>;
  readonly loadSnapshot: (snapshotHash: string) => Promise<SkillSnapshot>;
  readonly loadArtifactSummary: (ref: ArtifactRef) => Promise<unknown>;
  readonly modelCwd: string;
  readonly timeoutMs: number;
}

function verdictEvidence(verdict: VerdictBundle): EvidenceRef[] {
  return [
    ...verdict.evidence,
    ...verdict.dimensions.flatMap(({ evidence }) => evidence),
    ...verdict.verifier_results.flatMap(({ evidence }) => evidence)
  ];
}

function eventSequence(ref: EvidenceRef): number | undefined {
  const match = /^event:([0-9]+)$/u.exec(ref);
  return match === null ? undefined : Number(match[1]);
}

function diagnosisPrompt(bundleJson: string): string {
  return [
    "Diagnose this failed Arena run using only the sanitized evidence bundle below.",
    "Return observed_failure, likely_skill_gap, retry_analysis, suggested_changes, and evidence_refs.",
    "Every evidence_refs item must exactly match a ref present in the bundle; do not invent evidence.",
    `SANITIZED_EVIDENCE_BUNDLE_JSON=${bundleJson}`
  ].join("\n");
}

export class RunDiagnosisService {
  readonly #options: RunDiagnosisServiceOptions;

  constructor(options: RunDiagnosisServiceOptions) {
    this.#options = options;
  }

  async diagnoseRun(runId: string): Promise<Diagnosis> {
    const context = await this.#options.loadRunContext(runId);
    const envelope = RunEnvelopeSchema.parse(context.envelope);
    if (envelope.run_id !== runId || envelope.state !== "completed"
      || context.manifest_id.length === 0) {
      throw new Error("Diagnosis run context does not match the requested run");
    }

    const verdict = VerdictBundleSchema.parse(await this.#options.loadVerdict(runId));
    if (verdict.run_id !== runId || verdict.status !== "defeat") {
      throw new Error("Diagnosis verdict does not match the requested run");
    }
    validateSnapshotIdentity(
      await this.#options.loadSnapshot(envelope.snapshot_hash),
      {
        expected_source_hash: envelope.snapshot_hash,
        expected_execution_fingerprint: context.snapshot_execution_fingerprint
      }
    );

    const trace = await this.#options.runStore.readEvents(runId);
    const evidence = verdictEvidence(verdict);
    const referencedSequences = evidence
      .map(eventSequence)
      .filter((seq): seq is number => seq !== undefined);
    const selected = referencedSequences.length === 0
      ? []
      : trace.slice(Math.min(...referencedSequences), Math.max(...referencedSequences) + 1);
    if (selected.length > MAX_SELECTED_EVENTS) {
      throw new Error("Diagnosis evidence Trace exceeds the bounded selection limit");
    }
    for (const sequence of referencedSequences) {
      if (trace[sequence]?.seq !== sequence) {
        throw new Error(`Verdict references unavailable evidence: event:${sequence}`);
      }
    }

    const artifactRefs = [...new Set([
      ...evidence.filter((ref): ref is ArtifactRef => ArtifactRefSchema.safeParse(ref).success),
      ...selected.flatMap(({ artifacts }) => artifacts)
    ])].sort();
    if (artifactRefs.length > MAX_ARTIFACT_SUMMARIES) {
      throw new Error("Diagnosis artifact evidence exceeds the bounded summary limit");
    }
    const artifactSummaries = await Promise.all(artifactRefs.map(async (ref) => {
      const summary = ArtifactSummarySchema.parse(
        await this.#options.loadArtifactSummary(ref)
      );
      if (summary.ref !== ref) {
        throw new Error(`Artifact summary does not match requested ref: ${ref}`);
      }
      return summary;
    }));

    const selectedTrace = selected.map((event) => ({
      ref: `event:${event.seq}`,
      seq: event.seq,
      phase: event.phase,
      kind: event.kind,
      actor: event.actor,
      ...(event.span_id === undefined ? {} : { span_id: event.span_id }),
      artifacts: event.artifacts
    }));
    const availableRefs = new Set<EvidenceRef>([
      ...selectedTrace.map(({ ref }) => ref as EvidenceRef),
      ...artifactRefs
    ]);
    const bundleJson = canonicalJson({
      schema: "arena.diagnosis-evidence/v1",
      run: {
        run_id: runId,
        manifest_id: context.manifest_id,
        snapshot_hash: envelope.snapshot_hash
      },
      verdict,
      trace: selectedTrace,
      artifacts: artifactSummaries,
      evidence_refs: [...availableRefs].sort()
    });
    if (Buffer.byteLength(bundleJson) > MAX_BUNDLE_BYTES) {
      throw new Error("Diagnosis evidence bundle exceeds the size limit");
    }

    const validateDiagnosis = (value: unknown): Diagnosis => {
      const parsed = DiagnosisSchema.parse(value);
      if (parsed.run_id !== runId) {
        throw new Error("Diagnosis output does not match the requested run");
      }
      for (const ref of parsed.evidence_refs) {
        if (!availableRefs.has(ref)) {
          throw new Error(`Diagnosis references unavailable evidence: ${ref}`);
        }
      }
      return parsed;
    };
    const modelResult = await this.#options.model.run({
      cwd: this.#options.modelCwd,
      prompt: diagnosisPrompt(bundleJson),
      model: "gpt-5.6-sol",
      schema: DiagnosisJsonSchema,
      parse: validateDiagnosis,
      timeout_ms: this.#options.timeoutMs
    });

    const diagnosis = validateDiagnosis(modelResult);
    await this.#options.runStore.writeRecord(runId, "diagnosis.json", diagnosis);
    return diagnosis;
  }
}
