# Skill Crash-Test Arcade — Devpost Submission Copy v1

Use this document as the source of truth for the Devpost form. Replace every
`TODO` before submission.

## General information

### Project name

Skill Crash-Test Arcade

### Elevator pitch

Crash-test an Agent Skill before it crashes a real repository—run it with Codex
and GPT-5.6 Sol, lock failures with deterministic evidence, and review a
Skill-only repair.

### Category

Developer Tools

### Built with

TypeScript, React, Fastify, Vite, OpenAI Codex CLI, GPT-5.6 Sol, Playwright,
Vitest, Zod, Git, and FFmpeg.

### Repository

https://github.com/hangglider5/skill-crash-test-arcade

### Demo video

TODO: public YouTube URL

### Codex feedback session

TODO: `/feedback` Session ID for the Codex task containing the majority of the
core implementation.

## Project story

### Inspiration

Coding agents are getting very good at completing the task they were asked to
do. But a green focused test can hide a more dangerous failure: the agent may
overwrite an unrelated draft, skip a full verification step, or claim success
after an unproductive retry loop. Existing evals usually ask whether the final
answer is correct. We wanted to ask a more operational question: **can we trust
the workflow before it touches a real repository?**

That led to Skill Crash-Test Arcade—a local-first crash-test rig for normal,
non-malicious Agent Skills. It makes reliability failures visible, reproducible,
and a little theatrical: Skills enter an Arena, encounter deterministic fault
cards, and earn a verdict backed by evidence rather than confidence.

### What it does

Skill Crash-Test Arcade imports a Skill as a frozen, content-addressed snapshot
and matches it against a controlled repository fixture. Codex with GPT-5.6 Sol
runs the Skill inside a disposable workspace while the Arena records observable
Trace events and artifacts.

The flagship fault card, **Dirty Tree Doppelgänger**, starts with an unrelated
change already present in `docs/roadmap.md`. The tested Skill correctly fixes the
target `slugify` bug and passes its focused tests—but overwrites that pre-existing
draft. Independent deterministic verifiers lock the run as
`DEFEAT · 58/100`. GPT-5.6 Sol can explain the evidence, but it cannot grade
itself or rewrite the verdict.

The app then creates a private repair fork containing a candidate change to
`SKILL.md` only. The original import remains read-only. After explicit human
review and approval, the repaired Skill runs against the same manifest, fixture,
runner configuration, and parent run group. The protected change survives, the
score rises to `98/100`, and the Arena displays a controlled before/after
comparison.

The MVP also defines two additional fault cards: **False Green Mirage**, which
detects focused-test success that contradicts the full suite, and **Missing Tool
Trap**, which tests bounded fallback behavior when a nonessential tool is absent.

### How we built it

The product is a TypeScript monorepo-style application with a React/Vite Arena
UI and a loopback-only Fastify Core. Core owns imports, immutable snapshot
identity, disposable Git fixtures, Codex process execution, event normalization,
artifact storage, deterministic verifiers, repair authority, and sanitized
report export.

The central architecture deliberately separates three responsibilities:

1. **Codex Runner** — uses GPT-5.6 Sol for schema-constrained Skill Contract
   extraction, task execution, and evidence-linked advisory diagnosis/repair.
2. **Deterministic Judge** — independently owns hard gates, scores, and terminal
   victory/defeat/error states.
3. **Evidence Replay** — renders bounded persisted evidence without executing a
   model or manufacturing a result.

Live execution uses the authenticated Codex CLI with the exact
`gpt-5.6-sol` model. For judge-friendly, zero-credit testing, `pnpm demo` uses a
development-only scripted adapter while still exercising the real fixture,
orchestrator, trace, verifiers, repair review, and controlled rerun. A sanitized,
checked-in Live Proof records an authorized production Codex + GPT-5.6 Sol smoke
run with 5/5 verifiers passed and redaction complete.

### How Codex and GPT-5.6 helped

Codex was our primary full-stack engineering partner. It helped turn the initial
product idea into an implementation plan, built the runner/judge/replay
boundaries, implemented the React experience and Fastify Core, created
repository fixtures and verifier protocols, diagnosed integration and browser
issues, wrote regression tests, performed a real GPT-5.6 Sol live smoke, and
polished the submission flow.

