import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";

import type { ArtifactRef } from "../protocol/index.js";

import type {
  AgentEventHandler,
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  ArtifactSink
} from "./types.js";

export type RunnerErrorCode =
  | "RUNNER_TOOL_ENV_INVALID"
  | "RUNNER_SPAWN"
  | "RUNNER_JSONL_INVALID"
  | "RUNNER_STDOUT_LINE_TOO_LARGE"
  | "RUNNER_STDOUT_TOO_LARGE"
  | "RUNNER_PROCESS_EXIT"
  | "RUNNER_TIMEOUT"
  | "RUNNER_OUTPUT_FILE"
  | "RUNNER_STRUCTURED_PARSE";

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;
  readonly artifact_ref?: ArtifactRef;

  constructor(code: RunnerErrorCode, message: string, artifactRef?: ArtifactRef) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
    if (artifactRef !== undefined) this.artifact_ref = artifactRef;
  }
}

export interface CodexProcessRunnerOptions {
  command?: string;
  prefixArgs?: string[];
  artifactSink?: ArtifactSink;
  maxLineBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  killGraceMs?: number;
  parentEnv?: NodeJS.ProcessEnv;
}

const TOOL_ENV_KEYS = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI", "NO_COLOR"]);
const PARENT_ENV_KEYS = ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"] as const;

function sanitizedParentEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PARENT_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

function toolOverrides(toolEnv: Record<string, string> | undefined): string[] {
  if (!toolEnv) return [];
  const args: string[] = [];
  for (const key of Object.keys(toolEnv).sort()) {
    if (!TOOL_ENV_KEYS.has(key) || !/^[A-Z][A-Z0-9_]*$/u.test(key)) {
      throw new RunnerError("RUNNER_TOOL_ENV_INVALID", `tool_env key is not allowed: ${key}`);
    }
    const value = toolEnv[key];
    if (typeof value !== "string" || value.includes("\0")) {
      throw new RunnerError("RUNNER_TOOL_ENV_INVALID", `tool_env value is invalid for: ${key}`);
    }
    args.push("-c", `shell_environment_policy.set.${key}=${JSON.stringify(value)}`);
  }
  return args;
}

export function buildCodexArguments(input: AgentRunInput): string[] {
  if (input.model !== "gpt-5.6") {
    throw new RunnerError("RUNNER_SPAWN", "Runner model must be gpt-5.6");
  }
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    "shell_environment_policy.inherit=none",
    ...toolOverrides(input.tool_env),
    "--sandbox",
    input.sandbox,
    "--model",
    "gpt-5.6",
    "--output-schema",
    input.output_schema_path,
    "--output-last-message",
    input.output_path,
    "--cd",
    input.cwd,
    input.prompt
  ];
}

function signalProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export class CodexProcessRunner implements AgentRunner {
  readonly #command: string;
  readonly #prefixArgs: string[];
  readonly #artifactSink?: ArtifactSink;
  readonly #maxLineBytes: number;
  readonly #maxStdoutBytes: number;
  readonly #maxStderrBytes: number;
  readonly #killGraceMs: number;
  readonly #parentEnv: NodeJS.ProcessEnv;

  constructor(options: CodexProcessRunnerOptions = {}) {
    this.#command = options.command ?? "codex";
    this.#prefixArgs = options.prefixArgs ?? [];
    if (options.artifactSink) this.#artifactSink = options.artifactSink;
    this.#maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    this.#maxStdoutBytes = options.maxStdoutBytes ?? 16 * 1024 * 1024;
    this.#maxStderrBytes = options.maxStderrBytes ?? 1024 * 1024;
    this.#killGraceMs = options.killGraceMs ?? 1_000;
    this.#parentEnv = sanitizedParentEnv(options.parentEnv ?? process.env);
  }

  async #artifact(
    data: Uint8Array,
    mime = "text/plain; charset=utf-8"
  ): Promise<ArtifactRef | undefined> {
    return (await this.#artifactSink?.put(data, { mime, redacted: false }))?.ref;
  }

  async run(input: AgentRunInput, onEvent: AgentEventHandler): Promise<AgentRunResult> {
    const args = [...this.#prefixArgs, ...buildCodexArguments(input)];
    await rm(input.output_path, { force: true });

    return new Promise<AgentRunResult>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let killHandle: NodeJS.Timeout | undefined;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let lineBuffer = Buffer.alloc(0);
      const stderrParts: Buffer[] = [];
      let rawEventCount = 0;
      let work = Promise.resolve();
      let processingError: RunnerError | Error | undefined;
      let parseHalted = false;

      const child = spawn(this.#command, args, {
        cwd: input.cwd,
        env: this.#parentEnv,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });

      const stop = () => {
        try { signalProcess(child.pid, "SIGTERM"); } catch { /* close will settle */ }
      };

      const failProcessing = (error: RunnerError | Error) => {
        if (processingError) return;
        processingError = error;
        stop();
      };

      const storeAndFail = (code: RunnerErrorCode, message: string, bytes: Uint8Array) => {
        if (parseHalted) return;
        parseHalted = true;
        work = work.then(async () => {
          const artifact = await this.#artifact(bytes);
          failProcessing(new RunnerError(code, message, artifact));
        }).catch((error: unknown) => failProcessing(error as Error));
      };

      const parseLine = (line: Buffer) => {
        const normalized = line.at(-1) === 13 ? line.subarray(0, -1) : line;
        if (normalized.byteLength === 0) return;
        if (normalized.byteLength > this.#maxLineBytes) {
          storeAndFail("RUNNER_STDOUT_LINE_TOO_LARGE", "Codex JSONL line exceeded the configured byte limit", normalized);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(normalized.toString("utf8"));
        } catch {
          storeAndFail("RUNNER_JSONL_INVALID", "Codex emitted invalid JSONL; original line is stored as an artifact", normalized);
          return;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          storeAndFail("RUNNER_JSONL_INVALID", "Codex emitted a non-object JSONL record", normalized);
          return;
        }
        rawEventCount += 1;
        work = work.then(() => onEvent(parsed as Record<string, unknown>))
          .catch((error: unknown) => failProcessing(error as Error));
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (parseHalted || processingError) return;
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > this.#maxStdoutBytes) {
          const remaining = Math.max(0, this.#maxStdoutBytes - (stdoutBytes - chunk.byteLength));
          storeAndFail("RUNNER_STDOUT_TOO_LARGE", "Codex stdout exceeded the configured byte limit", chunk.subarray(0, remaining));
          return;
        }
        lineBuffer = Buffer.concat([lineBuffer, chunk]);
        let newline = lineBuffer.indexOf(10);
        while (newline >= 0 && !parseHalted && !processingError) {
          const line = lineBuffer.subarray(0, newline);
          lineBuffer = lineBuffer.subarray(newline + 1);
          parseLine(line);
          newline = lineBuffer.indexOf(10);
        }
        if (!parseHalted && lineBuffer.byteLength > this.#maxLineBytes) {
          storeAndFail("RUNNER_STDOUT_LINE_TOO_LARGE", "Codex JSONL line exceeded the configured byte limit", lineBuffer);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = Math.max(0, this.#maxStderrBytes - stderrBytes);
        if (remaining > 0) stderrParts.push(chunk.subarray(0, remaining));
        stderrBytes += Math.min(remaining, chunk.byteLength);
      });

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (killHandle) clearTimeout(killHandle);
        reject(new RunnerError("RUNNER_SPAWN", `Unable to start Codex process: ${error.message}`));
      });

      timeoutHandle = setTimeout(() => {
        timedOut = true;
        stop();
        killHandle = setTimeout(() => {
          try { signalProcess(child.pid, "SIGKILL"); } catch { /* close will settle */ }
        }, this.#killGraceMs);
      }, input.timeout_ms);

      child.once("close", (code) => {
        void (async () => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (killHandle) clearTimeout(killHandle);
          if (lineBuffer.byteLength > 0 && !processingError) parseLine(lineBuffer);
          await work;
          if (timedOut) throw new RunnerError("RUNNER_TIMEOUT", "Codex process exceeded its timeout");
          if (processingError) throw processingError;
          if (code !== 0) {
            const stderr = Buffer.concat(stderrParts);
            const artifact = stderr.byteLength > 0 ? await this.#artifact(stderr) : undefined;
            throw new RunnerError("RUNNER_PROCESS_EXIT", `Codex process exited with code ${String(code)}`, artifact);
          }
          let output: string;
          try {
            output = await readFile(input.output_path, "utf8");
          } catch {
            throw new RunnerError("RUNNER_OUTPUT_FILE", "Codex did not produce the required final output file");
          }
          let structured: unknown;
          try {
            structured = JSON.parse(output);
          } catch {
            const artifact = await this.#artifact(Buffer.from(output), "application/json");
            throw new RunnerError("RUNNER_STRUCTURED_PARSE", "Codex final output is not valid JSON", artifact);
          }
          resolve({ exit_code: 0, structured_output: structured, raw_event_count: rawEventCount });
        })().catch(reject);
      });
    });
  }
}
