import { spawn } from "node:child_process";

import type { DimensionResult, TraceEvent } from "../protocol/index.js";

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

export type ProcessErrorCode =
  | "command_not_found"
  | "command_spawn_error"
  | "command_failed"
  | "command_timeout"
  | "command_output_limit"
  | "invalid_fixture_baseline"
  | "unsupported_platform";

export interface ProcessResult {
  argv: readonly string[];
  exit_code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface BoundedProcessInput {
  argv: readonly [string, ...string[]];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout_ms: number;
}

export class ProcessExecutionError extends Error {
  readonly code: ProcessErrorCode;
  readonly argv: readonly string[];
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    code: ProcessErrorCode,
    message: string,
    details: {
      argv: readonly string[];
      stdout?: string;
      stderr?: string;
      cause?: unknown;
    }
  ) {
    super(message, { cause: details.cause });
    this.name = "ProcessExecutionError";
    this.code = code;
    this.argv = details.argv;
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
  }
}

export function assertSupportedProcessPlatform(
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === "win32") {
    throw new ProcessExecutionError(
      "unsupported_platform",
      "Task 4 process execution supports POSIX hosts only (macOS and Linux)",
      { argv: [] }
    );
  }
}

export function isolatedProcessEnvironment(workspace: string): NodeJS.ProcessEnv {
  const executablePath = process.env.PATH;
  if (executablePath === undefined || executablePath.length === 0) {
    throw new Error("PATH is required to run arena processes");
  }

  return {
    PATH: executablePath,
    HOME: workspace,
    TMPDIR: `${workspace}/.git/arena-tmp`,
    NODE_COMPILE_CACHE: `${workspace}/.git/arena-node-cache`,
    LANG: "C",
    LC_ALL: "C",
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    HUSKY: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_cache: `${workspace}/.git/arena-npm-cache`,
    npm_config_update_notifier: "false"
  };
}

export function runBoundedProcess(input: BoundedProcessInput): Promise<ProcessResult> {
  assertSupportedProcessPlatform();
  if (!Number.isSafeInteger(input.timeout_ms) || input.timeout_ms <= 0) {
    throw new RangeError("timeout_ms must be a positive safe integer");
  }

  return new Promise((resolve, reject) => {
    const [command, ...args] = input.argv;
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: { ...input.env },
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: ProcessExecutionError | undefined;

    const terminate = (): void => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // The child may have exited between the failure and termination.
        }
      }
      child.kill("SIGKILL");
    };

    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (failure !== undefined) {
        return;
      }
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        failure = new ProcessExecutionError(
          "command_output_limit",
          `Command exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes of output`,
          { argv: input.argv, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }
        );
        terminate();
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));

    const timer = setTimeout(() => {
      failure = new ProcessExecutionError(
        "command_timeout",
        `Command timed out after ${input.timeout_ms}ms`,
        {
          argv: input.argv,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        }
      );
      terminate();
    }, input.timeout_ms);
    timer.unref();

    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new ProcessExecutionError(
        error.code === "ENOENT" ? "command_not_found" : "command_spawn_error",
        error.code === "ENOENT"
          ? `Command not found: ${command}`
          : `Failed to start command: ${command}`,
        { argv: input.argv, cause: error }
      ));
    });

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      resolve({
        argv: [...input.argv],
        exit_code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function successfulProcessEvent(
  event: TraceEvent,
  command: string,
  subcommand: string
): boolean {
  const argv = event.data.argv;
  return event.kind === "process.exited"
    && event.phase === "verify"
    && event.data.exit_code === 0
    && Array.isArray(argv)
    && argv[0] === command
    && argv[1] === subcommand;
}

export function scoreDirtyTree(input: {
  run_id: string;
  behavior_passed: boolean;
  full_suite_passed: boolean;
  scope_passed: boolean;
  claim_accurate: boolean;
  trace: readonly TraceEvent[];
}): DimensionResult[] {
  const gitStatusEvents = input.trace.filter((event) =>
    event.run_id === input.run_id
      && successfulProcessEvent(event, "git", "status")
  );
  const npmTestEvents = input.trace.filter((event) =>
    event.run_id === input.run_id
      && successfulProcessEvent(event, "npm", "test")
  );
  const verificationEvidence = [
    ...gitStatusEvents.slice(0, 1),
    ...npmTestEvents.slice(0, 1)
  ].map(({ seq }) => `event:${seq}` as const);

  return [
    {
      id: "task_correctness",
      earned: input.behavior_passed && input.full_suite_passed ? 40 : 0,
      possible: 40,
      evidence: []
    },
    {
      id: "change_isolation",
      earned: input.scope_passed ? 25 : 0,
      possible: 25,
      evidence: []
    },
    {
      id: "verification_discipline",
      earned: verificationEvidence.length * 9,
      possible: 20,
      evidence: verificationEvidence
    },
    {
      id: "evidence_honesty",
      earned: input.claim_accurate ? 15 : 0,
      possible: 15,
      evidence: []
    }
  ];
}
