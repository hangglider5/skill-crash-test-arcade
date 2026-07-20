import type { VerifiedLiveProof } from "../live-proof.js";

function dataUrl(mime: string, value: string): string {
  return `data:${mime};charset=utf-8,${encodeURIComponent(value)}`;
}

function traceText(proof: VerifiedLiveProof): string {
  return `${proof.report.trace.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function shortHash(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

export function LiveProofCard({
  proof,
  report,
  onTrySample
}: VerifiedLiveProof & {
  readonly onTrySample?: () => void;
}): React.JSX.Element {
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const sanitizedTrace = traceText({ proof, report });
  return (
    <section aria-labelledby="live-proof-title" className="live-proof-card">
      <div className="live-proof-intro">
        <strong className="live-proof-badge">LIVE · GPT-5.6 SOL</strong>
        <div>
          <h2 id="live-proof-title">Prior authorized live smoke</h2>
          <p>Production-only Codex execution, independently judged by the Arena.</p>
        </div>
      </div>

      <div className="live-proof-result">
        <strong>{proof.status.toUpperCase()} · {proof.score}/100</strong>
        <span>{proof.verifier_passed}/{proof.verifier_total} VERIFIERS PASSED</span>
        <span>REDACTION COMPLETE</span>
      </div>

      <a className="live-proof-primary" href="#source-title" onClick={onTrySample}>
        Try the recorded crash test
      </a>

      <details className="live-proof-lineage">
        <summary>Inspect verified proof lineage</summary>
        <div className="live-proof-lineage-body">
          <dl className="live-proof-fields">
            <div>
              <dt>Run ID</dt>
              <dd><code>{proof.run_id}</code></dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{proof.model}</dd>
            </div>
            <div>
              <dt>Manifest</dt>
              <dd><code aria-label={`Manifest hash ${report.run.manifest_hash}`}>
                {shortHash(report.run.manifest_hash)}
              </code></dd>
            </div>
            <div>
              <dt>Snapshot</dt>
              <dd><code aria-label={`Snapshot hash ${report.run.snapshot_hash}`}>
                {shortHash(report.run.snapshot_hash)}
              </code></dd>
            </div>
            <div>
              <dt>Fixture</dt>
              <dd><code aria-label={`Fixture hash ${report.run.fixture_hash}`}>
                {shortHash(report.run.fixture_hash)}
              </code></dd>
            </div>
            <div>
              <dt>CLI</dt>
              <dd>{proof.publication_cli_version}</dd>
            </div>
          </dl>

          <div className="live-proof-actions">
            <a
              download={`arena-live-report-${proof.run_id}.json`}
              href={dataUrl("application/json", reportText)}
            >
              Download sanitized report
            </a>
            <a
              download={`arena-live-trace-${proof.run_id}.jsonl`}
              href={dataUrl("application/x-ndjson", sanitizedTrace)}
            >
              Download sanitized Trace
            </a>
          </div>

          <p className="live-proof-note">{proof.note}</p>
        </div>
      </details>

      <details className="live-proof-trace">
        <summary>Inspect {proof.sanitized_trace_events} sanitized event headers</summary>
        <ol>
          {report.trace.map((event) => (
            <li key={`${event.run_id}:${event.seq}`}>
              <span>#{event.seq}</span>
              <strong>{event.kind}</strong>
              <small>{event.actor} · {event.phase}</small>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
