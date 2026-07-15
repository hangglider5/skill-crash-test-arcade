import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  ArenaApi,
  type ArenaReport,
  type CandidatePatch,
  type ReplayManifest
} from "./api.js";
import { ImportLobby } from "./components/ImportLobby.js";
import { RunScreen } from "./components/RunScreen.js";
import {
  VerdictCompare,
  type CandidateRepairView,
  type LockedResultView
} from "./components/VerdictCompare.js";
import { useRunStream } from "./hooks/useRunStream.js";
import type {
  EvidenceRef,
  RunEnvelope,
  TraceEvent
} from "../../../src/protocol/schema.js";

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

export interface ActiveRunContext {
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

function mergeEvents(
  runId: string,
  report: ArenaReport | null,
  streamEvents: readonly TraceEvent[]
): TraceEvent[] {
  const merged = new Map<number, TraceEvent>();
  for (const event of reportEvents(report)) {
    if (event.run_id === runId) merged.set(event.seq, event);
  }
  for (const event of streamEvents) {
    if (event.run_id === runId) merged.set(event.seq, event);
  }
  return [...merged.values()].toSorted((left, right) => left.seq - right.seq);
}

export function RunSession(props: {
  readonly api: ArenaApi;
  readonly context: ActiveRunContext;
  readonly onReport?: (report: ArenaReport) => void;
}): React.JSX.Element {
  const stream = useRunStream(props.context.run.run_id, props.api);
  const [run, setRun] = useState(props.context.run);
  const [report, setReport] = useState<ArenaReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const terminalSeq = terminalEvent(stream.events)?.seq ?? null;

  useEffect(() => {
    let cancelled = false;
    const runId = props.context.run.run_id;
    void (async () => {
      try {
        const currentRun = await props.api.getRun(runId);
        if (cancelled) return;
        assertRunContext(props.context, currentRun);
        setLoadError(null);
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
        props.onReport?.(currentReport);
      } catch {
        if (!cancelled) setLoadError("Unable to refresh this run safely.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.api, props.context, terminalSeq]);

  const events = mergeEvents(props.context.run.run_id, report, stream.events);
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
        artifacts={report?.artifacts ?? []}
        events={events}
        manifest={props.context.manifest}
        run={run}
        {...(report === null ? {} : { verdict: report.verdict })}
      />
    </section>
  );
}

function reportResult(report: ArenaReport): LockedResultView {
  return {
    run: report.run,
    verdict: report.verdict,
    redaction_complete: report.redaction_complete,
    failed_verifier_evidence: report.verdict.verifier_results
      .filter(({ passed }) => !passed)
      .slice(0, 8)
      .map((verifier) => ({
        label: verifier.message.slice(0, 240),
        evidence_refs: verifier.evidence
      }))
  };
}

function repairedComparisonIsLocked(baseline: ArenaReport, child: RunEnvelope): boolean {
  return child.parent_run_id === baseline.run.run_id
    && child.run_group_id === baseline.run.run_group_id
    && child.manifest_hash === baseline.run.manifest_hash
    && child.fixture_hash === baseline.run.fixture_hash
    && child.snapshot_hash !== baseline.run.snapshot_hash
    && child.runner.adapter === baseline.run.runner.adapter
    && child.runner.model === baseline.run.runner.model;
}

export function approvedChildReportMatches(
  baseline: ArenaReport,
  child: ArenaReport
): boolean {
  const repair = baseline.repair;
  return repair?.status === "approved"
    && repair.run_id === baseline.run.run_id
    && repair.snapshot_hash === baseline.run.snapshot_hash
    && repair.reviewed_patch_ref === repair.patch_ref
    && repair.child_run_id === child.run.run_id
    && repair.new_snapshot_hash === child.run.snapshot_hash
    && repairedComparisonIsLocked(baseline, child.run);
}

export function VerdictSession(props: {
  readonly api: ArenaApi;
  readonly initialBaseline: ArenaReport;
  readonly child?: ArenaReport;
  readonly onBaselineUpdated?: (report: ArenaReport) => void;
  readonly onChildRunStarted: (run: RunEnvelope) => void;
}): React.JSX.Element {
  const [baseline, setBaseline] = useState(props.initialBaseline);
  const [candidatePatch, setCandidatePatch] = useState<CandidatePatch | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceRef | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    generationRef.current += 1;
    setBaseline(props.initialBaseline);
    setCandidatePatch(null);
    setSelectedEvidence(null);
    return () => {
      mountedRef.current = false;
    };
  }, [props.initialBaseline.run.run_id]);

  const generationIsCurrent = (generation: number, runId: string): boolean => (
    mountedRef.current
    && generationRef.current === generation
    && baseline.run.run_id === runId
  );
  const updateBaseline = (next: ArenaReport): void => {
    setBaseline(next);
    props.onBaselineUpdated?.(next);
  };
  const refreshBaseline = async (generation: number, runId: string): Promise<ArenaReport> => {
    const next = await props.api.report(runId);
    if (next.run.run_id !== runId || next.verdict.run_id !== runId) {
      throw new Error("Verdict report membership drifted");
    }
    if (generationIsCurrent(generation, runId)) updateBaseline(next);
    return next;
  };

  const diagnose = async (): Promise<void> => {
    const runId = baseline.run.run_id;
    const generation = generationRef.current;
    const diagnosis = await props.api.diagnose(runId);
    if (diagnosis.run_id !== runId) throw new Error("Diagnosis membership drifted");
    await refreshBaseline(generation, runId);
  };
  const createRepair = async (): Promise<void> => {
    const runId = baseline.run.run_id;
    const generation = generationRef.current;
    const proposal = await props.api.createRepair(runId);
    if (proposal.run_id !== runId || proposal.snapshot_hash !== baseline.run.snapshot_hash) {
      throw new Error("Repair membership drifted");
    }
    const [patch, next] = await Promise.all([
      props.api.candidatePatch(proposal.repair_id),
      props.api.report(runId)
    ]);
    if (patch.repair_id !== proposal.repair_id
      || patch.patch_ref !== proposal.patch_ref
      || next.run.run_id !== runId
      || next.repair?.repair_id !== proposal.repair_id) {
      throw new Error("Repair review membership drifted");
    }
    if (generationIsCurrent(generation, runId)) {
      setCandidatePatch(patch);
      updateBaseline(next);
    }
  };
  const approveRerun = async (): Promise<void> => {
    const repair = baseline.repair;
    if (repair === undefined || repair.status !== "pending"
      || candidatePatch?.repair_id !== repair.repair_id) {
      throw new Error("A reviewed pending repair is required");
    }
    const runId = baseline.run.run_id;
    const generation = generationRef.current;
    const child = await props.api.rerun(repair.repair_id);
    if (!repairedComparisonIsLocked(baseline, child)) {
      throw new Error("Repaired child lineage drifted");
    }
    const next = await props.api.report(runId);
    const approved = next.repair;
    if (approved?.status !== "approved"
      || approved.repair_id !== repair.repair_id
      || approved.patch_ref !== repair.patch_ref
      || approved.reviewed_patch_ref !== candidatePatch.patch_ref
      || approved.child_run_id !== child.run_id
      || approved.new_snapshot_hash !== child.snapshot_hash) {
      throw new Error("Approved repair proof drifted");
    }
    if (generationIsCurrent(generation, runId)) {
      updateBaseline(next);
      props.onChildRunStarted(child);
    }
  };
  const rejectRepair = async (): Promise<void> => {
    const repair = baseline.repair;
    if (repair?.status !== "pending") throw new Error("A pending repair is required");
    const runId = baseline.run.run_id;
    const generation = generationRef.current;
    const rejected = await props.api.rejectRepair(repair.repair_id);
    if (rejected.status !== "rejected" || rejected.repair_id !== repair.repair_id
      || rejected.run_id !== runId || rejected.patch_ref !== repair.patch_ref) {
      throw new Error("Rejected repair proof drifted");
    }
    const next = await refreshBaseline(generation, runId);
    if (next.repair?.status !== "rejected"
      || next.repair.repair_id !== repair.repair_id) {
      throw new Error("Rejected repair was not persisted");
    }
    if (generationIsCurrent(generation, runId)) setCandidatePatch(null);
  };
  const exportReport = async (): Promise<void> => {
    if (baseline.redaction_complete !== true || props.child === undefined
      || !approvedChildReportMatches(baseline, props.child)) {
      throw new Error("Report export is blocked");
    }
    const blob = new Blob([JSON.stringify(baseline, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `arena-report-${baseline.run.run_id.replace(/[^A-Za-z0-9_-]/gu, "_")}.json`;
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const visibleRepair = baseline.repair === undefined
    || baseline.repair.status === "rejected"
    || baseline.repair.status === "failed"
    ? undefined
    : {
      proposal: baseline.repair,
      ...(candidatePatch?.repair_id === baseline.repair.repair_id
        ? { patch: candidatePatch }
        : {})
    } satisfies CandidateRepairView;
  return (
    <div className="verdict-session">
      <VerdictCompare
        baseline={reportResult(baseline)}
        {...(props.child === undefined ? {} : { child: reportResult(props.child) })}
        {...(baseline.diagnosis === undefined ? {} : { diagnosis: baseline.diagnosis })}
        {...(visibleRepair === undefined ? {} : { repair: visibleRepair })}
        onApproveRerun={approveRerun}
        onCreateRepair={createRepair}
        onDiagnose={diagnose}
        onEvidenceSelect={setSelectedEvidence}
        onExportReport={exportReport}
        onReject={rejectRepair}
      />
      {selectedEvidence === null ? null : (
        <p aria-live="polite" className="selected-evidence">Selected evidence: <code>{selectedEvidence}</code></p>
      )}
    </div>
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
  const [baselineReport, setBaselineReport] = useState<ArenaReport | null>(null);
  const [childReport, setChildReport] = useState<ArenaReport | null>(null);

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
    setBaselineReport(null);
    setChildReport(null);
    setScreen("run");
  }

  function handleReport(next: ArenaReport): void {
    if (baselineReport !== null && approvedChildReportMatches(baselineReport, next)) {
      setChildReport(next);
    } else if (baselineReport === null || next.run.run_id === baselineReport.run.run_id) {
      setBaselineReport(next);
      setChildReport(null);
    }
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
          <RunSession
            key={activeRun.run.run_id}
            api={api}
            context={activeRun}
            onReport={handleReport}
          />
        ) : screen === "compare" && baselineReport !== null ? (
          <VerdictSession
            api={api}
            {...(childReport === null ? {} : { child: childReport })}
            initialBaseline={baselineReport}
            onBaselineUpdated={setBaselineReport}
            onChildRunStarted={(child) => {
              if (activeRun === null) return;
              setActiveRun({ run: child, manifest: activeRun.manifest });
              setScreen("run");
            }}
          />
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
