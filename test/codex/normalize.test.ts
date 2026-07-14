import { describe, expect, it } from "vitest";

import { normalizeCodexEvent } from "../../src/codex/normalize.js";
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
    }, context({ max_inline_output_bytes: 16 }))).rejects.toThrow("artifact sink");
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
});
