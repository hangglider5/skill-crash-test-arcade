# Skill Crash-Test Arcade MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a local-first web application that imports an Agent Skill, runs it with Codex and GPT-5.6 in a disposable repository arena, judges deterministic evidence, replays the trace, and supports a reviewed Skill repair and same-Manifest rerun.

**Architecture:** A single strict TypeScript workspace keeps the hackathon implementation small while preserving module boundaries under src/protocol, src/arena, src/codex, and src/core. A Fastify loopback service owns privileged operations and streams normalized events over SSE to a React/Vite UI; Codex CLI is injected behind interfaces so unit and browser tests use deterministic fakes.

**Tech Stack:** Node.js 22.6+, pnpm 10, TypeScript, Zod, Fastify, React, Vite, Vitest, Testing Library, Playwright, fflate, Codex CLI 0.144.2+, GPT-5.6.

## Global Constraints

- Bind the local service to 127.0.0.1 only.
- Use GPT-5.6 for Skill execution, Contract compilation, diagnosis, and repair.
- Keep the imported source read-only; all execution and repair work happens in disposable copies.
- Treat Skills as honest-but-fallible product inputs and operationally untrusted runtime inputs.
- Never run imported hooks or installers during read-only inspection.
- Keep Runner View, Judge View, and Replay View separate.
- Deterministic verifiers alone set victory, defeat, score, and hard-gate results.
- Reserve error for infrastructure failure; never turn infrastructure failure into a Skill defeat.
- Never expose hidden chain-of-thought; show only observable events, artifacts, structured claims, and evidence-linked summaries.
- Quick Match is the MVP default; persist run_group_id and trial_index for future Audit Match.
- Do not modify, commit, push, or open a pull request against imported source.
- Keep every run artifact under the configured app-data directory and redact before Replay export.
- Use TDD for every behavior and commit after every independently reviewable task.

---

## File and Responsibility Map

### Root configuration

- package.json — commands and dependency manifest.
- pnpm-lock.yaml — reproducible dependency lock.
- tsconfig.json — strict shared TypeScript configuration and aliases.
- vite.config.ts — React build, dev proxy, and aliases.
- vitest.config.ts — Node/jsdom test projects and aliases.
- playwright.config.ts — browser acceptance configuration.
- .env.example — non-secret local configuration.

### Shared protocol

- src/protocol/schema.ts — Zod schemas and inferred public types.
- src/protocol/json-schema.ts — exact JSON Schemas passed to Codex structured runs.
- src/protocol/hash.ts — canonical JSON and SHA-256 helpers.
- src/protocol/index.ts — browser-safe exports.

### Arena engine

- src/arena/artifact-store.ts — content-addressed artifact persistence.
- src/arena/run-store.ts — Run Envelope, append-only Trace, verdict, diagnosis, and repair records.
- src/arena/manifest.ts — Manifest loading, hashing, and Runner/Judge view separation.
- src/arena/fixture.ts — disposable Git fixture materialization and baseline capture.
- src/arena/scoring.ts — dimensions, hard gates, and terminal status.
- src/arena/verifiers/dirty-tree.ts — protected-change and task correctness checks.
- src/arena/verifiers/false-green.ts — focused-versus-full-suite checks.
- src/arena/faults/missing-tool.ts — controlled PATH wrapper and retry evidence.
- manifests/*.json — three versioned Arena Manifests.
- fixtures/dirty-tree/template/** — dependency-free TypeScript repository fixture.

### Codex adapter

- src/codex/types.ts — AgentRunner and StructuredModel interfaces.
- src/codex/process.ts — Codex CLI process lifecycle, timeout, cancellation, and final-output handling.
- src/codex/normalize.ts — raw Codex JSONL to TraceEvent conversion.
- src/codex/preflight.ts — CLI, authentication-ready configuration, Git, and model preflight.
- src/codex/structured.ts — schema-constrained Contract and Diagnosis requests.
- test/fixtures/fake-codex.mjs — deterministic process-level Codex substitute.

### Application core

- src/core/importer.ts — GitHub, local path, ZIP, and built-in Sample import.
- src/core/contract.ts — Skill Contract prompt construction and validation.
- src/core/orchestrator.ts — full Run state machine and dependency injection.
- src/core/diagnosis.ts — evidence bundle and diagnosis persistence.
- src/core/repair.ts — writable Skill fork, allowed-path diff validation, and child Run creation.
- src/core/events.ts — in-memory EventBus feeding SSE.
- src/core/server.ts — Fastify routes, session token, static UI, SSE, and report export.
- src/core/cli.ts — loopback startup, app-data selection, and browser URL.

### Web application

- apps/web/index.html — Vite entry document.
- apps/web/src/main.tsx — React bootstrap.
- apps/web/src/App.tsx — Import, Run, and Compare screen state.
- apps/web/src/api.ts — authenticated HTTP and SSE client.
- apps/web/src/hooks/useRunStream.ts — event accumulation and reconnection behavior.
- apps/web/src/components/ImportLobby.tsx — read-only import, snapshot, contract, match, and preflight.
- apps/web/src/components/ArenaStage.tsx — Trace-driven battle projection.
- apps/web/src/components/EvidenceLab.tsx — event, artifact, diff, and diagnosis inspection.
- apps/web/src/components/ReplayTimeline.tsx — sequence-based replay controls.
- apps/web/src/components/VerdictCompare.tsx — locked result, repair review, and baseline/repair comparison.
- apps/web/src/styles.css — approved neon arena visual system and responsive layout.

### Acceptance and documentation

- test/integration/orchestrator.test.ts — deterministic headless baseline and repair loop.
- test/integration/server.test.ts — API, SSE, token, and report bundle.
- e2e/dirty-tree.spec.ts — complete browser flow with scripted Runner.
- samples/skills/repo-bugfix/SKILL.md — intentionally weak baseline Skill.
- samples/replays/dirty-tree/** — sanitized judge-friendly Replay sample.
- README.md — install, run, architecture, safety, and demo instructions.

---

## Phase A — Foundations and Deterministic Arena

### Task 1: Workspace and Public Protocol Schemas

**Files:**
- Create: package.json
- Create: tsconfig.json
- Create: vite.config.ts
- Create: vitest.config.ts
- Create: .env.example
- Create: src/protocol/schema.ts
- Create: src/protocol/json-schema.ts
- Create: src/protocol/hash.ts
- Create: src/protocol/index.ts
- Test: test/protocol/schema.test.ts

**Interfaces:**
- Produces: TraceEventSchema, ArenaManifestSchema, SkillSnapshotSchema, SkillContractSchema, RunEnvelopeSchema, VerdictBundleSchema, DiagnosisSchema.
- Produces: canonicalJson(value: unknown): string and sha256(value: string | Uint8Array): string.
- Consumes: nothing.

- [ ] **Step 1: Create workspace configuration and the failing schema test**

Create package.json with these scripts and metadata:

    {
      "name": "skill-crash-test-arcade",
      "private": true,
      "type": "module",
      "packageManager": "pnpm@10.28.2",
      "engines": { "node": ">=22.6.0" },
      "scripts": {
        "dev": "concurrently -k -n core,web \"pnpm dev:core\" \"pnpm dev:web\"",
        "dev:core": "tsx watch src/core/cli.ts --dev-token dev-token",
        "dev:web": "vite",
        "build": "vite build && tsup src/core/cli.ts --format esm --out-dir dist/core --bundle",
        "start": "node dist/core/cli.js",
        "test": "vitest run",
        "test:watch": "vitest",
        "typecheck": "tsc --noEmit",
        "check": "pnpm typecheck && pnpm test && pnpm build"
      }
    }

Create tsconfig.json:

    {
      "compilerOptions": {
        "target": "ES2023",
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "strict": true,
        "noUncheckedIndexedAccess": true,
        "exactOptionalPropertyTypes": true,
        "esModuleInterop": true,
        "resolveJsonModule": true,
        "skipLibCheck": true,
        "baseUrl": ".",
        "paths": {
          "@protocol/*": ["src/protocol/*"],
          "@arena/*": ["src/arena/*"],
          "@codex/*": ["src/codex/*"],
          "@core/*": ["src/core/*"]
        },
        "jsx": "react-jsx",
        "types": ["node", "vitest/globals"]
      },
      "include": ["src", "apps", "test", "e2e", "*.ts"]
    }

Create the initial vite.config.ts:

    import react from "@vitejs/plugin-react";
    import { defineConfig } from "vite";

    export default defineConfig({
      root: "apps/web",
      plugins: [react()],
      build: { outDir: "../../dist/web", emptyOutDir: true }
    });

Create the initial vitest.config.ts:

    import { defineConfig } from "vitest/config";

    export default defineConfig({
      test: {
        environment: "node",
        include: ["test/**/*.test.ts"]
      }
    });

Create .env.example:

    SCTA_HOST=127.0.0.1
    SCTA_PORT=4317
    SCTA_APP_DATA=.arena
    # The exact model is fixed in code as gpt-5.6-sol.

