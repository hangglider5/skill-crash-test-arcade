import { lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compileSkillContract,
  compileSkillContractRecord
} from "../../src/core/contract.js";
import {
  CodexStructuredModel,
  type StructuredModel,
  type StructuredRunRequest
} from "../../src/codex/structured.js";
import { canonicalJson, sha256, type SkillContract, type SkillSnapshot } from "../../src/protocol/index.js";
import type { AgentRunInput, AgentRunner } from "../../src/codex/types.js";

const roots: string[] = [];

async function validSnapshot(): Promise<SkillSnapshot> {
  const importedPath = await realpath(await mkdtemp(path.join(tmpdir(), "scta-contract-")));
  roots.push(importedPath);
  const content = "# Skill\n\nRun focused verification.\n";
  await writeFile(path.join(importedPath, "SKILL.md"), content);
  return {
    schema: "arena.skill-snapshot/v1",
    source: { kind: "local", uri: importedPath },
    entrypoint: "SKILL.md",
    license: "Unknown",
    files: [{ path: "SKILL.md", bytes: Buffer.byteLength(content), sha256: sha256(content) }],
    source_hash: "b".repeat(64),
    imported_path: importedPath
  };
}

function validContract(snapshotHash = "b".repeat(64), statement = "Run focused verification"): SkillContract {
  return {
    schema: "arena.skill-contract/v1",
    snapshot_hash: snapshotHash,
    model: "gpt-5.6",
    promises: [{ statement, evidence: "SKILL.md:3", confidence: 0.94 }],
    preconditions: ["Git repository"],
    expected_artifacts: ["test output"],
    recovery_rules: [],
    risk_signals: ["preservation unspecified"]
  };
}

class CapturingModel implements StructuredModel {
  readonly requests: StructuredRunRequest<unknown>[] = [];

  constructor(readonly value: unknown) {}

