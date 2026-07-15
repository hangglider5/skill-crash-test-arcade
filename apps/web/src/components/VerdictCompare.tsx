import { useEffect, useRef, useState } from "react";

import type {
  CandidatePatch,
  SanitizedRepair,
  SanitizedVerdict
} from "../api.js";
import type {
  Diagnosis,
  EvidenceRef,
  RunEnvelope
} from "../../../../src/protocol/schema.js";
import { isLockedTerminalResult } from "../../../../src/protocol/schema.js";

const MAX_CHANGED_PATHS = 24;
const MAX_PATCH_PREVIEW_CHARS = 32_768;
const MAX_ADVISORY_TEXT_CHARS = 640;
const MAX_SUGGESTION_CHARS = 240;
const DIMENSION_LABELS: Readonly<Record<string, string>> = {
  task_correctness: "Task correctness",
  change_isolation: "Change isolation",
  verification_quality: "Verification quality",
  recovery_discipline: "Recovery discipline"
};

export interface FailedVerifierEvidenceItem {
  readonly label: string;
  readonly evidence_refs: readonly EvidenceRef[];
}

export interface LockedResultView {
  readonly run: RunEnvelope;
  readonly verdict: SanitizedVerdict;
  readonly redaction_complete: boolean | undefined;
  readonly failed_verifier_evidence: readonly FailedVerifierEvidenceItem[];
}

export interface CandidateRepairView {
  readonly proposal: SanitizedRepair;
  readonly patch?: CandidatePatch;
}

export interface VerdictCompareProps {
  readonly baseline: LockedResultView;
  readonly diagnosis?: Diagnosis;
  readonly repair?: CandidateRepairView;
  readonly child?: LockedResultView;
  readonly onDiagnose: () => Promise<void>;
  readonly onCreateRepair: () => Promise<void>;
  readonly onReject: () => Promise<void>;
  readonly onApproveRerun: () => Promise<void>;
  readonly onExportReport: () => Promise<void>;
  readonly onEvidenceSelect?: ((ref: EvidenceRef) => void) | undefined;
}

type ActionName = "diagnose" | "repair" | "reject" | "rerun" | "export";

function evidenceLabel(ref: EvidenceRef): string {
  return ref.startsWith("event:") ? ref : `artifact:${ref.slice(-8)}`;
}

function EvidenceLinks(props: {
  readonly refs: readonly EvidenceRef[];
  readonly onSelect: ((ref: EvidenceRef) => void) | undefined;
}): React.JSX.Element {
  const shown = props.refs.slice(0, 12);
  return (
    <span className="evidence-links">
      {shown.map((ref, index) => props.onSelect === undefined ? (
        <span className="evidence-ref evidence-ref-inert" key={`${ref}-${index}`} title={ref}>
          {evidenceLabel(ref)}
        </span>
      ) : (
        <button
          className="evidence-ref"
          key={`${ref}-${index}`}
          onClick={() => props.onSelect?.(ref)}
          title={ref}
          type="button"
        >
          {evidenceLabel(ref)}
        </button>
      ))}
      {props.refs.length > shown.length ? <span>+{props.refs.length - shown.length} refs</span> : null}
    </span>
  );
}

function statusLabel(verdict: SanitizedVerdict): string {
  return verdict.status.toUpperCase();
}

function sameRunner(left: RunEnvelope, right: RunEnvelope): boolean {
  return left.runner.adapter === right.runner.adapter && left.runner.model === right.runner.model;
}

interface ProofItem {
  readonly label: string;
  readonly ok: boolean;
  readonly mismatch: string;
}

function proofItems(baseline: RunEnvelope, child: RunEnvelope): readonly ProofItem[] {
  return [
    { label: "Same Manifest", ok: baseline.manifest_hash === child.manifest_hash, mismatch: "Manifest mismatch" },
    { label: "Same fixture", ok: baseline.fixture_hash === child.fixture_hash, mismatch: "Fixture mismatch" },
    { label: "Same Runner config", ok: sameRunner(baseline, child), mismatch: "Runner config mismatch" },
    { label: "Changed Skill Snapshot", ok: baseline.snapshot_hash !== child.snapshot_hash, mismatch: "Skill Snapshot did not change" },
    { label: "Child parent_run_id", ok: child.parent_run_id === baseline.run_id, mismatch: "Parent run mismatch" },
    { label: "Same Quick Match group", ok: child.run_group_id === baseline.run_group_id, mismatch: "Run group mismatch" }
  ];
}

