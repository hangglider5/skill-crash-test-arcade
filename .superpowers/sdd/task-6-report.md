# Task 6 Report: Read-Only Skill Import and Snapshot Identity

## TDD evidence

- RED: `pnpm test -- test/core/importer.test.ts` failed because `src/core/importer.ts` did not exist; the 106 pre-existing tests remained green.
- First GREEN: 20 importer cases plus 106 existing tests passed.
- Hardening RED: an existing content-correct snapshot made writable was incorrectly reused.
- Final GREEN: the importer rejects writable existing snapshots; 23 importer cases plus 106 existing tests pass.

## Implementation

- `src/core/importer.ts`: local/Git/sample acquisition, entrypoint and license metadata, canonical identity, sorted manifest, safe errors, and verified atomic publication.
- `src/core/zip-import.ts`: bounded archive read, central-directory preflight, path/type/conflict validation, and bounded extraction.
- `samples/skills/repo-bugfix/SKILL.md`: deliberately weak, minimal valid fixture.
- `test/core/importer.test.ts`: all four modes and the specified negative security boundaries.

## Validation

- `pnpm typecheck`
- `pnpm test -- test/core/importer.test.ts` (129/129 repository tests in the focused invocation)
- `uv run --with pyyaml python .../quick_validate.py samples/skills/repo-bugfix` (`Skill is valid!`)
- Final gate: `pnpm typecheck && pnpm test && git diff --check`

## Self-review

- Local traversal uses `lstat`, rejects root/descendant symlinks and non-regular files, opens files with `O_NOFOLLOW`, and verifies the opened inode before reading.
- Git uses no checkout hooks/templates/submodules/LFS smudge, disables credential and extension helpers, sanitizes inherited Git/SSH environment variables, resolves a commit, and checks it out detached in a cleaned temporary clone.
- ZIP count and declared output size are checked from the central directory before `unzipSync`; archive input is also capped at 16 MiB.
- Publication uses an unpredictable same-root staging directory, read-only file/directory modes, atomic rename, and full verification for concurrent/existing destinations.
- User-safe error messages/details contain only codes, limits, and relative paths; snapshot source URIs intentionally retain provenance.

## Residual assumptions

Portable Node does not expose `openat(2)` or a cross-platform directory `RENAME_NOREPLACE`. Repeated `lstat`/`realpath` containment checks, no-follow file opens, unpredictable staging names, and post-rename verification narrow path-swap races, but a hostile process running as the same OS user can still win a TOCTOU race by replacing directories between syscalls. The injected imports root is therefore assumed to be controlled by the application user and not concurrently mutated by another hostile same-user process.

## Security review fix (2026-07-14)

### TDD evidence

- RED: the expanded focused run had 11 new failures and 130 existing passes. The failures covered ancestor symlinks, local aggregate caps, Git provenance, portable ZIP collisions, ZIP flags/disk/header/CRC checks, a huge declared directory, and staging error wrapping.
- First GREEN attempt: typecheck passed; 7 compatibility failures remained (six empty-root assertions and one concurrent publication race).
- GREEN: focused verification passed all 141 repository tests after preserving reject-before-publication semantics and revalidating concurrent component creation.

### Fixes

- ZIP preflight now accounts for every central entry before `unzipSync`, requires zero-sized/zero-CRC stored directory entries, rejects ZIP64/multi-disk/encryption/data descriptors/unsupported flags or methods/extras, validates local headers and non-overlap, and CRC32-checks extracted regular files.
- Local, ZIP, and imports-root paths reject symlinks in preexisting ancestor components. Missing imports-root components are created one at a time and revalidated, including concurrent `EEXIST` winners.
- Every import mode uses NFC plus case-folded portable file/directory collision validation; local and Git collection share 200-file, 5 MiB aggregate, and 2 MiB per-file limits.
- Git source identity uses canonical file URIs for local locators and strips remote userinfo, query, and fragment while preserving the detached resolved commit.
- Staging creation/write/mode/rename/verification failures are typed and path-safe; cleanup is best effort and cannot mask the original failure.

### Final shape

- Production remains limited to `src/core/importer.ts` and `src/core/zip-import.ts`.
- Line counts: importer 831; ZIP importer 306. Top-level functions: 27 and 13. Longest top-level functions: 64 and 59 lines respectively.
- The duplicate portable-path checks are intentional: ZIP must reject conflicts before `unzipSync`, while the importer applies the same invariant to every mode. No dead production code was found in the final pass.

### Final validation

- `pnpm typecheck && pnpm test && git diff --check` passed with 141/141 tests.
- The unchanged sample's successful Task 6 `quick_validate.py` result remains recorded above. This rerun could not initialize the sandboxed uv cache, and the bundled Python fallback lacked PyYAML; no broader escalation or dependency change was made.

## Final resource-boundary fix (2026-07-14)

### TDD evidence

- RED: `pnpm exec vitest run test/core/importer.test.ts test/core/importer-source-race.test.ts` failed 2/37 cases. A ZIP containing 201 total central entries (one `SKILL.md` and 200 valid stored zero-size directories) was accepted, and a local file grown after traversal `lstat` was read and published at 5 MiB + 1 byte aggregate.
- The deterministic race test wraps `node:fs/promises.lstat` only in the test module: it captures the real `c.bin` metadata, appends two bytes, then returns the stale stat. No production test seam was added.
- GREEN: the same focused command passed 37/37 cases.

### Fixes

- ZIP preflight now caps the EOCD central-entry count at 200 before `unzipSync`; the accepted boundary is one file plus 199 directory entries, while one file plus 200 directories is rejected. Existing zero-size/CRC directory validation and aggregate uncompressed-byte accounting remain intact.
- The shared local/Git tree collector opens with `O_NOFOLLOW`, requires opened inode/type/size to match traversal metadata, enforces per-file and actual opened-size aggregate caps before allocation, performs bounded descriptor reads into an exact-size buffer, probes exact EOF, and rechecks stable descriptor metadata before accepting bytes.

### Validation

- Final gate: `pnpm typecheck && pnpm test && git diff --check`.
- The sample fixture is unchanged, so its prior successful validation remains applicable.
- Residual assumption remains unchanged: same-user mutation after the final descriptor check is outside the captured snapshot contents.
