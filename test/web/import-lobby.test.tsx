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
    license: "MIT",
    files: [{ path: "SKILL.md", bytes: 512, sha256: sourceHash }],
    source_hash: sourceHash,
    imported_path: "/private/arena/imports/redacted"
  };
}

function validContract(): SkillContract {
  return {
    schema: "arena.skill-contract/v1",
    snapshot_hash: hash,
    model: "gpt-5.6",
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

function readyHealth(): PreflightResult {
  return {
    ok: true,
    checks: [
      { id: "codex-version", ok: true, message: "Codex CLI available" },
      { id: "codex-login", ok: true, message: "Codex login ready" },
      { id: "git-version", ok: true, message: "Git available" },
      { id: "app-data", ok: true, message: "App data writable" }
    ],
    model: { target: "gpt-5.6", status: "configured-unverified" }
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
    runner: { adapter: "codex-cli", model: "gpt-5.6" },
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
    expect(screen.getByText("gpt-5.6")).toBeVisible();
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
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to verify local runner safely."
    );
    expect(screen.getByText("Dirty Tree")).toBeVisible();

    await user.type(
      screen.getByRole("textbox", { name: "GitHub URL" }),
      "https://github.com/example/skill"
    );
    await user.click(screen.getByRole("button", { name: "Inspect source" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to inspect this source safely."
    );
    expect(screen.queryByText(/secret remote detail|\/Users\/secret/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Crash Test" })).toBeDisabled();
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
});
