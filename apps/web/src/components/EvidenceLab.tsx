import { useRef, useState } from "react";

import type { Diagnosis, TraceEvent } from "../../../../src/protocol/schema.js";

const TABS = ["Evidence", "Trace", "Diff", "Diagnosis"] as const;
const MAX_FIELD_LENGTH = 480;

type EvidenceTab = typeof TABS[number];

export interface ArtifactSummary {
  readonly ref: `sha256:${string}`;
  readonly kind: "diff" | "process" | "test" | "verifier" | "other";
  readonly label: string;
  readonly summary: string;
  readonly redacted: boolean;
}

export interface EvidenceLabProps {
  readonly events: readonly TraceEvent[];
  readonly selectedEvent: TraceEvent | null;
  readonly artifacts: readonly ArtifactSummary[];
  readonly diagnosis?: Diagnosis;
  readonly onSelectSeq: (seq: number) => void;
}

function bounded(value: unknown, fallback = "Not recorded"): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return fallback;
  }
  const normalized = String(value).replaceAll(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return (normalized.length === 0 ? fallback : normalized).slice(0, MAX_FIELD_LENGTH);
}

function boundedArgv(value: unknown): string {
  if (!Array.isArray(value)) return "Not recorded";
  return value.slice(0, 12).map((entry) => bounded(entry, "[unavailable]").slice(0, 120)).join(" ")
    .slice(0, MAX_FIELD_LENGTH);
}

function verifierSummary(value: unknown): string {
  if (!Array.isArray(value)) return "Not recorded";
  return value.slice(0, 12).flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const item = candidate as Record<string, unknown>;
    const id = bounded(item.id, "verifier").slice(0, 80);
    const result = item.passed === true ? "passed" : item.passed === false ? "failed" : "unknown";
    return [`${id}: ${result}`];
  }).join(" · ").slice(0, MAX_FIELD_LENGTH) || "Not recorded";
}

function EvidenceFields({ event }: { readonly event: TraceEvent | null }): React.JSX.Element {
  if (event === null) return <p className="empty-evidence">Select a visible event to inspect evidence.</p>;
  const fields: Array<{ readonly label: string; readonly value: string }> = [];
  if (event.kind === "process.started" || event.kind === "process.exited") {
    fields.push({ label: "Command", value: boundedArgv(event.data.argv) });
    if (event.kind === "process.exited") {
      fields.push({ label: "Exit code", value: bounded(event.data.exit_code) });
      if (event.data.status !== undefined) {
        fields.push({ label: "Process status", value: bounded(event.data.status) });
      }
    }
  }
  if (event.kind === "file.changed") {
    fields.push({ label: "File", value: bounded(event.data.path, "Path unavailable") });
    fields.push({ label: "Mutation", value: bounded(event.data.change) });
    fields.push({
      label: "Protected",
      value: event.data.protected === true ? "Yes — hard-gate evidence" : "Not indicated"
    });
  }
  if (event.kind === "test.completed") {
    fields.push({ label: "Test", value: bounded(event.data.test) });
    fields.push({
      label: "Result",
      value: event.data.passed === true ? "Passed" : event.data.passed === false ? "Failed" : "Not recorded"
    });
  }
  if (event.kind === "verifier.completed") {
    fields.push({ label: "Verifier", value: verifierSummary(event.data.verifier_results) });
  }
  if (fields.length === 0) {
    fields.push({ label: "Observable event", value: event.kind });
    fields.push({ label: "Actor", value: event.actor });
  }
  return (
    <>
      <div className="evidence-sequence">SEQ {event.seq}</div>
      <dl className="evidence-fields">
        {fields.map((field) => (
          <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>
        ))}
      </dl>
      <div className="artifact-refs">
        <h3>Artifact refs</h3>
        {event.artifacts.length === 0 ? <p>None attached.</p> : (
          <ul>{event.artifacts.map((ref) => <li key={ref}><code>{ref}</code></li>)}</ul>
        )}
      </div>
    </>
  );
}