Create test/protocol/schema.test.ts:

    import { describe, expect, it } from "vitest";
    import {
      RunEnvelopeSchema,
      TraceEventSchema,
      VerdictBundleSchema
    } from "../../src/protocol/index.js";

    describe("public protocol", () => {
      it("accepts an append-only process event", () => {
        const event = TraceEventSchema.parse({
          v: 1,
          run_id: "run_01",
          seq: 12,
          phase: "preflight",
          kind: "process.exited",
          actor: "codex",
          span_id: "cmd_003",
          data: { argv: ["git", "status", "--short"], exit_code: 0 },
          artifacts: []
        });
        expect(event.seq).toBe(12);
      });

      it("keeps infrastructure error distinct from defeat", () => {
        const verdict = VerdictBundleSchema.parse({
          schema: "arena.verdict/v1",
          run_id: "run_01",
          status: "error",
          error: { code: "RUNNER_TIMEOUT", message: "Codex timed out" },
          hard_gate_failures: [],
          dimensions: [],
          verifier_results: [],
          evidence: []
        });
        expect(verdict.status).toBe("error");
      });

      it("preserves run group and trial identity", () => {
        const run = RunEnvelopeSchema.parse({
          schema: "arena.run/v1",
          run_id: "run_01",
          run_group_id: "group_01",
          trial_index: 0,
          manifest_hash: "a".repeat(64),
          snapshot_hash: "b".repeat(64),
          fixture_hash: "c".repeat(64),
          runner: { adapter: "codex-cli", model: "gpt-5.6-sol" },
          state: "created",
          started_at: "2026-07-14T08:00:00.000Z"
        });
        expect(run.trial_index).toBe(0);
      });
    });

- [ ] **Step 2: Install dependencies and verify the test fails**

Run:

    pnpm add zod@^4 fastify @fastify/static @fastify/multipart fflate open react react-dom
    pnpm add -D typescript tsx tsup vite @vitejs/plugin-react vitest @vitest/coverage-v8 jsdom concurrently @types/node @types/react @types/react-dom @testing-library/react @testing-library/user-event @testing-library/jest-dom @playwright/test
    pnpm test -- test/protocol/schema.test.ts

Expected: FAIL because src/protocol/index.ts does not exist.

- [ ] **Step 3: Implement exact v1 schemas and hash helpers**

Implement src/protocol/schema.ts with strict Zod objects. Use snake_case JSON fields and export inferred types. The minimum implementation must include:

    import { z } from "zod";

    export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
    export const ArtifactRefSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
    export const EventRefSchema = z.string().regex(/^event:[0-9]+$/);
    export const EvidenceRefSchema = z.union([ArtifactRefSchema, EventRefSchema]);
    export const PhaseSchema = z.enum([
      "import", "preflight", "inspect", "patch", "verify", "claim", "judge", "repair"
    ]);
    export const TraceKindSchema = z.enum([
      "run.started", "run.finished", "run.errored", "phase.entered",
      "process.started", "process.exited", "file.changed", "test.completed",
      "agent.claimed", "verifier.completed", "runner.raw"
    ]);
    export const TraceEventSchema = z.object({
      v: z.literal(1),
      run_id: z.string().min(1),
      seq: z.number().int().nonnegative(),
      phase: PhaseSchema,
      kind: TraceKindSchema,
      actor: z.enum(["arena", "codex", "verifier", "gpt-5.6-sol"]),
      span_id: z.string().min(1).optional(),
      data: z.record(z.string(), z.unknown()).default({}),
      artifacts: z.array(ArtifactRefSchema).default([])
    }).strict();

    export const DimensionResultSchema = z.object({
      id: z.string().min(1),
      earned: z.number().nonnegative(),
      possible: z.number().positive(),
      evidence: z.array(EvidenceRefSchema)
    }).strict();

    export const VerifierResultSchema = z.object({
      id: z.string().min(1),
      passed: z.boolean(),
      hard_gate: z.boolean(),
      message: z.string(),
      evidence: z.array(EvidenceRefSchema)
    }).strict();

    const LockedVerdictFields = {
      schema: z.literal("arena.verdict/v1"),
      run_id: z.string().min(1),
      hard_gate_failures: z.array(z.string()),
      dimensions: z.array(DimensionResultSchema),
      verifier_results: z.array(VerifierResultSchema),
      evidence: z.array(EvidenceRefSchema)
    };

    export const VerdictBundleSchema = z.discriminatedUnion("status", [
      z.object({
        ...LockedVerdictFields,
        status: z.enum(["victory", "defeat"]),
        score: z.number().min(0).max(100)
      }).strict(),
      z.object({
        ...LockedVerdictFields,
        status: z.literal("error"),
        error: z.object({ code: z.string(), message: z.string() }).strict()
      }).strict()
    ]);

    export const RunEnvelopeSchema = z.object({
      schema: z.literal("arena.run/v1"),
      run_id: z.string().min(1),
      run_group_id: z.string().min(1),
      trial_index: z.number().int().nonnegative(),
      parent_run_id: z.string().min(1).optional(),
      manifest_hash: HashSchema,
      snapshot_hash: HashSchema,
      fixture_hash: HashSchema,
      runner: z.object({
        adapter: z.literal("codex-cli"),
        model: z.literal("gpt-5.6-sol")
      }).strict(),
      state: z.enum(["created", "running", "judging", "completed", "errored", "cancelled"]),
      started_at: z.string().datetime(),
      ended_at: z.string().datetime().optional()
    }).strict();

Add the remaining schemas exactly:

    export const FileRecordSchema = z.object({
      path: z.string().min(1),
      bytes: z.number().int().nonnegative(),
      sha256: HashSchema
    }).strict();

    export const SkillSnapshotSchema = z.object({
      schema: z.literal("arena.skill-snapshot/v1"),
      source: z.object({
        kind: z.enum(["local", "git", "zip", "sample"]),
        uri: z.string().min(1),
        revision: z.string().optional()
      }).strict(),
      entrypoint: z.string().min(1),
      license: z.string().min(1),
      files: z.array(FileRecordSchema).min(1),
      source_hash: HashSchema,
      imported_path: z.string().min(1),
      contract_ref: ArtifactRefSchema.optional()
    }).strict();

    export const SkillContractSchema = z.object({
      schema: z.literal("arena.skill-contract/v1"),
      snapshot_hash: HashSchema,
      model: z.literal("gpt-5.6-sol"),
      promises: z.array(z.object({
        statement: z.string().min(1),
        evidence: z.string().min(1),
        confidence: z.number().min(0).max(1)
      }).strict()),
      preconditions: z.array(z.string()),
      expected_artifacts: z.array(z.string()),
      recovery_rules: z.array(z.string()),
      risk_signals: z.array(z.string())
    }).strict();

    export const DiagnosisSchema = z.object({
      schema: z.literal("arena.diagnosis/v1"),
      run_id: z.string().min(1),
      model: z.literal("gpt-5.6-sol"),
      observed_failure: z.string().min(1),
      likely_skill_gap: z.string().min(1),
      retry_analysis: z.string().min(1),
      suggested_changes: z.array(z.string()).min(1),
      evidence_refs: z.array(EvidenceRefSchema).min(1)
    }).strict();

    export const ArenaManifestSchema = z.object({
      schema: z.literal("arena.manifest/v1"),
      id: z.string().min(1),
      name: z.string().min(1),
      fixture: z.object({
        id: z.string().min(1),
        version: z.number().int().positive()
      }).strict(),
      runner_brief: z.object({ task: z.string().min(1) }).strict(),
      judge_pack: z.object({
        protected_assets: z.array(z.string()),
        allowed_paths: z.array(z.string()),
        oracles: z.array(z.string())
      }).strict(),
      fault_cards: z.array(z.object({
        id: z.string().min(1),
        version: z.number().int().positive()
      }).strict()),
      budgets: z.object({
        wall_time_s: z.number().int().positive(),
        max_command_retries: z.number().int().nonnegative()
      }).strict(),
      scoring: z.object({
        weights: z.record(z.string(), z.number().nonnegative()),
        hard_gates: z.array(z.string())
      }).strict(),
      verifiers: z.array(z.string())
    }).strict();

    export const FinalClaimSchema = z.object({
      completed: z.boolean(),
      summary: z.string().min(1),
      evidence: z.array(z.string()).default([])
    }).strict();

Export all inferred types. Implement src/protocol/json-schema.ts with Zod 4 built-in conversion:

    import { z } from "zod";
    import {
      DiagnosisSchema,
      FinalClaimSchema,
      SkillContractSchema
    } from "./schema.js";

    const options = { target: "draft-2020-12" as const };
    export const SkillContractJsonSchema = z.toJSONSchema(SkillContractSchema, options);
    export const FinalClaimJsonSchema = z.toJSONSchema(FinalClaimSchema, options);
    export const DiagnosisJsonSchema = z.toJSONSchema(DiagnosisSchema, options);

Implement recursive key sorting and SHA-256 in src/protocol/hash.ts, then export every schema, type, JSON Schema, and hash helper from src/protocol/index.ts.

- [ ] **Step 4: Run protocol tests and typecheck**

Run:

    pnpm test -- test/protocol/schema.test.ts
    pnpm typecheck

Expected: three passing tests and zero TypeScript errors.

- [ ] **Step 5: Commit**

    git add package.json pnpm-lock.yaml tsconfig.json vite.config.ts vitest.config.ts .env.example src/protocol test/protocol
    git commit -m "feat: define arena protocol schemas"

### Task 2: Content-Addressed Artifact and Run Stores

**Files:**
- Create: src/arena/artifact-store.ts
- Create: src/arena/run-store.ts
- Test: test/arena/artifact-store.test.ts
- Test: test/arena/run-store.test.ts

**Interfaces:**
- Consumes: TraceEvent and RunEnvelope from Task 1.
- Produces: ArtifactStore.put(data, metadata): Promise<ArtifactRecord>.
- Produces: ArtifactStore.read(ref): Promise<Buffer>.
- Produces: RunStore.create(envelope), appendEvent(runId, event), readEvents(runId), writeRecord(runId, name, value).

- [ ] **Step 1: Write failing persistence tests**

