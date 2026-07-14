import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executePreflightCommand, runPreflight } from "../../src/codex/preflight.js";

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

  it.each([
    "Not logged in",
    "not logged in",
    "User is Not logged in",
    "warning: Not logged in\n"
  ])("does not treat exit-zero negative auth output as success: %s", async (loginOutput) => {
    const appDataDir = await mkdtemp(path.join(tmpdir(), "scta-preflight-"));
    roots.push(appDataDir);
    const result = await runPreflight({
      appDataDir,
      execute: async (command, args) => command === "codex" && args[0] === "--version"
        ? { exit_code: 0, stdout: "codex-cli 0.144.2", stderr: "" }
        : command === "codex"
          ? { exit_code: 0, stdout: loginOutput, stderr: "" }
          : { exit_code: 0, stdout: "git version 2.53.0", stderr: "" }
    });
    expect(result.checks.find((check) => check.id === "codex-login")).toMatchObject({ ok: false, message: "Codex login is required" });
  });

  it("passes bounds to every injected command and externally bounds a hung executor", async () => {
    const appDataDir = await mkdtemp(path.join(tmpdir(), "scta-preflight-"));
    roots.push(appDataDir);
    const calls: unknown[] = [];
    const signals: AbortSignal[] = [];
    const started = Date.now();
    const result = await runPreflight({
      appDataDir,
      commandTimeoutMs: 10,
      maxStdoutBytes: 64,
      maxStderrBytes: 32,
      killGraceMs: 5,
      execute: (_command, _args, limits, signal) => {
        calls.push(limits);
        if (signal) signals.push(signal);
        return new Promise(() => {});
      }
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toHaveLength(3);
    expect(calls).toEqual(Array(3).fill({ timeout_ms: 10, max_stdout_bytes: 64, max_stderr_bytes: 32, kill_grace_ms: 5 }));
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.checks.slice(0, 3).every((check) => !check.ok)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("waits for a TERM-ignoring real command to close before starting the next preflight check", async () => {
    expect(executePreflightCommand).toBeTypeOf("function");
    const appDataDir = await mkdtemp(path.join(tmpdir(), "scta-preflight-"));
    roots.push(appDataDir);
    let commandActive = false;
    let overlapObserved = false;
    let call = 0;

    const result = await runPreflight({
      appDataDir,
      commandTimeoutMs: 20,
      killGraceMs: 30,
      execute: async (_command, _args, limits, signal) => {
        call += 1;
        if (commandActive) overlapObserved = true;
        if (call !== 1) {
          return call === 2
            ? { exit_code: 0, stdout: "Logged in using ChatGPT", stderr: "" }
            : { exit_code: 0, stdout: "git version 2.53.0", stderr: "" };
        }

        commandActive = true;
        try {
          return await executePreflightCommand(process.execPath, [
            "-e",
            "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
          ], limits, signal);
        } finally {
          commandActive = false;
        }
      }
    });

    expect(overlapObserved).toBe(false);
    expect(commandActive).toBe(false);
    expect(result.checks[0]).toMatchObject({ id: "codex-version", ok: false });
  });

  it("rejects noisy injected command results without retaining their raw output", async () => {
    const appDataDir = await mkdtemp(path.join(tmpdir(), "scta-preflight-"));
    roots.push(appDataDir);
    const result = await runPreflight({
      appDataDir,
      maxStdoutBytes: 16,
      maxStderrBytes: 16,
      execute: async () => ({ exit_code: 0, stdout: "private".repeat(100), stderr: "secret".repeat(100) })
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("secret");
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
