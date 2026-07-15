import { useEffect, useMemo, useRef, useState } from "react";

import type { TraceEvent } from "../../../../src/protocol/schema.js";

const SPEEDS = [0.5, 1, 2] as const;

function isFailure(event: TraceEvent): boolean {
  if (event.kind === "run.errored") return true;
  if (event.kind === "file.changed" && event.data.protected === true) return true;
  if (event.kind === "process.exited"
    && typeof event.data.exit_code === "number"
    && event.data.exit_code !== 0) return true;
  if (event.kind === "test.completed" && event.data.passed === false) return true;
  if (event.kind !== "verifier.completed" || !Array.isArray(event.data.verifier_results)) {
    return false;
  }
  return event.data.verifier_results.some((candidate) =>
    typeof candidate === "object" && candidate !== null
      && (candidate as Record<string, unknown>).passed === false
  );
}

export interface ReplayTimelineProps {
  readonly events: readonly TraceEvent[];
  readonly cursorSeq: number;
  readonly onCursorChange: (seq: number) => void;
}

export function ReplayTimeline(props: ReplayTimelineProps): React.JSX.Element {
  const sequences = useMemo(
    () => props.events.map(({ seq }) => seq).toSorted((left, right) => left - right),
    [props.events]
  );
  const phaseSequences = useMemo(
    () => props.events.filter(({ kind }) => kind === "phase.entered").map(({ seq }) => seq)
      .toSorted((left, right) => left - right),
    [props.events]
  );
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const first = sequences[0] ?? 0;
  const last = sequences.at(-1) ?? 0;
  const atLast = sequences.length < 2 || props.cursorSeq >= last;
  const cursorRef = useRef(props.cursorSeq);
  const onCursorChangeRef = useRef(props.onCursorChange);
  cursorRef.current = props.cursorSeq;
  onCursorChangeRef.current = props.onCursorChange;

  useEffect(() => {
    if (!playing) return;
    if (atLast) {
      setPlaying(false);
      return;
    }
    const timer = window.setInterval(() => {
      const next = sequences.find((seq) => seq > cursorRef.current);
      if (next === undefined) {
        setPlaying(false);
        return;
      }
      cursorRef.current = next;
      onCursorChangeRef.current(next);
      if (next === last) setPlaying(false);
    }, 1_000 / speed);
    return () => window.clearInterval(timer);
  }, [atLast, last, playing, sequences, speed]);

  function jumpToPreviousPhase(): void {
    const previous = phaseSequences.findLast((seq) => seq < props.cursorSeq);
    props.onCursorChange(previous ?? first);
    setPlaying(false);
  }

  function jumpToNextPhase(): void {
    const next = phaseSequences.find((seq) => seq > props.cursorSeq);
    if (next !== undefined) props.onCursorChange(next);
    setPlaying(false);
  }

  function jumpToFailure(): void {
    const failure = props.events.find(isFailure);
    if (failure !== undefined) props.onCursorChange(failure.seq);
    setPlaying(false);
  }

  return (
    <section aria-labelledby="replay-title" className="replay-timeline">
      <header>
        <div>
          <h2 id="replay-title">Replay Timeline</h2>
          <p>Ordered by persisted sequence, never wall-clock time.</p>
        </div>
        <output aria-live="polite">
          Replay position <span aria-hidden="true">{sequences.length === 0 ? "—" : props.cursorSeq}</span>
        </output>
      </header>
      <div className="replay-controls">
        <button
          aria-label={playing ? "Pause replay" : "Play replay"}
          disabled={sequences.length < 2 || (!playing && atLast)}
          onClick={() => setPlaying((current) => !current)}
          type="button"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button aria-label="Previous phase" disabled={sequences.length === 0} onClick={jumpToPreviousPhase} type="button">← Phase</button>
        <button aria-label="Next phase" disabled={sequences.length === 0} onClick={jumpToNextPhase} type="button">Phase →</button>
        <button
          aria-label="First failure"
          disabled={!props.events.some(isFailure)}
          onClick={jumpToFailure}
          type="button"
        >
          First failure
        </button>
        <div aria-label="Playback speed" className="speed-controls" role="group">
          {SPEEDS.map((candidate) => (
            <button
              aria-label={`Playback speed ${candidate}x`}
              aria-pressed={speed === candidate}
              key={candidate}
              onClick={() => setSpeed(candidate)}
              type="button"
            >
              {candidate}x
            </button>
          ))}
        </div>
      </div>
      <label className="replay-range">
        <span>Replay sequence</span>
        <input
          aria-label="Replay sequence"
          disabled={sequences.length === 0}
          max={last}
          min={first}
          onChange={(event) => {
            setPlaying(false);
            props.onCursorChange(Number(event.currentTarget.value));
          }}
          step="1"
          type="range"
          value={props.cursorSeq}
        />
      </label>
    </section>
  );
}
