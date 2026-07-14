import { useEffect, useRef, useState } from "react";

import type {
  ArenaApi,
  BrowserImportRequest,
  PreflightResult,
  ReplayManifest
} from "../api.js";
import type { SkillContract, SkillSnapshot } from "../../../../src/protocol/schema.js";

type ImportLobbyApi = Pick<
  ArenaApi,
  "health" | "importSkill" | "compileContract" | "listManifests" | "startRun"
>;

export interface ImportLobbyProps {
  readonly api: ImportLobbyApi;
  readonly onRunStarted: (runId: string) => void;
}

const STEPS = ["Source", "Inspect", "Configure", "Ready"] as const;
const SOURCE_TABS = [
  { id: "git", label: "GitHub URL" },
  { id: "local", label: "Local path" },
  { id: "zip", label: "ZIP" },
  { id: "sample", label: "Sample" }
] as const;
const PREFLIGHT_LABELS: Record<PreflightResult["checks"][number]["id"], string> = {
  "codex-version": "Codex CLI",
  "codex-login": "Codex login",
  "git-version": "Git",
  "app-data": "App data"
};

type SourceTab = typeof SOURCE_TABS[number]["id"];

function ProgressRail({ current }: { readonly current: number }): React.JSX.Element {
  return (
    <ol aria-label="Import progress" className="import-progress">
      {STEPS.map((step, index) => (
        <li aria-current={current === index ? "step" : undefined} key={step}>
          <span>{index + 1}</span>{step}
        </li>
      ))}
    </ol>
  );
}

function SnapshotPanel({ snapshot }: { readonly snapshot: SkillSnapshot }): React.JSX.Element {
  const source = snapshot.source.kind === "local"
    ? "Local source (path hidden)"
    : snapshot.source.kind === "zip"
      ? "Uploaded ZIP archive"
      : snapshot.source.uri;
  return (
    <section aria-labelledby="snapshot-title" className="snapshot-card">
      <div className="section-heading">
        <h2 id="snapshot-title">Skill Snapshot</h2>
        <strong className="locked-label">LOCKED</strong>
      </div>
      <dl className="snapshot-fields">
        <div><dt>Format</dt><dd>{snapshot.source.kind.toUpperCase()}</dd></div>
        <div><dt>Canonical source</dt><dd>{source}</dd></div>
        <div><dt>Revision</dt><dd>{snapshot.source.revision ?? "Not provided"}</dd></div>
        <div><dt>Entry point</dt><dd>{snapshot.entrypoint}</dd></div>
        <div><dt>License</dt><dd>{snapshot.license}</dd></div>
        <div><dt>File count</dt><dd>{snapshot.files.length}</dd></div>
        <div><dt>Source hash</dt><dd><code>{snapshot.source_hash.slice(0, 10)}…</code></dd></div>
      </dl>
    </section>
  );
}

function StringList(props: {
  readonly title: string;
  readonly values: readonly string[];
  readonly empty?: string;
}): React.JSX.Element {
  return (
    <div className="contract-group">
      <h3>{props.title}</h3>
      {props.values.length === 0 ? <p>{props.empty ?? "None declared"}</p> : (
        <ul>{props.values.map((value) => <li key={value}>{value}</li>)}</ul>
      )}
    </div>
  );
}

function ContractPanel({ contract }: { readonly contract: SkillContract }): React.JSX.Element {
  return (
    <section aria-labelledby="contract-title" className="contract-panel">
      <h2 id="contract-title">Compiled Contract</h2>
      <div className="contract-group">
        <h3>Promises</h3>
        {contract.promises.length === 0 ? <p>None declared</p> : (
          <ul className="promise-list">
            {contract.promises.map((promise) => (
              <li className="contract-chip" key={`${promise.statement}:${promise.evidence}`}>
                <strong>{promise.statement}</strong>
                <span>{Math.round(promise.confidence * 100)}% confidence</span>
                <small>Evidence: {promise.evidence}</small>
              </li>
            ))}
          </ul>
        )}
      </div>
      <StringList title="Preconditions" values={contract.preconditions} />
      <StringList title="Expected artifacts" values={contract.expected_artifacts} />
      <StringList title="Recovery rules" values={contract.recovery_rules} />
      <StringList
        empty="preservation unspecified"
        title="Risk signals"
        values={contract.risk_signals}
      />
    </section>
  );
}

