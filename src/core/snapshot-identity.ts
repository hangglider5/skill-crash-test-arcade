import {
  SkillSnapshotSchema,
  canonicalJson,
  sha256,
  type SkillSnapshot
} from "../protocol/index.js";

type SnapshotSourceIdentityInput = Pick<SkillSnapshot, "source" | "files">;
type SnapshotExecutionIdentityInput = Pick<
  SkillSnapshot,
  "source" | "source_hash" | "files" | "entrypoint" | "imported_path"
>;

export function computeSnapshotSourceHash(
  snapshot: SnapshotSourceIdentityInput
): string {
  return sha256(canonicalJson({
    source: snapshot.source,
    files: snapshot.files
  }));
}

export function computeSnapshotExecutionFingerprint(
  snapshot: SnapshotExecutionIdentityInput
): string {
  return sha256(canonicalJson({
    source: snapshot.source,
    source_hash: snapshot.source_hash,
    files: snapshot.files,
    entrypoint: snapshot.entrypoint,
    imported_path: snapshot.imported_path
  }));
}

export function validateSnapshotIdentity(
  value: SkillSnapshot,
  expected: {
    readonly expected_source_hash?: string;
    readonly expected_execution_fingerprint?: string;
  } = {}
): {
  readonly snapshot: SkillSnapshot;
  readonly source_hash: string;
  readonly execution_fingerprint: string;
} {
  const snapshot = SkillSnapshotSchema.parse(value);
  const sourceHash = computeSnapshotSourceHash(snapshot);
  if (sourceHash !== snapshot.source_hash
    || (expected.expected_source_hash !== undefined
      && sourceHash !== expected.expected_source_hash)) {
    throw new Error("Snapshot source identity does not match its locked hash");
  }
  const executionFingerprint = computeSnapshotExecutionFingerprint(snapshot);
  if (expected.expected_execution_fingerprint !== undefined
    && executionFingerprint !== expected.expected_execution_fingerprint) {
    throw new Error("Snapshot execution fingerprint does not match locked run context");
  }
  return { snapshot, source_hash: sourceHash, execution_fingerprint: executionFingerprint };
}
