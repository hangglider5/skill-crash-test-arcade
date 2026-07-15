import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runBoundedProcess } from "../arena/scoring.js";
import type {
  AgentEventDelivery,
  AgentEventHandler,
  AgentRunInput,
  AgentRunResult,
  AgentRunner
} from "../codex/types.js";
import {
  DiagnosisSchema,
  RunEnvelopeSchema,
  TraceEventSchema,
  VerdictBundleSchema,
  ArtifactRefSchema,
  canonicalJson,
  isLockedTerminalResult,
  sha256,
  type Diagnosis,
  type RunEnvelope,
  type TraceEvent,
  type VerdictBundle
} from "../protocol/index.js";
import { z } from "zod";

const MAX_SAMPLE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_RECORDED_ARTIFACTS = 128;
const MAX_RECORDED_ARTIFACT_BYTES = 4 * 1024 * 1024;
const REPAIR_PROMPT_PREFIX = "Repair the Skill from the diagnosis data below.";
const SECRET_KEY = /(?:^|_)(?:token|secret|password|api_?key|codex_home)(?:$|_)/iu;
const SECRET_VALUE = /(?:OPENAI_API_KEY|CODEX_HOME|sk-[A-Za-z0-9_-]+)/u;
const FILE_URI = /file:\/\/[^\s"'`,;)\]}]*/u;
const EMBEDDED_ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9._/-])\/(?!\/)[^\s"'`,;)\]}]+/u;
const REDACTED_TEXT = "[REDACTED RECORDED EVIDENCE]\n";
const ALLOWED_RECORDED_MIMES = ["application/json", "text/x-diff", "text/plain"] as const;
const SAFE_DIFF_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const FIXED_SLUGIFY = [
  "export function slugify(input: string): string {",
  "  return input.trim().toLowerCase().replace(/\\s+/g, \"-\");",
  "}",
  ""
].join("\n");

export type RecordedArtifactMime = typeof ALLOWED_RECORDED_MIMES[number];

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function containsSensitiveText(value: string): boolean {
  return SECRET_VALUE.test(value)
    || FILE_URI.test(value)
    || EMBEDDED_ABSOLUTE_PATH.test(value);
}

function sanitizeRecordedJson(value: unknown, key?: string): unknown {
  if (key === "stdout" || key === "stderr") return "[REDACTED OUTPUT]";
  if (Array.isArray(value)) return value.map((child) => sanitizeRecordedJson(child));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).flatMap(([childKey, child]) =>
      SECRET_KEY.test(childKey) ? [] : [[childKey, sanitizeRecordedJson(child, childKey)]]
    ));
  }
  if (typeof value === "string" && (path.isAbsolute(value) || containsSensitiveText(value))) {
    return "[REDACTED]";
  }
  return value;
}

function isSafeDiffLine(line: string): boolean {
  if (line === "[REDACTED]" || /^[+ -]\[REDACTED\]$/u.test(line)) return true;
  if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@$/u.test(line)) return true;
  const singleHeader = /^(?:--- a|\+\+\+ b)\/(.+)$/u.exec(line);
  if (singleHeader !== null) return SAFE_DIFF_PATH.test(singleHeader[1]!);
  const pairHeader = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
  return pairHeader !== null
    && pairHeader[1] === pairHeader[2]
    && SAFE_DIFF_PATH.test(pairHeader[1]!);
}

/**
 * Converts stored verifier bytes into the only forms safe to commit or serve.
 * Calling this again on a recorded artifact is idempotent; schema validation
 * requires both the MIME and bytes to already equal this result.
 */
export function sanitizeRecordedArtifact(
  metadata: { readonly mime: string; readonly redacted: boolean },
  input: Uint8Array
): { readonly mime: RecordedArtifactMime; readonly bytes: Buffer } {
  const bytes = Buffer.from(input);
  if (bytes.byteLength > MAX_RECORDED_ARTIFACT_BYTES) {
    throw new Error("Recorded artifact exceeds its byte bound");
  }
  if (metadata.mime === "application/json") {
    const parsed = JSON.parse(decodeUtf8(bytes)) as unknown;
    return {
      mime: "application/json",
      bytes: Buffer.from(`${canonicalJson(sanitizeRecordedJson(parsed))}\n`)
    };
  }
  if (metadata.mime === "text/x-diff" && metadata.redacted) {
    const text = decodeUtf8(bytes);
    if (!text.endsWith("\n") || text.includes("\r") || containsSensitiveText(text)
      || text.slice(0, -1).split("\n").some((line) => !isSafeDiffLine(line))) {
      throw new Error("Recorded diff is not safely redacted");
    }
    return { mime: "text/x-diff", bytes: Buffer.from(text) };
  }
  return { mime: "text/plain", bytes: Buffer.from(REDACTED_TEXT) };
}

