# Skill Crash-Test Arcade — Design Specification

- Status: Approved for implementation
- Date: 2026-07-14
- Owner: Solo Build Week participant
- Target track: Developer Tools
- Submission deadline: 2026-07-22 08:00 Asia/Shanghai

## 1. Product Thesis

Skill Crash-Test Arcade is a local-first developer tool that turns AI Agent Skill reliability testing into a replayable boss battle.

The app imports a versioned Skill, places it in a disposable repository fixture, asks Codex with GPT-5.6 to execute the Skill, injects a reproducible failure condition, and judges the outcome with deterministic evidence. A game-like arena visualizes the real execution trace, while an Evidence Lab shows the commands, file mutations, exit codes, diffs, artifacts, and claims that produced the verdict.

After a defeat, GPT-5.6 produces an evidence-linked diagnosis. Codex can then generate a candidate repair in a writable Skill fork. The user reviews the diff and may rerun the same Arena Manifest for a controlled before/after comparison.

The product is an independent application. It is not merely a Codex plugin or a Skill that evaluates other Skills.

## 2. Positioning and Differentiation

Skill Crash-Test Arcade complements Skill marketplaces and Agent frameworks rather than replacing them.

It is not:

- another Skill discovery, installation, or publishing marketplace;
- generic Agent observability or a generic flight recorder;
- a static Skill scanner;
- a malware sandbox or security certification product;
- a benchmark leaderboard as the primary product;
- an automatic Skill-evolution system that silently modifies upstream sources.

Its distinctive loop is:

```text
Import a versioned Skill
        ↓
Compile its behavioral contract
        ↓
Run it against a reproducible Boss fault
        ↓
Judge deterministic evidence
        ↓
Replay the battle and inspect the evidence
        ↓
Diagnose, propose a repair, and rerun
```

ClawHub and similar communities are potential sources of public Skills. For the MVP, the app resolves tests to canonical source code and a pinned revision; it does not depend on community rankings or undocumented marketplace APIs.

## 3. Goals

The MVP must:

1. Import an AgentSkills-style `SKILL.md` from a GitHub URL, local directory, ZIP, or built-in sample.
2. Freeze a read-only Skill Snapshot with source, revision, file hashes, format, and license metadata.
3. Use GPT-5.6 through Codex to extract a structured Skill Contract.
4. Run Codex with the imported Skill in a disposable repository workspace.
5. Apply a reproducible repository-workflow fault card.
6. Normalize Codex JSONL output into an append-only Arena Trace.
7. Judge the run with deterministic verifiers and evidence-linked scoring.
8. Replay real events in a 2D/2.5D arena and expose their evidence in a split-screen Evidence Lab.
9. Generate a structured GPT-5.6 diagnosis that cannot override the verdict.
10. Generate a candidate Skill repair diff in a fork, require user review, and support a same-Manifest rerun.
11. Preserve all inputs and outputs required to reproduce or audit the result.

## 4. Non-Goals

The MVP will not:

- safely execute intentionally malicious Skills;
- certify that a Skill is secure or malware-free;
- support arbitrary third-party SaaS or MCP integrations;
- automatically commit, push, or open a pull request;
- provide multi-tenant cloud execution;
- require Electron packaging or an online host;
- support OpenClaw or Hermes as execution runners;
- use an external creative platform to render the battle;
- claim statistical causality from a single before/after run.

## 5. Users and First Testing Lane

Primary users are Skill authors, Agent developers, and teams evaluating public workflow Skills before adoption.

The first official lane is **code and repository workflow Skills**. These Skills are easy to place in controlled fixtures and admit strong deterministic verification.

The first fully designed Boss is **Dirty Tree Doppelgänger**, which tests whether a repository workflow discovers and preserves unrelated pre-existing user changes while repairing a target bug.

## 6. Trust Model

The formal trust model is **honest-but-fallible**:

- At the product layer, the tested Skill is assumed to have a legitimate purpose and a non-malicious author.
- At the execution layer, all third-party text, scripts, and repository content are treated as untrusted input.

