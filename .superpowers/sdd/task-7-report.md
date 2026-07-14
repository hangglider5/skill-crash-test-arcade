# Task 7 Report — Codex Process Adapter and Trace Normalization

## Local contract evidence

- `codex-cli 0.144.2`; `codex login status` reported `Logged in using ChatGPT`.
- `git version 2.53.0`; the MVP worktree is writable.
- `codex exec --help` exposes the required documented options: `--json`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `-c/--config`, `--sandbox`, `--model`, `--output-schema`, `--output-last-message`, and `--cd`.
- No model request was made. GPT-5.6 remains a configured, unverified target until a successful live run.

## TDD evidence

- Initial RED: all three new suites failed because `src/codex/process.ts`, `normalize.ts`, and `preflight.ts` did not exist; the existing 144 tests remained green.
- Edge RED: oversized normalized output without an artifact sink initially resolved inline; it now rejects rather than persisting a large Trace payload.
- Edge RED: a valid line after malformed JSONL initially reached the callback; parsing now halts immediately while the original malformed line is stored through the artifact sink.
- Focused GREEN: 3 files and 26 tests passed, including CRLF/final-line handling, caps, typed errors, TERM-ignore escalation, POSIX process-group cleanup, safe normalization, and injected preflight checks.

## Files

- `src/codex/types.ts`: clean runner, artifact sink, normalization, and preflight contracts.
- `src/codex/process.ts`: exact CLI arguments, sanitized environment, JSONL parser, typed failures, output parsing, and timeout/group termination.
- `src/codex/normalize.ts`: schema-validated Trace mappings, sequence identity, safe raw projection, command display tokenization, and output artifacting.
- `src/codex/preflight.ts`: injectable local version/login/Git/writability checks without a model call.
- `test/codex/*.test.ts` and `test/fixtures/fake-codex.mjs`: process-level regression coverage.

## Final verification

`pnpm typecheck && pnpm test && git diff --check` passed: 12 test files, 170 tests, zero failures.

## Concerns

- Cancellation was not added because the current `AgentRunner` interface has no cancellation signal; timeout cleanup is fully covered and later orchestrator scope was intentionally avoided.
- macOS injects `__CF_USER_TEXT_ENCODING` into child processes even with an explicit environment object. The adapter itself forwards only `PATH`, `HOME`, `CODEX_HOME`, `TMPDIR`, `LANG`, `LC_ALL`, and `LC_CTYPE`; secrets and arbitrary parent variables are excluded.
