import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import type { PreflightCheck, PreflightResult } from "./types.js";

export interface CommandResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export type PreflightExecutor = (
  command: string,
  args: readonly string[]
) => Promise<CommandResult>;

export interface PreflightOptions {
  appDataDir?: string;
  execute?: PreflightExecutor;
}

async function executeCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      exit_code: code ?? -1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
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
  try {
    await mkdir(appDataDir, { recursive: true });
    await writeFile(probe, "ok", { flag: "wx" });
    await rm(probe);
    return { id: "app-data", ok: true, message: "App-data directory is writable" };
  } catch {
    await rm(probe, { force: true }).catch(() => undefined);
    return { id: "app-data", ok: false, message: "App-data directory is not writable" };
  }
}

export async function runPreflight(options: PreflightOptions = {}): Promise<PreflightResult> {
  const execute = options.execute ?? executeCommand;
  const checks: PreflightCheck[] = [];

  try {
    const result = await execute("codex", ["--version"]);
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
    const result = await execute("codex", ["login", "status"]);
    const loggedIn = result.exit_code === 0 && /\bLogged in(?: using .+)?\b/iu.test(`${result.stdout}\n${result.stderr}`);
    checks.push({ id: "codex-login", ok: loggedIn, message: loggedIn ? "Codex is logged in" : "Codex login is required" });
  } catch {
    checks.push({ id: "codex-login", ok: false, message: "Codex login status is unavailable" });
  }

  try {
    const result = await execute("git", ["--version"]);
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