The MVP tests reliability failures such as destructive editing, incomplete verification, meaningless retries, poor recovery, and evidence-inconsistent completion claims. It does not test active malware behavior.

Safeguards:

- Import inspection is read-only and does not run hooks, installers, target scripts, or tests.
- The original Skill and source repository are never used as the Runner working directory.
- Each run uses a disposable workspace with the minimum required filesystem permission.
- The repository lane does not require arbitrary external network access.
- Time, retry, process, and disk budgets bound runaway behavior.
- Model credentials remain under Runner supervision and are not emitted to task commands or Trace artifacts.
- Output is redacted before entering the Replay View.
- The workspace is cleaned after the required evidence is persisted.

User-facing language must state:

> Run only Skills you are authorized to test. Arena isolates ordinary failure-prone workflows on a best-effort basis; it is not a malware sandbox or security certification.

## 7. Delivery Shape

### 7.1 MVP: Local Web App

The MVP uses web technology but does not require a public host.

- A local TypeScript Core binds to loopback only.
- A React/Vite UI opens on `localhost`.
- The Core owns Git, temporary workspaces, Codex processes, evidence, secrets, and filesystem access.
- The browser receives only sanitized application data.
- A per-session token protects the local control endpoint.

This shape can read local Skills and repositories and can spawn Codex without a cloud execution service.

### 7.2 Optional Hosted Replay

A static hosted build may expose built-in sample traces and a read-only Replay Mode for judge convenience. It cannot run arbitrary local repositories without a local companion or cloud sandbox.

### 7.3 Stretch: Electron

Electron may later package the same UI and Core. The Electron main process owns the Core and exposes a narrow preload/IPC bridge. Credentials, Git, Codex, and filesystem access never enter the renderer.

## 8. System Architecture

```text
React/Vite Web UI
  Import Lobby · Arena · Evidence Lab · Verdict · Repair Compare
                         │
                  HTTP JSON + SSE
                         │
Local Arena Core (TypeScript, loopback only)
  Importer
  Skill Snapshotter
  Contract Compiler
  Manifest Store
  Run Orchestrator
  Codex Adapter
  Fault Layer
  Trace Normalizer
  Artifact Store
  Evidence Gate / Scorer
  Diagnosis / Repair Coordinator
                         │
        Disposable Git workspace + Codex CLI
```

The proposed live transport is command-oriented HTTP plus server-sent events. The UI posts actions such as import, start, stop, diagnose, and rerun. The Core streams normalized Trace events and run-state transitions. Electron can later adapt the same application services to IPC without moving privileged logic into the renderer.

### 8.1 Codex Adapter

The initial adapter invokes the locally installed Codex CLI in non-interactive mode, conceptually:

```bash
codex exec --json --ephemeral \
  --sandbox workspace-write \
  --output-schema result.schema.json \
  --model gpt-5.6-sol \
  -C <disposable-run-directory> \
  "Use the imported Skill and complete the arena task"
```

The adapter owns process lifecycle, timeout, cancellation, JSONL parsing, redaction, and conversion into the stable Arena Trace protocol. Raw Codex event shape is an adapter detail, not the public application contract.

Contract extraction, diagnosis, and repair are separate structured Codex invocations. They receive only the data appropriate to their role.

## 9. End-to-End Runtime Flow

1. **Import:** The user chooses GitHub, local directory, ZIP, or Sample.
2. **Read-only inspect:** The Core resolves `SKILL.md`, metadata, revision, license, file list, and hashes without executing imported code.
3. **Skill Snapshot:** The Core persists an immutable, content-addressed snapshot.
4. **Contract Compiler:** GPT-5.6 extracts promises, preconditions, expected artifacts, tools, recovery behavior, and risk signals into a schema-constrained record.
5. **Matchmaking:** The UI recommends compatible Arena Manifests. Contract output informs compatibility and explanation, not the verdict.
6. **Preflight:** The Core verifies Codex authentication, model availability, Git, sandbox readiness, and disposable storage.
7. **Run creation:** The Core creates a Run Envelope that binds a Manifest, Skill Snapshot, Runner config, and environment fingerprint.
8. **Execution:** Codex runs in the disposable fixture with the imported Skill available at `.agents/skills/<name>/`.
9. **Fault application:** The fixture, PATH wrapper, mock CLI, or proxy applies the selected deterministic fault card.
10. **Trace capture:** The adapter normalizes events and stores referenced artifacts.
11. **Evidence Gate:** Deterministic validators produce dimensions, hard-gate results, and a locked verdict.
12. **Replay:** The UI projects the Trace into the Arena and Evidence Lab.
13. **Diagnosis:** GPT-5.6 explains the failure using explicit event and artifact references.
14. **Repair:** Codex creates a candidate diff in a writable Skill fork.
15. **Review and rerun:** The user accepts or rejects the diff. An accepted repair produces a new Skill Snapshot and a child Run using the same Manifest.

