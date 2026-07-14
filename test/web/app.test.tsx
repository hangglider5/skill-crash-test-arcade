import { StrictMode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../../apps/web/src/App.js";
import { ApiError, ArenaApi } from "../../apps/web/src/api.js";

const hash = "a".repeat(64);

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("App", () => {
  it("requires the loopback session token", () => {
    window.history.replaceState({}, "", "/");
    render(<App />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Open Arena from the local startup URL"
    );
  });

  it("treats an empty token as missing and removes it without disturbing navigation", () => {
    window.history.replaceState({}, "", "/?foo=1&token=#hash");

    expect(() => render(<App />)).not.toThrow();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Open Arena from the local startup URL"
    );
    expect(window.location.search).toBe("?foo=1");
    expect(window.location.hash).toBe("#hash");
  });

  it("keeps the token in memory and removes only it from visible history", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    window.history.replaceState({}, "", "/?foo=1&token=arena-secret#hash");

    render(<StrictMode><App /></StrictMode>);

    expect(window.location.search).toBe("?foo=1");
    expect(window.location.hash).toBe("#hash");
    expect(window.location.href).not.toContain("arena-secret");
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Import a Skill" })).toBeVisible();
  });

  it("keeps import, run, and compare shell state in memory", () => {
    window.history.replaceState({}, "", "/?token=arena-secret");
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(screen.getByRole("heading", { name: "Run Monitor" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(screen.getByRole("heading", { name: "Compare Verdicts" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(screen.getByRole("heading", { name: "Import a Skill" })).toBeVisible();
  });
});

describe("ArenaApi", () => {
  it("maps the complete JSON control surface onto authenticated loopback routes", async () => {
    const snapshot = {
      schema: "arena.skill-snapshot/v1",
      source: { kind: "local", uri: "file:///redacted/import" },
      entrypoint: "SKILL.md",
      license: "MIT",
      files: [{ path: "SKILL.md", bytes: 8, sha256: hash }],
      source_hash: hash,
      imported_path: "/redacted/import"
    };
    const run = {
      schema: "arena.run/v1",
      run_id: "run/01",
      run_group_id: "group_01",
      trial_index: 0,
      manifest_hash: hash,
      snapshot_hash: hash,
      fixture_hash: hash,
      runner: { adapter: "codex-cli", model: "gpt-5.6" },
      state: "created",
      started_at: "2026-07-15T00:00:00.000Z"
    };
    const responses = new Map<string, unknown>([
      ["GET /api/health", {
        ok: true,
        checks: [{ id: "app-data", ok: true, message: "ready" }],
        model: { target: "gpt-5.6", status: "configured-unverified" }
      }],
      ["POST /api/imports", snapshot],
      [`GET /api/imports/${hash}`, snapshot],
      ["POST /api/contracts", {
        schema: "arena.skill-contract/v1",
        snapshot_hash: hash,
        model: "gpt-5.6",
        promises: [],
        preconditions: [],
        expected_artifacts: [],
        recovery_rules: [],
        risk_signals: []
      }],
      ["GET /api/manifests", []],
      ["POST /api/runs", run],
      ["GET /api/runs/run%2F01", run],
      ["POST /api/runs/run%2F01/diagnose", {
        schema: "arena.diagnosis/v1",
        run_id: "run/01",
        model: "gpt-5.6",
        observed_failure: "failure",
        likely_skill_gap: "gap",
        retry_analysis: "retry",
        suggested_changes: ["change"],
        evidence_refs: ["event:0"]
      }],
      ["POST /api/runs/run%2F01/repairs", {
        repair_id: "repair/01",
        run_id: "run/01",
        status: "pending",
        snapshot_hash: hash,
        created_at: "2026-07-15T00:02:00.000Z",
        changed_paths: ["SKILL.md"],
        patch_ref: `sha256:${hash}`
      }],
      ["POST /api/repairs/repair%2F01/rerun", { ...run, parent_run_id: "run/01" }],
      ["GET /api/runs/run%2F01/report", {
        schema: "arena.report/v1",
        run,
        manifest_id: "repo-dirty-tree-v1",
        snapshot: {},
        verdict: {},
        trace: []
      }]
    ]);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const method = init?.method ?? "GET";
      const key = `${method} ${String(input)}`;
      return new Response(JSON.stringify(responses.get(key)), {
        status: method === "POST" ? 201 : 200,
        headers: { "content-type": "application/json" }
      });
    });
    const api = new ArenaApi("arena-token", { fetch: fetchMock });

    await api.health();
    await api.importSkill({ kind: "local", path: "/skills/local", entrypoint: "SKILL.md" });
    await api.importSkill({
      kind: "git", url: "https://example.test/skill.git", revision: "main"
    });
    await api.importSkill({ kind: "sample", id: "repo-bugfix" });
    await api.getImport(hash);
    await api.compileContract(hash);
    await api.listManifests();
    await api.startRun("repo-dirty-tree-v1", hash);
    await api.getRun("run/01");
    await api.diagnose("run/01");
    await api.createRepair("run/01");
    await api.rerun("repair/01");
    await api.report("run/01");

    expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${String(url)}`))
      .toEqual([
        "GET /api/health",
        "POST /api/imports",
        "POST /api/imports",
        "POST /api/imports",
        `GET /api/imports/${hash}`,
        "POST /api/contracts",
        "GET /api/manifests",
        "POST /api/runs",
        "GET /api/runs/run%2F01",
        "POST /api/runs/run%2F01/diagnose",
        "POST /api/runs/run%2F01/repairs",
        "POST /api/repairs/repair%2F01/rerun",
        "GET /api/runs/run%2F01/report"
      ]);
    expect(fetchMock.mock.calls.every(([, init]) =>
      new Headers(init?.headers).get("x-arena-token") === "arena-token"
    )).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      kind: "local", path: "/skills/local", entrypoint: "SKILL.md"
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body))).toEqual({
      kind: "git", url: "https://example.test/skill.git", revision: "main"
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3]![1]?.body))).toEqual({
      kind: "sample", id: "repo-bugfix"
    });
    expect(JSON.parse(String(fetchMock.mock.calls[5]![1]?.body))).toEqual({
      snapshot_hash: hash
    });
    expect(JSON.parse(String(fetchMock.mock.calls[7]![1]?.body))).toEqual({
      manifest_id: "repo-dirty-tree-v1", snapshot_hash: hash
    });
  });

  it("uses header authentication for fetch and an encoded query only for SSE", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const streamUrls: string[] = [];
    const eventSource = vi.fn((url: string) => {
      streamUrls.push(url);
      return { close: vi.fn(), onopen: null, onmessage: null, onerror: null };
    });
    const token = "secret value&token=second";
    const api = new ArenaApi(token, { fetch: fetchMock, eventSource });

    await api.listManifests();
    api.openRunStream("run/01");

    const [fetchUrl, fetchInit] = fetchMock.mock.calls[0]!;
    expect(String(fetchUrl)).toBe("/api/manifests");
    expect(new Headers(fetchInit?.headers).get("x-arena-token")).toBe(token);
    expect(String(fetchUrl)).not.toContain("token=");
    const streamUrl = new URL(streamUrls[0]!, "http://localhost");
    expect([...streamUrl.searchParams.entries()]).toEqual([["token", token]]);
    expect(streamUrl.pathname).toBe("/api/runs/run%2F01/events");
  });

  it("authenticates multipart imports without setting content-type", async () => {
    const snapshot = {
      schema: "arena.skill-snapshot/v1",
      source: { kind: "zip", uri: "upload:skill.zip" },
      entrypoint: "SKILL.md",
      license: "unknown",
      files: [{ path: "SKILL.md", bytes: 8, sha256: hash }],
      source_hash: hash,
      imported_path: "/redacted/import"
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify(snapshot),
      { status: 201, headers: { "content-type": "application/json" } }
    ));
    const api = new ArenaApi("arena-token", { fetch: fetchMock });

    await api.importSkill({ kind: "zip", file: new File(["zip"], "skill.zip") });

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("x-arena-token")).toBe("arena-token");
    expect(headers.has("content-type")).toBe(false);
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it.each([
    [500, "text/plain", "server-secret plain text"],
    [502, "application/json", JSON.stringify({ error: { code: 42, message: ["secret"] } })]
  ])("rejects unsafe error payloads without exposing details", async (status, contentType, body) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      status,
      headers: { "content-type": contentType }
    }));
    const api = new ArenaApi("arena-token", { fetch: fetchMock });

    const request = api.getImport(hash);
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({
      status,
      code: "REQUEST_FAILED",
      message: "Request failed safely"
    });
    await expect(request).rejects.not.toThrow(/server-secret|plain text|secret/u);
  });

  it.each(["synchronous", "asynchronous"])(
    "wraps %s fetch failures without exposing transport details",
    async (mode) => {
      const fetchMock = vi.fn<typeof fetch>(() => {
        const error = new Error("server-secret transport failure");
        if (mode === "synchronous") throw error;
        return Promise.reject(error);
      });
      const api = new ArenaApi("arena-token", { fetch: fetchMock });

      const request = api.listManifests();
      await expect(request).rejects.toBeInstanceOf(ApiError);
      await expect(request).rejects.toMatchObject({
        status: 0,
        code: "REQUEST_FAILED",
        message: "Request failed safely"
      });
      await expect(request).rejects.not.toThrow(/server-secret|transport failure/u);
    }
  );
});
