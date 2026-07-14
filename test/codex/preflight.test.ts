import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runPreflight } from "../../src/codex/preflight.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("runPreflight", () => {
  it("checks only CLI version, login, Git, writable data, and labels the model unverified", async () => {
    const appDataDir = await mkdtemp(path.join(tmpdir(), "scta-preflight-"));
    roots.push(appDataDir);
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = await runPreflight({
      appDataDir,
      execute: async (command, args) => {
        calls.push({ command, args: [...args] });
        if (command === "codex" && args[0] === "--version") return { exit_code: 0, stdout: "warning: local build\ncodex-cli 0.144.2\n", stderr: "" };
        if (command === "codex") return { exit_code: 0, stdout: "Logged in using ChatGPT\n", stderr: "" };
        return { exit_code: 0, stdout: "git version 2.53.0\n", stderr: "" };
      }
    });
    expect(calls).toEqual([
      { command: "codex", args: ["--version"] },
      { command: "codex", args: ["login", "status"] },
      { command: "git", args: ["--version"] }
    ]);
    expect(result.ok).toBe(true);
    expect(result.model).toEqual({ target: "gpt-5.6", status: "configured-unverified" });
  });

  it("rejects Codex older than 0.144.2", async () => {
    const appDataDir = await mkdtemp(path.join(tmpdir(), "scta-preflight-"));
    roots.push(appDataDir);
    const result = await runPreflight({
      appDataDir,
      execute: async (command, args) => command === "codex" && args[0] === "--version"
        ? { exit_code: 0, stdout: "codex-cli 0.144.1", stderr: "" }
        : command === "codex"
          ? { exit_code: 0, stdout: "Logged in using ChatGPT", stderr: "" }
          : { exit_code: 0, stdout: "git version 2.53.0", stderr: "" }
    });
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "codex-version")?.ok).toBe(false);
  });
});
