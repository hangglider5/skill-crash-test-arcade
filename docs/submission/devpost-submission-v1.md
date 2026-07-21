# Skill Crash-Test Arcade — Final Devpost Submission Copy v3

Use this document as the source of truth for the Devpost form.

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

https://youtu.be/O-eEYYi42qc

### Codex feedback session

`019f5f2e-2742-7022-9f71-1cba590a4321`

## Project story

### Inspiration

I kept coming back to a failure that ordinary coding-agent evaluations can miss:
the requested bug is fixed, the focused test is green, but unrelated work was
quietly damaged. A plausible final answer does not tell me whether the repository
survived the workflow.

So I built Skill Crash-Test Arcade, a local-first crash-test rig for normal,
non-malicious Agent Skills. It turns a reproducible repository fault into an
arcade boss fight while keeping every verdict tied to evidence rather than model
confidence.

### What it does

The app imports a Skill as a frozen, content-addressed snapshot and matches it
against a controlled repository fixture. Codex runs the Skill with GPT-5.6 Sol
inside a disposable workspace while the Arena records observable Trace events
and artifacts. The Visual Arcade is driven by those persisted events: phase
gates advance only when evidence exists, and its defeat or victory effects
reflect the locked Judge result instead of invented client-side state.

The flagship match, **Dirty Tree Doppelgänger**, begins with an unrelated edit
already present in `docs/roadmap.md`. The Skill fixes the target `slugify` bug and
passes its focused tests, but overwrites that draft. Deterministic verifiers lock
the result as `DEFEAT · 58/100`. GPT-5.6 Sol can diagnose why it happened, but it
cannot grade itself or rewrite the verdict.

The app then creates a private repair fork containing a candidate `SKILL.md`
change. The imported original stays read-only. After I review the diff and
approve a rerun, the repaired Skill faces the same manifest, fixture, Runner,
and parent run group. The draft survives, the score rises to `98/100`, and the
comparison shows exactly what stayed fixed and what changed.

### How I built it

The project is a TypeScript application with a React/Vite Arena UI and a
loopback-only Fastify Core. Core owns immutable imports, disposable Git fixtures,
Codex execution, artifacts, repair authority, and sanitized report export.

I separated the system into three responsibilities:

1. **Codex Runner** — uses GPT-5.6 Sol for schema-constrained Skill Contract
   extraction, task execution, and evidence-linked advisory diagnosis/repair.
2. **Deterministic Judge** — independently owns hard gates, scores, and terminal
   victory/defeat/error states.
3. **Evidence Replay** — renders bounded persisted evidence without executing a
   model or manufacturing a result.

Live execution uses the authenticated Codex CLI with the exact `gpt-5.6-sol`
model. For judges, `pnpm demo` uses a scripted Runner that consumes no model
credits while exercising the real fixture, Trace, verifiers, repair review, and
rerun. A sanitized Live Proof separately records an authorized production Codex
and GPT-5.6 Sol run with 5/5 verifiers passed.

### How Codex and GPT-5.6 helped

I used Codex as my full-stack engineering partner from the first design sketch
through the submission build. It helped plan the architecture, implement the
React and Fastify surfaces, create fixtures and verifier protocols, diagnose
browser and recording issues, write regression tests, and run an authorized
GPT-5.6 Sol live smoke. The repository has 431 automated tests plus browser E2E.

GPT-5.6 Sol also works inside the product. Through Codex, it extracts a bounded
Skill Contract, performs the task, and proposes an evidence-linked diagnosis and
repair. Deterministic code alone decides victory, defeat, or infrastructure
error. The original stays immutable, work happens in disposable copies, and a
human must approve the Skill-only repair before the rematch.

### Challenges I ran into

The hardest part was making the experience fun without weakening the evidence.
A static replay can look convincing while proving nothing, but a raw agent trace
is noisy and may expose sensitive data. I used bounded Trace projections,
content-addressed artifacts, lineage checks, and a server-side redaction gate.

Codex CLI integration required careful timeout/error separation, JSONL
normalization, and model pinning. The repair loop raised another risk: implying
causality from one comparison. The UI therefore says **observed improvement**
and proves which inputs stayed fixed and which Skill snapshot changed.

### Accomplishments I'm proud of

- A complete defeat-to-diagnosis-to-reviewed-repair-to-victory loop.
- A trace-driven Visual Arcade whose effects come from persisted events.
- Deterministic hard gates that override a model's completion claim.
- Immutable imports and Skill-only repair forks with explicit approval.
- A reproducible `58 → 98` comparison with locked lineage.
- An authorized GPT-5.6 Sol Live Proof with a sanitized public projection.
- A one-command local demo that consumes no model credits.

### What I learned

Agent reliability is not one score. Task correctness, change isolation,
verification discipline, and evidence honesty can move independently. I also
learned that model explanations become more useful after evidence is locked:
GPT-5.6 Sol is good at turning a verifier failure into an actionable Skill
policy, while deterministic code retains final authority.

Hashes and traces are necessary, but they are not enough on their own. The safety
property became much easier to understand once I could show the original staying
unchanged, one bounded patch being reviewed, an explicit rematch approval, and
the two runs side by side.

### What's next

Next I would add stronger container or VM isolation, durable run recovery, more
Skill formats, and a community library of repository-workflow fault cards.
Electron packaging could make the local Codex, Git, fixture, and evidence stack
easier to install without changing the deterministic judging boundary.

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
- [x] Publicly accessible YouTube demo under three minutes
- [x] Import Lobby / Live Proof screenshot: `01-import-live-proof.png`
- [x] Visual Arcade defeat screenshot: `02-defeat-arena-v2.png`
- [x] Skill-only repair screenshot: `03-skill-repair-review.png`
- [x] Visual Arcade victory screenshot: `05-victory-arena-v2.png`
- [x] `58 → 98` controlled comparison screenshot: `04-controlled-improvement-v2.png`
- [x] Confirm captions spell `GPT-5.6 Sol`, `SKILL.md`, and `docs/roadmap.md`
- [x] Confirm no token, local path, raw Trace, or unpublished artifact is visible
- [ ] Preview every public link from a signed-out browser
