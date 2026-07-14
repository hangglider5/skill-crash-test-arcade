import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { PreflightCheck, PreflightResult } from "./types.js";

export interface CommandResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export interface PreflightCommandLimits {
  timeout_ms: number;
  max_stdout_bytes: number;
  max_stderr_bytes: number;
  kill_grace_ms: number;
}

export type PreflightExecutor = (
  command: string,
  args: readonly string[],
  limits: PreflightCommandLimits,
  signal: AbortSignal
) => Promise<CommandResult>;

export interface PreflightOptions {
  appDataDir?: string;
  execute?: PreflightExecutor;
  commandTimeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  killGraceMs?: number;
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function executePreflightCommand(
  command: string,
  args: readonly string[],
  limits: PreflightCommandLimits,
  signal: AbortSignal
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let stopping = false;
    let childClosed = false;
    let failure: Error | undefined;
    let killHandle: NodeJS.Timeout | undefined;

    const timeoutHandle = setTimeout(() => {
      failure ??= new Error("preflight command timed out");
      forceStop();
    }, limits.timeout_ms);

    const abort = () => {
      failure ??= new Error("preflight command aborted");
      forceStop();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();

    function forceStop(): void {
      if (stopping || childClosed) return;
      stopping = true;
      try { signalGroup(child.pid, "SIGTERM"); } catch { /* close/error settles safely */ }
      killHandle = setTimeout(() => {
        try { signalGroup(child.pid, "SIGKILL"); } catch { /* close/error settles safely */ }
      }, limits.kill_grace_ms);
    }

    function finish(error?: Error, result?: CommandResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("preflight command failed"));
    }

    function collect(chunk: Buffer, parts: Buffer[], stream: "stdout" | "stderr"): void {
      if (failure) return;
      const current = stream === "stdout" ? stdoutBytes : stderrBytes;
      const cap = stream === "stdout" ? limits.max_stdout_bytes : limits.max_stderr_bytes;
      const next = current + chunk.byteLength;
      if (next > cap) {
        failure = new Error("preflight command output exceeded limit");
        forceStop();
        return;
      }
      parts.push(chunk);
      if (stream === "stdout") stdoutBytes = next;
      else stderrBytes = next;
    }

    child.stdout.on("data", (chunk: Buffer) => collect(chunk, stdout, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, stderr, "stderr"));
    child.once("error", () => finish(new Error("preflight command unavailable")));
    child.once("close", (code) => {
      childClosed = true;
      if (failure) finish(failure);
      else finish(undefined, {
        exit_code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

const EXECUTOR_FALLBACK_MARGIN_MS = 100;

function withExecutorFallback<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const handle = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(new Error("preflight executor timed out"));
    }, timeoutMs);
    Promise.resolve().then(() => operation(controller.signal)).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(handle);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(handle);
        reject(new Error("preflight executor failed"));
      }
    );
  });
}

async function boundedExecute(
  execute: PreflightExecutor,
  command: string,
  args: readonly string[],
  limits: PreflightCommandLimits
): Promise<CommandResult> {
  const result = await withExecutorFallback(
    (signal) => execute(command, args, limits, signal),
    limits.timeout_ms + limits.kill_grace_ms + EXECUTOR_FALLBACK_MARGIN_MS
  );
  if (Buffer.byteLength(result.stdout) > limits.max_stdout_bytes
    || Buffer.byteLength(result.stderr) > limits.max_stderr_bytes) {
    throw new Error("preflight executor output exceeded limit");
  }
  return result;
}

function versionAtLeast(actual: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    const left = actual[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

async function writableCheck(appDataDir: string): Promise<PreflightCheck> {
  const probe = path.join(appDataDir, `.preflight-${randomUUID()}`);
  let created = false;
  try {
    await mkdir(appDataDir, { recursive: true });
    const stat = await lstat(appDataDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe app-data directory");
    const handle = await open(probe, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile("ok");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await unlink(probe);
    created = false;
    return { id: "app-data", ok: true, message: "App-data directory is writable" };
  } catch {
    if (created) await unlink(probe).catch(() => undefined);
    return { id: "app-data", ok: false, message: "App-data directory is not writable" };
  }
}

function hasCanonicalLoginLine(output: string): boolean {
  return output.split(/\r?\n/u).some((line) => /^Logged in(?: using [^\r\n]+)?$/u.test(line.trim()));
}

export async function runPreflight(options: PreflightOptions = {}): Promise<PreflightResult> {
  const execute = options.execute ?? executePreflightCommand;
  const limits: PreflightCommandLimits = {
    timeout_ms: options.commandTimeoutMs ?? 5_000,
    max_stdout_bytes: options.maxStdoutBytes ?? 64 * 1024,
    max_stderr_bytes: options.maxStderrBytes ?? 64 * 1024,
    kill_grace_ms: options.killGraceMs ?? 1_000
  };
  const checks: PreflightCheck[] = [];

  try {
    const result = await boundedExecute(execute, "codex", ["--version"], limits);
    const match = /\bcodex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)\b/iu.exec(`${result.stdout}\n${result.stderr}`);
    const supported = result.exit_code === 0 && match !== null
      && versionAtLeast(match.slice(1).map(Number), [0, 144, 2]);
    checks.push({
      id: "codex-version",
      ok: supported,
      message: supported ? `Codex CLI ${match?.[1]}.${match?.[2]}.${match?.[3]}` : "Codex CLI 0.144.2 or newer is required"
    });
  } catch {
    checks.push({ id: "codex-version", ok: false, message: "Codex CLI is unavailable" });
  }

  try {
    const result = await boundedExecute(execute, "codex", ["login", "status"], limits);
    const loggedIn = result.exit_code === 0 && hasCanonicalLoginLine(`${result.stdout}\n${result.stderr}`);
    checks.push({ id: "codex-login", ok: loggedIn, message: loggedIn ? "Codex is logged in" : "Codex login is required" });
  } catch {
    checks.push({ id: "codex-login", ok: false, message: "Codex login status is unavailable" });
  }

  try {
    const result = await boundedExecute(execute, "git", ["--version"], limits);
    const match = /\bgit version\s+\d+\.\d+(?:\.\d+)?\b/iu.exec(`${result.stdout}\n${result.stderr}`);
    const available = result.exit_code === 0 && match !== null;
    checks.push({ id: "git-version", ok: available, message: available ? match?.[0] ?? "Git available" : "Git is unavailable" });
  } catch {
    checks.push({ id: "git-version", ok: false, message: "Git is unavailable" });
  }

  checks.push(await writableCheck(options.appDataDir ?? path.join(homedir(), ".skill-crash-test-arcade")));
  return {
    ok: checks.every((check) => check.ok),
    checks,
    model: { target: "gpt-5.6", status: "configured-unverified" }
  };
}
