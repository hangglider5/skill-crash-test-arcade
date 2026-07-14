import { describe, expect, it } from "vitest";

import { NormalizerArtifactError, normalizeCodexEvent } from "../../src/codex/normalize.js";
import type { ArtifactSink, NormalizeContext } from "../../src/codex/types.js";

class RecordingSink implements ArtifactSink {
  readonly texts: string[] = [];
  async put(data: Uint8Array) {
    this.texts.push(Buffer.from(data).toString("utf8"));
    return { ref: `sha256:${String(this.texts.length).padStart(64, "a")}` as const };
  }
}

function context(overrides: Partial<NormalizeContext> = {}): NormalizeContext {
  return { run_id: "run_01", phase: "verify", next_seq: 4, ...overrides };
}

describe("normalizeCodexEvent", () => {
  it("maps required events, assigns contiguous sequence, and preserves run identity", async () => {
    const ctx = context();
    const raw = [
      { type: "thread.started", thread_id: "thread_fake" },
      { type: "item.started", item: { id: "cmd_1", type: "command_execution", command: "git status --short", status: "in_progress" } },
      { type: "item.completed", item: { id: "cmd_1", type: "command_execution", command: "git status --short", aggregated_output: "ok", exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "msg_1", type: "agent_message", text: "Task complete", reasoning: "hidden" } },
      { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 10 } }
    ];
    const events = [];
    for (const item of raw) events.push(...await normalizeCodexEvent(item, ctx));
    expect(events.map((event) => event.kind)).toEqual(["run.started", "process.started", "process.exited", "agent.claimed", "run.finished"]);
    expect(events.map((event) => event.seq)).toEqual([4, 5, 6, 7, 8]);
    expect(events.every((event) => event.run_id === "run_01")).toBe(true);
    expect(events[2]?.data).toMatchObject({ argv: ["git", "status", "--short"], exit_code: 0 });
    expect(events[3]?.data).toEqual({ text: "Task complete" });
    expect(JSON.stringify(events[3])).not.toContain("hidden");
  });

  it("normalizes command strings without shell evaluation", async () => {
    const marker = "/tmp/must-not-exist-from-normalizer";
    const [event] = await normalizeCodexEvent({
      type: "item.started",
      item: { id: "cmd", type: "command_execution", command: `printf x > ${marker}; echo '$HOME'` }
    }, context());
    expect(event?.data.argv).toEqual(["printf", "x", ">", marker + ";", "echo", "$HOME"]);
  });

  it("artifacts large command output before emitting Trace", async () => {
    const sink = new RecordingSink();
    const [event] = await normalizeCodexEvent({
      type: "item.completed",
      item: { id: "cmd", type: "command_execution", command: "test", aggregated_output: "x".repeat(50), exit_code: 1 }
    }, context({ artifact_sink: sink, max_inline_output_bytes: 16 }));
    expect(event?.data).not.toHaveProperty("aggregated_output");
    expect(event?.artifacts).toHaveLength(1);
    expect(sink.texts).toEqual(["x".repeat(50)]);
  });

  it("refuses to emit oversized command output when no artifact sink is available", async () => {
    await expect(normalizeCodexEvent({
      type: "item.completed",
      item: { id: "cmd", type: "command_execution", command: "test", aggregated_output: "x".repeat(50), exit_code: 1 }
    }, context({ max_inline_output_bytes: 16 })))
      .rejects.toMatchObject({ code: "NORMALIZER_ARTIFACT_REQUIRED" });
  });

  it("projects unknown events to safe metadata without reasoning or text", async () => {
    const [event] = await normalizeCodexEvent({
      type: "mystery.event",
      thread_id: "thread_1",
      item: { id: "item_1", type: "reasoning", text: "secret", reasoning: "hidden" },
      text: "secret too",
      usage: { input_tokens: 3 }
    }, context());
    expect(event?.kind).toBe("runner.raw");
    expect(event?.data).toEqual({ raw_type: "mystery.event", thread_id: "thread_1", item_id: "item_1", item_type: "reasoning", usage: { input_tokens: 3 } });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(JSON.stringify(event)).not.toContain("hidden");
  });

  it("serializes concurrent calls per context while a prior artifact sink is slow", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sink: ArtifactSink = {
      put: async () => {
        await gate;
        return { ref: `sha256:${"b".repeat(64)}` as const };
      }
    };
    const ctx = context({ artifact_sink: sink, max_inline_output_bytes: 4 });
    const first = normalizeCodexEvent({
      type: "item.completed",
      item: { id: "first", type: "command_execution", command: "first", aggregated_output: "slow output", exit_code: 0 }
    }, ctx);
    const second = normalizeCodexEvent({ type: "thread.started", thread_id: "second" }, ctx);

    let secondSettled = false;
    void second.finally(() => { secondSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondSettled).toBe(false);
    release();

    const [[firstEvent], [secondEvent]] = await Promise.all([first, second]);
    expect([firstEvent?.seq, secondEvent?.seq]).toEqual([4, 5]);
    expect([firstEvent?.span_id, secondEvent?.data.thread_id]).toEqual(["first", "second"]);
    expect(ctx.next_seq).toBe(6);
  });

  it("does not let one concurrent normalization failure poison a later call", async () => {
    const sink: ArtifactSink = { put: async () => { throw new Error("sink failed"); } };
    const ctx = context({ artifact_sink: sink, max_inline_output_bytes: 4 });
    const first = normalizeCodexEvent({
      type: "item.completed",
      item: { id: "first", type: "command_execution", command: "first", aggregated_output: "too large", exit_code: 0 }
    }, ctx);
    const second = normalizeCodexEvent({ type: "thread.started", thread_id: "second" }, ctx);
    await expect(first).rejects.toMatchObject({ code: "NORMALIZER_ARTIFACT_REJECTED" });
    await expect(second).resolves.toMatchObject([{ seq: 4, kind: "run.started" }]);
    expect(ctx.next_seq).toBe(5);
  });

  it("maps a rejecting artifact sink to a typed safe error and accepts the next sink write", async () => {
    let calls = 0;
    const sink: ArtifactSink = {
      put: async () => {
        calls += 1;
        if (calls === 1) throw new Error("private bucket and credential details");
        return { ref: `sha256:${"c".repeat(64)}` as const };
      }
    };
    const ctx = context({ artifact_sink: sink, max_inline_output_bytes: 4 });
    const raw = (id: string) => ({
      type: "item.completed",
      item: { id, type: "command_execution", command: id, aggregated_output: "large output", exit_code: 0 }
    });

    let caught: unknown;
    try { await normalizeCodexEvent(raw("first"), ctx); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NormalizerArtifactError);
    expect(caught).toMatchObject({ code: "NORMALIZER_ARTIFACT_REJECTED" });
    expect((caught as Error).message).not.toContain("private bucket");
    await expect(normalizeCodexEvent(raw("second"), ctx)).resolves.toMatchObject([
      { seq: 4, span_id: "second", artifacts: [`sha256:${"c".repeat(64)}`] }
    ]);
    expect(ctx.next_seq).toBe(5);
  });

  it.each([
    {
      name: "an undefined sink result",
      malformed: () => undefined
    },
    {
      name: "a throwing ref getter",
      malformed: () => Object.defineProperty({}, "ref", {
        get: () => { throw new Error("private ref getter details"); }
      })
    },
    {
      name: "an invalid ref string",
      malformed: () => ({ ref: "not-an-artifact-ref" })
    }
  ])("maps $name to a typed safe rejection, aborts it, and accepts the next write", async ({ malformed }) => {
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    const sink: ArtifactSink = {
      put: async (_data, _metadata, options) => {
        calls += 1;
        if (calls === 1) {
          firstSignal = options.signal;
          return malformed() as Awaited<ReturnType<ArtifactSink["put"]>>;
        }
        return { ref: `sha256:${"f".repeat(64)}` as const };
      }
    };
    const ctx = context({
      artifact_sink: sink,
      artifact_sink_timeout_ms: 50,
      max_inline_output_bytes: 4
    });
    const raw = (id: string) => ({
      type: "item.completed",
      item: { id, type: "command_execution", command: id, aggregated_output: "large output", exit_code: 0 }
    });

    const outcome = await Promise.race([
      normalizeCodexEvent(raw("malformed"), ctx).then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error })
      ),
      new Promise<{ status: "pending" }>((resolve) => {
        setTimeout(() => resolve({ status: "pending" }), 100);
      })
    ]);

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.error).toBeInstanceOf(NormalizerArtifactError);
    expect(outcome.error).toMatchObject({ code: "NORMALIZER_ARTIFACT_REJECTED" });
    expect(outcome.error).not.toHaveProperty("cause");
    expect((outcome.error as Error).message).not.toContain("private");
    expect(firstSignal?.aborted).toBe(true);
    expect(ctx.next_seq).toBe(4);
    await expect(normalizeCodexEvent(raw("recovered"), ctx)).resolves.toMatchObject([
      { seq: 4, span_id: "recovered", artifacts: [`sha256:${"f".repeat(64)}`] }
    ]);
    expect(ctx.next_seq).toBe(5);
  });

  it("times out a never-settling sink, aborts it, and leaves the context queue usable", async () => {
    let calls = 0;
    let abortObserved = false;
    const sink: ArtifactSink = {
      put: (_data, _metadata, options) => {
        calls += 1;
        if (calls === 1) {
          options.signal.addEventListener("abort", () => { abortObserved = true; }, { once: true });
          return new Promise(() => {});
        }
        return Promise.resolve({ ref: `sha256:${"d".repeat(64)}` as const });
      }
    };
    const ctx = context({
      artifact_sink: sink,
      artifact_sink_timeout_ms: 15,
      max_inline_output_bytes: 4
    });
    const raw = (id: string) => ({
      type: "item.completed",
      item: { id, type: "command_execution", command: id, aggregated_output: "large output", exit_code: 0 }
    });

    await expect(normalizeCodexEvent(raw("first"), ctx))
      .rejects.toMatchObject({ code: "NORMALIZER_ARTIFACT_TIMEOUT" });
    expect(abortObserved).toBe(true);
    await expect(normalizeCodexEvent(raw("second"), ctx)).resolves.toMatchObject([{ seq: 4 }]);
    expect(ctx.next_seq).toBe(5);
  });

  it("does not emit a Trace or advance sequence when a timed-out sink completes late", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sink: ArtifactSink = {
      put: async () => {
        await gate;
        return { ref: `sha256:${"e".repeat(64)}` as const };
      }
    };
    const ctx = context({
      artifact_sink: sink,
      artifact_sink_timeout_ms: 10,
      max_inline_output_bytes: 4
    });
    const persisted: unknown[] = [];
    const timedOut = normalizeCodexEvent({
      type: "item.completed",
      item: { id: "late", type: "command_execution", command: "late", aggregated_output: "large output", exit_code: 0 }
    }, ctx).then((events) => { persisted.push(...events); });

    await expect(timedOut).rejects.toMatchObject({ code: "NORMALIZER_ARTIFACT_TIMEOUT" });
    expect(ctx.next_seq).toBe(4);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(persisted).toEqual([]);
    expect(ctx.next_seq).toBe(4);
    await expect(normalizeCodexEvent({ type: "thread.started" }, ctx))
      .resolves.toMatchObject([{ seq: 4 }]);
  });
});
