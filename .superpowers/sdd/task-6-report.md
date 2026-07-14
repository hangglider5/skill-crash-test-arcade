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
