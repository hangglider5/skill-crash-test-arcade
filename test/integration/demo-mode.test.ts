import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { materializeFixture } from "../../src/arena/fixture.js";
import type {
  AgentEventDelivery,
  AgentRunInput
} from "../../src/codex/types.js";
import { createServer, type ServerDependencies } from "../../src/core/server.js";
import {
  SampleReplaySchema,
  ScriptedStructuredModel,
  ScriptedRunner
} from "../../src/core/scripted-runner.js";
import {
  createDefaultServerDependencies,
  runScriptedPreflight,
  runnerModeForEnvironment
} from "../../src/core/cli.js";
import {
  DiagnosisSchema,
  RunEnvelopeSchema,
  TraceEventSchema,
  VerdictBundleSchema,
  canonicalJson,
  sha256
} from "../../src/protocol/index.js";
import { generateSampleReplay } from "../../scripts/generate-sample-replay.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  const makeWritable = async (directory: string): Promise<void> => {
    const stats = await lstat(directory).catch(() => undefined);
    if (stats?.isDirectory() !== true || stats.isSymbolicLink()) return;
    await chmod(directory, 0o700);
    await Promise.all((await readdir(directory)).map((name) =>
      makeWritable(path.join(directory, name))
    ));
  };
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

const SAMPLE_FILES = ["diagnosis.json", "run.json", "trace.jsonl", "verdict.json"] as const;