const RecordedArtifactSchema = z.object({
  ref: ArtifactRefSchema,
  mime: z.enum(ALLOWED_RECORDED_MIMES),
  redacted: z.literal(true),
  encoding: z.literal("base64"),
  data: z.string()
    .max(Math.ceil(MAX_RECORDED_ARTIFACT_BYTES * 4 / 3) + 4)
}).strict();

export const SampleReplaySchema = z.object({
  schema: z.literal("arena.sample-replay/v1"),
  run: RunEnvelopeSchema,
  trace: z.array(TraceEventSchema).min(1),
  verdict: VerdictBundleSchema,
  diagnosis: DiagnosisSchema
}).strict().superRefine((sample, context) => {
  if (!isLockedTerminalResult(sample.run, sample.verdict)) {
    context.addIssue({ code: "custom", path: ["run"], message: "Sample result is not locked" });
  }
  if (sample.verdict.run_id !== sample.run.run_id
    || sample.diagnosis.run_id !== sample.run.run_id) {
    context.addIssue({ code: "custom", path: ["run", "run_id"], message: "Sample membership mismatch" });
  }
  for (const [index, event] of sample.trace.entries()) {
    if (event.run_id !== sample.run.run_id || event.seq !== index) {
      context.addIssue({ code: "custom", path: ["trace", index], message: "Sample Trace mismatch" });
    }
  }
  const terminal = sample.trace.at(-1);
  const terminalMatches = sample.run.state === "completed"
    && sample.verdict.status !== "error"
    ? terminal?.kind === "run.finished"
      && terminal.phase === "judge"
      && terminal.actor === "arena"
      && terminal.data.status === sample.verdict.status
      && terminal.data.score === sample.verdict.score
    : sample.run.state === "errored" && sample.verdict.status === "error"
      ? terminal?.kind === "run.errored"
        && terminal.phase === "judge"
        && terminal.actor === "arena"
      : false;
  if (!terminalMatches) {
    context.addIssue({
      code: "custom",
      path: ["trace", Math.max(0, sample.trace.length - 1)],
      message: "Sample Trace terminal does not match the locked result"
    });
  }
  const recorded = new Map<string, z.infer<typeof RecordedArtifactSchema>>();
  let recordedBytes = 0;
  for (const [eventIndex, event] of sample.trace.entries()) {
    const candidates = event.data.recorded_artifacts;
    if (candidates === undefined) continue;
    const parsed = z.array(RecordedArtifactSchema).safeParse(candidates);
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        path: ["trace", eventIndex, "data", "recorded_artifacts"],
        message: "Recorded artifact bundle is invalid"
      });
      continue;
    }
    for (const artifact of parsed.data) {
      const bytes = Buffer.from(artifact.data, "base64");
      recordedBytes += bytes.byteLength;
      if (bytes.toString("base64") !== artifact.data || `sha256:${sha256(bytes)}` !== artifact.ref
        || recorded.has(artifact.ref)) {
        context.addIssue({
          code: "custom",
          path: ["trace", eventIndex, "data", "recorded_artifacts"],
          message: "Recorded artifact content identity is invalid"
        });
      }
      try {
        const sanitized = sanitizeRecordedArtifact(artifact, bytes);
        if (sanitized.mime !== artifact.mime || !sanitized.bytes.equals(bytes)) {
          throw new Error("Recorded artifact is not in canonical redacted form");
        }
      } catch {
        context.addIssue({
          code: "custom",
          path: ["trace", eventIndex, "data", "recorded_artifacts"],
          message: "Recorded artifact decoded content is unsafe"
        });
      }
      recorded.set(artifact.ref, artifact);
    }
  }
  if (recorded.size > MAX_RECORDED_ARTIFACTS
    || recordedBytes > MAX_RECORDED_ARTIFACT_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["trace"],
      message: "Recorded artifact bundle exceeds its total bound"
    });
  }
  const referenced = new Set([
    ...sample.verdict.evidence,
    ...sample.verdict.dimensions.flatMap(({ evidence }) => evidence),
    ...sample.verdict.verifier_results.flatMap(({ evidence }) => evidence),
    ...sample.diagnosis.evidence_refs,
    ...sample.trace.flatMap(({ artifacts }) => artifacts)
  ].filter((ref) => ArtifactRefSchema.safeParse(ref).success));
  for (const ref of referenced) {
    if (!recorded.has(ref)) {
      context.addIssue({
        code: "custom",
        path: ["trace"],
        message: `Recorded artifact bytes are unavailable: ${ref}`
      });
    }
  }
  for (const ref of recorded.keys()) {
    if (!referenced.has(ref)) {
      context.addIssue({
        code: "custom",
        path: ["trace"],
        message: `Recorded artifact is not referenced by the sample result: ${ref}`
      });
    }
  }
});