function terminalLocked(result: LockedResultView): boolean {
  return isLockedTerminalResult(result.run, result.verdict);
}

function comparisonProofItems(
  baseline: LockedResultView,
  child: LockedResultView,
  repair: CandidateRepairView | undefined
): readonly ProofItem[] {
  const proposal = repair?.proposal;
  const approved = proposal?.status === "approved" ? proposal : undefined;
  return [
    ...proofItems(baseline.run, child.run),
    {
      label: "Baseline verdict membership",
      ok: terminalLocked(baseline),
      mismatch: "Baseline result is not terminal and membership-locked"
    },
    {
      label: "Child verdict membership",
      ok: terminalLocked(child),
      mismatch: "Child result is not terminal and membership-locked"
    },
    {
      label: "Approved repair",
      ok: approved !== undefined,
      mismatch: "Repair is not approved"
    },
    {
      label: "Reviewed patch membership",
      ok: approved !== undefined
        && approved.run_id === baseline.run.run_id
        && approved.snapshot_hash === baseline.run.snapshot_hash
        && approved.reviewed_patch_ref === approved.patch_ref,
      mismatch: "Reviewed patch does not match the approved repair"
    },
    {
      label: "Approved child membership",
      ok: approved !== undefined
        && approved.child_run_id === child.run.run_id
        && approved.new_snapshot_hash === child.run.snapshot_hash,
      mismatch: "Child does not match the approved repair"
    }
  ];
}

function comparisonIsControlled(
  baseline: LockedResultView,
  child: LockedResultView | undefined,
  repair: CandidateRepairView | undefined
): boolean {
  return child !== undefined && comparisonProofItems(baseline, child, repair).every(({ ok }) => ok);
}

function ComparisonProof(props: {
  readonly baseline: LockedResultView;
  readonly child?: LockedResultView;
  readonly repair?: CandidateRepairView;
}): React.JSX.Element {
  if (props.child === undefined) {
    return <p className="compare-pending">No repaired child run yet.</p>;
  }
  const allProof = comparisonProofItems(props.baseline, props.child, props.repair);
  const comparable = allProof.every(({ ok }) => ok);
  const observedImprovement = comparable
    && props.baseline.verdict.status === "defeat"
    && props.child.verdict.status === "victory";
  return (
    <div className={`proof-strip ${comparable ? "is-comparable" : "is-mismatch"}`}>
      <div className="proof-heading">
        <strong>{comparable ? "Controlled comparison" : "Non-comparable result"}</strong>
        {observedImprovement ? <span>Observed improvement</span> : null}
      </div>
      <ul aria-label="Comparison proof">
        {allProof.map((item) => (
          <li className={item.ok ? "proof-ok" : "proof-fail"} key={item.label}>
            <span aria-hidden="true">{item.ok ? "✓" : "×"}</span>
            {item.ok ? item.label : item.mismatch}
          </li>
        ))}
      </ul>
      <p>Quick Match is an observed outcome, not causal proof.</p>
    </div>
  );
}

function repairMatchesBaseline(
  repair: CandidateRepairView,
  baseline: LockedResultView
): boolean {
  return repair.proposal.run_id === baseline.run.run_id
    && repair.proposal.snapshot_hash === baseline.run.snapshot_hash
    && (repair.patch === undefined || (repair.patch.repair_id === repair.proposal.repair_id
      && repair.patch.patch_ref === repair.proposal.patch_ref));
}

