import { spawn } from "node:child_process";

import type { ArtifactRef } from "../protocol/index.js";

import { readOwnedOutputFile, validateOwnedOutputPath } from "./output-file.js";
import type {
  AgentEventDelivery,
  AgentEventHandler,
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  ArtifactSink
} from "./types.js";

export type RunnerErrorCode =
  | "RUNNER_TOOL_ENV_INVALID"
  | "RUNNER_UNSUPPORTED_PLATFORM"
  | "RUNNER_OUTPUT_PATH_INVALID"
  | "RUNNER_SPAWN"
  | "RUNNER_JSONL_INVALID"
  | "RUNNER_STDOUT_LINE_TOO_LARGE"
  | "RUNNER_STDOUT_TOO_LARGE"
  | "RUNNER_CALLBACK_TIMEOUT"
  | "RUNNER_CALLBACK_FAILED"
  | "RUNNER_CALLBACK_INACTIVE"
  | "RUNNER_CALLBACK_COMMIT_ASYNC"
  | "RUNNER_ARTIFACT_FAILED"
  | "RUNNER_EXIT_NONZERO"
  | "RUNNER_TIMEOUT"
  | "RUNNER_OUTPUT_INVALID";

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
  ownedOutputRoot: string;
  command?: string;
  prefixArgs?: string[];
  artifactSink?: ArtifactSink;
  maxLineBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxOutputBytes?: number;
  callbackTimeoutMs?: number;
  killGraceMs?: number;
  parentEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
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
      throw new RunnerError("RUNNER_TOOL_ENV_INVALID", "A tool environment key is not allowed");
    }
    const value = toolEnv[key];
    if (typeof value !== "string" || value.includes("\0")) {
      throw new RunnerError("RUNNER_TOOL_ENV_INVALID", "A tool environment value is invalid");
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

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function boundedHook<T>(
  operation: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
  timeoutCode: RunnerErrorCode,
  failureCode: RunnerErrorCode
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const controller = new AbortController();
    const handle = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(new RunnerError(timeoutCode, "A runner callback exceeded its time limit"));
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
        controller.abort();
        clearTimeout(handle);
        reject(new RunnerError(failureCode, "A runner callback failed"));
      }
    );
  });
}

function isAsyncFunction(operation: () => unknown): boolean {
  return Object.prototype.toString.call(operation) === "[object AsyncFunction]";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? typeof (value as { then?: unknown }).then === "function"
    : false;
}

function deliverEvent(
  handler: AgentEventHandler,
  event: Record<string, unknown>,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let active = true;
    let settled = false;
    let timeoutHandle: NodeJS.Timeout;

    const fail = (error: RunnerError) => {
      if (settled) return;
      settled = true;
      active = false;
      controller.abort();
      clearTimeout(timeoutHandle);
      reject(error);
    };

    const delivery: AgentEventDelivery = {
      signal: controller.signal,
      commit<T>(operation: () => T): T {
        if (!active || controller.signal.aborted) {
          throw new RunnerError(
            "RUNNER_CALLBACK_INACTIVE",
            "The event delivery is no longer active"
          );
        }
        if (isAsyncFunction(operation)) {
          const error = new RunnerError(
            "RUNNER_CALLBACK_COMMIT_ASYNC",
            "Event delivery commits must be synchronous"
          );
          fail(error);
          throw error;
        }

        const value = operation();
        if (isPromiseLike(value)) {
          void Promise.resolve(value).catch(() => undefined);
          const error = new RunnerError(
            "RUNNER_CALLBACK_COMMIT_ASYNC",
            "Event delivery commits must be synchronous"
          );
          fail(error);
          throw error;
        }
        return value;
      }
    };

    timeoutHandle = setTimeout(() => {
      fail(new RunnerError(
        "RUNNER_CALLBACK_TIMEOUT",
        "A runner callback exceeded its time limit"
      ));
    }, timeoutMs);

    Promise.resolve().then(() => handler(event, delivery)).then(
      () => {
        if (settled) return;
        settled = true;
        active = false;
        clearTimeout(timeoutHandle);
        resolve();
      },
      () => {
        fail(new RunnerError("RUNNER_CALLBACK_FAILED", "A runner callback failed"));
      }
    );
  });
}