function PreflightPanel({ health }: { readonly health: PreflightResult | null }): React.JSX.Element {
  return (
    <section aria-labelledby="preflight-title" className="preflight-panel">
      <h2 id="preflight-title">Runner Preflight</h2>
      {health === null ? <p>Checking local runner…</p> : (
        <div className="preflight-list">
          {health.checks.map((check) => (
            <div className="preflight-row" key={check.id}>
              <span>{PREFLIGHT_LABELS[check.id]}</span>
              <strong>{check.ok ? "Ready" : "Blocked"}</strong>
              <small>{check.message}</small>
            </div>
          ))}
          <div className="preflight-row">
            <span>Exact model</span>
            <strong>{health.model.target}</strong>
            <small>{health.model.status}</small>
          </div>
          <div className="preflight-row">
            <span>Sandbox</span>
            <strong>Configured policy</strong>
            <small>Disposable workspace / workspace-write run copy</small>
          </div>
        </div>
      )}
    </section>
  );
}

export function ImportLobby({ api, onRunStarted }: ImportLobbyProps): React.JSX.Element {
  const [sourceTab, setSourceTab] = useState<SourceTab>("git");
  const [githubUrl, setGithubUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [snapshot, setSnapshot] = useState<SkillSnapshot | null>(null);
  const [contract, setContract] = useState<SkillContract | null>(null);
  const [health, setHealth] = useState<PreflightResult | null>(null);
  const [manifests, setManifests] = useState<ReplayManifest[]>([]);
  const [selectedManifestId, setSelectedManifestId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"inspect" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const inspectSequenceRef = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    const loadHealth = api.health();
    const loadManifests = api.listManifests();
    void Promise.allSettled([loadHealth, loadManifests]).then(([healthResult, manifestResult]) => {
      if (!mountedRef.current) return;
      if (healthResult.status === "fulfilled") {
        setHealth(healthResult.value);
      } else {
        setPreflightError("Unable to verify local runner safely.");
      }
      if (manifestResult.status === "fulfilled") {
        setManifests(manifestResult.value);
      } else {
        setManifestError("Unable to load Replay-safe manifests safely.");
      }
    });
    return () => {
      mountedRef.current = false;
      inspectSequenceRef.current += 1;
    };
  }, [api]);

  const repositoryWorkflow = snapshot === null || snapshot.source.kind !== "zip";
  const sortedManifests = repositoryWorkflow
    ? manifests.toSorted((left, right) => {
      const leftDirty = left.id.includes("dirty") ? 0 : 1;
      const rightDirty = right.id.includes("dirty") ? 0 : 1;
      return leftDirty - rightDirty;
    })
    : manifests;
  const manifest = sortedManifests.find((item) => item.id === selectedManifestId)
    ?? sortedManifests[0]
    ?? null;
  const canStart = snapshot !== null
    && contract !== null
    && manifest !== null
    && health?.ok === true
    && busy === null;
  const sourceReady = sourceTab === "git"
    ? githubUrl.trim().length > 0
    : sourceTab === "local"
      ? localPath.trim().length > 0
      : sourceTab === "zip"
        ? zipFile !== null
        : true;
  const progressStep = canStart ? 3 : snapshot !== null ? 2 : busy === "inspect" ? 1 : 0;
  const visibleError = error ?? preflightError ?? manifestError;

  function invalidateInspection(): void {
    inspectSequenceRef.current += 1;
    if (busy === "inspect") {
      busyRef.current = false;
      setBusy(null);
    }
    setSnapshot(null);
    setContract(null);
    setSelectedManifestId(null);
    setError(null);
  }

  function chooseSource(tab: SourceTab): void {
    if (tab === sourceTab || busy === "start") return;
    invalidateInspection();
    setSourceTab(tab);
  }

  function buildImportRequest(): BrowserImportRequest | null {
    if (sourceTab === "git") {
      const url = githubUrl.trim();
      return url.length === 0 ? null : { kind: "git", url };
    }
    if (sourceTab === "local") {
      const path = localPath.trim();
      return path.length === 0 ? null : { kind: "local", path };
    }
    if (sourceTab === "zip") {
      return zipFile === null ? null : { kind: "zip", file: zipFile };
    }
    return { kind: "sample", id: "repo-bugfix" };
  }

  async function inspectSource(): Promise<void> {
    if (busyRef.current) return;
    const request = buildImportRequest();
    if (request === null) return;
    busyRef.current = true;
    const sequence = inspectSequenceRef.current + 1;
    inspectSequenceRef.current = sequence;
    setBusy("inspect");
    setError(null);
    setSnapshot(null);
    setContract(null);
    try {
      const nextSnapshot = await api.importSkill(request);
      if (!mountedRef.current || inspectSequenceRef.current !== sequence) return;
      const nextContract = await api.compileContract(nextSnapshot.source_hash);
      if (!mountedRef.current || inspectSequenceRef.current !== sequence) return;
      setSnapshot(nextSnapshot);
      setContract(nextContract);
    } catch {
      if (!mountedRef.current || inspectSequenceRef.current !== sequence) return;
      setError("Unable to inspect this source safely.");
    } finally {
      if (mountedRef.current && inspectSequenceRef.current === sequence) {
        busyRef.current = false;
        setBusy(null);
      }
    }
  }

  async function startCrashTest(): Promise<void> {
    if (busyRef.current || !canStart || snapshot === null || manifest === null) return;
    busyRef.current = true;
    setBusy("start");
    setError(null);
    try {
      const run = await api.startRun(manifest.id, snapshot.source_hash);
      if (mountedRef.current) onRunStarted(run.run_id);
    } catch {
      if (mountedRef.current) setError("Unable to start this run safely.");
    } finally {
      if (mountedRef.current) {
        busyRef.current = false;
        setBusy(null);
      }
    }
  }

  return (
    <section aria-labelledby="import-lobby-title" className="import-lobby">
      <header className="lobby-header">
        <div>
          <h1 id="import-lobby-title">Import a Skill</h1>
          <p>Inspect a frozen copy before matching it to a controlled crash test.</p>
        </div>
        <ProgressRail current={progressStep} />
      </header>
      <div className="import-grid">
        <div className="source-column">
          <section aria-labelledby="source-title" className="source-panel">
            <h2 id="source-title">Source</h2>
            <div className="source-tabs" role="tablist" aria-label="Skill source">
              {SOURCE_TABS.map((tab) => (
                <button
                  aria-controls={`source-panel-${tab.id}`}
                  aria-selected={sourceTab === tab.id}
                  id={`source-tab-${tab.id}`}
                  key={tab.id}
                  onClick={() => chooseSource(tab.id)}
                  role="tab"
                  tabIndex={sourceTab === tab.id ? 0 : -1}
                  type="button"
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div
              aria-labelledby={`source-tab-${sourceTab}`}
              id={`source-panel-${sourceTab}`}
              role="tabpanel"
            >
              {sourceTab === "git" ? (
                <>
                  <label htmlFor="github-url">GitHub URL</label>
                  <input
                    id="github-url"
                    onChange={(event) => {
                      invalidateInspection();
                      setGithubUrl(event.currentTarget.value);
                    }}
                    placeholder="https://github.com/owner/skill"
                    type="url"
                    value={githubUrl}
                  />
                </>
              ) : sourceTab === "local" ? (
                <>
                  <label htmlFor="local-path">Local path</label>
                  <input
                    id="local-path"
                    onChange={(event) => {
                      invalidateInspection();
                      setLocalPath(event.currentTarget.value);
                    }}
                    placeholder="/path/to/skill"
                    type="text"
                    value={localPath}
                  />
                </>
              ) : sourceTab === "zip" ? (
                <>
                  <label htmlFor="zip-file">ZIP file</label>
                  <input
                    accept=".zip,application/zip"
                    id="zip-file"
                    onChange={(event) => {
                      invalidateInspection();
                      setZipFile(event.currentTarget.files?.[0] ?? null);
                    }}
                    type="file"
                  />
                </>
              ) : (
                <div className="sample-source">
                  <strong>Recorded Replay</strong>
                  <p>Repository bug-fix sample, distinct from a Live Run.</p>
                </div>
              )}
            </div>
            <div className="read-only-notice">
              <strong>READ-ONLY PHASE</strong>
              <p>Inspection creates an isolated snapshot. It does not modify the original source.</p>
            </div>
            <button
              disabled={busy !== null || !sourceReady}
              onClick={() => void inspectSource()}
              type="button"
            >
              {busy === "inspect" ? "Inspecting…" : "Inspect source"}
            </button>
            {visibleError === null ? null : <p role="alert">{visibleError}</p>}
          </section>
        </div>
        <div className="configuration-column">
          {snapshot === null ? null : <SnapshotPanel snapshot={snapshot} />}
          {contract === null ? null : <ContractPanel contract={contract} />}
          <section aria-labelledby="arena-title" className="arena-card">
            <h2 id="arena-title">Arena Match</h2>
            {sortedManifests.length === 0 ? <p>Loading Replay-safe manifests…</p> : (
              <div className="manifest-options">
                {sortedManifests.map((item, index) => (
                  <label key={item.id}>
                    <input
                      checked={manifest?.id === item.id}
                      name="arena-manifest"
                      onChange={() => setSelectedManifestId(item.id)}
                      type="radio"
                    />
                    <strong>{item.name}</strong>
                    <span>
                      {repositoryWorkflow && index === 0
                        ? "Best compatibility for repository mutation checks."
                        : `Fixture ${item.fixture.id} v${item.fixture.version}; ${item.fault_cards.length} fault card(s).`}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>
          <PreflightPanel health={health} />
          <div className="start-zone">
            <div className="run-boundaries">
              <span>Original source <strong>READ-ONLY</strong></span>
              <span>Run directory <strong>NEW</strong></span>
            </div>
            <button
              className="start-button"
              disabled={!canStart}
              onClick={() => void startCrashTest()}
              type="button"
            >
              {busy === "start" ? "Starting…" : "Start Crash Test"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
