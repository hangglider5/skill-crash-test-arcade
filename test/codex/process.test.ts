import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexProcessRunner,
  RunnerError
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
  const cwd = await mkdtemp(path.join(tmpdir(), "scta-codex-"));
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
    const runner = new CodexProcessRunner({ command: process.execPath, prefixArgs: [fakeScriptPath] });

    try {
      const result = await runner.run(input, async (event) => { events.push(event); });
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
      await expect(new CodexProcessRunner({ command: process.execPath, prefixArgs: [fakeScriptPath] }).run(input, async () => {}))
        .rejects.toMatchObject({ code: "RUNNER_TOOL_ENV_INVALID" });
    }
  );

  it("JSON-quotes tool env values without TOML injection", async () => {
    const input = await fixture();
    input.tool_env = { LANG: 'x"\n-c\nevil=true' };
    const result = await new CodexProcessRunner({ command: process.execPath, prefixArgs: [fakeScriptPath] }).run(input, async () => {});
    const argv = (result.structured_output as { argv: string[] }).argv;
    expect(argv).toContain(`shell_environment_policy.set.LANG=${JSON.stringify(input.tool_env.LANG)}`);
  });

  it.each(["crlf", "final-no-newline"])("supports %s JSONL", async (prompt) => {
    const events: unknown[] = [];
    const result = await new CodexProcessRunner({ command: process.execPath, prefixArgs: [fakeScriptPath] })
      .run(await fixture(prompt), async (event) => { events.push(event); });
    expect(events).toHaveLength(1);
    expect(result.exit_code).toBe(0);
  });

  it("stores an invalid original line without putting it in the typed error message", async () => {
    const sink = new RecordingSink();
    const runner = new CodexProcessRunner({ command: process.execPath, prefixArgs: [fakeScriptPath], artifactSink: sink });
    const events: unknown[] = [];
    let caught: unknown;
    try { await runner.run(await fixture("invalid-json"), async (event) => { events.push(event); }); } catch (error) { caught = error; }
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
    const runner = new CodexProcessRunner({
      command: process.execPath,
      prefixArgs: [fakeScriptPath],
      artifactSink: sink,
      maxLineBytes: 1024,
      maxStdoutBytes: prompt === "oversize-line" ? 4096 : 2048
    });
    await expect(runner.run(await fixture(prompt), async () => {})).rejects.toMatchObject({ code });
    expect(sink.writes).toHaveLength(1);
  });

  it("caps and artifacts stderr on process failure", async () => {
    const sink = new RecordingSink();
    const runner = new CodexProcessRunner({ command: process.execPath, prefixArgs: [fakeScriptPath], artifactSink: sink, maxStderrBytes: 128 });
    await expect(runner.run(await fixture("stderr-large"), async () => {})).rejects.toMatchObject({ code: "RUNNER_PROCESS_EXIT", artifact_ref: expect.stringMatching(/^sha256:/) });
    expect(sink.writes[0]?.text).toHaveLength(128);
  });

  it.each([
    ["missing-output", "RUNNER_OUTPUT_FILE"],
    ["invalid-output", "RUNNER_STRUCTURED_PARSE"],
    ["exit-7", "RUNNER_PROCESS_EXIT"]
  ] as const)("returns typed %s failure", async (prompt, code) => {
    const sink = new RecordingSink();
    await expect(new CodexProcessRunner({ command: process.execPath, prefixArgs: [fakeScriptPath], artifactSink: sink }).run(await fixture(prompt), async () => {}))
      .rejects.toMatchObject({ code });
  });

  it("times out with SIGTERM and settles once", async () => {
    const input = await fixture("timeout");
    input.timeout_ms = 50;
    await expect(new CodexProcessRunner({ command: process.execPath, prefixArgs: [fakeScriptPath], killGraceMs: 50 }).run(input, async () => {}))
      .rejects.toMatchObject({ code: "RUNNER_TIMEOUT" });
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const input = await fixture("ignore-term");
    input.timeout_ms = 50;
    const started = Date.now();
    await expect(new CodexProcessRunner({ command: process.execPath, prefixArgs: [fakeScriptPath], killGraceMs: 50 }).run(input, async () => {}))
      .rejects.toMatchObject({ code: "RUNNER_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it.skipIf(process.platform === "win32")("kills the POSIX process group on timeout", async () => {
    const input = await fixture();
    const marker = path.join(input.cwd, "child-alive.txt");
    input.prompt = `spawn-child:${marker}`;
    input.timeout_ms = 50;
    await expect(new CodexProcessRunner({ command: process.execPath, prefixArgs: [fakeScriptPath], killGraceMs: 50 }).run(input, async () => {}))
      .rejects.toMatchObject({ code: "RUNNER_TIMEOUT" });
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });
});