export class CodexProcessRunner implements AgentRunner {
  readonly #ownedOutputRoot: string;
  readonly #command: string;
  readonly #prefixArgs: string[];
  readonly #artifactSink?: ArtifactSink;
  readonly #maxLineBytes: number;
  readonly #maxStdoutBytes: number;
  readonly #maxStderrBytes: number;
  readonly #maxOutputBytes: number;
  readonly #callbackTimeoutMs: number;
  readonly #killGraceMs: number;
  readonly #parentEnv: NodeJS.ProcessEnv;

  constructor(options: CodexProcessRunnerOptions) {
    if ((options.platform ?? process.platform) === "win32") {
      throw new RunnerError("RUNNER_UNSUPPORTED_PLATFORM", "The Codex runner requires POSIX process groups");
    }
    this.#ownedOutputRoot = options.ownedOutputRoot;
    this.#command = options.command ?? "codex";
    this.#prefixArgs = options.prefixArgs ?? [];
    if (options.artifactSink) this.#artifactSink = options.artifactSink;
    this.#maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    this.#maxStdoutBytes = options.maxStdoutBytes ?? 16 * 1024 * 1024;
    this.#maxStderrBytes = options.maxStderrBytes ?? 1024 * 1024;
    this.#maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    this.#callbackTimeoutMs = options.callbackTimeoutMs ?? 5_000;
    this.#killGraceMs = options.killGraceMs ?? 1_000;
    this.#parentEnv = sanitizedParentEnv(options.parentEnv ?? process.env);
  }