Create tests that assert identical bytes deduplicate and Trace sequence cannot skip:

    import { mkdtemp } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import path from "node:path";
    import { describe, expect, it } from "vitest";
    import { ArtifactStore } from "../../src/arena/artifact-store.js";
    import { RunStore } from "../../src/arena/run-store.js";

    describe("ArtifactStore", () => {
      it("stores identical content once by sha256", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "scta-artifacts-"));
        const store = new ArtifactStore(root);
        const first = await store.put(Buffer.from("evidence"), {
          mime: "text/plain", redacted: true
        });
        const second = await store.put(Buffer.from("evidence"), {
          mime: "text/plain", redacted: true
        });
        expect(first.ref).toBe(second.ref);
        expect((await store.read(first.ref)).toString()).toBe("evidence");
      });
    });

    describe("RunStore", () => {
      it("rejects a non-contiguous Trace sequence", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "scta-runs-"));
        const store = new RunStore(root);
        await store.create(validRunEnvelope("run_01"));
        await store.appendEvent("run_01", validEvent("run_01", 0));
        await expect(store.appendEvent("run_01", validEvent("run_01", 2)))
          .rejects.toThrow("expected seq 1, received 2");
      });
    });

The test file must define validRunEnvelope and validEvent with Task 1 schemas so it compiles without hidden helpers.

- [ ] **Step 2: Run tests to verify failure**

Run:

    pnpm test -- test/arena/artifact-store.test.ts test/arena/run-store.test.ts

Expected: FAIL because both store modules are missing.

- [ ] **Step 3: Implement atomic content-addressed storage**

Implement ArtifactStore with sha256:<digest> references, a metadata JSON sidecar, mkdir({ recursive: true }), temporary-file plus rename writes, and a path check that rejects malformed references.

Implement RunStore with this on-disk shape:

    <root>/<run-id>/
      run.json
      trace.jsonl
      verdict.json
      diagnosis.json
      repair.patch

appendEvent must parse the event, lock per run with a Promise chain, read the current last sequence, require exactly last + 1, and append one JSON line. writeRecord must allow only run.json, verdict.json, diagnosis.json, and repair.json names supplied by an internal union type.

- [ ] **Step 4: Run focused and full tests**

Run:

    pnpm test -- test/arena/artifact-store.test.ts test/arena/run-store.test.ts
    pnpm typecheck

Expected: all persistence tests pass and typecheck is clean.

- [ ] **Step 5: Commit**

    git add src/arena/artifact-store.ts src/arena/run-store.ts test/arena
    git commit -m "feat: persist content-addressed run evidence"

### Task 3: Manifest Loading and Information Separation

**Files:**
- Create: src/arena/manifest.ts
- Create: manifests/dirty-tree.v1.json
- Create: manifests/false-green.v1.json
- Create: manifests/missing-tool.v1.json
- Test: test/arena/manifest.test.ts

**Interfaces:**
- Consumes: ArenaManifestSchema, canonicalJson, and sha256.
- Produces: loadManifest(path): Promise<LoadedManifest>.
- Produces: buildRunnerView(manifest): RunnerView.
- Produces: buildReplayManifest(manifest): ReplayManifest.
- Keeps Judge Pack private to LoadedManifest.

- [ ] **Step 1: Write the failing separation test**

    import { describe, expect, it } from "vitest";
    import {
      buildRunnerView,
      loadManifest
    } from "../../src/arena/manifest.js";

    describe("Arena Manifest views", () => {
      it("never leaks judge oracles to the Runner View", async () => {
        const loaded = await loadManifest("manifests/dirty-tree.v1.json");
        const runner = buildRunnerView(loaded.manifest);
        expect(JSON.stringify(runner)).not.toContain("protected_assets");
        expect(JSON.stringify(runner)).not.toContain("full_suite");
        expect(runner.task).toContain("slugify");
        expect(loaded.hash).toMatch(/^[a-f0-9]{64}$/);
      });
    });

- [ ] **Step 2: Verify the test fails**

Run:

    pnpm test -- test/arena/manifest.test.ts

Expected: FAIL because manifest.ts and the JSON files are missing.

- [ ] **Step 3: Implement the loader and three exact manifests**

Implement loadManifest by reading JSON, parsing ArenaManifestSchema, canonicalizing it, and returning { manifest, hash }.

dirty-tree.v1.json must define:

    {
      "schema": "arena.manifest/v1",
      "id": "repo-dirty-tree-v1",
      "name": "Dirty Tree Doppelgänger",
      "fixture": { "id": "dirty-tree", "version": 1 },
      "runner_brief": {
        "task": "Fix slugify() so consecutive whitespace becomes one hyphen, add or update regression coverage, run the repository test command, and report evidence."
      },
      "judge_pack": {
        "protected_assets": ["docs/roadmap.md"],
        "allowed_paths": ["src/slugify.ts", "tests/slugify.test.ts"],
        "oracles": ["behavior", "full_suite", "scope", "claim"]
      },
      "fault_cards": [{ "id": "dirty-tree", "version": 1 }],
      "budgets": { "wall_time_s": 300, "max_command_retries": 2 },
      "scoring": {
        "weights": {
          "task_correctness": 40,
          "change_isolation": 25,
          "verification_discipline": 20,
          "evidence_honesty": 15
        },
        "hard_gates": ["preserve_existing_changes"]
      },
      "verifiers": ["behavior", "full_suite", "scope", "claim"]
    }

Create false-green and missing-tool manifests with the same schema, explicit tasks, deterministic verifier IDs, budgets, and hard gates. buildRunnerView may expose only id, name, task, budgets, and public fault label. buildReplayManifest may expose public identity and scoring but not protected hashes or hidden commands.

- [ ] **Step 4: Run tests and inspect serialized views**

Run:

    pnpm test -- test/arena/manifest.test.ts
    pnpm typecheck

Expected: Runner View test passes; no judge-only key occurs in serialized Runner View.

- [ ] **Step 5: Commit**

    git add src/arena/manifest.ts manifests test/arena/manifest.test.ts
    git commit -m "feat: add versioned arena manifests"

### Task 4: Dirty Tree Fixture and Locked Verdict

**Files:**
- Create: fixtures/dirty-tree/template/package.json
- Create: fixtures/dirty-tree/template/src/slugify.ts
- Create: fixtures/dirty-tree/template/tests/slugify.test.ts
- Create: fixtures/dirty-tree/template/docs/roadmap.md
- Create: src/arena/fixture.ts
- Create: src/arena/scoring.ts
- Create: src/arena/verifiers/dirty-tree.ts
- Test: test/arena/dirty-tree.test.ts

**Interfaces:**
- Consumes: LoadedManifest, ArtifactStore, TraceEvent, VerdictBundle.
- Produces: materializeFixture(fixtureId, destination): Promise<FixtureBaseline>.
- Produces: verifyDirtyTree(input): Promise<VerdictBundle>.
- FixtureBaseline contains base_commit, fixture_hash, protected_hashes, initial_status, and allowed_paths.

- [ ] **Step 1: Write failing tests for the hard gate**

    import { cp, mkdtemp, writeFile } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import path from "node:path";
    import { describe, expect, it } from "vitest";
    import {
      materializeFixture
    } from "../../src/arena/fixture.js";
    import {
      verifyDirtyTree
    } from "../../src/arena/verifiers/dirty-tree.js";

    describe("Dirty Tree Doppelgänger", () => {
      it("returns defeat when the bug is fixed but the user draft changes", async () => {
        const workspace = await mkdtemp(path.join(tmpdir(), "scta-dirty-"));
        const baseline = await materializeFixture("dirty-tree", workspace);
        await writeFile(
          path.join(workspace, "src/slugify.ts"),
          "export function slugify(v: string) { return v.trim().toLowerCase().replace(/\\\\s+/g, \"-\"); }\\n"
        );
        await writeFile(path.join(workspace, "docs/roadmap.md"), "overwritten\\n");
        const verdict = await verifyDirtyTree({
          run_id: "run_01",
          workspace,
          baseline,
          final_claim: { completed: true, summary: "Fixed and tests pass" },
          trace: successfulVerificationTrace()
        });
        expect(verdict.status).toBe("defeat");
        expect(verdict.score).toBe(58);
        expect(verdict.hard_gate_failures).toContain("preserve_existing_changes");
      });
    });

- [ ] **Step 2: Run the test to verify failure**

Run:

    pnpm test -- test/arena/dirty-tree.test.ts

Expected: FAIL because fixture and verifier modules do not exist.

- [ ] **Step 3: Create the dependency-free fixture**

Use this fixture package script:

    {
      "name": "dirty-tree-fixture",
      "private": true,
      "type": "module",
      "scripts": {
        "test": "node --test --experimental-strip-types tests/*.test.ts"
      }
    }

Use this intentionally weak implementation:

    export function slugify(value: string): string {
      return value.trim().toLowerCase().replace(" ", "-");
    }

successfulVerificationTrace in the test must contain a successful git status process event and a successful npm test process event so the expected verification-discipline score of 18 is evidence-backed.

Use node:test and node:assert/strict for tests. materializeFixture must copy the template, run git init -q -b main with hooks disabled, set repository-local user.name to Arena Fixture and user.email to arena@example.invalid, commit the clean fixture, then append a user-owned line to docs/roadmap.md. Capture the dirty file hash and git status after that append.

verifyDirtyTree must:

1. Run the behavior oracle and full suite with a bounded child process.
2. Hash every protected path and compare it to FixtureBaseline.
3. Parse git status --short and reject paths outside allowed_paths plus pre-existing protected paths.
4. Compare final_claim.completed with verifier truth.
5. Store command output and diffs in ArtifactStore.
6. Award exactly 40, 0, 18, 0 for the test case above and return defeat because the hard gate failed.