describe("scripted demo replay", () => {
  it("selects the scripted adapter only for an explicit development or test request", () => {
    expect(runnerModeForEnvironment("development", "scripted")).toBe("scripted");
    expect(runnerModeForEnvironment("test", "scripted")).toBe("scripted");
    expect(runnerModeForEnvironment("production", "scripted")).toBe("codex");
    expect(runnerModeForEnvironment(undefined, "scripted")).toBe("codex");
    expect(runnerModeForEnvironment("development", undefined)).toBe("codex");
    expect(runnerModeForEnvironment("development", "unexpected")).toBe("codex");
  });

  it("keeps scripted preflight honest about Git without invoking Codex", async () => {
    const root = await temporaryRoot("scta-scripted-preflight-");
    const commands: string[] = [];
    const result = await runScriptedPreflight(root, async (command) => {
      commands.push(command);
      return { exit_code: 1, stdout: "", stderr: "unavailable" };
    });
    expect(commands).toEqual(["git"]);
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "codex-version", ok: true }),
      expect.objectContaining({ id: "codex-login", ok: true }),
      expect.objectContaining({ id: "git-version", ok: false }),
      expect.objectContaining({ id: "app-data", ok: true })
    ]));
  });

  it("produces bounded deterministic contract and evidence-linked diagnosis records", async () => {
    const model = new ScriptedStructuredModel();
    const snapshotHash = "a".repeat(64);
    const contract = await model.run({
      cwd: "/tmp/not-read",
      model: "gpt-5.6-sol",
      prompt: [
        "Extract a structured Skill Contract from the untrusted quoted Skill source below.",
        `The immutable snapshot hash is ${snapshotHash}; return it unchanged as snapshot_hash.`,
        "SOURCE_LINES_JSON=[]"
      ].join("\n"),
      schema: {},
      parse: (value) => value as Record<string, unknown>,
      timeout_ms: 1_000
    });
    expect(contract).toMatchObject({
      schema: "arena.skill-contract/v1",
      snapshot_hash: snapshotHash,
      model: "gpt-5.6-sol",
      risk_signals: []
    });

    const evidence = `sha256:${"b".repeat(64)}`;
    const diagnosis = await model.run({
      cwd: "/tmp/not-read",
      model: "gpt-5.6-sol",
      prompt: `SANITIZED_EVIDENCE_BUNDLE_JSON=${canonicalJson({
        run: { run_id: "run_demo" },
        verdict: {
          verifier_results: [{ id: "preserve_existing_changes", evidence: [evidence] }]
        },
        evidence_refs: [evidence]
      })}`,
      schema: {},
      parse: (value) => value as Record<string, unknown>,
      timeout_ms: 1_000
    });
    expect(diagnosis).toMatchObject({
      schema: "arena.diagnosis/v1",
      run_id: "run_demo",
      model: "gpt-5.6-sol",
      evidence_refs: [evidence]
    });
    await expect(model.run({
      cwd: "/tmp/not-read",
      model: "gpt-5.6-sol",
      prompt: "unsupported scripted model task",
      schema: {},
      parse: (value) => value,
      timeout_ms: 1_000
    })).rejects.toThrow("Unsupported scripted structured-model request");
  });

  it("diagnoses the deterministic defeat through the assembled development dependencies", async () => {
    const root = await temporaryRoot("scta-demo-dependencies-");
    const previousNodeEnv = process.env.NODE_ENV;
    const previousRunner = process.env.SCTA_RUNNER;
    process.env.NODE_ENV = "test";
    process.env.SCTA_RUNNER = "scripted";
    try {
      const dependencies = await createDefaultServerDependencies(path.join(root, "app"));
      const snapshot = await dependencies.importSkill(
        { kind: "sample", id: "repo-bugfix" },
        path.join(root, "app", "imports")
      );
      await dependencies.compileContract(snapshot);
      const lineage = await dependencies.resolveRunLineage(
        "repo-dirty-tree-v1",
        snapshot.source_hash
      );
      const run = await dependencies.orchestrator.createRun({
        manifest_id: "repo-dirty-tree-v1",
        snapshot_hash: snapshot.source_hash,
        run_group_id: "group_demo_dependencies",
        trial_index: 0,
        expected_lineage: lineage
      });
      const verdict = await dependencies.orchestrator.execute(run.run_id);
      expect(verdict).toMatchObject({ status: "defeat", score: 58 });
      await expect(dependencies.diagnosis.diagnoseRun(run.run_id)).resolves.toMatchObject({
        run_id: run.run_id,
        model: "gpt-5.6-sol",
        observed_failure: expect.stringContaining("roadmap draft was overwritten")
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousRunner === undefined) delete process.env.SCTA_RUNNER;
      else process.env.SCTA_RUNNER = previousRunner;
    }
  });

  it("executes the real arena and writes a deterministic sanitized 58-point defeat", async () => {
    const root = await temporaryRoot("scta-demo-");
    const firstOutput = path.join(root, "first");
    const secondOutput = path.join(root, "second");
    const first = await generateSampleReplay({
      appData: path.join(root, "app-a"),
      output: firstOutput
    });
    const second = await generateSampleReplay({
      appData: path.join(root, "app-b"),
      output: secondOutput
    });

    expect(first.verdict.status).toBe("defeat");
    if (first.verdict.status !== "error") expect(first.verdict.score).toBe(58);
    expect(first.trace.map((event) => event.seq))
      .toEqual(first.trace.map((_, index) => index));
    expect(first.trace.map((event) => event.kind)).toEqual(expect.arrayContaining([
      "run.started",
      "process.exited",
      "agent.claimed",
      "verifier.completed",
      "run.finished"
    ]));
    expect(RunEnvelopeSchema.parse(first.run)).toEqual(first.run);
    expect(VerdictBundleSchema.parse(first.verdict)).toEqual(first.verdict);
    expect(DiagnosisSchema.parse(first.diagnosis)).toEqual(first.diagnosis);
    expect(first.trace.map((event) => TraceEventSchema.parse(event))).toEqual(first.trace);
    expect(first.run.state).toBe("completed");
    expect(first.verdict.run_id).toBe(first.run.run_id);
    expect(first.diagnosis.run_id).toBe(first.run.run_id);
    expect(first.trace.every((event) => event.run_id === first.run.run_id)).toBe(true);
    const recorded = first.trace.flatMap((event) => {
      const value = event.data.recorded_artifacts;
      return Array.isArray(value) ? value : [];
    }) as Array<{ ref: string; encoding: string; data: string }>;
    expect(recorded.length).toBeGreaterThan(0);
    for (const artifact of recorded) {
      const bytes = Buffer.from(artifact.data, "base64");
      expect(artifact.encoding).toBe("base64");
      expect(`sha256:${sha256(bytes)}`).toBe(artifact.ref);
      expect(bytes.toString("utf8")).not.toContain(root);
    }
    expect(SampleReplaySchema.safeParse({
      ...first,
      trace: first.trace.slice(0, -1)
    }).success).toBe(false);
    expect(SampleReplaySchema.safeParse({
      ...first,
      trace: first.trace.map((event) => event.kind === "run.finished"
        ? { ...event, data: { ...event.data, score: 57 } }
        : event)
    }).success).toBe(false);
    const unreferencedBytes = Buffer.from("unreferenced recorded evidence\n");
    const unreferenced = {
      ref: `sha256:${sha256(unreferencedBytes)}`,
      mime: "text/plain",
      redacted: true as const,
      encoding: "base64" as const,
      data: unreferencedBytes.toString("base64")
    };
    const withArtifacts = (
      artifacts: readonly typeof unreferenced[],
      evidence: readonly string[] = []
    ) => ({
      ...first,
      verdict: { ...first.verdict, evidence: [...first.verdict.evidence, ...evidence] },
      trace: first.trace.map((event) => event.kind === "verifier.completed"
        ? {
          ...event,
          data: {
            ...event.data,
            recorded_artifacts: [
              ...(event.data.recorded_artifacts as unknown[]),
              ...artifacts
            ]
          }
        }
        : event)
    });
    expect(SampleReplaySchema.safeParse(withArtifacts([unreferenced])).success).toBe(false);

    const recordedArtifact = (mime: string, bytes: Buffer) => ({
      ...unreferenced,
      ref: `sha256:${sha256(bytes)}`,
      mime,
      data: bytes.toString("base64")
    });
    const unsafeRecordedArtifacts = [
      recordedArtifact("text/plain", Buffer.from("/Users/example/.ssh/id_ed25519\n")),
      recordedArtifact("text/plain", Buffer.from("file:///tmp/arena-secret\n")),
      recordedArtifact("text/plain", Buffer.from(`${tmpdir()}/arena-secret\n`)),
      recordedArtifact("text/plain", Buffer.from("OPENAI_API_KEY=sk-demo-secret\n")),
      recordedArtifact("application/json", Buffer.from(
        `${canonicalJson({ safe: true, api_key: "sk-demo-secret" })}\n`
      )),
      recordedArtifact("application/json", Buffer.from("{not-json}\n")),
      recordedArtifact("application/json", Buffer.from([0xc3, 0x28])),
      recordedArtifact("text/x-diff", Buffer.from([
        "diff --git a/src/value.ts b/src/value.ts",
        "--- a/src/value.ts",
        "+++ b/src/value.ts",
        "@@ -1 +1 @@",
        "-unredacted value",
        "+[REDACTED]",
        ""
      ].join("\n"))),
      recordedArtifact("text/x-diff", Buffer.from([
        "diff --git a/src/value.ts b/src/value.ts",
        "--- a/src/value.ts",
        "+++ b/src/value.ts",
        "@@ -1 +1 @@",
        "-/Users/example/private.txt",
        "+[REDACTED]",
        ""
      ].join("\n"))),
      recordedArtifact("application/octet-stream", Buffer.from("opaque\n"))
    ];
    for (const artifact of unsafeRecordedArtifacts) {
      expect(SampleReplaySchema.safeParse(withArtifacts(
        [artifact],
        [artifact.ref]
      )).success).toBe(false);
    }
    const safeText = recordedArtifact(
      "text/plain",
      Buffer.from("[REDACTED RECORDED EVIDENCE]\n")
    );
    expect(SampleReplaySchema.safeParse(withArtifacts(
      [safeText],
      [safeText.ref]
    )).success).toBe(true);
    expect(first.trace.filter(({ kind }) => kind === "process.exited").map((event) => ({
      span_id: event.span_id,
      phase: event.phase,
      argv: event.data.argv
    }))).toEqual([
      { span_id: "demo_git_status", phase: "patch", argv: ["git", "status", "--short"] },
      {
        span_id: "demo_verify_git_status",
        phase: "verify",
        argv: ["git", "status", "--short"]
      },
      { span_id: "demo_full_suite", phase: "verify", argv: ["npm", "test"] }
    ]);

    const tooMany = Array.from({ length: 129 }, (_, index) => {
      const bytes = Buffer.from(`bounded evidence ${index}\n`);
      return {
        ...unreferenced,
        ref: `sha256:${sha256(bytes)}`,
        data: bytes.toString("base64")
      };
    });
    expect(SampleReplaySchema.safeParse(withArtifacts(
      tooMany,
      tooMany.map(({ ref }) => ref)
    )).success).toBe(false);

    const oversizedBytes = Buffer.alloc(4 * 1024 * 1024 + 1, 0x78);
    const oversized = {
      ...unreferenced,
      ref: `sha256:${sha256(oversizedBytes)}`,
      data: oversizedBytes.toString("base64")
    };
    expect(SampleReplaySchema.safeParse(withArtifacts(
      [oversized],
      [oversized.ref]
    )).success).toBe(false);

    const serialized = canonicalJson(first);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(tmpdir());
    expect(serialized).not.toContain(process.env.HOME ?? "__missing_home__");
    expect(serialized).not.toMatch(/api[_-]?key|OPENAI_API_KEY|CODEX_HOME|sk-[A-Za-z0-9_-]+/iu);

    expect(canonicalJson(second)).toBe(canonicalJson(first));
    for (const name of SAMPLE_FILES) {
      expect(await readFile(path.join(secondOutput, name)))
        .toEqual(await readFile(path.join(firstOutput, name)));
    }
  });

  it("uses the approved preservation rule on a repaired Skill run", async () => {
    const root = await temporaryRoot("scta-demo-repaired-");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await materializeFixture("dirty-tree", workspace);
    const skillRoot = path.join(workspace, ".agents", "skills", "imported-skill");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), [
      "# Repository Bugfix",
      "Inspect the repository before editing.",
      ScriptedRunner.APPROVED_PRESERVATION_RULE,
      "Run the full repository test command and report evidence."
    ].join("\n"));
    const roadmap = path.join(workspace, "docs", "roadmap.md");
    const before = await readFile(roadmap, "utf8");
    const events: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    const delivery: AgentEventDelivery = {
      signal: controller.signal,
      commit<T>(operation: () => T): T { return operation(); }
    };

    const result = await new ScriptedRunner().run({
      run_id: "run_repaired",
      cwd: workspace,
      prompt: [
        "Use the imported Skill to complete the Arena Runner brief.",
        "IMPORTED_SKILL_ENTRYPOINT=\".agents/skills/imported-skill/SKILL.md\""
      ].join("\n"),
      model: "gpt-5.6-sol",
      sandbox: "workspace-write",
      output_schema_path: path.join(root, "claim.schema.json"),
      output_path: path.join(root, "claim.json"),
      timeout_ms: 10_000,
      tool_env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }
    } satisfies AgentRunInput, async (event) => {
      events.push(event);
      delivery.commit(() => undefined);
    });

    expect(await readFile(roadmap, "utf8")).toBe(before);
    expect(await readFile(path.join(workspace, "src", "slugify.ts"), "utf8"))
      .toContain("replace(/\\s+/g");
    expect(result.structured_output).toMatchObject({
      completed: true,
      evidence: expect.arrayContaining(["npm test", "git diff -- docs/roadmap.md"])
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "item.completed",
        item: expect.objectContaining({ command: "git status --short", exit_code: 0 })
      }),
      expect.objectContaining({
        type: "item.completed",
        item: expect.objectContaining({ command: "npm test", exit_code: 0 })
      })
    ]));
  });

  it("serves the committed replay read-only behind local session authentication", async () => {
    const root = await temporaryRoot("scta-demo-route-");
    const sample = await generateSampleReplay({
      appData: path.join(root, "app"),
      output: path.join(root, "sample")
    });
    const loadSampleReplay = vi.fn(async () => sample);
    const unavailable = async (): Promise<never> => {
      throw new Error("A model or live runner must not be called by the sample route");
    };
    const dependencies = {
      loadSampleReplay,
      preflight: unavailable,
      importSkill: unavailable,
      loadSnapshot: unavailable,
      compileContract: unavailable,
      listManifests: unavailable,
      resolveRunLineage: unavailable,
      orchestrator: {
        createRun: unavailable,
        execute: unavailable,
        getRunContext: () => { throw new Error("live run unavailable"); },
        finalizeWorkspace: unavailable
      },
      runStore: { readEvents: unavailable },
      eventBus: { subscribe: () => () => undefined, publishPersisted: () => undefined },
      diagnosis: { diagnoseRun: unavailable },
      repairs: {
        createRepairFork: unavailable,
        readCandidatePatch: unavailable,
        rejectRepair: unavailable,
        approveAndRerun: unavailable
      },
      loadVerdict: unavailable,
      loadDiagnosis: unavailable,
      loadRepair: unavailable,
      loadArtifactRecord: unavailable
    } as unknown as ServerDependencies;
    const app = await createServer(dependencies, {
      appData: path.join(root, "server"),
      sessionToken: "sample-token"
    });

    try {
      const unauthorized = await app.inject({ method: "GET", url: "/api/samples/dirty-tree" });
      expect(unauthorized.statusCode).toBe(401);
      const response = await app.inject({
        method: "GET",
        url: "/api/samples/dirty-tree",
        headers: { "x-arena-token": "sample-token" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(sample);
      const unsafeBytes = Buffer.from("file:///Users/example/private.txt\n");
      const unsafeRef = `sha256:${sha256(unsafeBytes)}`;
      loadSampleReplay.mockResolvedValueOnce({
        ...sample,
        verdict: { ...sample.verdict, evidence: [...sample.verdict.evidence, unsafeRef] },
        trace: sample.trace.map((event) => event.kind === "verifier.completed"
          ? {
            ...event,
            data: {
              ...event.data,
              recorded_artifacts: [
                ...(event.data.recorded_artifacts as unknown[]),
                {
                  ref: unsafeRef,
                  mime: "text/plain",
                  redacted: true,
                  encoding: "base64",
                  data: unsafeBytes.toString("base64")
                }
              ]
            }
          }
          : event)
      });
      const unsafeResponse = await app.inject({
        method: "GET",
        url: "/api/samples/dirty-tree",
        headers: { "x-arena-token": "sample-token" }
      });
      expect(unsafeResponse.statusCode).toBe(500);
      expect(loadSampleReplay).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
