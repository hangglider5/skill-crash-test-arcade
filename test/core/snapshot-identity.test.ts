import { describe, expect, it } from "vitest";

import {
  computeSnapshotExecutionFingerprint,
  computeSnapshotSourceHash,
  validateSnapshotIdentity
} from "../../src/core/snapshot-identity.js";
import type { SkillSnapshot } from "../../src/protocol/index.js";

function snapshot(): SkillSnapshot {
  const candidate = {
    schema: "arena.skill-snapshot/v1" as const,
    source: { kind: "local" as const, uri: "file:///safe/source" },
    entrypoint: "SKILL.md",
    license: "MIT",
    files: [{ path: "SKILL.md", bytes: 5, sha256: "a".repeat(64) }],
    source_hash: "",
    imported_path: "/safe/imports/source"
  };
  return { ...candidate, source_hash: computeSnapshotSourceHash(candidate) };
}

describe("snapshot identity", () => {
  it("keeps source identity separate from execution fingerprint", () => {
    const original = snapshot();
    const entrypointDrift = { ...original, entrypoint: "nested/SKILL.md" };

    expect(computeSnapshotSourceHash(entrypointDrift)).toBe(original.source_hash);
    expect(computeSnapshotExecutionFingerprint(entrypointDrift))
      .not.toBe(computeSnapshotExecutionFingerprint(original));
    expect(() => validateSnapshotIdentity(entrypointDrift, {
      expected_source_hash: original.source_hash,
      expected_execution_fingerprint: computeSnapshotExecutionFingerprint(original)
    })).toThrow("execution fingerprint");
  });

  it("rejects a provider that preserves a fake hash while changing source files", () => {
    const original = snapshot();
    const drifted = {
      ...original,
      source: { ...original.source, uri: "file:///different/source" },
      files: [{ ...original.files[0]!, bytes: 6 }]
    };

    expect(() => validateSnapshotIdentity(drifted, {
      expected_source_hash: original.source_hash
    })).toThrow("source identity");
  });
});
