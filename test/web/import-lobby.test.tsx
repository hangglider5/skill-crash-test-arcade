import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  PreflightResult,
  ReplayManifest
} from "../../apps/web/src/api.js";
import type { ArenaApi } from "../../apps/web/src/api.js";
import { ImportLobby } from "../../apps/web/src/components/ImportLobby.js";
import type {
  RunEnvelope,
  SkillContract,
  SkillSnapshot
} from "../../src/protocol/schema.js";

const hash = "a".repeat(64);

type ImportLobbyApi = Pick<
  ArenaApi,
  "health" | "importSkill" | "compileContract" | "listManifests" | "startRun"
>;

function validSnapshot(options: {
  readonly kind?: SkillSnapshot["source"]["kind"];
  readonly uri?: string;
  readonly revision?: string;
  readonly sourceHash?: string;
  readonly license?: string;
  readonly importedPath?: string;
} = {}): SkillSnapshot {
  const sourceHash = options.sourceHash ?? hash;
  return {
    schema: "arena.skill-snapshot/v1",
    source: {
      kind: options.kind ?? "git",
      uri: options.uri ?? "https://github.com/example/skill",
      ...(options.revision === undefined ? { revision: "main" } : { revision: options.revision })
    },
    entrypoint: "SKILL.md",
    license: options.license ?? "MIT",
    files: [{ path: "SKILL.md", bytes: 512, sha256: sourceHash }],
    source_hash: sourceHash,
    imported_path: options.importedPath ?? "/private/arena/imports/redacted"
  };
}

function validContract(): SkillContract {
  return {
    schema: "arena.skill-contract/v1",
    snapshot_hash: hash,
    model: "gpt-5.6-sol",
    promises: [{
      statement: "Preserve repository documentation",
      evidence: "SKILL.md:12",
      confidence: 0.91
    }],
    preconditions: ["Git repository is available"],
    expected_artifacts: ["Updated source files"],
    recovery_rules: ["Stop after repeated command failure"],
    risk_signals: []
  };
}

function dirtyTreeSummary(): ReplayManifest {
  return {
    schema: "arena.replay-manifest/v1",
    id: "repo-dirty-tree-v1",
    name: "Dirty Tree",
    fixture: { id: "repo-bugfix", version: 1 },
    fault_cards: [{ id: "dirty-tree", version: 1 }],
    budgets: { wall_time_s: 180, max_command_retries: 2 },
    scoring: {
      weights: { task_correctness: 1 },
      hard_gates: ["preserve-protected-files"]
    }
  };
}

function falseGreenSummary(): ReplayManifest {
  return {
    ...dirtyTreeSummary(),
    id: "repo-false-green-v1",
    name: "False Green",
    fault_cards: [{ id: "false-green", version: 1 }]
  };
}

function manifestSummary(options: {
  readonly id: string;
  readonly name: string;
  readonly faultCard: string;
}): ReplayManifest {
  return {
    ...dirtyTreeSummary(),
    id: options.id,
    name: options.name,
    fault_cards: [{ id: options.faultCard, version: 1 }]
  };
}

function readyHealth(): PreflightResult {
  return {
    ok: true,
    checks: [
      { id: "codex-version", ok: true, message: "Codex CLI available" },
      { id: "codex-login", ok: true, message: "Codex login ready" },
      { id: "git-version", ok: true, message: "Git available" },
      { id: "app-data", ok: true, message: "App data writable" }
    ],
    model: { target: "gpt-5.6-sol", status: "configured-unverified" }
  };
}

function createdRun(): RunEnvelope {
  return {
    schema: "arena.run/v1",
    run_id: "run_01",
    run_group_id: "group_01",
    trial_index: 0,
    manifest_hash: hash,
    snapshot_hash: hash,
    fixture_hash: hash,
    runner: { adapter: "codex-cli", model: "gpt-5.6-sol" },
    state: "created",
    started_at: "2026-07-15T00:00:00.000Z"
  };
}

