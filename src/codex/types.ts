import type { ArtifactRef, Phase, TraceEvent } from "../protocol/index.js";

export interface AgentRunInput {
  run_id: string;
  cwd: string;
  prompt: string;
  model: "gpt-5.6";
  sandbox: "read-only" | "workspace-write";
  output_schema_path: string;
  output_path: string;
  timeout_ms: number;
  /**
   * The runner validates this allowlisted environment only. Task 9's orchestrator
   * must provide a synthetic HOME and a PATH containing the fault wrapper plus
   * the required Git, Node, and shell tool directories.
   */
  tool_env?: Record<string, string>;
}

export interface AgentRunResult {
  exit_code: 0;
  structured_output: unknown;
  raw_event_count: number;
}

export interface AgentEventDelivery {
  /** Aborted synchronously before a timed-out or failed delivery is rejected. */
  readonly signal: AbortSignal;
  /**
   * Atomically guards externally visible mutation while this delivery is active.
   * The operation must finish synchronously and must not return a Promise.
   * Task 9 must synchronously enqueue finalized raw/normalized records here,
   * then await its own persistence queue before computing the verdict.
   */
  commit<T>(operation: () => T): T;
}

/**
 * A handler may perform asynchronous preparation, but every externally visible
 * mutation or enqueue must occur inside synchronous `delivery.commit`. Direct
 * side effects outside that guard cannot be revoked or policed by JavaScript.
 */
export type AgentEventHandler = (
  event: Record<string, unknown>,
  delivery: AgentEventDelivery
) => void | Promise<void>;

export interface AgentRunner {
  run(input: AgentRunInput, onEvent: AgentEventHandler): Promise<AgentRunResult>;
}

export interface ArtifactSink {
  /**
   * Implementations should cooperatively observe `signal`. A third-party sink
   * may still finish after abort; such a content-addressed blob is unreferenced
   * and must not mutate the persisted Trace.
   */
  put(
    data: Uint8Array,
    metadata: { mime: string; redacted: boolean },
    options: { signal: AbortSignal }
  ): Promise<{ ref: ArtifactRef }>;
}

export interface NormalizeContext {
  run_id: string;
  phase: Phase;
  next_seq: number;
  artifact_sink?: ArtifactSink;
  /** Bounds each artifact write; cancellation support is cooperative. */
  artifact_sink_timeout_ms?: number;
  max_inline_output_bytes?: number;
}

export type NormalizedEvents = TraceEvent[];

export interface PreflightCheck {
  id: "codex-version" | "codex-login" | "git-version" | "app-data";
  ok: boolean;
  message: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  model: {
    target: "gpt-5.6";
    status: "configured-unverified";
  };
}
