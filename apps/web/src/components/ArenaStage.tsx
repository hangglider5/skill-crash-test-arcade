import type { ReplayManifest } from "../api.js";
import type { Phase, TraceEvent } from "../../../../src/protocol/schema.js";

const PHASES = ["inspect", "patch", "verify", "claim", "judge"] as const;

type ArenaTone = "idle" | "active" | "risk" | "victory" | "defeat";

export interface ArenaOutcome {
  readonly status: "victory" | "defeat" | "error";
  readonly score?: number;
}

function eventLabel(event: TraceEvent): string {
  if (event.kind === "file.changed") {
    return event.data.protected === true ? "Protected asset touched" : "File mutation observed";
  }
  if (event.kind === "test.completed") {
    if (event.data.passed === true) return "Focused test passed";
    if (event.data.passed === false) return "Focused test failed";
    return "Focused test result unknown";
  }
  if (event.kind === "verifier.completed") {
    const results = Array.isArray(event.data.verifier_results)
      ? event.data.verifier_results.filter((result): result is Record<string, unknown> =>
        typeof result === "object" && result !== null)
      : [];
    if (results.some((result) => result.passed === false)) return "Verifier failure observed";
    if (results.length > 0 && results.every((result) => result.passed === true)) {
      return "Verifier checks passed";
    }
    return "Verifier result unknown";
  }
  if (event.kind === "process.started") return "Command started";
  if (event.kind === "process.exited") {
    if (event.data.exit_code === 0) return "Command completed";
    if (typeof event.data.exit_code === "number") return "Command exited with failure";
    return "Command exit status unknown";
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

function effectTone(event: TraceEvent): "skill" | "fault" | "proof" | "neutral" {
  if (event.kind === "file.changed" && event.data.protected === true) return "fault";
  if (event.kind === "run.errored") return "fault";
  if (event.kind === "test.completed") {
    if (event.data.passed === true) return "proof";
    if (event.data.passed === false) return "fault";
  }
  if (event.kind === "verifier.completed" && Array.isArray(event.data.verifier_results)) {
    const results = event.data.verifier_results.filter((result): result is Record<string, unknown> =>
      typeof result === "object" && result !== null
    );
    if (results.some((result) => result.passed === false)) return "fault";
    if (results.length > 0 && results.every((result) => result.passed === true)) return "proof";
  }
  if (event.kind === "process.started" || event.kind === "file.changed") return "skill";
  return "neutral";
}

function effectGlyph(event: TraceEvent): string {
  if (event.kind === "file.changed") return event.data.protected === true ? "!" : "+";
  if (event.kind === "test.completed") return event.data.passed === true ? "✓" : "×";
  if (event.kind === "verifier.completed") return "◇";
  if (event.kind === "agent.claimed") return "◆";
  if (event.kind === "process.started" || event.kind === "process.exited") return ">_";
  if (event.kind === "run.finished") return "◎";
  if (event.kind === "run.errored") return "×";
  return "·";
}

function arenaTone(events: readonly TraceEvent[], outcome: ArenaOutcome | undefined): ArenaTone {
  if (outcome?.status === "victory") return "victory";
  if (outcome?.status === "defeat" || outcome?.status === "error") return "defeat";
  if (events.some((event) => effectTone(event) === "fault")) return "risk";
  return events.length === 0 ? "idle" : "active";
}

function announcerCopy(tone: ArenaTone, phase: Phase | "preflight"): string {
  if (tone === "victory") return "VERIFIED VICTORY";
  if (tone === "defeat") return "HARD GATE DEFEAT";
  if (tone === "risk") return "FAULT SIGNAL DETECTED";
  if (phase === "preflight") return "AWAITING FIRST SIGNAL";
  return `${phase.toUpperCase()} PHASE LIVE`;
}

export interface ArenaStageProps {
  readonly manifest: ReplayManifest;
  readonly events: readonly TraceEvent[];
  readonly selectedSeq: number | null;
  readonly onSelectSeq: (seq: number) => void;
  readonly outcome?: ArenaOutcome;
}

export function ArenaStage(props: ArenaStageProps): React.JSX.Element {
  const phase = currentPhase(props.events);
  const visualEvents = props.events.filter((event) =>
    event.kind !== "phase.entered" && event.kind !== "runner.raw" && event.kind !== "run.started"
  );
  const shownEvents = visualEvents.slice(-10);
  const tone = arenaTone(props.events, props.outcome);
  const completedPhaseIndex = PHASES.indexOf(phase as typeof PHASES[number]);
  const latestEffect = visualEvents.at(-1);

  return (
    <section
      aria-labelledby="arena-stage-title"
      className={`arena-stage arena-tone-${tone}`}
      data-phase={phase}
    >
      <header className="arena-stage-header">
        <div>
          <h1 id="arena-stage-title">Trace Arena</h1>
          <p>Persisted events drive every visible effect.</p>
        </div>
        <div aria-live="polite" className="phase-readout">
          <span>Gate signal</span>
          <strong className="current-phase">{phase.toUpperCase()}</strong>
        </div>
      </header>

      <div className="arena-playfield">
        <div aria-hidden="true" className="arena-horizon" />
        <article className="combatant skill-combatant">
          <div aria-hidden="true" className="combatant-figure skill-cartridge">
            <span className="cartridge-notch" />
            <span className="cartridge-code">&lt;/&gt;</span>
            <span className="combatant-platform" />
          </div>
          <div className="combatant-copy">
            <span>PLAYER 01 · SKILL</span>
            <h2>Imported Skill</h2>
            <p>Read-only snapshot</p>
          </div>
        </article>

        <div aria-hidden="true" className="arena-crossfire">
          <span className="energy-beam" />
          <span className="energy-orb skill-orb" />
          <span className="energy-orb fault-orb" />
          <span className="arena-reticle"><i /></span>
        </div>

        <article className="combatant boss-combatant">
          <div aria-hidden="true" className="combatant-figure dirty-tree-boss">
            <span className="tree-branch branch-left" />
            <span className="tree-branch branch-right" />
            <span className="tree-node node-one" />
            <span className="tree-node node-two" />
            <span className="tree-node node-three" />
            <span className="boss-core"><i /><i /></span>
            <span className="combatant-platform" />
          </div>
          <div className="combatant-copy">
            <span>FAULT BOSS · {props.manifest.fault_cards.length.toString().padStart(2, "0")}</span>
            <h2>{props.manifest.name}</h2>
            <p>{props.manifest.fault_cards.map(({ id }) => id).join(" · ")}</p>
          </div>
        </article>

        <div aria-live="polite" className="arena-announcer">
          <span>{props.outcome?.score === undefined ? "LIVE" : `${props.outcome.score} PTS`}</span>
          <strong>{announcerCopy(tone, phase)}</strong>
        </div>
      </div>

      <ol aria-label="Run phases" className="phase-gates">
        {PHASES.map((candidate, index) => {
          const phaseEvent = props.events.findLast((event) =>
            event.kind === "phase.entered" && event.phase === candidate
          );
          const active = phase === candidate;
          const cleared = phaseEvent !== undefined && completedPhaseIndex > index;
          return (
            <li className={cleared ? "phase-cleared" : undefined} key={candidate}>
              <button
                aria-current={active ? "step" : undefined}
                disabled={phaseEvent === undefined}
                onClick={() => phaseEvent === undefined ? undefined : props.onSelectSeq(phaseEvent.seq)}
                type="button"
              >
                <span className="gate-index">{cleared ? "✓" : String(index + 1).padStart(2, "0")}</span>
                <span className="gate-label">{candidate[0]!.toUpperCase() + candidate.slice(1)}</span>
                <span aria-hidden="true" className="gate-signal" />
              </button>
            </li>
          );
        })}
      </ol>

      <div className="event-feed-heading">
        <span>LIVE EFFECT FEED</span>
        <strong>{visualEvents.length.toString().padStart(2, "0")} SIGNALS</strong>
      </div>
      <div aria-label="Visible trace effects" className="event-effects">
        {shownEvents.length === 0 ? (
          <p>Waiting for observable effects…</p>
        ) : shownEvents.map((event) => (
          <button
            aria-label={eventLabel(event)}
            aria-pressed={props.selectedSeq === event.seq}
            className={`event-effect effect-${event.kind.replaceAll(".", "-")} effect-tone-${effectTone(event)} ${latestEffect?.seq === event.seq ? "is-latest" : ""}`}
            key={event.seq}
            onClick={() => props.onSelectSeq(event.seq)}
            type="button"
          >
            <span aria-hidden="true" className="effect-glyph">{effectGlyph(event)}</span>
            <span className="effect-seq">#{event.seq}</span>
            <strong>{eventLabel(event)}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}
