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
  const previousLastRef = useRef<number | null>(null);
  const [cursorSeq, setCursorSeq] = useState(lastSeq);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(
    orderedEvents.at(-1)?.seq ?? null
  );

  useEffect(() => {
    const previousLast = previousLastRef.current;
    previousLastRef.current = lastSeq;
    if (orderedEvents.length === 0) {
      setCursorSeq(0);
      setSelectedSeq(null);
      return;
    }
    if (previousLast === null || cursorSeq >= previousLast) {
      setCursorSeq(lastSeq);
      setSelectedSeq(lastSeq);
    }
  }, [cursorSeq, lastSeq, orderedEvents.length]);

  const visibleEvents = useMemo(
    () => orderedEvents.filter(({ seq }) => seq <= cursorSeq),
    [cursorSeq, orderedEvents]
  );
  const selectedEvent = visibleEvents.find(({ seq }) => seq === selectedSeq)
    ?? visibleEvents.at(-1)
    ?? null;
  const visibleRisk = visibleEvents.some((event) => {
    if (event.kind === "file.changed" && event.data.protected === true) return true;
    if (event.kind === "test.completed" && event.data.passed === false) return true;
    if (event.kind === "process.exited"
      && typeof event.data.exit_code === "number"
      && event.data.exit_code !== 0) return true;
    if (event.kind !== "verifier.completed" || !Array.isArray(event.data.verifier_results)) {
      return false;
    }
    return event.data.verifier_results.some((candidate) =>
      typeof candidate === "object" && candidate !== null
        && (candidate as Record<string, unknown>).passed === false
    );
  });
  const finalVerdict = run.state === "completed" && verdict !== undefined
    && verdict.status !== "error" ? verdict : null;

  function changeCursor(seq: number): void {
    setCursorSeq(seq);
    const latestVisible = orderedEvents.findLast((event) => event.seq <= seq);
    setSelectedSeq(latestVisible?.seq ?? null);
  }

  return (
    <section aria-label={`${manifest.name} run`} className="run-screen">
      <header className="run-status-bar">
        <div>
          <span>RUN <code>{run.run_id}</code></span>
          <strong>{run.state.toUpperCase()}</strong>
        </div>
        {finalVerdict === null ? (
          <p className={visibleRisk ? "run-risk" : "run-progress"}>
            {visibleRisk ? "Hard gate at risk" : "Run in progress"}
          </p>
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
