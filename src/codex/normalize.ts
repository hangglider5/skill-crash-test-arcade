import { TraceEventSchema, type TraceEvent } from "../protocol/index.js";
import type { NormalizeContext } from "./types.js";

export type NormalizerArtifactErrorCode =
  | "NORMALIZER_ARTIFACT_REQUIRED"
  | "NORMALIZER_ARTIFACT_REJECTED"
  | "NORMALIZER_ARTIFACT_TIMEOUT";

export class NormalizerArtifactError extends Error {
  readonly code: NormalizerArtifactErrorCode;

  constructor(code: NormalizerArtifactErrorCode, message: string) {
    super(message);
    this.name = "NormalizerArtifactError";
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Tokenizes for display only. This function never invokes a shell. */
export function normalizeCommand(command: unknown): string[] {
  if (Array.isArray(command)) {
    return command.filter((part): part is string => typeof part === "string");
  }
  if (typeof command !== "string") return [];

  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let active = false;
  for (const character of command) {
    if (escaping) {
      token += character;
      escaping = false;
      active = true;
    } else if (character === "\\" && quote !== "'") {
      escaping = true;
      active = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      active = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      active = true;
    } else if (/\s/u.test(character)) {
      if (active) {
        tokens.push(token);
        token = "";
        active = false;
      }
    } else {
      token += character;
      active = true;
    }
  }
  if (escaping) token += "\\";
  if (active) tokens.push(token);
  return tokens;
}

function safeUsage(value: unknown): Record<string, number> | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  const usage: Record<string, number> = {};
  for (const key of ["input_tokens", "cached_input_tokens", "output_tokens"] as const) {
    const amount = finiteNumber(candidate[key]);
    if (amount !== undefined && amount >= 0) usage[key] = amount;
  }
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function safeRawProjection(raw: Record<string, unknown>): Record<string, unknown> {
  const item = record(raw.item);
  const projected: Record<string, unknown> = {};
  const rawType = text(raw.type);
  const threadId = text(raw.thread_id);
  const itemId = text(item?.id);
  const itemType = text(item?.type);
  const status = text(raw.status) ?? text(item?.status);
  const usage = safeUsage(raw.usage);
  if (rawType) projected.raw_type = rawType;
  if (threadId) projected.thread_id = threadId;
  if (itemId) projected.item_id = itemId;
  if (itemType) projected.item_type = itemType;
  if (status) projected.status = status;
  if (usage) projected.usage = usage;
  return projected;
}

function buildEvent(
  context: NormalizeContext,
  kind: TraceEvent["kind"],
  actor: TraceEvent["actor"],
  data: Record<string, unknown>,
  spanId?: string,
  artifacts: TraceEvent["artifacts"] = []
): TraceEvent {
  const event = TraceEventSchema.parse({
    v: 1,
    run_id: context.run_id,
    seq: context.next_seq,
    phase: context.phase,
    kind,
    actor,
    ...(spanId ? { span_id: spanId } : {}),
    data,
    artifacts
  });
  context.next_seq += 1;
  return event;
}

async function storeArtifact(
  output: string,
  context: NormalizeContext
): Promise<TraceEvent["artifacts"][number]> {
  const sink = context.artifact_sink;
  if (!sink) {
    throw new NormalizerArtifactError(
      "NORMALIZER_ARTIFACT_REQUIRED",
      "An artifact sink is required for oversized command output"
    );
  }

  const timeoutMs = context.artifact_sink_timeout_ms ?? 5_000;
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = (error: NormalizerArtifactError) => {
      if (settled) return;
      settled = true;
      controller.abort();
      clearTimeout(timeoutHandle);
      reject(error);
    };
    const timeoutHandle = setTimeout(() => {
      finishReject(new NormalizerArtifactError(
        "NORMALIZER_ARTIFACT_TIMEOUT",
        "The artifact sink exceeded its time limit"
      ));
    }, Math.max(0, timeoutMs));

    Promise.resolve().then(() => sink.put(
      Buffer.from(output),
      { mime: "text/plain; charset=utf-8", redacted: false },
      { signal: controller.signal }
    )).then(
      (stored) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve(stored.ref);
      },
      () => {
        finishReject(new NormalizerArtifactError(
          "NORMALIZER_ARTIFACT_REJECTED",
          "The artifact sink rejected the command output"
        ));
      }
    );
  });
}

const contextQueues = new WeakMap<NormalizeContext, Promise<void>>();

async function normalizeOne(
  candidate: unknown,
  context: NormalizeContext
): Promise<TraceEvent[]> {
  const raw = record(candidate) ?? {};
  const type = text(raw.type);
  const item = record(raw.item);
  const itemType = text(item?.type);
  const itemId = text(item?.id);

  if (type === "thread.started") {
    const threadId = text(raw.thread_id);
    return [buildEvent(context, "run.started", "codex", threadId ? { thread_id: threadId } : {})];
  }

  if (type === "item.started" && itemType === "command_execution") {
    return [buildEvent(
      context,
      "process.started",
      "codex",
      { argv: normalizeCommand(item?.command), ...(text(item?.status) ? { status: text(item?.status) } : {}) },
      itemId
    )];
  }

  if (type === "item.completed" && itemType === "command_execution") {
    const output = text(item?.aggregated_output);
    const artifacts: TraceEvent["artifacts"] = [];
    const data: Record<string, unknown> = {
      argv: normalizeCommand(item?.command),
      ...(finiteNumber(item?.exit_code) !== undefined ? { exit_code: finiteNumber(item?.exit_code) } : {}),
      ...(text(item?.status) ? { status: text(item?.status) } : {})
    };
    const inlineLimit = context.max_inline_output_bytes ?? 16 * 1024;
    if (output !== undefined) {
      if (Buffer.byteLength(output) > inlineLimit && !context.artifact_sink) {
        throw new NormalizerArtifactError(
          "NORMALIZER_ARTIFACT_REQUIRED",
          "An artifact sink is required for oversized command output"
        );
      }
      if (Buffer.byteLength(output) > inlineLimit && context.artifact_sink) {
        artifacts.push(await storeArtifact(output, context));
      } else {
        data.aggregated_output = output;
      }
    }
    return [buildEvent(context, "process.exited", "codex", data, itemId, artifacts)];
  }

  if (type === "item.completed" && itemType === "agent_message") {
    const message = text(item?.text);
    return [buildEvent(
      context,
      "agent.claimed",
      "gpt-5.6",
      message === undefined ? {} : { text: message },
      itemId
    )];
  }

  if (type === "turn.completed") {
    const usage = safeUsage(raw.usage);
    return [buildEvent(context, "run.finished", "codex", usage ? { usage } : {})];
  }

  return [buildEvent(context, "runner.raw", "codex", safeRawProjection(raw), itemId)];
}

export function normalizeCodexEvent(
  candidate: unknown,
  context: NormalizeContext
): Promise<TraceEvent[]> {
  const previous = contextQueues.get(context) ?? Promise.resolve();
  const result = previous.then(
    () => normalizeOne(candidate, context),
    () => normalizeOne(candidate, context)
  );
  const tail = result.then(() => undefined, () => undefined);
  contextQueues.set(context, tail);
  void tail.then(() => {
    if (contextQueues.get(context) === tail) contextQueues.delete(context);
  });
  return result;
}
