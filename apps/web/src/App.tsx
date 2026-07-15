import { useEffect, useLayoutEffect, useState } from "react";

import { ArenaApi, type ArenaReport, type ReplayManifest } from "./api.js";
import { ImportLobby } from "./components/ImportLobby.js";
import { RunScreen } from "./components/RunScreen.js";
import { useRunStream } from "./hooks/useRunStream.js";
import type { RunEnvelope, TraceEvent } from "../../../src/protocol/schema.js";

type Screen = "import" | "run" | "compare";

const screenContent: Record<Screen, { readonly title: string; readonly detail: string }> = {
  import: {
    title: "Import a Skill",
    detail: "Inspect a Skill before starting a private loopback run."
  },
  run: {
    title: "Run Monitor",
    detail: "Run events will appear here after a replay starts."
  },
  compare: {
    title: "Compare Verdicts",
    detail: "Baseline and repaired verdicts will appear here when available."
  }
};

interface InitialSessionToken {
  readonly present: boolean;
  readonly value: string | null;
}

interface ActiveRunContext {
  readonly run: RunEnvelope;
  readonly manifest: ReplayManifest;
}

function readSessionToken(): InitialSessionToken {
  const raw = new URLSearchParams(window.location.search).get("token");
  return { present: raw !== null, value: raw === null || raw.length === 0 ? null : raw };
}

function terminalEvent(events: readonly TraceEvent[]): TraceEvent | undefined {
  return events.findLast(({ kind }) => kind === "run.finished" || kind === "run.errored");
}

function sameLockedRun(left: RunEnvelope, right: RunEnvelope): boolean {
  return left.run_id === right.run_id
    && left.run_group_id === right.run_group_id
    && left.trial_index === right.trial_index
    && left.parent_run_id === right.parent_run_id
    && left.manifest_hash === right.manifest_hash
    && left.snapshot_hash === right.snapshot_hash
    && left.fixture_hash === right.fixture_hash
    && left.runner.adapter === right.runner.adapter
    && left.runner.model === right.runner.model;
}

function assertRunContext(
  context: ActiveRunContext,
  run: RunEnvelope,
  report?: ArenaReport
): void {
  if (!sameLockedRun(context.run, run)) throw new Error("Run context drifted");
  if (report === undefined) return;
  if (report.manifest_id !== context.manifest.id
    || report.snapshot.source_hash !== context.run.snapshot_hash
    || report.verdict.run_id !== context.run.run_id
    || report.trace.some((event) => event.run_id !== context.run.run_id)
    || (report.diagnosis !== undefined && report.diagnosis.run_id !== context.run.run_id)
    || (report.repair !== undefined && report.repair.run_id !== context.run.run_id)) {
    throw new Error("Run report context drifted");
  }
}

function reportEvents(report: ArenaReport | null): TraceEvent[] {
  if (report === null) return [];
  return report.trace.map((event) => ({ ...event, data: {} }));
}

function RunSession(props: {
  readonly api: ArenaApi;
  readonly context: ActiveRunContext;
}): React.JSX.Element {
  const stream = useRunStream(props.context.run.run_id, props.api);
  const [run, setRun] = useState(props.context.run);
  const [report, setReport] = useState<ArenaReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const terminalSeq = terminalEvent(stream.events)?.seq ?? null;

  useEffect(() => {
    let cancelled = false;
    const runId = props.context.run.run_id;
    setRun(props.context.run);
    setReport(null);
    setLoadError(null);
    void (async () => {
      try {
        const currentRun = await props.api.getRun(runId);
        if (cancelled) return;
        assertRunContext(props.context, currentRun);
        setRun(currentRun);
        const shouldLoadReport = terminalSeq !== null
          || currentRun.state === "completed"
          || currentRun.state === "errored";
        if (!shouldLoadReport) return;
        const currentReport = await props.api.report(runId);
        if (cancelled) return;
        assertRunContext(props.context, currentReport.run, currentReport);
        setRun(currentReport.run);
        setReport(currentReport);
      } catch {
        if (!cancelled) setLoadError("Unable to refresh this run safely.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.api, props.context, terminalSeq]);

  const events = stream.events.length === 0 ? reportEvents(report) : stream.events;
  return (
    <section aria-labelledby="run-monitor-title" className="run-session">
      <h1 className="visually-hidden" id="run-monitor-title">Run Monitor</h1>
      <div aria-live="polite" className="stream-state">
        <span>Stream {stream.connection}</span>
        {stream.lastError === null ? null : <span>{stream.lastError}</span>}
        {loadError === null ? null : <span role="alert">{loadError}</span>}
      </div>
      <RunScreen
        {...(report?.diagnosis === undefined ? {} : { diagnosis: report.diagnosis })}
        events={events}
        manifest={props.context.manifest}
        run={run}
        {...(report === null ? {} : { verdict: report.verdict })}
      />
    </section>
  );
}

export function App(): React.JSX.Element {
  const [sessionToken] = useState(readSessionToken);
  const [api] = useState(() => sessionToken.value === null
    ? null
    : new ArenaApi(sessionToken.value));
  const [screen, setScreen] = useState<Screen>("import");
  const [runId, setRunId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<ActiveRunContext | null>(null);

  useLayoutEffect(() => {
    if (!sessionToken.present) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("token")) return;
    url.searchParams.delete("token");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`
    );
  }, [sessionToken]);

  if (api === null) {
    return (
      <main className="launch-gate">
        <p role="alert">Open Arena from the local startup URL</p>
      </main>
    );
  }

  function handleRunStarted(nextRunId: string): void {
    setRunId(nextRunId);
    setScreen("run");
  }

  return (
    <main className="app-shell">
      <header className="app-bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">S</span>
          <strong>Skill Crash Test Arcade</strong>
        </div>
        <nav aria-label="Arena screens" className="screen-nav">
          {(["import", "run", "compare"] as const).map((value) => (
            <button
              aria-pressed={screen === value}
              className="nav-button"
              key={value}
              onClick={() => setScreen(value)}
              type="button"
            >
              {value[0]!.toUpperCase() + value.slice(1)}
            </button>
          ))}
        </nav>
      </header>
      <div className={screen === "import" || (screen === "run" && activeRun !== null)
        ? "shell-content shell-content-wide"
        : "shell-content"}>
        {screen === "import" ? (
          <ImportLobby
            api={api}
            onRunContext={setActiveRun}
            onRunStarted={handleRunStarted}
          />
        ) : screen === "run" && activeRun !== null ? (
          <RunSession api={api} context={activeRun} />
        ) : (
          <section aria-labelledby="screen-title" aria-live="polite" className="panel placeholder-panel">
            <span className="section-index" aria-hidden="true">0{screen === "run" ? 2 : 3}</span>
            <div>
              <h1 id="screen-title">{screenContent[screen].title}</h1>
              <p>{screenContent[screen].detail}</p>
              {screen === "run" && runId !== null ? <code className="run-id">{runId}</code> : null}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