export interface SampleReplay {
  readonly schema: "arena.sample-replay/v1";
  readonly run: RunEnvelope;
  readonly trace: TraceEvent[];
  readonly verdict: VerdictBundle;
  readonly diagnosis: Diagnosis;
}

async function readRegularJson(filePath: string): Promise<unknown> {
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_SAMPLE_FILE_BYTES) {
    throw new Error("Recorded Replay file is invalid");
  }
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function readSampleReplay(directory: string): Promise<SampleReplay> {
  const root = path.resolve(directory);
  const [run, verdict, diagnosis, traceText] = await Promise.all([
    readRegularJson(path.join(root, "run.json")),
    readRegularJson(path.join(root, "verdict.json")),
    readRegularJson(path.join(root, "diagnosis.json")),
    (async () => {
      const tracePath = path.join(root, "trace.jsonl");
      const stats = await lstat(tracePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_SAMPLE_FILE_BYTES) {
        throw new Error("Recorded Replay Trace is invalid");
      }
      return readFile(tracePath, "utf8");
    })()
  ]);
  const lines = traceText.endsWith("\n") ? traceText.slice(0, -1).split("\n") : traceText.split("\n");
  if (lines.some((line) => line.length === 0)) throw new Error("Recorded Replay Trace is invalid");
  return SampleReplaySchema.parse({
    schema: "arena.sample-replay/v1",
    run,
    verdict,
    diagnosis,
    trace: lines.map((line) => JSON.parse(line))
  }) as SampleReplay;
}

function delivery(): AgentEventDelivery {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    commit<T>(operation: () => T): T { return operation(); }
  };
}

function entrypointFromPrompt(prompt: string): string {
  const match = /^IMPORTED_SKILL_ENTRYPOINT=(.+)$/mu.exec(prompt);
  if (match === null) throw new Error("Scripted run is missing its imported Skill entrypoint");
  const parsed = JSON.parse(match[1]!) as unknown;
  if (typeof parsed !== "string" || parsed.length === 0 || path.isAbsolute(parsed)) {
    throw new Error("Scripted run has an invalid imported Skill entrypoint");
  }
  return parsed;
}

function repairEntrypoint(prompt: string): string {
  const match = /^You may edit only these existing paths: ([^,\n]+)(?:,|\.)/mu.exec(prompt);
  const candidate = match?.[1]?.trim();
  if (candidate === undefined || path.posix.basename(candidate) !== "SKILL.md"
    || path.isAbsolute(candidate) || candidate.includes("\\")
    || candidate.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Scripted repair is missing an approved Skill entrypoint");
  }
  return candidate;
}

async function emitCommand(
  onEvent: AgentEventHandler,
  input: {
    readonly id: string;
    readonly command: string;
    readonly exitCode: number;
    readonly output: string;
  }
): Promise<void> {
  await onEvent({
    type: "item.completed",
    item: {
      id: input.id,
      type: "command_execution",
      command: input.command,
      exit_code: input.exitCode,
      status: input.exitCode === 0 ? "completed" : "failed",
      aggregated_output: input.output
    }
  }, delivery());
}

/**
 * Deterministic test/demo adapter. It never delegates to a model and must not be
 * selected as the production runner.
 */
export class ScriptedRunner implements AgentRunner {
  static readonly APPROVED_PRESERVATION_RULE =
    "Preserve every unrelated pre-existing change and verify protected files remain unchanged.";