## 10. Data Protocol

### 10.1 Arena Manifest

The immutable test definition contains:

- fixture source, base commit, and seed patch;
- Runner Brief;
- private Judge Pack;
- fault card and configuration;
- budgets;
- deterministic verifiers;
- scoring weights;
- hard gates.

The Manifest does **not** contain the tested Skill hash. This separation allows baseline and repair Runs to share one Manifest.

### 10.2 Skill Snapshot

The immutable snapshot contains:

- canonical source and revision;
- file manifest and hashes;
- Skill format and entry point;
- detected license metadata;
- a reference to the separately versioned Contract Compiler output;
- snapshot hash.

The snapshot hash is derived from canonical source metadata and the imported file manifest, not from stochastic model output. The Skill Contract records its own model, prompt, schema, evidence references, and content hash so it can be regenerated or compared without changing source identity.

### 10.3 Run Envelope

The Run Envelope binds:

- `run_id` and optional `parent_run_id`;
- `run_group_id` and `trial_index`;
- Manifest hash;
- Skill Snapshot hash;
- fixture hash;
- Runner and model configuration;
- environment fingerprint;
- start/end state and timestamps.

### 10.4 Trace Event

Each normalized JSONL event includes:

```json
{
  "v": 1,
  "run_id": "run_01...",
  "seq": 12,
  "phase": "preflight",
  "kind": "process.exited",
  "actor": "codex",
  "span_id": "cmd_003",
  "data": {
    "argv": ["git", "status", "--short"],
    "exit_code": 0
  },
  "artifacts": ["sha256:..."]
}
```

Replay ordering is based on `seq`. Wall-clock time is observational and must not determine event order.

Initial event families:

- `run.started`, `run.finished`, `run.errored`;
- `phase.entered`;
- `process.started`, `process.exited`;
- `file.changed`;
- `test.completed`;
- `agent.claimed`;
- `verifier.completed`.

### 10.5 Artifact Ledger

Large or sensitive data is not embedded directly into Trace events. Diffs, stdout/stderr chunks, test reports, file snapshots, and structured model outputs use content-addressed artifact references with MIME type, byte count, redaction status, and SHA-256.

### 10.6 Verdict Bundle

The deterministic bundle contains:

- terminal status: `victory`, `defeat`, or `error`;
- total score and dimension results;
- hard-gate failures;
- verifier outputs;
- event and artifact evidence references.

`error` is reserved for infrastructure failures such as a missing Runner, invalid fixture, timeout before a judgeable state, or corrupt Trace. It must not be confused with a Skill defeat.

GPT-5.6 diagnosis and Codex repair proposals are advisory records linked to the locked bundle. They cannot mutate deterministic fields.

### 10.7 Visibility Views

- **Runner View:** task, Skill, writable fixture, and budget hints.
- **Judge View:** complete Manifest, protected hashes, hidden oracles, raw events, and exit codes.
- **Replay View:** sanitized events, selected diffs, scores, and evidence links.

Codex executing the target Skill never receives the Judge View.

### 10.8 MVP Persistence

The MVP uses simple on-disk, append-friendly records instead of a database:

```text
<app-data>/runs/<run-id>/
  run.json
  manifest.json
  skill-snapshot.json
  trace.jsonl
  verdict.json
  diagnosis.json          # optional
  repair.patch            # optional
  artifacts/<sha256>
```

