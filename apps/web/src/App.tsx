import { useLayoutEffect, useState } from "react";

import { ArenaApi } from "./api.js";
import { ImportLobby } from "./components/ImportLobby.js";

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

function readSessionToken(): InitialSessionToken {
  const raw = new URLSearchParams(window.location.search).get("token");
  return { present: raw !== null, value: raw === null || raw.length === 0 ? null : raw };
}

export function App(): React.JSX.Element {
  const [sessionToken] = useState(readSessionToken);
  const [api] = useState(() => sessionToken.value === null
    ? null
    : new ArenaApi(sessionToken.value));
  const [screen, setScreen] = useState<Screen>("import");
  const [runId, setRunId] = useState<string | null>(null);

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
      <div className={screen === "import" ? "shell-content shell-content-wide" : "shell-content"}>
        {screen === "import" ? (
          <ImportLobby api={api} onRunStarted={handleRunStarted} />
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