export function EvidenceLab(props: EvidenceLabProps): React.JSX.Element {
  const [tab, setTab] = useState<EvidenceTab>("Evidence");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const redactedDiffs = props.artifacts.filter((artifact) =>
    artifact.kind === "diff" && artifact.redacted === true
  );

  function chooseTab(nextIndex: number): void {
    const nextTab = TABS[nextIndex];
    if (nextTab === undefined) return;
    setTab(nextTab);
    tabRefs.current[nextIndex]?.focus();
  }

  function handleTabKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentIndex: number
  ): void {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % TABS.length;
    if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
    }
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    chooseTab(nextIndex);
  }

  return (
    <aside aria-labelledby="evidence-lab-title" className="evidence-lab">
      <header>
        <div>
          <h2 id="evidence-lab-title">Evidence Lab</h2>
          <p>Observable, bounded, Replay-safe fields</p>
        </div>
      </header>
      <div aria-label="Evidence views" className="evidence-tabs" role="tablist">
        {TABS.map((candidate, index) => (
          <button
            aria-controls={`evidence-panel-${candidate.toLowerCase()}`}
            aria-selected={tab === candidate}
            id={`evidence-tab-${candidate.toLowerCase()}`}
            key={candidate}
            onClick={() => setTab(candidate)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            role="tab"
            tabIndex={tab === candidate ? 0 : -1}
            type="button"
          >
            {candidate}
          </button>
        ))}
      </div>
      <div
        aria-labelledby="evidence-tab-evidence"
        className="evidence-panel"
        hidden={tab !== "Evidence"}
        id="evidence-panel-evidence"
        role="tabpanel"
      >
        <EvidenceFields event={props.selectedEvent} />
      </div>
      <div
        aria-labelledby="evidence-tab-trace"
        className="evidence-panel"
        hidden={tab !== "Trace"}
        id="evidence-panel-trace"
        role="tabpanel"
      >
          <ol className="trace-list">
            {props.events.length === 0 ? <li>No visible events.</li> : props.events.map((event) => (
              <li key={event.seq}>
                <button onClick={() => props.onSelectSeq(event.seq)} type="button">
                  <span>#{event.seq}</span><strong>{event.kind}</strong>
                </button>
              </li>
            ))}
          </ol>
      </div>
      <div
        aria-labelledby="evidence-tab-diff"
        className="evidence-panel"
        hidden={tab !== "Diff"}
        id="evidence-panel-diff"
        role="tabpanel"
      >
        {redactedDiffs.length === 0 ? <p>No redacted diff artifacts supplied.</p> : (
            <ul className="diff-list">
              {redactedDiffs.map((artifact) => (
                <li key={artifact.ref}>
                  <strong>{bounded(artifact.label)}</strong>
                  <p>{bounded(artifact.summary)}</p>
                  <code>{artifact.ref}</code>
                  <span>REDACTED</span>
                </li>
              ))}
            </ul>
        )}
      </div>
      <div
        aria-labelledby="evidence-tab-diagnosis"
        className="evidence-panel"
        hidden={tab !== "Diagnosis"}
        id="evidence-panel-diagnosis"
        role="tabpanel"
      >
        {props.diagnosis === undefined ? <p>No diagnosis supplied.</p> : (
            <div className="diagnosis-advisory">
              <strong>ADVISORY</strong>
              <dl>
                <div><dt>Observed failure</dt><dd>{bounded(props.diagnosis.observed_failure)}</dd></div>
                <div><dt>Likely Skill gap</dt><dd>{bounded(props.diagnosis.likely_skill_gap)}</dd></div>
                <div><dt>Retry analysis</dt><dd>{bounded(props.diagnosis.retry_analysis)}</dd></div>
              </dl>
              <ul>{props.diagnosis.suggested_changes.map((change) => (
                <li key={change}>{bounded(change)}</li>
              ))}</ul>
            </div>
        )}
      </div>
    </aside>
  );
}