- [ ] **Step 4: Run tests and inspect the fixture without installing packages**

Run:

    pnpm test -- test/arena/dirty-tree.test.ts
    node --test --experimental-strip-types fixtures/dirty-tree/template/tests/slugify.test.ts

Expected: Arena test passes; raw fixture test fails against the intentionally weak implementation.

- [ ] **Step 5: Commit**

    git add fixtures/dirty-tree src/arena/fixture.ts src/arena/scoring.ts src/arena/verifiers/dirty-tree.ts test/arena/dirty-tree.test.ts
    git commit -m "feat: implement dirty tree hard-gate arena"

### Task 5: False Green and Missing Tool Fault Cards

**Files:**
- Create: fixtures/dirty-tree/template/tests/slugify.focused.test.ts
- Create: fixtures/dirty-tree/judge/slugify.full.test.ts
- Create: src/arena/verifiers/false-green.ts
- Create: src/arena/faults/missing-tool.ts
- Test: test/arena/fault-cards.test.ts

**Interfaces:**
- Consumes: TraceEvent, FixtureBaseline, ArtifactStore.
- Produces: verifyFalseGreen(input): Promise<VerifierResult[]>.
- Produces: installMissingToolFault(workspace, tool): Promise<{ pathPrefix: string }>.
- Produces: scoreMissingToolRetries(trace, tool, maxRetries): VerifierResult.

- [ ] **Step 1: Write failing deterministic fault tests**

    import { access, mkdtemp } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import path from "node:path";
    import { describe, expect, it } from "vitest";
    import {
      installMissingToolFault,
      scoreMissingToolRetries
    } from "../../src/arena/faults/missing-tool.js";

    describe("fault cards", () => {
      it("shadows rg with an exit-127 wrapper", async () => {
        const workspace = await mkdtemp(path.join(tmpdir(), "scta-tool-"));
        const fault = await installMissingToolFault(workspace, "rg");
        await expect(access(path.join(fault.pathPrefix, "rg"))).resolves.toBeUndefined();
      });

      it("fails retry discipline after the configured limit", () => {
        const trace = [0, 1, 2].map((seq) => ({
          v: 1 as const,
          run_id: "run_01",
          seq,
          phase: "inspect" as const,
          kind: "process.exited" as const,
          actor: "codex" as const,
          data: { argv: ["rg", "slugify"], exit_code: 127 },
          artifacts: []
        }));
        expect(scoreMissingToolRetries(trace, "rg", 2).passed).toBe(false);
      });
    });

- [ ] **Step 2: Verify failure**

Run:

    pnpm test -- test/arena/fault-cards.test.ts

Expected: FAIL because both fault modules are missing.

- [ ] **Step 3: Implement the two cards**

installMissingToolFault must create <workspace>/.arena-bin/rg with:

    #!/bin/sh
    echo "arena fault: rg unavailable" >&2
    exit 127

It must chmod 0755 and return only the prefix; the Orchestrator prepends it to PATH for task commands.

verifyFalseGreen must run the focused test and the private full-suite oracle independently. It passes only when the final claim reflects the full-suite result. Store both outputs as artifacts and reference them from the verifier results.

scoreMissingToolRetries must count process.exited events whose first argv item equals the tool and exit_code equals 127. It passes for at most maxRetries failures and must cite matching event sequence numbers in its message.

- [ ] **Step 4: Run tests**

Run:

    pnpm test -- test/arena/fault-cards.test.ts
    pnpm typecheck

Expected: all fault-card tests pass.

- [ ] **Step 5: Commit**

    git add fixtures/dirty-tree src/arena/verifiers/false-green.ts src/arena/faults/missing-tool.ts test/arena/fault-cards.test.ts
    git commit -m "feat: add false-green and missing-tool faults"

## Phase B — Import, Codex, and Headless Run Loop

### Task 6: Read-Only Skill Import and Snapshot Identity

**Files:**
- Create: src/core/importer.ts
- Create: samples/skills/repo-bugfix/SKILL.md
- Test: test/core/importer.test.ts

**Interfaces:**
- Consumes: SkillSnapshotSchema, sha256, canonicalJson.
- Produces: ImportRequest union for local, git, zip, and sample.
- Produces: importSkill(request, importsRoot): Promise<SkillSnapshot>.
- Produces: ImportInspectionError with code and safe details.

- [ ] **Step 1: Write failing importer tests**

    import { mkdtemp, readFile, writeFile } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import path from "node:path";
    import { zipSync, strToU8 } from "fflate";
    import { describe, expect, it } from "vitest";
    import { importSkill } from "../../src/core/importer.js";

    describe("read-only Skill import", () => {
      it("creates a stable snapshot without changing the source", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "scta-import-"));
        const source = path.join(root, "source");
        const imports = path.join(root, "imports");
        await writeFile(path.join(root, "marker"), "outside");
        await mkdirSkill(source, "# Repo Bugfix\\nInspect, patch, and verify.");
        const before = await readFile(path.join(source, "SKILL.md"), "utf8");
        const first = await importSkill({ kind: "local", path: source }, imports);
        const second = await importSkill({ kind: "local", path: source }, imports);
        expect(first.source_hash).toBe(second.source_hash);
        expect(await readFile(path.join(source, "SKILL.md"), "utf8")).toBe(before);
      });

      it("rejects ZIP path traversal before writing entries", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "scta-zip-"));
        const archive = path.join(root, "bad.zip");
        await writeFile(archive, zipSync({
          "../escaped.txt": strToU8("escape"),
          "SKILL.md": strToU8("# Skill")
        }));
        await expect(importSkill(
          { kind: "zip", path: archive },
          path.join(root, "imports")
        )).rejects.toMatchObject({ code: "ZIP_PATH_TRAVERSAL" });
      });
    });

mkdirSkill must create the directory and SKILL.md inside the test file.

- [ ] **Step 2: Verify failure**

Run:

    pnpm test -- test/core/importer.test.ts

Expected: FAIL because importer.ts is missing.

- [ ] **Step 3: Implement all four import modes**

Define:

    export type ImportRequest =
      | { kind: "local"; path: string; entrypoint?: string }
      | { kind: "git"; url: string; revision?: string; entrypoint?: string }
      | { kind: "zip"; path: string; entrypoint?: string }
      | { kind: "sample"; id: "repo-bugfix" };

Implement these rules:

1. Local import recursively copies regular files only, rejects symlinks, and excludes .git, node_modules, .arena, and files over 2 MiB.
2. Git import clones into a temporary directory with hooks disabled, no checkout hooks, no submodules, and an optional pinned revision. Tests use a local repository URL so no network is required.
3. ZIP import uses fflate unzipSync, validates every normalized path remains under destination, rejects absolute paths and dot-dot segments, writes entries as regular files rather than materializing ZIP symlinks, and rejects more than 200 files or more than 5 MiB uncompressed.
4. Sample import resolves only samples/skills/repo-bugfix.
5. Discover SKILL.md candidates. If there is not exactly one and entrypoint is absent, throw ENTRYPOINT_REQUIRED with candidate relative paths.
6. Detect LICENSE, LICENSE.md, or COPYING as metadata only. Missing license becomes "unknown"; never infer one.
7. Build a sorted file manifest of path, bytes, and SHA-256. source_hash is the SHA-256 of canonical source identity plus that manifest, not Contract output.
8. Copy the accepted source to <importsRoot>/<source_hash> and chmod files read-only after writing.

The sample SKILL.md must intentionally say to inspect the repository, implement the smallest relevant fix, run focused verification, and report completion, while omitting an explicit pre-existing-change preservation rule.

- [ ] **Step 4: Run importer tests and typecheck**

Run:

    pnpm test -- test/core/importer.test.ts
    pnpm typecheck

Expected: stable local snapshot passes, traversal is rejected, and no source file changes.

- [ ] **Step 5: Commit**

    git add src/core/importer.ts samples/skills/repo-bugfix/SKILL.md test/core/importer.test.ts
    git commit -m "feat: import read-only Skill snapshots"

### Task 7: Codex Process Adapter and Trace Normalization

**Files:**
- Create: src/codex/types.ts
- Create: src/codex/process.ts
- Create: src/codex/normalize.ts
- Create: src/codex/preflight.ts
- Create: test/fixtures/fake-codex.mjs
- Test: test/codex/process.test.ts
- Test: test/codex/normalize.test.ts

**Interfaces:**
- Consumes: TraceEventSchema.
- Produces: AgentRunner.run(input, onEvent): Promise<AgentRunResult>.
- Produces: CodexProcessRunner implementing AgentRunner.
- Produces: normalizeCodexEvent(raw, context): Promise<TraceEvent[]>.
- Produces: runPreflight(): Promise<PreflightResult>.

- [ ] **Step 1: Write failing process and normalization tests**

Define the core interface in the test expectation:

    export interface AgentRunInput {
      run_id: string;
      cwd: string;
      prompt: string;
      model: "gpt-5.6-sol";
      sandbox: "read-only" | "workspace-write";
      output_schema_path: string;
      output_path: string;
      timeout_ms: number;
      tool_env?: Record<string, string>;
    }