  async #evidence(
    data: Uint8Array,
    mime = "text/plain; charset=utf-8"
  ): Promise<ArtifactRef | undefined> {
    if (!this.#artifactSink) return undefined;
    try {
      const stored = await boundedHook(
        (signal) => this.#artifactSink!.put(data, { mime, redacted: false }, { signal }),
        this.#callbackTimeoutMs,
        "RUNNER_CALLBACK_TIMEOUT",
        "RUNNER_ARTIFACT_FAILED"
      );
      return stored.ref;
    } catch {
      return undefined;
    }
  }

  async run(input: AgentRunInput, onEvent: AgentEventHandler): Promise<AgentRunResult> {
    let ownedOutput;
    try {
      ownedOutput = await validateOwnedOutputPath(this.#ownedOutputRoot, input.output_path, input.output_schema_path);
    } catch {
      throw new RunnerError("RUNNER_OUTPUT_PATH_INVALID", "The requested output path is not an owned new file");
    }
    const args = [...this.#prefixArgs, ...buildCodexArguments(input)];

    return new Promise<AgentRunResult>((resolve, reject) => {
      let settled = false;
      let childClosed = false;
      let stopping = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let killHandle: NodeJS.Timeout | undefined;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let lineBuffer = Buffer.alloc(0);
      const stderrParts: Buffer[] = [];
      let rawEventCount = 0;
      let work = Promise.resolve();
      let primaryError: RunnerError | undefined;
      let parseHalted = false;

      let child;
      try {
        child = spawn(this.#command, args, {
          cwd: input.cwd,
          env: this.#parentEnv,
          shell: false,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch {
        reject(new RunnerError("RUNNER_SPAWN", "Unable to start the Codex process"));
        return;
      }

      const clearTimers = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (killHandle) clearTimeout(killHandle);
      };

      const settleReject = (error: RunnerError) => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(error);
      };

      const settleResolve = (result: AgentRunResult) => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve(result);
      };

      const forceStop = () => {
        if (stopping || childClosed) return;
        stopping = true;
        try { signalGroup(child.pid, "SIGTERM"); } catch { /* KILL attempt still follows */ }
        killHandle = setTimeout(() => {
          if (childClosed) return;
          try { signalGroup(child.pid, "SIGKILL"); } catch { /* close/error owns settlement */ }
        }, this.#killGraceMs);
      };

      const recordFailure = (error: RunnerError) => {
        if (!primaryError) primaryError = error;
        forceStop();
      };

      const storeFailureEvidence = (
        error: RunnerError,
        bytes: Uint8Array,
        mime = "text/plain; charset=utf-8"
      ) => {
        if (parseHalted) return;
        parseHalted = true;
        recordFailure(error);
        work = work.then(async () => {
          const artifact = await this.#evidence(bytes, mime);
          if (primaryError === error && artifact) {
            primaryError = new RunnerError(error.code, error.message, artifact);
          }
        });
      };

      const parseLine = (line: Buffer) => {
        const normalized = line.at(-1) === 13 ? line.subarray(0, -1) : line;
        if (normalized.byteLength === 0 || parseHalted || primaryError) return;
        if (normalized.byteLength > this.#maxLineBytes) {
          storeFailureEvidence(
            new RunnerError("RUNNER_STDOUT_LINE_TOO_LARGE", "Codex JSONL line exceeded the byte limit"),
            normalized.subarray(0, this.#maxLineBytes)
          );
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(normalized.toString("utf8"));
        } catch {
          storeFailureEvidence(new RunnerError("RUNNER_JSONL_INVALID", "Codex emitted invalid JSONL"), normalized);
          return;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          storeFailureEvidence(new RunnerError("RUNNER_JSONL_INVALID", "Codex emitted invalid JSONL"), normalized);
          return;
        }
        rawEventCount += 1;
        work = work.then(async () => {
          if (primaryError) return;
          try {
            await deliverEvent(onEvent, parsed as Record<string, unknown>, this.#callbackTimeoutMs);
          } catch (error) {
            recordFailure(error instanceof RunnerError
              ? error
              : new RunnerError("RUNNER_CALLBACK_FAILED", "The event callback failed"));
          }
        });
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (parseHalted || primaryError) return;
        const nextBytes = stdoutBytes + chunk.byteLength;
        if (nextBytes > this.#maxStdoutBytes) {
          const remaining = Math.max(0, this.#maxStdoutBytes - stdoutBytes);
          stdoutBytes = nextBytes;
          storeFailureEvidence(
            new RunnerError("RUNNER_STDOUT_TOO_LARGE", "Codex stdout exceeded the byte limit"),
            chunk.subarray(0, remaining)
          );
          return;
        }
        stdoutBytes = nextBytes;
        lineBuffer = Buffer.concat([lineBuffer, chunk]);
        let newline = lineBuffer.indexOf(10);
        while (newline >= 0 && !parseHalted && !primaryError) {
          const line = lineBuffer.subarray(0, newline);
          lineBuffer = lineBuffer.subarray(newline + 1);
          parseLine(line);
          newline = lineBuffer.indexOf(10);
        }
        if (!parseHalted && !primaryError && lineBuffer.byteLength > this.#maxLineBytes) {
          storeFailureEvidence(
            new RunnerError("RUNNER_STDOUT_LINE_TOO_LARGE", "Codex JSONL line exceeded the byte limit"),
            lineBuffer.subarray(0, this.#maxLineBytes)
          );
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = Math.max(0, this.#maxStderrBytes - stderrBytes);
        if (remaining > 0) stderrParts.push(chunk.subarray(0, remaining));
        stderrBytes += Math.min(remaining, chunk.byteLength);
      });

      child.once("error", () => {
        recordFailure(new RunnerError("RUNNER_SPAWN", "The Codex process failed to start"));
        settleReject(primaryError!);
      });

      timeoutHandle = setTimeout(() => {
        recordFailure(new RunnerError("RUNNER_TIMEOUT", "The Codex process exceeded its time limit"));
      }, input.timeout_ms);

      child.once("close", (code) => {
        childClosed = true;
        if (killHandle) clearTimeout(killHandle);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        void (async () => {
          if (settled) return;
          if (lineBuffer.byteLength > 0 && !primaryError) parseLine(lineBuffer);
          await work;
          if (primaryError) throw primaryError;
          if (code !== 0) {
            const error = new RunnerError("RUNNER_EXIT_NONZERO", "The Codex process exited unsuccessfully");
            const stderr = Buffer.concat(stderrParts);
            const artifact = stderr.byteLength > 0 ? await this.#evidence(stderr) : undefined;
            throw artifact ? new RunnerError(error.code, error.message, artifact) : error;
          }

          let output: Buffer;
          try {
            output = await readOwnedOutputFile(ownedOutput, this.#maxOutputBytes);
          } catch {
            throw new RunnerError("RUNNER_OUTPUT_INVALID", "Codex did not produce a valid owned output file");
          }
          let structured: unknown;
          try {
            structured = JSON.parse(output.toString("utf8"));
          } catch {
            const error = new RunnerError("RUNNER_OUTPUT_INVALID", "Codex final output is not valid JSON");
            const artifact = await this.#evidence(output, "application/json");
            throw artifact ? new RunnerError(error.code, error.message, artifact) : error;
          }
          settleResolve({ exit_code: 0, structured_output: structured, raw_event_count: rawEventCount });
        })().catch((error: unknown) => {
          settleReject(error instanceof RunnerError
            ? error
            : new RunnerError("RUNNER_SPAWN", "The Codex runner failed safely"));
        });
      });
    });
  }
}