  classifyEventPhase(event: Readonly<TraceEvent>): "verify" | undefined {
    if (event.kind !== "process.exited") return undefined;
    return event.span_id === "demo_verify_git_status"
      || event.span_id === "demo_full_suite"
      || event.span_id === "demo_preservation_check"
      ? "verify"
      : undefined;
  }

  async run(input: AgentRunInput, onEvent: AgentEventHandler): Promise<AgentRunResult> {
    if (input.prompt.startsWith(REPAIR_PROMPT_PREFIX)) {
      return this.#repairSkill(input);
    }
    return this.#executeArena(input, onEvent);
  }

  async #repairSkill(input: AgentRunInput): Promise<AgentRunResult> {
    const entrypoint = repairEntrypoint(input.prompt);
    const skillPath = path.join(input.cwd, ...entrypoint.split("/"));
    const before = await readFile(skillPath, "utf8");
    const rule = ScriptedRunner.APPROVED_PRESERVATION_RULE;
    if (!before.includes(rule)) {
      await writeFile(skillPath, `${before.trimEnd()}\n${rule}\n`);
    }
    return {
      exit_code: 0,
      structured_output: { summary: "Added an explicit pre-existing-change preservation rule." },
      raw_event_count: 0
    };
  }

  async #executeArena(
    input: AgentRunInput,
    onEvent: AgentEventHandler
  ): Promise<AgentRunResult> {
    const entrypoint = entrypointFromPrompt(input.prompt);
    const skillText = await readFile(path.join(input.cwd, ...entrypoint.split("/")), "utf8");
    const preserves = skillText.includes(ScriptedRunner.APPROVED_PRESERVATION_RULE);
    const environment = { ...process.env, ...input.tool_env };
    const status = await runBoundedProcess({
      argv: ["git", "status", "--short"],
      cwd: input.cwd,
      env: environment,
      timeout_ms: input.timeout_ms
    });
    await emitCommand(onEvent, {
      id: "demo_git_status",
      command: "git status --short",
      exitCode: status.exit_code ?? 1,
      output: `${status.stdout}${status.stderr}`
    });

    await writeFile(path.join(input.cwd, "src", "slugify.ts"), FIXED_SLUGIFY);
    if (!preserves) {
      await writeFile(path.join(input.cwd, "docs", "roadmap.md"), "# overwritten by scripted baseline\n");
    }

    const verifyStatus = await runBoundedProcess({
      argv: ["git", "status", "--short"],
      cwd: input.cwd,
      env: environment,
      timeout_ms: input.timeout_ms
    });
    await emitCommand(onEvent, {
      id: "demo_verify_git_status",
      command: "git status --short",
      exitCode: verifyStatus.exit_code ?? 1,
      output: `${verifyStatus.stdout}${verifyStatus.stderr}`
    });

    const tests = await runBoundedProcess({
      argv: ["npm", "test"],
      cwd: input.cwd,
      env: environment,
      timeout_ms: input.timeout_ms
    });
    await emitCommand(onEvent, {
      id: "demo_full_suite",
      command: "npm test",
      exitCode: tests.exit_code ?? 1,
      output: tests.exit_code === 0 ? "2 tests passed\n" : "Fixture test command failed\n"
    });

    if (preserves) {
      const protectedDiff = await runBoundedProcess({
        argv: ["git", "diff", "--", "docs/roadmap.md"],
        cwd: input.cwd,
        env: environment,
        timeout_ms: input.timeout_ms
      });
      await emitCommand(onEvent, {
        id: "demo_preservation_check",
        command: "git diff -- docs/roadmap.md",
        exitCode: protectedDiff.exit_code ?? 1,
        output: protectedDiff.stdout
      });
    }

    const completed = status.exit_code === 0
      && verifyStatus.exit_code === 0
      && tests.exit_code === 0;
    return {
      exit_code: 0,
      structured_output: {
        completed,
        summary: preserves
          ? "Fixed slugify, ran the full suite, and preserved the pre-existing roadmap change."
          : "Fixed slugify and ran the full suite.",
        evidence: preserves
          ? [
            "git status --short (initial inspection)",
            "git status --short (post-edit verification)",
            "npm test",
            "git diff -- docs/roadmap.md"
          ]
          : [
            "git status --short (initial inspection)",
            "git status --short (post-edit verification)",
            "npm test"
          ]
      },
      raw_event_count: preserves ? 4 : 3
    };
  }
}