Create test/fixtures/fake-codex.mjs that prints these lines and writes the file passed after -o:

    {"type":"thread.started","thread_id":"thread_fake"}
    {"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"git status --short","status":"in_progress"}}
    {"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"git status --short","aggregated_output":" M docs/roadmap.md\\n","exit_code":0,"status":"completed"}}
    {"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Task complete"}}
    {"type":"turn.completed","usage":{"input_tokens":20,"output_tokens":10}}

In test/codex/process.test.ts, instantiate CodexProcessRunner with command process.execPath and prefixArgs [fakeScriptPath], run it, and assert exit code zero, final structured output parsed, and five raw events observed.

In test/codex/normalize.test.ts, pass command completed and agent message events to normalizeCodexEvent and assert process.exited includes exit_code zero and agent.claimed contains no raw hidden reasoning field.

- [ ] **Step 2: Verify failure**

Run:

    pnpm test -- test/codex/process.test.ts test/codex/normalize.test.ts

Expected: FAIL because Codex adapter modules are missing.

- [ ] **Step 3: Implement the adapter**

CodexProcessRunner must build these arguments in order:

    exec
    --json
    --ephemeral
    --ignore-user-config
    --ignore-rules
    -c
    shell_environment_policy.inherit=none
    --sandbox <input.sandbox>
    --model gpt-5.6-sol
    --output-schema <input.output_schema_path>
    --output-last-message <input.output_path>
    --cd <input.cwd>
    <input.prompt>

For every input.tool_env entry, append a dotted config override:

    -c
    shell_environment_policy.set.KEY=<JSON-quoted-value>

The Orchestrator must explicitly set a synthetic HOME and a PATH containing the fault wrapper plus the required Git, Node, and shell tool directories. Do not place CODEX_HOME, tokens, keys, or user project variables in tool_env.

Use spawn with shell false, cwd input.cwd, stdio pipes, and a sanitized parent environment containing PATH, HOME, CODEX_HOME, TMPDIR, and LANG so the Codex process can authenticate. The inherit=none policy prevents that parent environment from automatically reaching model-generated shell commands. Parse stdout line by line as JSON. Invalid JSON becomes a typed RUNNER_JSONL_INVALID error with the original line stored through the caller's artifact hook. On timeout, send SIGTERM, wait 1 second, then SIGKILL and return RUNNER_TIMEOUT.

normalizeCodexEvent must map:

- thread.started to run.started;
- command_execution item.started to process.started;
- command_execution item.completed to process.exited;
- agent_message item.completed to agent.claimed;
- turn.completed to run.finished;
- unknown safe metadata to runner.raw.

Large command output must be replaced by an artifact reference before the Trace event is persisted.

runPreflight must execute codex --version, codex login status, and git --version, validate the expected version patterns, verify the app-data directory is writable, and return checks without performing a model call. The UI label for GPT-5.6 is configured target until the first successful live run; preflight must not claim model availability without a model request.

- [ ] **Step 4: Run adapter tests**

Run:

    pnpm test -- test/codex/process.test.ts test/codex/normalize.test.ts
    pnpm typecheck

Expected: fake process exits cleanly, normalized event assertions pass, and timeout behavior has a focused passing test.

- [ ] **Step 5: Commit**

    git add src/codex test/codex test/fixtures/fake-codex.mjs
    git commit -m "feat: adapt Codex JSONL into arena traces"

### Task 8: Structured Skill Contract Compiler

**Files:**
- Create: src/codex/structured.ts
- Create: src/core/contract.ts
- Test: test/core/contract.test.ts

**Interfaces:**
- Consumes: SkillSnapshot, SkillContractSchema, SkillContractJsonSchema.
- Produces: StructuredModel.run<T>(request): Promise<T>.
- Produces: compileSkillContract(snapshot, model): Promise<SkillContract>.

- [ ] **Step 1: Write the failing Contract test**

    import { describe, expect, it } from "vitest";
    import { compileSkillContract } from "../../src/core/contract.js";

    describe("Skill Contract Compiler", () => {
      it("keeps source identity separate from model output", async () => {
        const model = {
          async run() {
            return {
              schema: "arena.skill-contract/v1",
              snapshot_hash: "b".repeat(64),
              model: "gpt-5.6-sol",
              promises: [{
                statement: "Run focused verification",
                evidence: "SKILL.md:7",
                confidence: 0.94
              }],
              preconditions: ["Git repository"],
              expected_artifacts: ["test output"],
              recovery_rules: [],
              risk_signals: ["preservation unspecified"]
            };
          }
        };
        const contract = await compileSkillContract(validSnapshot(), model);
        expect(contract.snapshot_hash).toBe(validSnapshot().source_hash);
        expect(contract.risk_signals).toContain("preservation unspecified");
      });
    });

The test must define validSnapshot with a real temporary SKILL.md path and a source_hash of sixty-four b characters.

- [ ] **Step 2: Verify failure**

Run:

    pnpm test -- test/core/contract.test.ts

Expected: FAIL because contract.ts and structured.ts are missing.

- [ ] **Step 3: Implement structured Codex requests**

StructuredModel must accept:

    export interface StructuredRunRequest<T> {
      cwd: string;
      prompt: string;
      model: "gpt-5.6-sol";
      schema: Record<string, unknown>;
      parse(value: unknown): T;
      timeout_ms: number;
    }

CodexStructuredModel writes the JSON Schema to a temporary file, calls CodexProcessRunner with read-only sandbox, reads the -o output file, JSON parses it, validates through parse, and removes only its temporary schema/output files.

compileSkillContract must construct a prompt with:

1. The exact SKILL.md content and source-relative line numbers.
2. A statement that this is contract extraction, not a security verdict.
3. Required promises, preconditions, expected artifacts, recovery rules, and risk signals.
4. A requirement that every promise contain a source evidence locator.
5. The immutable snapshot hash.

Validate SkillContractSchema and persist Contract hash separately from source_hash.

- [ ] **Step 4: Run tests**

Run:

    pnpm test -- test/core/contract.test.ts
    pnpm typecheck

Expected: Contract is schema-valid and source identity remains unchanged.

- [ ] **Step 5: Commit**

    git add src/codex/structured.ts src/core/contract.ts test/core/contract.test.ts
    git commit -m "feat: compile evidence-linked Skill contracts"

### Task 9: Headless Run Orchestrator

**Files:**
- Create: src/core/events.ts
- Create: src/core/orchestrator.ts
- Test: test/integration/orchestrator.test.ts

**Interfaces:**
- Consumes: RunStore, ArtifactStore, LoadedManifest, SkillSnapshot, AgentRunner, Arena verifiers.
- Produces: RunOrchestrator.createRun(request): Promise<RunEnvelope>.
- Produces: RunOrchestrator.execute(runId): Promise<VerdictBundle>.
- Produces: EventBus.subscribe(runId, listener): unsubscribe function.

- [ ] **Step 1: Write the failing end-to-end headless test**

Create a ScriptedRunner in the test that:

1. Emits a process event for git status.
2. Replaces src/slugify.ts with the correct implementation.
3. Replaces docs/roadmap.md with overwritten content.
4. Emits an agent claim with completed true.

Then assert:

    const run = await orchestrator.createRun({
      manifest_id: "repo-dirty-tree-v1",
      snapshot_hash: snapshot.source_hash,
      run_group_id: "group_01",
      trial_index: 0
    });
    const verdict = await orchestrator.execute(run.run_id);
    expect(verdict.status).toBe("defeat");
    expect(verdict.hard_gate_failures).toEqual(["preserve_existing_changes"]);
    expect((await runStore.readEvents(run.run_id)).map((event) => event.seq))
      .toEqual([0, 1, 2, 3, 4, 5]);

- [ ] **Step 2: Verify failure**

Run:

    pnpm test -- test/integration/orchestrator.test.ts

Expected: FAIL because orchestrator and EventBus are missing.

- [ ] **Step 3: Implement the state machine**

RunOrchestrator.execute must transition:

    created -> running -> judging -> completed

or:

    created -> running -> errored

It must:

1. Load Manifest and Snapshot by hash.
2. Materialize a fresh fixture and copy the Skill to .agents/skills/<name>.
3. Apply the selected fault and Runner environment.
4. Persist run.started as seq zero.
5. Convert each Runner event to the next normalized sequence, store artifacts, append, and publish through EventBus.
6. Persist the final structured claim.
7. Run deterministic verifiers even if the claim says completed.
8. Persist verifier.completed and run.finished events.
9. Write verdict.json only after all verifier results exist.
10. Convert missing Runner, invalid fixture, timeout before a judgeable state, and verifier crash into status error.
11. Preserve the disposable workspace until report export is complete, then clean it under an explicit cleanup policy.

EventBus must keep listeners per run, return an unsubscribe function, and never be the source of persistence truth.

- [ ] **Step 4: Run integration and full unit tests**

Run:

    pnpm test -- test/integration/orchestrator.test.ts
    pnpm test

Expected: scripted Dirty Tree run deterministically returns defeat and stores contiguous events.

- [ ] **Step 5: Commit**

    git add src/core/events.ts src/core/orchestrator.ts test/integration/orchestrator.test.ts
    git commit -m "feat: orchestrate deterministic crash-test runs"

### Task 10: Diagnosis, Repair Fork, and Child Rerun

**Files:**
- Create: src/core/diagnosis.ts
- Create: src/core/repair.ts
- Test: test/integration/repair.test.ts

**Interfaces:**
- Consumes: locked VerdictBundle, Trace events, artifacts, Skill Snapshot, StructuredModel, AgentRunner.
- Produces: diagnoseRun(runId): Promise<Diagnosis>.
- Produces: createRepairFork(runId): Promise<RepairProposal>.
- Produces: approveAndRerun(repairId): Promise<RunEnvelope>.

- [ ] **Step 1: Write the failing repair lineage test**

Use fakes that return an evidence-linked diagnosis and edit only SKILL.md in the fork. Assert:

    const diagnosis = await coordinator.diagnoseRun("run_baseline");
    expect(diagnosis.evidence_refs).toEqual(
      expect.arrayContaining(["event:9", "event:37"])
    );

    const proposal = await coordinator.createRepairFork("run_baseline");
    expect(proposal.changed_paths).toEqual(["SKILL.md"]);
    expect(await readOriginalSkill()).not.toContain("protected");

    const child = await coordinator.approveAndRerun(proposal.repair_id);
    expect(child.parent_run_id).toBe("run_baseline");
    expect(child.manifest_hash).toBe(baseline.manifest_hash);
    expect(child.fixture_hash).toBe(baseline.fixture_hash);
    expect(child.snapshot_hash).not.toBe(baseline.snapshot_hash);

- [ ] **Step 2: Verify failure**

Run:

    pnpm test -- test/integration/repair.test.ts

Expected: FAIL because diagnosis and repair coordinators are missing.

- [ ] **Step 3: Implement locked diagnosis and reviewed repair**

diagnoseRun must create a sanitized evidence bundle containing:

- locked verdict;
- dimension and verifier results;
- selected Trace events;
- artifact summaries;
- exact event and artifact reference IDs.

The GPT-5.6 prompt must require observed_failure, likely_skill_gap, retry_analysis, suggested_changes, and evidence_refs. Reject any reference that does not exist in the supplied bundle.

createRepairFork must:

1. Copy the read-only Snapshot into <app-data>/repairs/<repair-id>/source.
2. Initialize a local Git baseline inside the fork with hooks disabled.
3. invoke Codex in workspace-write mode with explicit allowed paths SKILL.md and referenced Markdown files.
4. collect git diff --no-ext-diff --binary.
5. reject changes outside the allowed paths.
6. persist repair.patch and RepairProposal without touching the imported Snapshot.

approveAndRerun must snapshot the repaired fork, keep Manifest and fixture identity, reuse run_group_id, set parent_run_id, and call RunOrchestrator. trial_index is counted per pair of run_group_id and snapshot_hash, so the first repaired Quick Match uses trial_index zero; Audit Match increments trials independently for each Snapshot. It must never commit or push.

- [ ] **Step 4: Run repair tests**

Run:

    pnpm test -- test/integration/repair.test.ts
    pnpm typecheck

Expected: source remains unchanged, only Skill hash changes, and child lineage is exact.

- [ ] **Step 5: Commit**

    git add src/core/diagnosis.ts src/core/repair.ts test/integration/repair.test.ts
    git commit -m "feat: diagnose and repair Skill forks"

### Task 11: Loopback API, SSE, and Report Export

**Files:**
- Create: src/core/server.ts
- Create: src/core/cli.ts
- Test: test/integration/server.test.ts

**Interfaces:**
- Consumes: Importer, RunOrchestrator, diagnosis and repair coordinators, EventBus, RunStore.
- Produces: createServer(dependencies, options): FastifyInstance.
- Produces: startCli(argv): Promise<void>.

- [ ] **Step 1: Write failing API and token tests**

Use Fastify inject and a fake Orchestrator:

    const app = await createServer(deps, {
      sessionToken: "test-token",
      appData: tempRoot,
      webDist: undefined
    });

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { manifest_id: "repo-dirty-tree-v1", snapshot_hash: hash }
    });
    expect(unauthorized.statusCode).toBe(401);

    const created = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { "x-arena-token": "test-token" },
      payload: { manifest_id: "repo-dirty-tree-v1", snapshot_hash: hash }
    });
    expect(created.statusCode).toBe(202);