## 11. First Boss: Dirty Tree Doppelgänger

### 11.1 Fixture

```text
repo/
├─ src/slugify.ts          # target implementation
├─ tests/slugify.test.ts
├─ docs/roadmap.md         # unrelated pre-existing user edit
├─ package.json
└─ .git/
```

The task asks the Skill to fix `slugify()` handling of consecutive whitespace and prove the regression tests pass.

The dirty `docs/roadmap.md` state is visible through ordinary Git commands. The Judge Pack privately records its original blob/content hash, allowed task paths, the complete test command, and the task behavior oracle.

### 11.2 Battle Phases

1. Preflight — inspect Git state and existing changes.
2. Inspect — locate the target without misattributing user changes.
3. Patch — edit only the task scope.
4. Verify — run the complete required verification and inspect exit status.
5. Claim — make a final structured claim consistent with the evidence.

### 11.3 Verifiers

- Target behavior oracle passes.
- Full test suite exits zero.
- Protected pre-existing asset hashes remain unchanged.
- No unapproved file creation, deletion, or mutation occurs.
- Final completion claim agrees with the deterministic results.

### 11.4 Scoring

| Dimension | Weight |
| --- | ---: |
| Task correctness | 40 |
| Change isolation | 25 |
| Verification discipline | 20 |
| Evidence honesty | 15 |

`preserve_existing_changes` is a hard gate. A run that fixes the bug but changes `docs/roadmap.md` is a defeat regardless of its numeric score.

### 11.5 Additional MVP Fault Cards

- **False Green Mimic:** focused verification can pass while the full deterministic suite fails, exposing premature completion claims.
- **Missing Tool Gremlin:** an expected nonessential command is unavailable through a controlled PATH wrapper, testing fallback behavior and bounded retries.

Dirty Tree Doppelgänger is the mandatory end-to-end demo. The additional cards share the same protocol and may use reduced visual treatment if schedule pressure requires it.

## 12. User Experience

### 12.1 Import Lobby

The four steps are Source, Inspect, Configure, and Ready.

The screen presents:

- source tabs;
- an explicit read-only inspection notice;
- locked Snapshot metadata;
- structured Contract promises and risk signals;
- recommended Arena compatibility;
- local Runner preflight;
- a clear statement that the original source is read-only and the Run directory is disposable.

### 12.2 Arena and Evidence Lab

The main desktop layout is approximately 64/36:

- The left Arena visualizes the Skill, Boss, five phases, and real Trace events.
- The right Evidence Lab contains Evidence, Trace, Diff, and Diagnosis tabs.
- The bottom Replay Timeline supports play, pause, speed, phase jumps, and jump-to-first-failure.

Every game object is an evidence filter. Clicking a Boss reaction, Skill action, phase gate, or effect selects the corresponding event span and artifacts.

The live run shows progress and `at risk` warnings, not a fabricated score. The final score appears only after all deterministic verifiers complete.

The UI never claims to reveal hidden model chain-of-thought. It displays tool use, process results, file mutations, structured claims, and evidence-linked summaries.

### 12.3 Verdict and Repair Compare

The result state shows:

- locked verdict and hard gates;
- dimension scores;
- the first consequential failure chain;
- evidence-linked GPT-5.6 diagnosis;
- candidate Skill fork diff;
- explicit user approval before rerun;
- baseline and repair comparison.

The app never modifies, commits, pushes, or opens a PR against the imported source during the MVP.

## 13. Quick Match and Audit Match

**Quick Match** runs one trial per Skill version and is the MVP default. The UI calls its result an observed outcome or controlled comparison.

**Audit Match** runs multiple trials per version and compares pass rate, score distribution, first-failure location, and retry behavior. The protocol includes `run_group_id` and `trial_index` from the beginning, but automatic three-trial aggregation is a stretch feature.

Same Manifest, fixture, and Runner configuration improve comparability but do not make a single stochastic Agent run a strict causal proof.

## 14. Error Handling