export function VerdictCompare(props: VerdictCompareProps): React.JSX.Element {
  const mounted = useRef(true);
  const generationRef = useRef(0);
  const busyRef = useRef<ActionName | null>(null);
  const [busy, setBusy] = useState<ActionName | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    generationRef.current += 1;
    busyRef.current = null;
    setBusy(null);
    setActionError(null);
    return () => {
      mounted.current = false;
    };
  }, [props.baseline.run.run_id]);

  const runAction = async (name: ActionName, action: () => Promise<void>): Promise<void> => {
    if (busyRef.current !== null) return;
    const generation = generationRef.current;
    busyRef.current = name;
    setBusy(name);
    setActionError(null);
    try {
      await action();
    } catch {
      if (mounted.current && generationRef.current === generation) {
        setActionError("Action failed safely. The locked verdict is unchanged.");
      }
    } finally {
      if (mounted.current && generationRef.current === generation) {
        busyRef.current = null;
        setBusy(null);
      }
    }
  };

  const { baseline } = props;
  const verdict = baseline.verdict;
  if (!terminalLocked(baseline)) {
    return (
      <section aria-labelledby="verdict-title" className="verdict-compare verdict-invalid">
        <header className="verdict-hero">
          <div>
            <p className="advisory-label">UNVERIFIED RESULT</p>
            <h1 id="verdict-title">Result unavailable</h1>
            <p>The run and verdict do not form a valid terminal result.</p>
          </div>
        </header>
      </section>
    );
  }
  const diagnosis = props.diagnosis?.run_id === baseline.run.run_id ? props.diagnosis : undefined;
  const repair = props.repair !== undefined && repairMatchesBaseline(props.repair, baseline)
    ? props.repair
    : undefined;
  const paths = repair?.proposal.changed_paths.slice(0, MAX_CHANGED_PATHS) ?? [];
  const patchText = repair?.patch?.text ?? "";
  const patchTruncated = patchText.length > MAX_PATCH_PREVIEW_CHARS;
  const controlledComparison = comparisonIsControlled(baseline, props.child, repair);
  const exportBlocked = baseline.redaction_complete !== true || !controlledComparison;

  return (
    <section aria-labelledby="verdict-title" className={`verdict-compare verdict-${verdict.status}`}>
      <header className="verdict-hero">
        <div>
          <p className="locked-label">Deterministic verdict · LOCKED</p>
          <h1 id="verdict-title">{statusLabel(verdict)}</h1>
          {verdict.status === "error"
            ? <code className="verdict-error-code">{verdict.error.code}</code>
            : <strong className="verdict-score">{verdict.score} / 100</strong>}
        </div>
        <div className="hard-gate-summary">
          <span>Hard gates</span>
          {verdict.hard_gate_failures.length === 0
            ? <strong>No locked failures</strong>
            : verdict.hard_gate_failures.slice(0, 12).map((gate) => <strong key={gate}>{gate}</strong>)}
        </div>
      </header>

      <div className="verdict-layout">
        <div className="verdict-main">
          <section aria-label="Dimension scores" className="result-section dimension-section">
            <h2>Dimension scores</h2>
            <div className="dimension-bars">
              {verdict.dimensions.slice(0, 4).map((dimension) => {
                const ratio = dimension.possible === 0 ? 0 : dimension.earned / dimension.possible;
                return (
                  <div className="dimension-row" key={dimension.id}>
                    <div className="dimension-copy">
                      <strong>{DIMENSION_LABELS[dimension.id] ?? dimension.id}</strong>
                      <span>{dimension.earned} / {dimension.possible}</span>
                    </div>
                    <div
                      aria-label={`${dimension.id}: ${dimension.earned} of ${dimension.possible}`}
                      aria-valuemax={dimension.possible}
                      aria-valuemin={0}
                      aria-valuenow={dimension.earned}
                      className="dimension-track"
                      role="progressbar"
                    >
                      <span style={{ width: `${Math.max(0, Math.min(100, ratio * 100))}%` }} />
                    </div>
                    <EvidenceLinks refs={dimension.evidence} onSelect={props.onEvidenceSelect} />
                  </div>
                );
              })}
            </div>
          </section>

          <section className="result-section failure-chain-section">
            <h2>Failed verifier evidence</h2>
            {baseline.failed_verifier_evidence.length === 0 ? (
              <p>No failed verifier evidence was supplied.</p>
            ) : (
              <ol className="failure-chain">
                {baseline.failed_verifier_evidence.slice(0, 8).map((item, index) => (
                  <li key={`${index}-${item.label}`}>
                    <span>{item.label}</span>
                    <EvidenceLinks refs={item.evidence_refs} onSelect={props.onEvidenceSelect} />
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="result-section diagnosis-section">
            <div className="section-heading-row">
              <h2>GPT-5.6 diagnosis</h2>
              <span className="advisory-label">ADVISORY</span>
            </div>
            {diagnosis === undefined ? (
              <button
                className="secondary-action"
                disabled={busy !== null || verdict.status !== "defeat"}
                onClick={() => void runAction("diagnose", props.onDiagnose)}
                type="button"
              >
                {busy === "diagnose" ? "Diagnosing…" : "Diagnose locked defeat"}
              </button>
            ) : (
              <div className="diagnosis-copy">
                <p><strong>Observed:</strong> {diagnosis.observed_failure.slice(0, MAX_ADVISORY_TEXT_CHARS)}</p>
                <p><strong>Likely Skill gap:</strong> {diagnosis.likely_skill_gap.slice(0, MAX_ADVISORY_TEXT_CHARS)}</p>
                <p><strong>Retry analysis:</strong> {diagnosis.retry_analysis.slice(0, MAX_ADVISORY_TEXT_CHARS)}</p>
                <ul>{diagnosis.suggested_changes.slice(0, 8).map((change, index) => (
                  <li key={`${index}-${change}`}>{change.slice(0, MAX_SUGGESTION_CHARS)}</li>
                ))}</ul>
                <EvidenceLinks refs={diagnosis.evidence_refs} onSelect={props.onEvidenceSelect} />
              </div>
            )}
          </section>
        </div>

        <aside className="repair-compare" aria-label="Repair review">
          <section className="result-section repair-section">
            <div className="section-heading-row">
              <h2>Candidate Skill fork</h2>
              <span className="source-safe-label">Original unchanged</span>
            </div>
            {repair === undefined ? (
              <button
                className="repair-action"
                disabled={busy !== null || diagnosis === undefined || verdict.status !== "defeat"}
                onClick={() => void runAction("repair", props.onCreateRepair)}
                type="button"
              >
                {busy === "repair" ? "Building repair…" : "Create repair candidate"}
              </button>
            ) : (
              <>
                <div className="changed-paths">
                  <strong>Changed paths</strong>
                  <ul>{paths.map((changedPath) => <li key={changedPath}><code>{changedPath}</code></li>)}</ul>
                  {repair.proposal.changed_paths.length > paths.length
                    ? <p>Showing {paths.length} of {repair.proposal.changed_paths.length} changed paths.</p>
                    : null}
                </div>
                {repair.patch === undefined ? (
                  <p>Candidate patch content is unavailable for authenticated local review.</p>
                ) : (
                  <div className="patch-review">
                    <span className="local-review-label">Local review only — not export-redacted</span>
                    <pre tabIndex={0}>{patchText.slice(0, MAX_PATCH_PREVIEW_CHARS)}</pre>
                    {patchTruncated ? <p>Patch preview truncated for safe rendering.</p> : null}
                  </div>
                )}
                <div className="repair-actions">
                  <button
                    className="secondary-action"
                    disabled={busy !== null || repair.proposal.status !== "pending"}
                    onClick={() => void runAction("reject", props.onReject)}
                    type="button"
                  >
                    {busy === "reject" ? "Rejecting…" : "Reject"}
                  </button>
                  <button
                    className="repair-action"
                    disabled={busy !== null || repair.patch === undefined || repair.proposal.status !== "pending"}
                    onClick={() => void runAction("rerun", props.onApproveRerun)}
                    type="button"
                  >
                    {busy === "rerun" ? "Approving…" : "Approve & Rerun"}
                  </button>
                </div>
              </>
            )}
          </section>

          <section className="result-section comparison-section">
            <h2>Baseline / repaired proof</h2>
            <ComparisonProof
              baseline={baseline}
              {...(props.child === undefined ? {} : { child: props.child })}
              {...(repair === undefined ? {} : { repair })}
            />
          </section>

          <section className="export-section">
            <button
              className="export-action"
              disabled={busy !== null || exportBlocked}
              onClick={() => void runAction("export", props.onExportReport)}
              type="button"
            >
              {busy === "export" ? "Exporting…" : "Export report"}
            </button>
            {baseline.redaction_complete === undefined
              ? <p>Export blocked: redaction completeness is unknown.</p>
              : baseline.redaction_complete
                ? controlledComparison
                  ? <p>Sanitized controlled comparison is ready for export.</p>
                  : <p>Export blocked: approved repair comparison proof is incomplete.</p>
                : <p>Export blocked: redaction is incomplete.</p>}
          </section>
        </aside>
      </div>
      {actionError === null ? null : <p className="action-error" role="alert">{actionError}</p>}
    </section>
  );
}
