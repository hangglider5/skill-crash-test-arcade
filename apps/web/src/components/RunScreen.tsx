import { useEffect, useMemo, useRef, useState } from "react";

import type { ReplayManifest, SanitizedVerdict } from "../api.js";
import type {
  Diagnosis,
  RunEnvelope,
  TraceEvent,
  VerdictBundle
} from "../../../../src/protocol/schema.js";

import { ArenaStage } from "./ArenaStage.js";
import { EvidenceLab, type ArtifactSummary } from "./EvidenceLab.js";
import { ReplayTimeline } from "./ReplayTimeline.js";

const EMPTY_ARTIFACTS: readonly ArtifactSummary[] = [];

function failedVerifier(event: TraceEvent, hardGate: boolean): boolean {
  if (event.kind !== "verifier.completed" || !Array.isArray(event.data.verifier_results)) {
    return false;
  }
  return event.data.verifier_results.some((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const result = candidate as Record<string, unknown>;
    return result.passed === false && result.hard_gate === hardGate;
  });
}

function hasHardGateRisk(events: readonly TraceEvent[]): boolean {
  return events.some((event) =>
    (event.kind === "file.changed" && event.data.protected === true)
    || failedVerifier(event, true)
  );
}

function hasGenericRisk(events: readonly TraceEvent[]): boolean {
  return events.some((event) =>
    (event.kind === "test.completed" && event.data.passed === false)
    || (event.kind === "process.exited"
      && typeof event.data.exit_code === "number"
      && event.data.exit_code !== 0)
    || failedVerifier(event, false)
  );
}

export interface RunScreenProps {
  readonly run: RunEnvelope;
  readonly manifest: ReplayManifest;
  readonly events: readonly TraceEvent[];
  readonly artifacts?: readonly ArtifactSummary[];
  readonly verdict?: VerdictBundle | SanitizedVerdict;
  readonly diagnosis?: Diagnosis;
}

export function RunScreen({
  run,
  manifest,
  events,
  artifacts = EMPTY_ARTIFACTS,
  verdict,
  diagnosis
}: RunScreenProps): React.JSX.Element {
  const orderedEvents = useMemo(() => {
    const unique = new Map<number, TraceEvent>();
    for (const event of events) {
      if (event.run_id === run.run_id && !unique.has(event.seq)) unique.set(event.seq, event);
    }
    return [...unique.values()].toSorted((left, right) => left.seq - right.seq);
  }, [events, run.run_id]);
  const lastSeq = orderedEvents.at(-1)?.seq ?? 0;
  const previousTraceRef = useRef({ runId: run.run_id, lastSeq, length: orderedEvents.length });
  const [cursorSeq, setCursorSeq] = useState(lastSeq);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(
    orderedEvents.at(-1)?.seq ?? null
  );

  useEffect(() => {
    const previous = previousTraceRef.current;
    const runChanged = previous.runId !== run.run_id;
    const contracted = !runChanged
      && (lastSeq < previous.lastSeq || orderedEvents.length < previous.length);
    previousTraceRef.current = { runId: run.run_id, lastSeq, length: orderedEvents.length };
    if (orderedEvents.length === 0) {
      setCursorSeq(0);
      setSelectedSeq(null);
      return;
    }
    const firstSeq = orderedEvents[0]!.seq;
    if (runChanged || contracted || cursorSeq < firstSeq || cursorSeq > lastSeq) {
      setCursorSeq(lastSeq);
      setSelectedSeq(lastSeq);
      return;
    }
    if (cursorSeq >= previous.lastSeq && lastSeq > previous.lastSeq) {
      setCursorSeq(lastSeq);
      setSelectedSeq(lastSeq);
    }
  }, [cursorSeq, lastSeq, orderedEvents, run.run_id]);

  const visibleEvents = useMemo(
    () => orderedEvents.filter(({ seq }) => seq <= cursorSeq),
    [cursorSeq, orderedEvents]
  );
  const selectedEvent = visibleEvents.find(({ seq }) => seq === selectedSeq)
    ?? visibleEvents.at(-1)
    ?? null;
  const hardGateRisk = hasHardGateRisk(visibleEvents);
  const genericRisk = hasGenericRisk(visibleEvents);
  const finalVerdict = run.state === "completed" && verdict !== undefined
    && verdict.status !== "error" ? verdict : null;
  const arenaOutcome = finalVerdict === null
    ? run.state === "errored" ? { status: "error" as const } : undefined
    : { status: finalVerdict.status, score: finalVerdict.score };
  let pendingLabel = "Run in progress";
  let pendingClass = "run-progress";
  if (run.state === "errored") {
    pendingLabel = "Run errored";
    pendingClass = "run-risk";
  } else if (run.state === "cancelled") {
    pendingLabel = "Run cancelled";
    pendingClass = "run-risk";
  } else if (run.state === "completed" && verdict?.status === "error") {
    pendingLabel = "Locked verdict unavailable";
    pendingClass = "run-risk";
  } else if (run.state === "completed") {
    pendingLabel = "Locked verdict loading or unavailable";
    pendingClass = "run-progress";
  } else if (hardGateRisk) {
    pendingLabel = "Hard gate at risk";
    pendingClass = "run-risk";
  } else if (genericRisk) {
    pendingLabel = "Run at risk";
    pendingClass = "run-risk";
  }

  function changeCursor(seq: number): void {
    setCursorSeq(seq);
    const latestVisible = orderedEvents.findLast((event) => event.seq <= seq);
    setSelectedSeq(latestVisible?.seq ?? null);
  }

  return (
    <section aria-label={`${manifest.name} run`} className="run-screen">
      <header className={`run-status-bar ${finalVerdict === null ? "" : `run-status-${finalVerdict.status}`}`}>
        <div>
          <span>RUN <code>{run.run_id}</code></span>
          <strong>{run.state.toUpperCase()}</strong>
        </div>
        {finalVerdict === null ? (
          <p className={pendingClass}>{pendingLabel}</p>
        ) : (
          <div className={`locked-live-verdict verdict-${finalVerdict.status}`}>
            <strong>{finalVerdict.status.toUpperCase()}</strong>
            <span>{finalVerdict.score}/100</span>
          </div>
        )}
      </header>
      {orderedEvents.length === 0 ? (
        <p className="run-waiting">Waiting for the first persisted event…</p>
      ) : null}
      <div className="arena-evidence-grid">
        <ArenaStage
          events={visibleEvents}
          manifest={manifest}
          onSelectSeq={setSelectedSeq}
          {...(arenaOutcome === undefined ? {} : { outcome: arenaOutcome })}
          selectedSeq={selectedEvent?.seq ?? null}
        />
        <EvidenceLab
          artifacts={artifacts}
          {...(diagnosis === undefined ? {} : { diagnosis })}
          events={visibleEvents}
          onSelectSeq={setSelectedSeq}
          selectedEvent={selectedEvent}
        />
      </div>
      <ReplayTimeline
        cursorSeq={cursorSeq}
        events={orderedEvents}
        onCursorChange={changeCursor}
      />
    </section>
  );
}