function fakeApi(options: {
  readonly snapshot?: SkillSnapshot;
  readonly contract?: SkillContract;
  readonly manifests?: ReplayManifest[];
  readonly health?: PreflightResult;
  readonly run?: RunEnvelope;
} = {}): ImportLobbyApi {
  const snapshot = options.snapshot ?? validSnapshot();
  return {
    health: vi.fn<ImportLobbyApi["health"]>().mockResolvedValue(
      options.health ?? readyHealth()
    ),
    importSkill: vi.fn<ImportLobbyApi["importSkill"]>().mockResolvedValue(snapshot),
    compileContract: vi.fn<ImportLobbyApi["compileContract"]>().mockResolvedValue(
      options.contract ?? validContract()
    ),
    listManifests: vi.fn<ImportLobbyApi["listManifests"]>().mockResolvedValue(
      options.manifests ?? [dirtyTreeSummary()]
    ),
    startRun: vi.fn<ImportLobbyApi["startRun"]>().mockResolvedValue(
      options.run ?? createdRun()
    )
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type TestUser = ReturnType<typeof userEvent.setup>;

async function inspectGit(user: TestUser): Promise<void> {
  await user.type(
    screen.getByRole("textbox", { name: "GitHub URL" }),
    "https://github.com/example/skill"
  );
  await user.click(screen.getByRole("button", { name: "Inspect source" }));
  await screen.findByText("LOCKED");
}

describe("ImportLobby", () => {
  it("inspects before it enables Start Crash Test", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const onRunStarted = vi.fn<(runId: string) => void>();
    render(<ImportLobby api={api} onRunStarted={onRunStarted} />);

    expect(screen.getByText("READ-ONLY PHASE")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start Crash Test" })).toBeDisabled();

    await user.type(
      screen.getByRole("textbox", { name: "GitHub URL" }),
      "https://github.com/example/skill"
    );
    await user.click(screen.getByRole("button", { name: "Inspect source" }));

    expect(await screen.findByText("LOCKED")).toBeVisible();
    expect(screen.getByText("preservation unspecified")).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start Crash Test" })).toBeEnabled();
    });
    expect(api.importSkill).toHaveBeenCalledWith({
      kind: "git",
      url: "https://github.com/example/skill"
    });

    const startButton = screen.getByRole("button", { name: "Start Crash Test" });
    fireEvent.click(startButton);
    fireEvent.click(startButton);
    expect(api.startRun).toHaveBeenCalledTimes(1);
    expect(api.startRun).toHaveBeenCalledWith("repo-dirty-tree-v1", hash);
    await waitFor(() => expect(onRunStarted).toHaveBeenCalledWith("run_01"));
  });

  it("renders the full structured contract and exact local preflight", async () => {
    const user = userEvent.setup();
    render(<ImportLobby api={fakeApi()} onRunStarted={vi.fn()} />);

    await user.type(
      screen.getByRole("textbox", { name: "GitHub URL" }),
      "https://github.com/example/skill"
    );
    await user.click(screen.getByRole("button", { name: "Inspect source" }));

    expect(await screen.findByText("91% confidence")).toBeVisible();
    expect(screen.getByText("Evidence: SKILL.md:12")).toBeVisible();
    expect(screen.getByText("Git repository is available")).toBeVisible();
    expect(screen.getByText("Updated source files")).toBeVisible();
    expect(screen.getByText("Stop after repeated command failure")).toBeVisible();
    expect(screen.getByText("preservation unspecified")).toBeVisible();
    expect(screen.getByText("Codex CLI")).toBeVisible();
    expect(screen.getByText("Codex login")).toBeVisible();
    expect(screen.getByText("Git")).toBeVisible();
    expect(screen.getByText("App data")).toBeVisible();
    expect(screen.getAllByText("gpt-5.6-sol")).toHaveLength(2);
    expect(screen.getByText("configured-unverified")).toBeVisible();
    expect(screen.getByText("Disposable workspace / workspace-write run copy")).toBeVisible();
  });

  it("uses accessible source tabs and sends Local, ZIP, and Sample request shapes", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<ImportLobby api={api} onRunStarted={vi.fn()} />);
    const tabs = screen.getByRole("tablist", { name: "Skill source" });

    await user.click(within(tabs).getByRole("tab", { name: "Local path" }));
    await user.type(screen.getByRole("textbox", { name: "Local path" }), "/skills/local");
    await user.click(screen.getByRole("button", { name: "Inspect source" }));
    await screen.findByText("LOCKED");
    expect(api.importSkill).toHaveBeenLastCalledWith({ kind: "local", path: "/skills/local" });

    await user.click(within(tabs).getByRole("tab", { name: "ZIP" }));
    const archive = new File(["skill"], "skill.zip", { type: "application/zip" });
    await user.upload(screen.getByLabelText("ZIP file"), archive);
    await user.click(screen.getByRole("button", { name: "Inspect source" }));
    await screen.findByText("LOCKED");
    expect(api.importSkill).toHaveBeenLastCalledWith({ kind: "zip", file: archive });

    await user.click(within(tabs).getByRole("tab", { name: "Sample" }));
    expect(screen.getByText("Recorded Replay")).toBeVisible();
    expect(screen.getByText(/distinct from a Live Run/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Inspect source" }));
    await screen.findByText("LOCKED");
    expect(api.importSkill).toHaveBeenLastCalledWith({ kind: "sample", id: "repo-bugfix" });
  });

  it("remounts source controls without controlled-input warnings", async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let warningCalls: unknown[][] = [];
    try {
      render(<ImportLobby api={fakeApi()} onRunStarted={vi.fn()} />);
      await user.click(screen.getByRole("tab", { name: "Local path" }));
      await user.click(screen.getByRole("tab", { name: "ZIP" }));
      warningCalls = consoleError.mock.calls;
    } finally {
      consoleError.mockRestore();
    }
    expect(warningCalls).toEqual([]);
  });

  it("hides local provenance and prioritizes Dirty Tree while allowing selection", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      snapshot: validSnapshot({ kind: "local", uri: "file:///Users/secret/skill" }),
      manifests: [falseGreenSummary(), dirtyTreeSummary()]
    });
    render(<ImportLobby api={api} onRunStarted={vi.fn()} />);

    await user.click(screen.getByRole("tab", { name: "Local path" }));
    await user.type(
      screen.getByRole("textbox", { name: "Local path" }),
      "/Users/secret/skill"
    );
    await user.click(screen.getByRole("button", { name: "Inspect source" }));

    expect(await screen.findByText("Local source (path hidden)")).toBeVisible();
    expect(screen.queryByText("file:///Users/secret/skill")).not.toBeInTheDocument();
    expect(screen.queryByText("/private/arena/imports/redacted")).not.toBeInTheDocument();
    const choices = screen.getAllByRole("radio");
    expect(choices).toHaveLength(2);
    expect(choices[0]).toHaveAccessibleName(/Dirty Tree/);
    await user.click(screen.getByRole("radio", { name: /False Green/ }));
    expect(screen.getByRole("radio", { name: /False Green/ })).toBeChecked();
  });

  it("prefetches health and manifests independently and reports safe failures", async () => {
    const api = fakeApi();
    vi.mocked(api.health).mockRejectedValueOnce(new Error("/Users/secret/.codex"));
    vi.mocked(api.listManifests).mockResolvedValueOnce([dirtyTreeSummary()]);
    vi.mocked(api.importSkill).mockRejectedValueOnce(new Error("secret remote detail"));
    const user = userEvent.setup();
    render(<ImportLobby api={api} onRunStarted={vi.fn()} />);

    expect(api.health).toHaveBeenCalledTimes(1);
    expect(api.listManifests).toHaveBeenCalledTimes(1);
    const sourcePanel = screen.getByRole("region", { name: "Source" });
    const preflightPanel = screen.getByRole("region", { name: "Runner Preflight" });
    expect(await within(preflightPanel).findByRole("alert")).toHaveTextContent(
      "Unable to verify local runner safely."
    );
    expect(screen.getByText("Dirty Tree")).toBeVisible();

    await user.type(
      screen.getByRole("textbox", { name: "GitHub URL" }),
      "https://github.com/example/skill"
    );
    await user.click(screen.getByRole("button", { name: "Inspect source" }));
    expect(await within(sourcePanel).findByRole("alert")).toHaveTextContent(
      "Unable to inspect this source safely."
    );
    expect(screen.queryByText(/secret remote detail|\/Users\/secret/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Crash Test" })).toBeDisabled();
  });

  it("renders health while manifests remain pending", async () => {
    const pendingManifests = deferred<ReplayManifest[]>();
    const api = fakeApi();
    vi.mocked(api.listManifests).mockReturnValueOnce(pendingManifests.promise);
    render(<ImportLobby api={api} onRunStarted={vi.fn()} />);
    const arenaPanel = screen.getByRole("region", { name: "Arena Match" });
    const preflightPanel = screen.getByRole("region", { name: "Runner Preflight" });

    expect(await within(preflightPanel).findByText("Codex CLI available")).toBeVisible();
    expect(within(preflightPanel).queryByText(/Checking/)).not.toBeInTheDocument();
    expect(within(arenaPanel).getByText(/Loading/)).toBeVisible();

    await act(async () => pendingManifests.resolve([dirtyTreeSummary()]));
  });

  it("renders manifests while health remains pending", async () => {
    const pendingHealth = deferred<PreflightResult>();
    const api = fakeApi();
    vi.mocked(api.health).mockReturnValueOnce(pendingHealth.promise);
    render(<ImportLobby api={api} onRunStarted={vi.fn()} />);
    const arenaPanel = screen.getByRole("region", { name: "Arena Match" });
    const preflightPanel = screen.getByRole("region", { name: "Runner Preflight" });

    expect(await within(arenaPanel).findByText("Dirty Tree")).toBeVisible();
    expect(within(arenaPanel).queryByText(/Loading/)).not.toBeInTheDocument();
    expect(within(preflightPanel).getByText(/Checking/)).toBeVisible();

    await act(async () => pendingHealth.resolve(readyHealth()));
  });

  it("drops a stale inspection when the source changes", async () => {
    let resolveFirst: ((snapshot: SkillSnapshot) => void) | undefined;
    const firstImport = new Promise<SkillSnapshot>((resolve) => {
      resolveFirst = resolve;
    });
    const api = fakeApi();
    vi.mocked(api.importSkill)
      .mockReturnValueOnce(firstImport)
      .mockResolvedValueOnce(validSnapshot({ uri: "https://github.com/example/new" }));
    const user = userEvent.setup();
    render(<ImportLobby api={api} onRunStarted={vi.fn()} />);

    const input = screen.getByRole("textbox", { name: "GitHub URL" });
    await user.type(input, "https://github.com/example/old");
    await user.click(screen.getByRole("button", { name: "Inspect source" }));
    fireEvent.change(input, { target: { value: "https://github.com/example/new" } });
    await user.click(screen.getByRole("button", { name: "Inspect source" }));

    expect(await screen.findByText("https://github.com/example/new")).toBeVisible();
    resolveFirst?.(validSnapshot({ uri: "https://github.com/example/old" }));
    await waitFor(() => {
      expect(screen.queryByText("https://github.com/example/old")).not.toBeInTheDocument();
    });
  });

  it("ignores prefetch completion after unmount", async () => {
    let resolveHealth!: (health: PreflightResult) => void;
    let resolveManifests!: (manifests: ReplayManifest[]) => void;
    const api = fakeApi();
    vi.mocked(api.health).mockReturnValueOnce(new Promise((resolve) => {
      resolveHealth = resolve;
    }));
    vi.mocked(api.listManifests).mockReturnValueOnce(new Promise((resolve) => {
      resolveManifests = resolve;
    }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = render(<ImportLobby api={api} onRunStarted={vi.fn()} />);

    unmount();
    await act(async () => {
      resolveHealth(readyHealth());
      resolveManifests([dirtyTreeSummary()]);
      await Promise.resolve();
    });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("redacts path-like provenance even when the server labels it as git", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      snapshot: validSnapshot({
        kind: "git",
        uri: "file:///Users/private-owner/skill",
        importedPath: "/Users/private-owner/.arena/imports/skill"
      })
    });
    render(<ImportLobby api={api} onRunStarted={vi.fn()} />);

    await inspectGit(user);

    expect(screen.getByText("Local source (path hidden)")).toBeVisible();
    expect(screen.queryByText(/private-owner|file:\/\/\//)).not.toBeInTheDocument();
  });

  it.each([
    {
      caseName: "a missing required check",
      health: { ...readyHealth(), checks: readyHealth().checks.slice(0, 3) }
    },
    {
      caseName: "a failed required check",
      health: {
        ...readyHealth(),
        checks: readyHealth().checks.map((check) => check.id === "git-version"
          ? { ...check, ok: false }
          : check)
      }
    },
    {
      caseName: "a duplicated required check",
      health: {
        ...readyHealth(),
        checks: [...readyHealth().checks, readyHealth().checks[0]!]
      }
    }
  ])("blocks Start when preflight has $caseName", async ({ health }) => {
    const user = userEvent.setup();
    render(<ImportLobby api={fakeApi({ health })} onRunStarted={vi.fn()} />);

    await inspectGit(user);

    expect(screen.getByRole("button", { name: "Start Crash Test" })).toBeDisabled();
  });

  it("drops old API prefetch results and clears dependent state on API change", async () => {
    const oldHealth = deferred<PreflightResult>();
    const oldManifests = deferred<ReplayManifest[]>();
    const oldApi = fakeApi();
    vi.mocked(oldApi.health).mockReturnValueOnce(oldHealth.promise);
    vi.mocked(oldApi.listManifests).mockReturnValueOnce(oldManifests.promise);
    const newHealth: PreflightResult = {
      ...readyHealth(),
      checks: readyHealth().checks.map((check) => ({
        ...check,
        message: `new API ${check.id}`
      }))
    };
    const newApi = fakeApi({ health: newHealth, manifests: [falseGreenSummary()] });
    const user = userEvent.setup();
    const { rerender } = render(<ImportLobby api={oldApi} onRunStarted={vi.fn()} />);
    await inspectGit(user);

    rerender(<ImportLobby api={newApi} onRunStarted={vi.fn()} />);
    expect(await screen.findByText("False Green")).toBeVisible();
    expect(screen.getByText("new API codex-version")).toBeVisible();
    await waitFor(() => expect(screen.queryByText("LOCKED")).not.toBeInTheDocument());

    await act(async () => {
      oldHealth.reject(new Error("/Users/old-api-secret"));
      oldManifests.resolve([dirtyTreeSummary()]);
      await Promise.allSettled([oldHealth.promise, oldManifests.promise]);
    });

    expect(screen.queryByText("Dirty Tree")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/old-api-secret/)).not.toBeInTheDocument();
  });

  it("clears a prior operation error when the API changes", async () => {
    const oldApi = fakeApi();
    vi.mocked(oldApi.importSkill).mockRejectedValueOnce(new Error("old secret"));
    const newApi = fakeApi({ manifests: [falseGreenSummary()] });
    const user = userEvent.setup();
    const { rerender } = render(<ImportLobby api={oldApi} onRunStarted={vi.fn()} />);
    await user.type(
      screen.getByRole("textbox", { name: "GitHub URL" }),
      "https://github.com/example/skill"
    );
    await user.click(screen.getByRole("button", { name: "Inspect source" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to inspect this source safely."
    );

    rerender(<ImportLobby api={newApi} onRunStarted={vi.fn()} />);

    await screen.findByText("False Green");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("supports roving keyboard navigation across source tabs", async () => {
    const user = userEvent.setup();
    render(<ImportLobby api={fakeApi()} onRunStarted={vi.fn()} />);
    const github = screen.getByRole("tab", { name: "GitHub URL" });
    const local = screen.getByRole("tab", { name: "Local path" });
    const sample = screen.getByRole("tab", { name: "Sample" });
    github.focus();

    await user.keyboard("{ArrowRight}");
    expect(local).toHaveFocus();
    expect(local).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(sample).toHaveFocus();
    expect(sample).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(github).toHaveFocus();
    expect(github).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowLeft}");
    expect(sample).toHaveFocus();
    expect(sample).toHaveAttribute("aria-selected", "true");
  });

  it("does not expose broken aria-controls relationships from source tabs", () => {
    render(<ImportLobby api={fakeApi()} onRunStarted={vi.fn()} />);

    for (const tab of screen.getAllByRole("tab")) {
      const controlledId = tab.getAttribute("aria-controls");
      if (controlledId !== null) {
        expect(document.getElementById(controlledId)).not.toBeNull();
      }
    }
  });

  it("disables every mutable configuration control while a run is starting", async () => {
    const pendingRun = deferred<RunEnvelope>();
    const api = fakeApi();
    vi.mocked(api.startRun).mockReturnValueOnce(pendingRun.promise);
    const onRunStarted = vi.fn<(runId: string) => void>();
    const user = userEvent.setup();
    render(<ImportLobby api={api} onRunStarted={onRunStarted} />);
    await inspectGit(user);

    await user.click(screen.getByRole("button", { name: "Start Crash Test" }));

    expect(screen.getAllByRole("tab").every((tab) => (tab as HTMLButtonElement).disabled))
      .toBe(true);
    expect(screen.getByRole("textbox", { name: "GitHub URL" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Inspect source" })).toBeDisabled();
    expect(screen.getAllByRole("radio").every((radio) => (radio as HTMLInputElement).disabled))
      .toBe(true);

    await act(async () => pendingRun.resolve(createdRun()));
    await waitFor(() => expect(onRunStarted).toHaveBeenCalledWith("run_01"));
  });

  it("reports a successfully created run even after the lobby unmounts", async () => {
    const pendingRun = deferred<RunEnvelope>();
    const api = fakeApi();
    vi.mocked(api.startRun).mockReturnValueOnce(pendingRun.promise);
    const onRunStarted = vi.fn<(runId: string) => void>();
    const user = userEvent.setup();
    const { unmount } = render(<ImportLobby api={api} onRunStarted={onRunStarted} />);
    await inspectGit(user);
    await user.click(screen.getByRole("button", { name: "Start Crash Test" }));

    unmount();
    await act(async () => pendingRun.resolve(createdRun()));

    expect(onRunStarted).toHaveBeenCalledWith("run_01");
  });

  it("does not report a created run from a superseded API while still mounted", async () => {
    const pendingRun = deferred<RunEnvelope>();
    const oldApi = fakeApi();
    vi.mocked(oldApi.startRun).mockReturnValueOnce(pendingRun.promise);
    const newApi = fakeApi({ manifests: [falseGreenSummary()] });
    const onRunStarted = vi.fn<(runId: string) => void>();
    const user = userEvent.setup();
    const { rerender } = render(
      <ImportLobby api={oldApi} onRunStarted={onRunStarted} />
    );
    await inspectGit(user);
    await user.click(screen.getByRole("button", { name: "Start Crash Test" }));

    rerender(<ImportLobby api={newApi} onRunStarted={onRunStarted} />);
    expect(await screen.findByText("False Green")).toBeVisible();
    await act(async () => pendingRun.resolve(createdRun()));

    expect(onRunStarted).not.toHaveBeenCalled();
  });

  it("does not report a superseded API run after the lobby later unmounts", async () => {
    const pendingRun = deferred<RunEnvelope>();
    const oldApi = fakeApi();
    vi.mocked(oldApi.startRun).mockReturnValueOnce(pendingRun.promise);
    const newApi = fakeApi({ manifests: [falseGreenSummary()] });
    const onRunStarted = vi.fn<(runId: string) => void>();
    const user = userEvent.setup();
    const { rerender, unmount } = render(
      <ImportLobby api={oldApi} onRunStarted={onRunStarted} />
    );
    await inspectGit(user);
    await user.click(screen.getByRole("button", { name: "Start Crash Test" }));

    rerender(<ImportLobby api={newApi} onRunStarted={onRunStarted} />);
    expect(await screen.findByText("False Green")).toBeVisible();
    unmount();
    await act(async () => pendingRun.resolve(createdRun()));

    expect(onRunStarted).not.toHaveBeenCalled();
  });

  it("renders independent safe preflight and manifest failure states in their panels", async () => {
    const api = fakeApi();
    vi.mocked(api.health).mockRejectedValueOnce(new Error("health secret"));
    vi.mocked(api.listManifests).mockRejectedValueOnce(new Error("manifest secret"));
    render(<ImportLobby api={api} onRunStarted={vi.fn()} />);
    const arenaPanel = screen.getByRole("region", { name: "Arena Match" });
    const preflightPanel = screen.getByRole("region", { name: "Runner Preflight" });

    expect(await within(arenaPanel).findByRole("alert")).toHaveTextContent(
      "Unable to load Replay-safe manifests safely."
    );
    expect(await within(preflightPanel).findByRole("alert")).toHaveTextContent(
      "Unable to verify local runner safely."
    );
    expect(within(arenaPanel).queryByText(/Loading/)).not.toBeInTheDocument();
    expect(within(preflightPanel).queryByText(/Checking/)).not.toBeInTheDocument();
    expect(screen.queryByText(/health secret|manifest secret/)).not.toBeInTheDocument();
  });

  it("distinguishes an empty manifest response from loading", async () => {
    render(<ImportLobby api={fakeApi({ manifests: [] })} onRunStarted={vi.fn()} />);
    const arenaPanel = screen.getByRole("region", { name: "Arena Match" });

    expect(await within(arenaPanel).findByText("No Replay-safe manifests available."))
      .toBeVisible();
    expect(within(arenaPanel).queryByText(/Loading/)).not.toBeInTheDocument();
  });

  it("recommends only the exact Dirty Tree manifest and sorts other matches deterministically", async () => {
    const impostor = manifestSummary({
      id: "0-dirty-tree-lookalike",
      name: "Dirty Lookalike",
      faultCard: "dirty-tree"
    });
    const alpha = manifestSummary({ id: "a-false", name: "Alpha", faultCard: "false-green" });
    const zulu = manifestSummary({ id: "z-false", name: "Zulu", faultCard: "false-green" });
    render(<ImportLobby
      api={fakeApi({ manifests: [zulu, impostor, dirtyTreeSummary(), alpha] })}
      onRunStarted={vi.fn()}
    />);

    const radios = await screen.findAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-label") ?? radio.parentElement?.textContent))
      .toEqual([
        expect.stringContaining("Dirty Tree"),
        expect.stringContaining("Dirty Lookalike"),
        expect.stringContaining("Alpha"),
        expect.stringContaining("Zulu")
      ]);
    const exactLabel = screen.getByRole("radio", { name: /^Dirty Tree / }).closest("label");
    const impostorLabel = screen.getByRole("radio", { name: /^Dirty Lookalike / }).closest("label");
    expect(exactLabel).not.toBeNull();
    expect(impostorLabel).not.toBeNull();
    expect(within(exactLabel!).getByText("Best compatibility for repository mutation checks."))
      .toBeVisible();
    expect(within(impostorLabel!).queryByText("Best compatibility for repository mutation checks."))
      .not.toBeInTheDocument();
  });

  it("uses semantic status classes for ready, blocked, advisory, and policy states", async () => {
    const blockedHealth: PreflightResult = {
      ...readyHealth(),
      ok: false,
      checks: readyHealth().checks.map((check) => check.id === "git-version"
        ? { ...check, ok: false, message: "Git blocked" }
        : check)
    };
    render(<ImportLobby api={fakeApi({ health: blockedHealth })} onRunStarted={vi.fn()} />);

    const readyRow = (await screen.findByText("Codex CLI"))
      .closest<HTMLElement>(".preflight-row");
    const blockedRow = screen.getByText("Git").closest<HTMLElement>(".preflight-row");
    const modelRow = screen.getByText("Exact model").closest<HTMLElement>(".preflight-row");
    const policyRow = screen.getByText("Sandbox").closest<HTMLElement>(".preflight-row");
    expect(within(readyRow!).getByText("Ready")).toHaveClass("status-ready");
    expect(within(blockedRow!).getByText("Blocked")).toHaveClass("status-blocked");
    expect(within(modelRow!).getByText("configured-unverified")).toHaveClass("status-advisory");
    expect(within(policyRow!).getByText("Configured policy")).toHaveClass("status-policy");
  });

  it("shows an explicit warning when license metadata is unknown", async () => {
    const user = userEvent.setup();
    render(<ImportLobby
      api={fakeApi({ snapshot: validSnapshot({ license: "unknown" }) })}
      onRunStarted={vi.fn()}
    />);

    await inspectGit(user);

    expect(screen.getByRole("status")).toHaveTextContent("License metadata unavailable");
    expect(screen.getByRole("status")).toHaveClass("license-warning");
  });
});