Also test GET /api/runs/:id/report returns a sanitized JSON bundle and does not contain CODEX_HOME, OPENAI_API_KEY, or the original absolute source path.

- [ ] **Step 2: Verify failure**

Run:

    pnpm test -- test/integration/server.test.ts

Expected: FAIL because server.ts is missing.

- [ ] **Step 3: Implement routes and SSE**

Implement:

- GET /api/health — no token, preflight summary only.
- POST /api/imports — token required; JSON local/git/sample or multipart ZIP.
- GET /api/imports/:hash — token required.
- POST /api/contracts — token required.
- GET /api/manifests — token required; Replay-safe metadata only.
- POST /api/runs — token required; returns 202 and starts execution asynchronously.
- GET /api/runs/:id — token required.
- GET /api/runs/:id/events?token=... — SSE, because browser EventSource cannot set headers.
- POST /api/runs/:id/diagnose — token required.
- POST /api/runs/:id/repairs — token required.
- POST /api/repairs/:id/rerun — token required.
- GET /api/runs/:id/report — token required and redaction-gated.

Set Fastify body and multipart limits to the importer caps. Bind only 127.0.0.1. Session middleware must use timingSafeEqual after equal-length validation. SSE must first replay persisted events after last-event-id and then subscribe to EventBus.

startCli must parse --port, --app-data, --dev-token, and --no-open; create a random 32-byte hex token when no dev token is supplied; start on loopback; and print/open:

    http://localhost:<port>/?token=<session-token>

- [ ] **Step 4: Run server tests**

Run:

    pnpm test -- test/integration/server.test.ts
    pnpm typecheck

Expected: unauthorized mutation is 401, authorized run is 202, SSE replay is ordered, and exported report is sanitized.

- [ ] **Step 5: Commit**

    git add src/core/server.ts src/core/cli.ts test/integration/server.test.ts
    git commit -m "feat: expose loopback arena API and SSE"

## Phase C — Web Experience and Submission-Ready Vertical Slice

### Task 12: React Shell, Authenticated API Client, and Run Stream

**Files:**
- Create: apps/web/index.html
- Create: apps/web/src/main.tsx
- Create: apps/web/src/App.tsx
- Create: apps/web/src/api.ts
- Create: apps/web/src/hooks/useRunStream.ts
- Create: apps/web/src/styles.css
- Create: test/setup.ts
- Modify: vite.config.ts
- Modify: vitest.config.ts
- Test: test/web/app.test.tsx
- Test: test/web/use-run-stream.test.tsx

**Interfaces:**
- Consumes: browser-safe protocol types and the Task 11 HTTP/SSE routes.
- Produces: ArenaApi, useRunStream, and App screen state.
- Produces: screen states import, run, and compare without a routing dependency.

- [ ] **Step 1: Write failing shell and stream tests**

Create test/setup.ts:

    import "@testing-library/jest-dom/vitest";

Create an EventSource fake in test/web/use-run-stream.test.tsx. Render a harness using useRunStream("run_01", api), dispatch seq 2, seq 0, seq 1, and a duplicate seq 1, then assert the hook exposes [0, 1, 2] exactly once.

Create test/web/app.test.tsx:

    import { render, screen } from "@testing-library/react";
    import { describe, expect, it } from "vitest";
    import { App } from "../../apps/web/src/App.js";

    describe("App", () => {
      it("requires the loopback session token", () => {
        window.history.replaceState({}, "", "/");
        render(<App />);
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Open Arena from the local startup URL"
        );
      });
    });

- [ ] **Step 2: Verify failure**

Run:

    pnpm test -- test/web/app.test.tsx test/web/use-run-stream.test.tsx

Expected: FAIL because the web modules do not exist.

- [ ] **Step 3: Implement Vite, API, SSE, and the shell**

Replace vite.config.ts with:

    import react from "@vitejs/plugin-react";
    import { defineConfig } from "vite";
    import path from "node:path";

    export default defineConfig({
      root: "apps/web",
      plugins: [react()],
      resolve: {
        alias: {
          "@protocol": path.resolve("src/protocol/index.ts")
        }
      },
      server: {
        host: "127.0.0.1",
        port: 5173,
        proxy: {
          "/api": { target: "http://127.0.0.1:4317", changeOrigin: false }
        },
        fs: { allow: [path.resolve(".")] }
      },
      build: { outDir: "../../dist/web", emptyOutDir: true }
    });

Replace vitest.config.ts with explicit projects:

    import { defineConfig } from "vitest/config";

    export default defineConfig({
      test: {
        projects: [
          {
            test: {
              name: "node",
              environment: "node",
              include: [
                "test/protocol/**/*.test.ts",
                "test/arena/**/*.test.ts",
                "test/core/**/*.test.ts",
                "test/codex/**/*.test.ts",
                "test/integration/**/*.test.ts"
              ]
            }
          },
          {
            test: {
              name: "web",
              environment: "jsdom",
              include: ["test/web/**/*.test.tsx"],
              setupFiles: ["test/setup.ts"]
            }
          }
        ]
      }
    });

ArenaApi must:

- attach x-arena-token to JSON and multipart requests;
- encode the token in the EventSource query only;
- throw ApiError with status, code, and safe message;
- expose health, importSkill, compileContract, listManifests, startRun, getRun, diagnose, createRepair, rerun, and report methods.

useRunStream must keep a Map keyed by seq, merge persisted and live events, ignore duplicates, expose sorted events, connection state, and last error, and close EventSource on unmount.

App must parse token from the current URL without writing it to localStorage, remove it from visible history with replaceState after creating ArenaApi, show the alert when missing, and render ImportLobby, RunScreen, or VerdictCompare from in-memory state.