GPT-5.6 Sol also operates inside the product. It extracts a bounded Skill
Contract, performs the task through Codex, and produces an advisory diagnosis and
candidate Skill repair linked to locked evidence. We intentionally kept the
model outside the scoring boundary: deterministic code decides whether a run is
a victory or defeat.

The most important human decisions were architectural rather than cosmetic: the
original Skill must remain immutable; all work must happen in disposable copies;
repair authority must be narrow and require explicit approval; and a model must
never be allowed to alter its own verdict.

### Challenges we ran into

The hardest problem was preserving a fun, legible product experience without
weakening the evidence model. A static replay can look convincing but prove
nothing, while raw agent traces are too noisy and can expose sensitive data. We
therefore built bounded Trace projections, content-addressed artifact references,
lineage checks, and a server-side redaction gate.

Codex CLI integration also required careful process handling: owned structured
output files, timeout/error separation, JSONL normalization, model pinning, and
preflight checks. Finally, the repair loop had to demonstrate improvement without
overclaiming causality. The comparison UI therefore says **observed
improvement** and proves which inputs stayed fixed and which Skill snapshot
changed.

### Accomplishments that we're proud of

- A complete defeat-to-diagnosis-to-reviewed-repair-to-victory loop.
- Deterministic hard gates that override a model's completion claim.
- Immutable imports and Skill-only repair forks with explicit human approval.
- A reproducible `58 → 98` controlled comparison with locked lineage.
- A real authorized GPT-5.6 Sol live proof with a sanitized public projection.
- A zero-credit judge path that runs locally with one command.
- 431 automated tests plus browser E2E and deterministic demo recording.

### What we learned

Agent reliability is not one score. Task correctness, change isolation,
verification discipline, and evidence honesty can move independently. We also
learned that model explanations are most useful after evidence is locked: GPT-5.6
Sol is excellent at turning a verifier failure into an actionable Skill policy,
but deterministic code should retain final authority.

Most importantly, reproducibility needs a product surface. Hashes and traces
matter, but people understand the safety property when they can see the original
stay unchanged, review one bounded patch, explicitly approve a rerun, and compare
the two runs side by side.

### What's next

Next we would add stronger container or VM isolation, durable run recovery,
additional Skill formats and community import flows, richer fault-card authoring,
and a larger library of repository-workflow scenarios. Electron packaging could
provide a polished desktop distribution while keeping Codex, Git, fixtures, and
evidence local. If time and budget allow, an optional agent-driven creative
platform could generate shareable visual replays without entering the judging
boundary.

## Judge quick start

### Supported platform

Submission-verified on desktop macOS. Desktop Linux is expected to work with the
same prerequisites. Windows, phones, and tablets are not supported by this MVP.

### Deterministic zero-credit demo

```bash
git clone https://github.com/hangglider5/skill-crash-test-arcade.git
cd skill-crash-test-arcade
pnpm install --frozen-lockfile
pnpm demo
```

Open `http://127.0.0.1:5173/?token=dev-token`, choose **Try the recorded crash
test**, inspect the Sample, and start **Dirty Tree Doppelgänger**.

### Real Codex run

Install and authenticate the Codex CLI, confirm access to GPT-5.6 Sol, then use
`pnpm dev` instead of `pnpm demo`. The explicit `pnpm smoke:live` command may
consume model credits.

## Trust, privacy, and current boundary

This MVP is designed for normal, non-malicious Skills. It is not a malware
sandbox. The Core binds only to loopback, imported sources remain read-only,
runs use disposable repositories, repair candidates can modify only their
private Skill fork, and no commit, push, pull request, or upstream mutation is
performed. Public report export is blocked until the server completes its
redaction check.

## Media checklist

- [x] 3:2 thumbnail: `assets/devpost-thumbnail.png`
- [ ] Public YouTube demo under three minutes
- [ ] Import Lobby / Live Proof screenshot
- [ ] `DEFEAT · 58/100` evidence screenshot
- [ ] Skill-only repair screenshot
- [ ] `58 → 98` controlled comparison screenshot
- [ ] Confirm captions spell `GPT-5.6 Sol`, `SKILL.md`, and `docs/roadmap.md`
- [ ] Confirm no token, local path, raw Trace, or unpublished artifact is visible
- [ ] Preview every public link from a signed-out browser