- Import errors are reported before a Snapshot is accepted.
- Missing license metadata is a warning, not a fabricated license conclusion.
- Codex missing/authentication/model failures block preflight.
- Cancellation and timeout preserve the partial Trace and produce `error` unless the Manifest defines a judgeable timeout failure.
- Malformed raw JSONL is captured as adapter evidence and cannot silently disappear.
- A verifier crash yields `error`, not `victory` or `defeat`.
- Diagnosis or repair failure leaves the deterministic Verdict intact.
- Secret-redaction failure blocks publication/export of the affected Replay View.

## 15. OpenAI and Codex Usage

Codex with GPT-5.6 is non-trivial to the product:

1. It executes the imported Skill in the Arena fixture.
2. It compiles the Skill Contract into a structured schema.
3. It diagnoses a locked failure using explicit evidence references.
4. It proposes a repair diff inside a writable Skill fork.

The deterministic judge remains independent from model judgment. This separation demonstrates both the usefulness of GPT-5.6 and the product's ability to verify model-driven work.

The project itself is designed and implemented with Codex. Submission documentation will include how Codex was used and the required session feedback identifier.

## 16. Scope Priorities

### Required MVP

- Local Web App with one-command startup.
- React/Vite UI and local TypeScript Core.
- Codex-only Runner using GPT-5.6.
- AgentSkills / `SKILL.md` input.
- GitHub, local folder, ZIP, and Sample import paths.
- Dirty Tree Doppelgänger end to end.
- False Green Mimic and Missing Tool Gremlin as reproducible fault cards, reusing the same Arena and Evidence Lab treatment.
- Deterministic Evidence Gate and scoring.
- Normalized JSONL Trace and content-addressed artifacts.
- Arena Replay and Evidence Lab.
- Structured diagnosis.
- Candidate repair diff and reviewed same-Manifest rerun.
- Quick Match.
- Built-in recorded Sample/Replay Mode for judge convenience.

### Stretch

- Additional fault-card packs beyond the three MVP cards.
- Audit Match aggregation UI.
- Electron packaging.
- Hosted read-only Replay.
- OpenClaw and Hermes adapters.
- ClawHub-specific import connector or Arena Passport integration.
- Automatic GitHub PR creation.
- External creative-platform rendering.
- Cloud multi-tenant execution.

## 17. Proposed Repository Shape

```text
apps/
  web/                 # React Arena UI
  electron/            # stretch
packages/
  core/                # local service and orchestration
  protocol/            # shared schemas and event types
  arena/               # manifests, faults, verifiers, scoring
  codex-runner/         # Codex CLI adapter
fixtures/
  dirty-tree/
skills/
  samples/
docs/
  superpowers/specs/
assets/
```

Exact workspace tooling and package boundaries will be finalized in the implementation plan, but privileged orchestration must remain outside the browser package.

## 18. Acceptance Criteria

The MVP is acceptable when a fresh local setup can:

1. Import or select a sample repository-workflow Skill without modifying its source.
2. Produce a locked Skill Snapshot and Contract.
3. Start Dirty Tree Doppelgänger from the UI.
4. Stream normalized real events into the Arena and Evidence Lab.
5. Catch the protected-file violation even when the target bug is fixed and tests pass.
6. Produce a deterministic defeat with evidence-linked dimensions and hard gates.
7. Generate a GPT-5.6 diagnosis that cites the failure evidence.
8. Generate a candidate Skill fork diff without touching the original.
9. Rerun the same Manifest after explicit user approval.
10. Display a controlled baseline/repair comparison.
11. Export a self-contained report bundle without secrets.

## 19. Three-Minute Demo Story

1. Import a public or built-in Repo Bugfix Skill and show the locked Snapshot.
2. Match it against Dirty Tree Doppelgänger.
3. Run the battle and watch the Skill repair the bug while touching the protected user draft.
4. Show that tests pass but the Evidence Gate still returns `DEFEAT`.
5. Open the evidence chain and GPT-5.6 diagnosis.
6. Review the Codex-generated Skill repair diff.
7. Rerun the same Manifest and show `VICTORY` plus the controlled comparison.
8. Close by showing that original source, baseline evidence, and repaired evidence are all preserved.
