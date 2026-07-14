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
  tool_env?: Record<string, string>;
}

export interface AgentRunResult {
  exit_code: 0;
  structured_output: unknown;
  raw_event_count: number;
}

export type AgentEventHandler = (event: Record<string, unknown>) => void | Promise<void>;

export interface AgentRunner {
  run(input: AgentRunInput, onEvent: AgentEventHandler): Promise<AgentRunResult>;
}

export interface ArtifactSink {
  put(
    data: Uint8Array,
    metadata: { mime: string; redacted: boolean }
  ): Promise<{ ref: ArtifactRef }>;
}

export interface NormalizeContext {
  run_id: string;
  phase: Phase;
  next_seq: number;
  artifact_sink?: ArtifactSink;
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
