import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexProcessRunner,
  RunnerError,
  type CodexProcessRunnerOptions
} from "../../src/codex/process.js";
import type { AgentRunInput, ArtifactSink } from "../../src/codex/types.js";

const roots: string[] = [];
const fakeScriptPath = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));

class RecordingSink implements ArtifactSink {
  readonly writes: Array<{ text: string; mime: string; redacted: boolean }> = [];

  async put(data: Uint8Array, metadata: { mime: string; redacted: boolean }) {
    this.writes.push({ text: Buffer.from(data).toString("utf8"), ...metadata });
    return { ref: `sha256:${String(this.writes.length).padStart(64, "0")}` as const };
  }
}

async function fixture(prompt = "ok"): Promise<AgentRunInput> {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "scta-codex-")));
  roots.push(cwd);
  const schema = path.join(cwd, "schema.json");
  const output = path.join(cwd, "output.json");
  await writeFile(schema, '{}');
  return {
    run_id: "run_01",
    cwd,
    prompt,
    model: "gpt-5.6",
    sandbox: "workspace-write",
    output_schema_path: schema,
    output_path: output,
    timeout_ms: 5_000
  };
}

function runner(input: AgentRunInput, options: Omit<CodexProcessRunnerOptions, "ownedOutputRoot"> = {}) {
  return new CodexProcessRunner({
    command: process.execPath,
    prefixArgs: [fakeScriptPath],
    ownedOutputRoot: input.cwd,
    ...options
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CodexProcessRunner", () => {
  it("uses the exact CLI contract, sanitized env, and parses five incremental events plus output", async () => {
    process.env.ARBITRARY_PARENT_SECRET = "must-not-leak";
    process.env.OPENAI_API_KEY = "must-not-leak";
    const input = await fixture();
    input.tool_env = { PATH: "/fault:/git:/node:/shell", CI: "1", NO_COLOR: "true" };
    const events: unknown[] = [];
    const processRunner = runner(input);

    try {
      const result = await processRunner.run(input, async (event) => { events.push(event); });
      const structured = result.structured_output as { argv: string[]; env: Record<string, string> };
      expect(result.exit_code).toBe(0);
      expect(events).toHaveLength(5);
      expect(structured.argv).toEqual([
        "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
        "-c", "shell_environment_policy.inherit=none",
        "-c", 'shell_environment_policy.set.CI="1"',
        "-c", 'shell_environment_policy.set.NO_COLOR="true"',
        "-c", 'shell_environment_policy.set.PATH="/fault:/git:/node:/shell"',
        "--sandbox", "workspace-write", "--model", "gpt-5.6",
        "--output-schema", input.output_schema_path,
        "--output-last-message", input.output_path,
        "--cd", input.cwd, "ok"
      ]);
      expect(structured.env.ARBITRARY_PARENT_SECRET).toBeUndefined();
      expect(structured.env.OPENAI_API_KEY).toBeUndefined();
      expect(Object.keys(structured.env).every((key) => ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"].includes(key))).toBe(true);
    } finally {
      delete process.env.ARBITRARY_PARENT_SECRET;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it.each(["CODEX_HOME", "OPENAI_API_KEY", "MY_TOKEN", "safe.key", "BAD-KEY"])(
    "rejects unsafe tool_env key %s",
    async (key) => {
      const input = await fixture();
      input.tool_env = { [key]: "value" };
      await expect(runner(input).run(input, async () => {}))
        .rejects.toMatchObject({ code: "RUNNER_TOOL_ENV_INVALID" });
    }
  );

  it("JSON-quotes tool env values without TOML injection", async () => {
    const input = await fixture();
    input.tool_env = { LANG: 'x"\n-c\nevil=true' };
    const result = await runner(input).run(input, async () => {});
    const argv = (result.structured_output as { argv: string[] }).argv;
    expect(argv).toContain(`shell_environment_policy.set.LANG=${JSON.stringify(input.tool_env.LANG)}`);
  });

  it.each(["crlf", "final-no-newline"])("supports %s JSONL", async (prompt) => {
    const events: unknown[] = [];
    const input = await fixture(prompt);
    const result = await runner(input).run(input, async (event) => { events.push(event); });
    expect(events).toHaveLength(1);
    expect(result.exit_code).toBe(0);
  });

  it("stores an invalid original line without putting it in the typed error message", async () => {
    const sink = new RecordingSink();
    const input = await fixture("invalid-json");
    const processRunner = runner(input, { artifactSink: sink });
    const events: unknown[] = [];
    let caught: unknown;
    try { await processRunner.run(input, async (event) => { events.push(event); }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(RunnerError);
    expect(caught).toMatchObject({ code: "RUNNER_JSONL_INVALID", artifact_ref: expect.stringMatching(/^sha256:/) });
    expect((caught as Error).message).not.toContain("hidden payload");
    expect(sink.writes[0]?.text).toContain("hidden payload");
    expect(events).toEqual([]);
  });

  it.each([
    ["oversize-line", "RUNNER_STDOUT_LINE_TOO_LARGE"],
    ["oversize-stream", "RUNNER_STDOUT_TOO_LARGE"]
  ] as const)("caps stdout for %s", async (prompt, code) => {
    const sink = new RecordingSink();
    const input = await fixture(prompt);
    const processRunner = runner(input, {
      artifactSink: sink,
      maxLineBytes: 1024,
      maxStdoutBytes: prompt === "oversize-line" ? 4096 : 2048
    });
    await expect(processRunner.run(input, async () => {})).rejects.toMatchObject({ code });
    expect(sink.writes).toHaveLength(1);
  });

  it("caps and artifacts stderr on process failure", async () => {
    const sink = new RecordingSink();
    const input = await fixture("stderr-large");
    const processRunner = runner(input, { artifactSink: sink, maxStderrBytes: 128 });
    await expect(processRunner.run(input, async () => {})).rejects.toMatchObject({ code: "RUNNER_EXIT_NONZERO", artifact_ref: expect.stringMatching(/^sha256:/) });
    expect(sink.writes[0]?.text).toHaveLength(128);
  });

  it.each([
    ["missing-output", "RUNNER_OUTPUT_INVALID"],
    ["invalid-output", "RUNNER_OUTPUT_INVALID"],
    ["exit-7", "RUNNER_EXIT_NONZERO"]
  ] as const)("returns typed %s failure", async (prompt, code) => {
    const sink = new RecordingSink();
    const input = await fixture(prompt);
    await expect(runner(input, { artifactSink: sink }).run(input, async () => {}))
      .rejects.toMatchObject({ code });
  });

  it("times out with SIGTERM and settles once", async () => {
    const input = await fixture("timeout");
    input.timeout_ms = 50;
    await expect(runner(input, { killGraceMs: 50 }).run(input, async () => {}))
      .rejects.toMatchObject({ code: "RUNNER_TIMEOUT" });
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const input = await fixture("ignore-term");
    input.timeout_ms = 50;
    const started = Date.now();
    await expect(runner(input, { killGraceMs: 50 }).run(input, async () => {}))
      .rejects.toMatchObject({ code: "RUNNER_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it.skipIf(process.platform === "win32")("kills the POSIX process group on timeout", async () => {
    const input = await fixture();
    const marker = path.join(input.cwd, "child-alive.txt");
    input.prompt = `spawn-child:${marker}`;
    input.timeout_ms = 50;
    await expect(runner(input, { killGraceMs: 50 }).run(input, async () => {}))
      .rejects.toMatchObject({ code: "RUNNER_TIMEOUT" });
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("fails fast on Windows instead of pretending direct-child cleanup is sufficient", async () => {
    const input = await fixture();
    expect(() => runner(input, { platform: "win32" })).toThrow(expect.objectContaining({ code: "RUNNER_UNSUPPORTED_PLATFORM" }));
  });

  it("preserves invalid JSONL when the child ignores TERM and requires KILL", async () => {
    const input = await fixture("invalid-json-ignore-term");
    input.timeout_ms = 500;
    const started = Date.now();
    await expect(runner(input, { killGraceMs: 30 }).run(input, async () => {}))
      .rejects.toMatchObject({ code: "RUNNER_JSONL_INVALID" });
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("bounds a never-resolving event callback after the child closes", async () => {
    const input = await fixture("one-event");
    await expect(runner(input, { callbackTimeoutMs: 30 }).run(input, () => new Promise(() => {})))
      .rejects.toMatchObject({ code: "RUNNER_CALLBACK_TIMEOUT" });
  });

  it("maps event callback rejection to a safe typed error", async () => {
    const input = await fixture("one-event");
    let caught: unknown;
    try {
      await runner(input, { callbackTimeoutMs: 100 }).run(input, async () => { throw new Error("secret callback payload"); });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "RUNNER_CALLBACK_FAILED" });
    expect((caught as Error).message).not.toContain("secret callback payload");
  });

  it("catches an event callback rejection that arrives after its timeout", async () => {
    const input = await fixture("one-event");
    await expect(runner(input, { callbackTimeoutMs: 10 }).run(input, () => new Promise((_, reject) => {
      setTimeout(() => reject(new Error("late private rejection")), 40);
    }))).rejects.toMatchObject({ code: "RUNNER_CALLBACK_TIMEOUT" });
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  it("aborts a timed-out delivery and refuses its late commit without mutating persisted state", async () => {
    const input = await fixture("one-event");
    const persisted: unknown[] = [];
    let abortObserved = false;
    let lateCommitError: unknown;

    await expect(runner(input, { callbackTimeoutMs: 10 }).run(input, async (event, delivery) => {
      delivery.signal.addEventListener("abort", () => { abortObserved = true; }, { once: true });
      await new Promise((resolve) => setTimeout(resolve, 40));
      try {
        delivery.commit(() => { persisted.push(event); });
      } catch (error) {
        lateCommitError = error;
      }
    })).rejects.toMatchObject({ code: "RUNNER_CALLBACK_TIMEOUT" });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(abortObserved).toBe(true);
    expect(lateCommitError).toMatchObject({ code: "RUNNER_CALLBACK_INACTIVE" });
    expect(persisted).toEqual([]);
  });

  it("rejects an async commit function before it can mutate persisted state", async () => {
    const input = await fixture("one-event");
    const persisted: unknown[] = [];

    await expect(runner(input).run(input, async (_event, delivery) => {
      delivery.commit(async () => {
        await Promise.resolve();
        persisted.push("late");
      });
    })).rejects.toMatchObject({ code: "RUNNER_CALLBACK_COMMIT_ASYNC" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(persisted).toEqual([]);
  });

  it("lets a cooperative callback observe cancellation while preserving the timeout error", async () => {
    const input = await fixture("one-event");
    let observed = false;

    await expect(runner(input, { callbackTimeoutMs: 10 }).run(input, (_event, delivery) => new Promise<void>((resolve) => {
      delivery.signal.addEventListener("abort", () => {
        observed = true;
        resolve();
      }, { once: true });
    }))).rejects.toMatchObject({ code: "RUNNER_CALLBACK_TIMEOUT" });
    expect(observed).toBe(true);
  });

  it("allows close during a bounded callback and settles once", async () => {
    const input = await fixture("one-event");
    let calls = 0;
    const result = await runner(input, { callbackTimeoutMs: 100 }).run(input, async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.exit_code).toBe(0);
    expect(calls).toBe(1);
  });

  it("commits synchronous callback state while the delivery is active", async () => {
    const input = await fixture("one-event");
    const persisted: unknown[] = [];
    const result = await runner(input).run(input, async (event, delivery) => {
      delivery.commit(() => { persisted.push(event); });
    });
    expect(result.exit_code).toBe(0);
    expect(persisted).toMatchObject([{ type: "thread.started" }]);
  });

  it.each(["reject", "hang"] as const)("preserves invalid JSONL when its evidence sink %s", async (behavior) => {
    const input = await fixture("invalid-json-ignore-term");
    const artifactSink: ArtifactSink = {
      put: behavior === "reject"
        ? async () => { throw new Error("private sink path"); }
        : () => new Promise(() => {})
    };
    let caught: unknown;
    try {
      await runner(input, { artifactSink, callbackTimeoutMs: 20, killGraceMs: 20 }).run(input, async () => {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "RUNNER_JSONL_INVALID" });
    expect((caught as Error).message).not.toContain("private sink path");
  });

  it("catches an evidence sink rejection that arrives after its timeout", async () => {
    const input = await fixture("invalid-json-ignore-term");
    const artifactSink: ArtifactSink = {
      put: () => new Promise((_, reject) => setTimeout(() => reject(new Error("late sink rejection")), 40))
    };
    await expect(runner(input, {
      artifactSink,
      callbackTimeoutMs: 10,
      killGraceMs: 10
    }).run(input, async () => {})).rejects.toMatchObject({ code: "RUNNER_JSONL_INVALID" });
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  it.each([
    ["stderr-large", "RUNNER_EXIT_NONZERO"],
    ["invalid-output", "RUNNER_OUTPUT_INVALID"]
  ] as const)("preserves %s when the evidence sink fails", async (prompt, code) => {
    const input = await fixture(prompt);
    const artifactSink: ArtifactSink = { put: async () => { throw new Error("/private/sink/raw"); } };
    let caught: unknown;
    try { await runner(input, { artifactSink }).run(input, async () => {}); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code });
    expect((caught as Error).message).not.toContain("/private/sink/raw");
  });

  it("rejects a preexisting output without deleting the caller's sentinel", async () => {
    const input = await fixture();
    await writeFile(input.output_path, "sentinel");
    await expect(runner(input).run(input, async () => {})).rejects.toMatchObject({ code: "RUNNER_OUTPUT_PATH_INVALID" });
    await expect(readFile(input.output_path, "utf8")).resolves.toBe("sentinel");
  });

  it("rejects output/schema collisions and output symlinks", async () => {
    const collision = await fixture();
    collision.output_path = collision.output_schema_path;
    await expect(runner(collision).run(collision, async () => {})).rejects.toMatchObject({ code: "RUNNER_OUTPUT_PATH_INVALID" });

    const linked = await fixture();
    const sentinel = path.join(linked.cwd, "sentinel.json");
    await writeFile(sentinel, "unchanged");
    await symlink(sentinel, linked.output_path);
    await expect(runner(linked).run(linked, async () => {})).rejects.toMatchObject({ code: "RUNNER_OUTPUT_PATH_INVALID" });
    await expect(readFile(sentinel, "utf8")).resolves.toBe("unchanged");
  });

  it("rejects an output root supplied through a symlink", async () => {
    const input = await fixture();
    const alias = `${input.cwd}-alias`;
    roots.push(alias);
    await symlink(input.cwd, alias);
    input.output_path = path.join(alias, "other.json");
    await expect(new CodexProcessRunner({
      command: process.execPath,
      prefixArgs: [fakeScriptPath],
      ownedOutputRoot: alias
    }).run(input, async () => {})).rejects.toMatchObject({ code: "RUNNER_OUTPUT_PATH_INVALID" });
  });

  it("rejects bounded final output that is oversized", async () => {
    const input = await fixture("oversize-output");
    await expect(runner(input, { maxOutputBytes: 32 }).run(input, async () => {}))
      .rejects.toMatchObject({ code: "RUNNER_OUTPUT_INVALID" });
  });
});