  async run<T>(request: StructuredRunRequest<T>): Promise<T> {
    this.requests.push(request as StructuredRunRequest<unknown>);
    return request.parse(this.value);
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Skill Contract Compiler", () => {
  it("keeps source identity separate from model output", async () => {
    const snapshot = await validSnapshot();
    const model = new CapturingModel(validContract());

    const contract = await compileSkillContract(snapshot, model);

    expect(contract.snapshot_hash).toBe(snapshot.source_hash);
    expect(contract.risk_signals).toContain("preservation unspecified");
  });

  it("quotes exact source deterministically and requests every contract section", async () => {
    const snapshot = await validSnapshot();
    const first = new CapturingModel(validContract());
    const second = new CapturingModel(validContract());

    await compileSkillContract(snapshot, first);
    await compileSkillContract(snapshot, second);

    const request = first.requests[0]!;
    expect(request.prompt).toBe(second.requests[0]!.prompt);
    expect(request.prompt).toContain(JSON.stringify("# Skill\n\nRun focused verification.\n"));
    expect(request.prompt).toContain('"locator":"SKILL.md:3"');
    expect(request.prompt).toContain("contract extraction, not a security verdict");
    expect(request.prompt).toContain(snapshot.source_hash);
    expect(request.prompt).toContain("promises, preconditions, expected_artifacts, recovery_rules, and risk_signals");
    expect(request).toMatchObject({ cwd: snapshot.imported_path, model: "gpt-5.6" });
  });

  it("rejects output identity drift, unknown keys, and out-of-range evidence", async () => {
    const snapshot = await validSnapshot();
    await expect(compileSkillContract(snapshot, new CapturingModel({
      ...validContract("c".repeat(64)),
      extra: true
    }))).rejects.toThrow();
    await expect(compileSkillContract(snapshot, new CapturingModel({
      ...validContract(),
      promises: [{ statement: "Claim", evidence: "SKILL.md:99", confidence: 1 }]
    }))).rejects.toThrow(/evidence locator/u);
  });

  it("rejects a drifted or symlinked snapshot entrypoint before calling the model", async () => {
    const drifted = await validSnapshot();
    const driftModel = new CapturingModel(validContract());
    await writeFile(path.join(drifted.imported_path, drifted.entrypoint), "changed");
    await expect(compileSkillContract(drifted, driftModel)).rejects.toThrow(/snapshot entrypoint/u);
    expect(driftModel.requests).toHaveLength(0);

    const linked = await validSnapshot();
    const target = path.join(linked.imported_path, "target.md");
    await writeFile(target, "# Skill\n\nRun focused verification.\n");
    await rm(path.join(linked.imported_path, linked.entrypoint));
    await symlink(target, path.join(linked.imported_path, linked.entrypoint));
    const linkModel = new CapturingModel(validContract());
    await expect(compileSkillContract(linked, linkModel)).rejects.toThrow(/snapshot entrypoint/u);
    expect(linkModel.requests).toHaveLength(0);
  });

  it("persists exact canonical contract bytes while keeping source and contract hashes separate", async () => {
    const snapshot = await validSnapshot();
    const writes: Array<{ bytes: Buffer; mime: string; redacted: boolean }> = [];
    const sink = {
      async put(data: Uint8Array, metadata: { mime: string; redacted: boolean }) {
        const bytes = Buffer.from(data);
        writes.push({ bytes, ...metadata });
        return { ref: `sha256:${sha256(bytes)}` as const };
      }
    };

    const record = await compileSkillContractRecord(snapshot, new CapturingModel(validContract()), sink);

    const expected = canonicalJson(record.contract);
    expect(writes).toEqual([{ bytes: Buffer.from(expected), mime: "application/json", redacted: false }]);
    expect(record.contract_hash).toBe(sha256(expected));
    expect(record.contract_ref).toBe(`sha256:${record.contract_hash}`);
    expect(record.contract_hash).not.toBe(snapshot.source_hash);
    expect(record.prompt_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(record.schema_hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("deduplicates identical contracts and changes only contract identity for different valid model output", async () => {
    const snapshot = await validSnapshot();
    const refs: string[] = [];
    const sink = {
      async put(data: Uint8Array) {
        const ref = `sha256:${sha256(data)}` as const;
        refs.push(ref);
        return { ref };
      }
    };
    const one = await compileSkillContractRecord(snapshot, new CapturingModel(validContract()), sink);
    const same = await compileSkillContractRecord(snapshot, new CapturingModel(validContract()), sink);
    const different = await compileSkillContractRecord(
      snapshot,
      new CapturingModel(validContract(snapshot.source_hash, "Run the complete test suite")),
      sink
    );

    expect(one.contract_hash).toBe(same.contract_hash);
    expect(one.contract_ref).toBe(same.contract_ref);
    expect(different.contract_hash).not.toBe(one.contract_hash);
    expect(different.contract.snapshot_hash).toBe(one.contract.snapshot_hash);
    expect(new Set(refs).size).toBe(2);
  });
});

describe("CodexStructuredModel", () => {
  it("runs Codex read-only with an exclusive schema and cleans only owned temporary files", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-structured-")));
    roots.push(root);
    const sentinel = path.join(root, ".structured-collision.output.json");
    await writeFile(sentinel, "keep me");
    const captured: AgentRunInput[] = [];
    let schemaAtRun: unknown;
    const runner: AgentRunner = {
      async run(input) {
        captured.push(input);
        schemaAtRun = JSON.parse(await readFile(input.output_schema_path, "utf8"));
        await writeFile(input.output_path, JSON.stringify({ answer: "ok" }), { flag: "wx" });
        return { exit_code: 0, structured_output: { answer: "ok" }, raw_event_count: 0 };
      }
    };
    const ids = ["collision", "fresh-id"];
    const model = new CodexStructuredModel({ runner, tempRoot: root, idFactory: () => ids.shift()! });

    const result = await model.run({
      cwd: root,
      prompt: "extract",
      model: "gpt-5.6",
      schema: { type: "object", additionalProperties: false },
      parse(value) { return value as { answer: string }; },
      timeout_ms: 1234
    });

    expect(result).toEqual({ answer: "ok" });
    expect(schemaAtRun).toEqual({ type: "object", additionalProperties: false });
    expect(captured[0]).toMatchObject({
      cwd: root,
      prompt: "extract",
      model: "gpt-5.6",
      sandbox: "read-only",
      timeout_ms: 1234
    });
    expect(path.dirname(captured[0]!.output_path)).toBe(root);
    expect(path.dirname(captured[0]!.output_schema_path)).toBe(root);
    expect(await readdir(root)).toEqual([path.basename(sentinel)]);
    expect(await readFile(sentinel, "utf8")).toBe("keep me");
  });

  it("cleans its exclusive schema on runner failure without deleting a collision sentinel", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "scta-structured-fail-")));
    roots.push(root);
    const sentinel = path.join(root, ".structured-collision.schema.json");
    await writeFile(sentinel, "keep me");
    const runner: AgentRunner = { async run() { throw new Error("boom"); } };
    const ids = ["collision", "fresh-id"];
    const model = new CodexStructuredModel({ runner, tempRoot: root, idFactory: () => ids.shift()! });

    await expect(model.run({
      cwd: root,
      prompt: "extract",
      model: "gpt-5.6",
      schema: {},
      parse(value) { return value; },
      timeout_ms: 1234
    })).rejects.toThrow("boom");

    expect(await readdir(root)).toEqual([path.basename(sentinel)]);
    expect((await lstat(sentinel)).isFile()).toBe(true);
  });
});
