import type { ReplayManifest } from "../api.js";
import type { Phase, TraceEvent } from "../../../../src/protocol/schema.js";

const PHASES = ["inspect", "patch", "verify", "claim", "judge"] as const;

function eventLabel(event: TraceEvent): string {
  if (event.kind === "file.changed") {
    return event.data.protected === true ? "Protected asset touched" : "File mutation observed";
  }
  if (event.kind === "test.completed") {
    return `Focused test ${event.data.passed === false ? "failed" : "passed"}`;
  }
  if (event.kind === "verifier.completed") {
    const results = Array.isArray(event.data.verifier_results)
      ? event.data.verifier_results.filter((result): result is Record<string, unknown> =>
        typeof result === "object" && result !== null)
      : [];
    return results.some((result) => result.passed === false)
      ? "Verifier failure observed"
      : "Verifier checks completed";
  }
  if (event.kind === "process.started") return "Command started";
  if (event.kind === "process.exited") {
    return event.data.exit_code === 0 ? "Command completed" : "Command exited with failure";
  }
  if (event.kind === "agent.claimed") return "Agent claim recorded";
  if (event.kind === "run.errored") return "Run infrastructure error";
  if (event.kind === "run.finished") return "Run finished";
  return `${event.kind} · SEQ ${event.seq}`;
}

function currentPhase(events: readonly TraceEvent[]): Phase | "preflight" {
  let phase: Phase | "preflight" = "preflight";
  for (const event of events) {
    if (event.kind !== "phase.entered") continue;
    phase = event.phase;
  }
  return phase;
}

export interface ArenaStageProps {
  readonly manifest: ReplayManifest;
  readonly events: readonly TraceEvent[];
  readonly selectedSeq: number | null;
  readonly onSelectSeq: (seq: number) => void;
}

export function ArenaStage(props: ArenaStageProps): React.JSX.Element {
  const phase = currentPhase(props.events);
  const visualEvents = props.events.filter((event) =>
    event.kind !== "phase.entered" && event.kind !== "runner.raw" && event.kind !== "run.started"
  );

  return (
    <section aria-labelledby="arena-stage-title" className="arena-stage">
      <header className="arena-stage-header">
        <div>
          <h1 id="arena-stage-title">Trace Arena</h1>
          <p>Every effect is backed by a persisted event.</p>
        </div>
        <div aria-live="polite" className="phase-readout">
          <span>Current phase</span>
          <strong className="current-phase">{phase.toUpperCase()}</strong>
        </div>
      </header>

      <div className="combatants">
        <article className="combatant skill-combatant">
          <span className="combatant-glyph" aria-hidden="true">S</span>
          <div>
            <h2>Imported Skill</h2>
            <p>Read-only snapshot</p>
          </div>
        </article>
        <div aria-hidden="true" className="versus-line"><span>VS</span></div>
        <article className="combatant boss-combatant">
          <span className="combatant-glyph boss-glyph" aria-hidden="true">D</span>
          <div>
            <h2>{props.manifest.name}</h2>
            <p>{props.manifest.fault_cards.map(({ id }) => id).join(" · ")}</p>
          </div>
        </article>
      </div>

      <ol aria-label="Run phases" className="phase-gates">
        {PHASES.map((candidate, index) => {
          const phaseEvent = props.events.findLast((event) =>
            event.kind === "phase.entered" && event.phase === candidate
          );
          const active = phase === candidate;
          return (
            <li key={candidate}>
              <button
                aria-current={active ? "step" : undefined}
                disabled={phaseEvent === undefined}
                onClick={() => phaseEvent === undefined ? undefined : props.onSelectSeq(phaseEvent.seq)}
                type="button"
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                {candidate[0]!.toUpperCase() + candidate.slice(1)} phase gate
              </button>
            </li>
          );
        })}
      </ol>

      <div aria-label="Visible trace effects" className="event-effects">
        {visualEvents.length === 0 ? (
          <p>Waiting for observable effects…</p>
        ) : visualEvents.map((event) => (
          <button
            aria-label={eventLabel(event)}
            aria-pressed={props.selectedSeq === event.seq}
            className={`event-effect effect-${event.kind.replaceAll(".", "-")}`}
            key={event.seq}
            onClick={() => props.onSelectSeq(event.seq)}
            type="button"
          >
            <span aria-hidden="true">#{event.seq}</span>
            <strong>{eventLabel(event)}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}