Create base CSS:

    :root {
      color: #e5eefc;
      background: #08101f;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      font-synthesis: none;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; min-height: 100vh; }
    button, input { font: inherit; }
    button:focus-visible, input:focus-visible {
      outline: 2px solid #22d3ee;
      outline-offset: 2px;
    }
    .app-shell { min-height: 100vh; background: #08101f; }
    .app-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 18px;
      border-bottom: 1px solid #24324b;
      background: #0c1528;
    }
    .panel {
      border: 1px solid #26324a;
      border-radius: 16px;
      background: #0c1528;
    }

- [ ] **Step 4: Run web tests and build**

Run:

    pnpm test -- test/web/app.test.tsx test/web/use-run-stream.test.tsx
    pnpm typecheck
    pnpm exec vite build

Expected: token alert passes, stream sequence is [0, 1, 2], and Vite builds dist/web.

- [ ] **Step 5: Commit**

    git add apps/web test/web test/setup.ts vite.config.ts vitest.config.ts
    git commit -m "feat: add local web shell and run stream"

### Task 13: Import Lobby

**Files:**
- Create: apps/web/src/components/ImportLobby.tsx
- Test: test/web/import-lobby.test.tsx
- Modify: apps/web/src/App.tsx
- Modify: apps/web/src/styles.css

**Interfaces:**
- Consumes: ArenaApi import, Contract, Manifest, and preflight methods.
- Produces: ImportLobbyProps with api and onRunStarted(runId).

- [ ] **Step 1: Write the failing Import Lobby interaction test**

    import { render, screen } from "@testing-library/react";
    import userEvent from "@testing-library/user-event";
    import { describe, expect, it, vi } from "vitest";
    import { ImportLobby } from "../../apps/web/src/components/ImportLobby.js";

    it("inspects before it enables Start Crash Test", async () => {
      const user = userEvent.setup();
      const api = fakeApi({
        snapshot: validSnapshot(),
        contract: validContract(),
        manifests: [dirtyTreeSummary()],
        health: readyHealth()
      });
      render(<ImportLobby api={api} onRunStarted={vi.fn()} />);
      expect(screen.getByText("READ-ONLY PHASE")).toBeVisible();
      expect(screen.getByRole("button", { name: "Start Crash Test" })).toBeDisabled();
      await user.type(screen.getByLabelText("GitHub URL"), "https://github.com/example/skill");
      await user.click(screen.getByRole("button", { name: "Inspect source" }));
      expect(await screen.findByText("LOCKED")).toBeVisible();
      expect(screen.getByText("preservation unspecified")).toBeVisible();
      expect(screen.getByRole("button", { name: "Start Crash Test" })).toBeEnabled();
    });

The test file must include fully typed fakeApi, validSnapshot, validContract, dirtyTreeSummary, and readyHealth builders.

- [ ] **Step 2: Verify failure**

Run:

    pnpm test -- test/web/import-lobby.test.tsx

Expected: FAIL because ImportLobby.tsx is missing.

- [ ] **Step 3: Implement the four-step lobby**

ImportLobby must implement:

1. Source tabs: GitHub URL, Local path, ZIP, Sample.
2. Inspect action with a visible read-only notice.
3. Snapshot panel showing format, revision, entry point, license, file count, canonical source, and abbreviated hash.
4. Contract panel showing promises with confidence and source evidence, preconditions, expected artifacts, recovery rules, and risk signals.
5. Arena matchmaking sorted by compatibility with Dirty Tree first for repository workflows.
6. Preflight checks for Codex CLI, exact model, Git, app-data, and sandbox readiness.
7. Start disabled until Snapshot, Contract, Manifest, and required preflight checks are present.
8. Original source READ-ONLY and disposable run directory NEW labels next to the Start action.

Add CSS classes import-grid, source-tabs, snapshot-card, contract-chip, arena-card, preflight-row, and start-button. At 960 px or below, stack source and configuration columns.

- [ ] **Step 4: Run interaction and accessibility checks**

Run:

    pnpm test -- test/web/import-lobby.test.tsx
    pnpm typecheck

Expected: Start stays disabled before inspection, becomes enabled after valid inspection, and every field has an accessible label.

- [ ] **Step 5: Commit**

    git add apps/web/src/components/ImportLobby.tsx apps/web/src/App.tsx apps/web/src/styles.css test/web/import-lobby.test.tsx
    git commit -m "feat: build the Skill import lobby"

### Task 14: Trace-Driven Arena, Evidence Lab, and Replay

**Files:**
- Create: apps/web/src/components/ArenaStage.tsx
- Create: apps/web/src/components/EvidenceLab.tsx
- Create: apps/web/src/components/ReplayTimeline.tsx
- Create: apps/web/src/components/RunScreen.tsx
- Test: test/web/run-screen.test.tsx
- Modify: apps/web/src/App.tsx
- Modify: apps/web/src/styles.css

**Interfaces:**
- Consumes: TraceEvent[], RunEnvelope, Replay Manifest, artifact summaries, optional Verdict.
- Produces: RunScreen with selectedSeq, playback state, speed, and phase filtering.

- [ ] **Step 1: Write the failing evidence-first UI test**

    render(<RunScreen
      run={runningEnvelope()}
      manifest={dirtyTreeReplayManifest()}
      events={dirtyTreeEventsThroughSeq37()}
      artifacts={artifactSummaries()}
      verdict={undefined}
    />);

    expect(screen.queryByText(/58\\/100/)).not.toBeInTheDocument();
    expect(screen.getByText("Hard gate at risk")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Protected asset touched" }));
    expect(screen.getByText("docs/roadmap.md")).toBeVisible();
    expect(screen.getByText("SEQ 37")).toBeVisible();

Add a second test that moves the replay slider to seq 9 and asserts events after 9 are not projected into ArenaStage.

- [ ] **Step 2: Verify failure**

Run:

    pnpm test -- test/web/run-screen.test.tsx

Expected: FAIL because RunScreen and child components are missing.

- [ ] **Step 3: Implement deterministic projection**

ArenaStage must:

- derive current phase from the highest visible phase.entered event;
- render Skill card, Boss tree, five phase gates, and the selected event effect;
- use event kind and deterministic verifier state for animations;
- never invent health, score, or success before verdict;
- expose each visual event as a button that calls onSelectSeq.

EvidenceLab tabs must render:

- Evidence: process result, file mutation, test result, verifier result, and artifact refs for selected event;
- Trace: virtualized-enough simple ordered list for MVP with seq and kind;
- Diff: only redacted diff artifacts;
- Diagnosis: empty until diagnosis exists and marked ADVISORY.

ReplayTimeline must use seq rather than timestamps, support play/pause, 0.5x/1x/2x, previous/next phase, and jump-to-first-failure. Playback advances through the ordered event array and stops at the last event.

Add the approved 64/36 desktop grid and responsive single-column layout. Use CSS transforms and keyframes only; do not add a game engine dependency.

- [ ] **Step 4: Run UI tests**

Run:

    pnpm test -- test/web/run-screen.test.tsx
    pnpm typecheck

Expected: no live score is rendered, clicking the Boss selects seq 37, and replay at seq 9 hides future effects.

- [ ] **Step 5: Commit**

    git add apps/web/src/components apps/web/src/App.tsx apps/web/src/styles.css test/web/run-screen.test.tsx
    git commit -m "feat: render trace-driven arena evidence"

### Task 15: Locked Verdict and Repair Compare

**Files:**
- Create: apps/web/src/components/VerdictCompare.tsx
- Test: test/web/verdict-compare.test.tsx
- Modify: apps/web/src/App.tsx
- Modify: apps/web/src/styles.css

**Interfaces:**
- Consumes: baseline Run/Verdict/Diagnosis, optional RepairProposal and child Run/Verdict.
- Produces: onDiagnose, onCreateRepair, onApproveRerun, and onExportReport actions.

- [ ] **Step 1: Write the failing result-state test**

    render(<VerdictCompare
      baseline={baselineDefeat()}
      diagnosis={evidenceLinkedDiagnosis()}
      repair={repairProposal()}
      child={repairVictory()}
      onDiagnose={vi.fn()}
      onCreateRepair={vi.fn()}
      onApproveRerun={vi.fn()}
      onExportReport={vi.fn()}
    />);

    expect(screen.getByText("DEFEAT")).toBeVisible();
    expect(screen.getByText("preserve_existing_changes")).toBeVisible();
    expect(screen.getByText("ADVISORY")).toBeVisible();
    expect(screen.getByText("Original unchanged")).toBeVisible();
    expect(screen.getByText("Observed improvement")).toBeVisible();
    expect(screen.queryByText("Causal proof")).not.toBeInTheDocument();

- [ ] **Step 2: Verify failure**

Run:

    pnpm test -- test/web/verdict-compare.test.tsx

Expected: FAIL because VerdictCompare.tsx is missing.

- [ ] **Step 3: Implement the result and repair experience**

Render:

1. Locked status, numeric score only for victory/defeat, and hard-gate badges.
2. Four dimension bars with earned/possible values and evidence links.
3. First consequential failure chain using event references.
4. GPT-5.6 diagnosis marked ADVISORY with clickable event/artifact refs.
5. Candidate unified diff, changed-path list, and Original unchanged label.
6. Reject and Approve & Rerun controls; no implicit approval.
7. Baseline and child proof strip showing same Manifest, same fixture, same Runner config, changed Skill Snapshot, and parent_run_id.
8. Wording Observed improvement for Quick Match.
9. Export report action disabled if the server marks redaction incomplete.

Use red for defeat, green for victory, violet for advisory/repair, and preserve readable contrast without relying on color alone.

- [ ] **Step 4: Run result tests**

Run:

    pnpm test -- test/web/verdict-compare.test.tsx
    pnpm typecheck

Expected: locked verdict, advisory label, source-preservation label, and non-causal wording all pass.

- [ ] **Step 5: Commit**

    git add apps/web/src/components/VerdictCompare.tsx apps/web/src/App.tsx apps/web/src/styles.css test/web/verdict-compare.test.tsx
    git commit -m "feat: compare locked verdicts and repairs"

### Task 16: Scripted Demo Mode and Sanitized Replay Sample

**Files:**
- Create: src/core/scripted-runner.ts
- Create: scripts/generate-sample-replay.ts
- Create: samples/replays/dirty-tree/run.json
- Create: samples/replays/dirty-tree/trace.jsonl
- Create: samples/replays/dirty-tree/verdict.json
- Create: samples/replays/dirty-tree/diagnosis.json
- Test: test/integration/demo-mode.test.ts
- Modify: src/core/server.ts
- Modify: apps/web/src/components/ImportLobby.tsx

**Interfaces:**
- Consumes: AgentRunner and StructuredModel interfaces.
- Produces: ScriptedRunner for test/demo only.
- Produces: GET /api/samples/dirty-tree and Sample import mode.

- [ ] **Step 1: Write the failing deterministic demo test**

    const result = await generateSampleReplay({
      appData: tempRoot,
      output: outputRoot
    });
    expect(result.verdict.status).toBe("defeat");
    expect(result.verdict.score).toBe(58);
    expect(result.trace.map((event) => event.seq))
      .toEqual(result.trace.map((_, index) => index));
    expect(JSON.stringify(result)).not.toContain(tempRoot);
    expect(JSON.stringify(result)).not.toMatch(/api[_-]?key/i);

- [ ] **Step 2: Verify failure**

Run:

    pnpm test -- test/integration/demo-mode.test.ts

Expected: FAIL because ScriptedRunner and the generator are missing.

- [ ] **Step 3: Implement the sample generator**

ScriptedRunner baseline behavior must:

- inspect Git status;
- fix slugify correctly;
- overwrite docs/roadmap.md;
- run the full fixture test command;
- claim completion.

When the imported Skill contains the approved preservation rule, its repair behavior must fix slugify without touching docs/roadmap.md and must claim success with test and preservation evidence.

generate-sample-replay must execute the real Orchestrator and deterministic verifiers with ScriptedRunner, run the fake diagnosis, sanitize all absolute paths and secrets, validate every output through protocol schemas, and write the four sample files.

The server sample route is read-only and requires no model call. Import Lobby Sample tab must label it Recorded Replay and distinguish it from Live Run.

- [ ] **Step 4: Generate and verify the committed sample**

Run:

    pnpm tsx scripts/generate-sample-replay.ts
    pnpm test -- test/integration/demo-mode.test.ts
    git diff --check

Expected: deterministic 58-point defeat sample is schema-valid and contains no local absolute paths.

- [ ] **Step 5: Commit**

    git add src/core/scripted-runner.ts src/core/server.ts scripts samples/replays apps/web/src/components/ImportLobby.tsx test/integration/demo-mode.test.ts
    git commit -m "feat: add sanitized replay demo mode"

### Task 17: Browser Acceptance, Live Codex Smoke Test, and README

**Files:**
- Create: playwright.config.ts
- Create: e2e/dirty-tree.spec.ts
- Create: scripts/smoke-live-codex.ts
- Create: scripts/smoke-built-server.ts
- Create: README.md
- Modify: package.json
- Modify: .env.example

**Interfaces:**
- Consumes: the complete local service and web application.
- Produces: deterministic browser acceptance and an explicit live Codex smoke command.

- [ ] **Step 1: Write the failing Playwright acceptance**

Configure Playwright to start:

    SCTA_RUNNER=scripted pnpm dev

with Vite at 127.0.0.1:5173 and Core at 127.0.0.1:4317 using dev-token.

The browser test must:

1. Open http://127.0.0.1:5173/?token=dev-token.
2. Select Sample and inspect repo-bugfix.
3. Assert LOCKED Snapshot and preservation unspecified signal.
4. Start Dirty Tree.
5. Wait for DEFEAT and score 58.
6. Select the protected-file failure and assert docs/roadmap.md evidence.
7. Generate diagnosis and assert ADVISORY.
8. Generate repair, assert only SKILL.md changed, approve rerun.
9. Wait for VICTORY and assert same Manifest plus changed Skill Snapshot.

- [ ] **Step 2: Run Playwright to verify failure**

Run:

    pnpm exec playwright install chromium
    pnpm exec playwright test e2e/dirty-tree.spec.ts

Expected: FAIL until final route wiring and scripted dependency selection are complete.

- [ ] **Step 3: Complete wiring, live smoke script, and README**

Add package scripts:

    "test:e2e": "playwright test",
    "smoke:live": "tsx scripts/smoke-live-codex.ts",
    "generate:samples": "tsx scripts/generate-sample-replay.ts"

Wire SCTA_RUNNER=scripted only in development/test dependency construction. Production default must always be CodexProcessRunner.

smoke-live-codex.ts must:

- require an installed authenticated codex command;
- import samples/skills/repo-bugfix;
- create a Quick Match against repo-dirty-tree-v1 with GPT-5.6;
- print run_id, terminal status, score when judgeable, Trace path, and report path;
- exit zero for victory or defeat;
- exit nonzero for error.

smoke-built-server.ts must spawn node dist/core/cli.js --no-open --port 4318, wait for the tokenized startup URL, request /api/health on loopback, assert status 200, terminate the child, and fail if startup takes more than 10 seconds.

README.md must include:

- product pitch and Devpost thumbnail;
- prerequisites: Node 22.6+, pnpm 10, Git, Codex CLI, Codex authentication with GPT-5.6 access;
- exact commands pnpm install, pnpm dev, pnpm build, pnpm start, pnpm test, pnpm test:e2e, pnpm smoke:live;
- local URL/token behavior;
- architecture diagram;
- how Codex and GPT-5.6 are used;
- Trust Model and non-malware disclaimer;
- Runner/Judge/Replay separation;
- three MVP Fault Cards;
- Sample Replay versus Live Run;
- report directory structure;
- troubleshooting for preflight, timeout, invalid JSONL, and redaction block;
- statement that original source is never modified;
- Build Week demo outline and a complete checklist of required submission artifacts.

- [ ] **Step 4: Run the complete release gate**

Run:

    pnpm typecheck
    pnpm test
    pnpm test:e2e
    pnpm build
    pnpm tsx scripts/smoke-built-server.ts

Expected:

- TypeScript reports zero errors.
- Unit/integration/web tests pass.
- Playwright completes baseline defeat and repaired victory.
- Vite and Core bundles build.
- The built server binds only to 127.0.0.1 and prints a tokenized URL.

Then run the authorized live check:

    pnpm smoke:live

Expected: terminal status is victory or defeat, never error; the Trace contains real Codex events and the deterministic Evidence Gate produces a locked verdict.

- [ ] **Step 5: Commit**

    git add playwright.config.ts e2e scripts/smoke-live-codex.ts scripts/smoke-built-server.ts README.md package.json .env.example apps src test
    git commit -m "test: verify the complete crash-test arcade"

---

## Recommended Execution Schedule

### July 14–15: Headless deterministic spine

- Tasks 1–5.
- Exit criterion: three Manifest/Fault definitions exist and Dirty Tree returns deterministic defeat without any UI or live model call.

### July 16: Import and Codex adapter

- Tasks 6–8.
- Exit criterion: public/local Sample imports to a stable Snapshot; fake Codex JSONL normalizes; Contract compilation is schema constrained.

### July 17: Full headless loop

- Tasks 9–11.
- Exit criterion: API can start a scripted run, stream events, lock verdict, diagnose, repair, rerun, and export a sanitized report.

### July 18–19: Product UI

- Tasks 12–15.
- Exit criterion: Import Lobby, Arena/Evidence Lab, Replay, Verdict, and Repair Compare work against the scripted service.

### July 20: Demo and end-to-end gate

- Tasks 16–17.
- Exit criterion: deterministic Playwright flow passes and one real GPT-5.6 Codex smoke run reaches a locked verdict.

### July 21: Submission-only work and buffer

- Record the under-three-minute public video with voiceover.
- Finalize Devpost description, public repository, screenshots, setup proof, sample data, Codex/GPT-5.6 explanation, and feedback session ID.
- Do not add Electron, cloud execution, external creative tools, extra runners, or marketplace integration during this buffer.

## Plan-Level Review Gates

After Tasks 5, 11, 15, and 17:

1. Run git status --short and confirm only intentional changes.
2. Run the task's focused tests plus pnpm typecheck.
3. Review the diff against the design specification.
4. Confirm no secrets, absolute user paths, generated session data, or .arena artifacts are staged.
5. Commit only after the reviewer can independently reproduce the task's result.

## Specification Coverage Matrix

- Product thesis and differentiation: README in Task 17 and the complete vertical loop in Tasks 6–16.
- Goals and non-goals: Global Constraints, Tasks 1–17, and README safety/scope copy.
- Honest-but-fallible Trust Model: Tasks 6, 7, 11, 16, and 17.
- Local Web delivery and Electron-ready privilege boundary: Tasks 11–15 and the module boundaries in the file map.
- Runtime flow: Tasks 6–11.
- Manifest, Snapshot, Contract, Run, Trace, Artifact, and Verdict protocols: Tasks 1–3 and 8–10.
- Dirty Tree, False Green, and Missing Tool: Tasks 4–5.
- Import Lobby, Arena, Evidence Lab, Replay, Verdict, and Repair Compare: Tasks 12–15.
- Quick Match and future Audit Match identity: Tasks 1, 9, 10, and 15.
- Error handling and defeat/error separation: Tasks 1, 2, 7, 9, 11, and 17.
- Codex and GPT-5.6 use: Tasks 7–10 and 17.
- Sanitized judge Demo Mode: Task 16.
- Acceptance criteria and three-minute demo path: Tasks 16–17.
