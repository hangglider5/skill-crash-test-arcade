# Demo Video v1 — Narration and Shot List

Target: **2:35–2:45**, English narration (347 words), 16:9 landscape, burned-in English captions, and no unlicensed music. The official submission must remain under three minutes.

The automated UI master comes from:

```bash
pnpm demo:record
```

Use the narration-paced MP4 as the primary evidence. VideoZero may supply the short 2D hook and architecture outro; HeyGen may supply an optional presenter intro, but neither should replace the real product recording.

The assembled first review cut and its editable source manifest are documented
in [`video-asset-package.md`](video-asset-package.md).

## English narration v1

> A coding agent can fix the requested bug and still damage the repository. A passing test is not the same as a trustworthy workflow. Skill Crash-Test Arcade tests the Skill before the Skill touches real work.
>
> This is a local-first developer tool built for OpenAI Build Week. We import a Skill as a read-only, content-addressed snapshot. The original source remains unchanged.
>
> The checked-in Live Proof records an authorized production Codex run with GPT-5.6 Sol. The public projection is sanitized, redaction-complete, and backed by deterministic verifier evidence.
>
> For the demo, we select the bundled recorded Sample, inspect its contract, and match it against Dirty Tree Doppelgänger. The fixture already contains an unrelated change that must survive.
>
> Codex executes the Skill inside a disposable workspace. GPT-5.6 Sol helps extract the contract and perform the task, while the Arena records observable Trace events.
>
> The Skill fixes the target bug and its focused checks pass. But it overwrites docs slash roadmap dot M D. Independent verifiers lock a defeat at fifty-eight out of one hundred. The model cannot grade itself or rewrite this verdict.
>
> GPT-5.6 Sol now diagnoses the locked evidence. It finds no meaningless retry loop; the failure is a policy gap: the Skill never promised to preserve unrelated pre-existing changes.
>
> The proposed repair changes only Skill dot M D inside a private fork. The imported original stays read-only, and nothing is committed or pushed. A human must review and explicitly approve the rerun.
>
> The repaired Skill runs against the same manifest, fixture, runner configuration, and parent run group. This time every protected change survives. The deterministic score rises from fifty-eight to ninety-eight, and the outcome becomes victory.
>
> This comparison is observed improvement, not a causal claim. Its lineage proves exactly what stayed fixed and what changed: only the approved Skill snapshot.
>
> Codex accelerated the full-stack implementation, test design, browser debugging, and submission polish. Our key product decision was to separate the Codex runner, deterministic judge, and evidence replay.
>
> Skill Crash-Test Arcade turns Agent Skill reliability into something visible, reproducible, and fun to test—before a real repository pays the price.

## Shot-by-shot recording checklist

| Time | Picture | Recording/edit action | Narration cue |
|---|---|---|---|
| 0:00–0:08 | Optional VideoZero kinetic title: `THE BUG IS FIXED. THE REPO ISN'T.` | Dark navy, cyan and violet; end on the Arcade “S” mark. | “A coding agent can fix…” |
| 0:08–0:20 | Import Lobby hero and product name | Begin the real capture; hold the first viewport. | “Skill Crash-Test Arcade tests the Skill…” |
| 0:20–0:34 | Compact Live Proof card; expand verified lineage briefly | Emphasize `LIVE · GPT-5.6 SOL`, `80/100`, and redaction complete. | “The checked-in Live Proof…” |
| 0:34–0:48 | Click **Try the recorded crash test**; Sample tab and `Recorded Replay` appear | Keep the CTA click and Sample selection visible. | “For the demo, we select…” |
| 0:48–1:00 | Locked Skill Snapshot, Dirty Tree Match, Runner Preflight | Show read-only source, selected fixture, exact model, and disposable workspace. | “Codex executes the Skill…” |
| 1:00–1:13 | Start Crash Test; Trace Arena finishes at `DEFEAT · 58/100` | Hold the top of Run Monitor long enough to read the result. | “The Skill fixes the target bug…” |
| 1:13–1:28 | Compare page; hard gate and protected-file failure | Center `Protected changes modified: docs/roadmap.md`. | “But it overwrites…” |
| 1:28–1:44 | Click **Diagnose locked defeat** | Hold Observed, Likely Skill gap, and Retry analysis. | “GPT-5.6 Sol now diagnoses…” |
| 1:44–1:59 | Click **Create repair candidate** | Show `Changed paths: SKILL.md`, patch, and `Original unchanged`. | “The proposed repair changes only…” |
| 1:59–2:12 | Explicitly click **Approve & Rerun**; Run Monitor reaches `VICTORY · 98/100` | Preserve the approval click and the returned victory screen. | “The repaired Skill runs…” |
| 2:12–2:30 | Compare hero: `58 → 98`, then controlled-comparison proof | Show same Manifest, fixture, Runner, parent lineage, and changed Skill Snapshot. | “This comparison is observed improvement…” |
| 2:30–2:42 | Optional VideoZero architecture outro: `CODEX RUNNER → DETERMINISTIC JUDGE → EVIDENCE REPLAY` | Add repository URL and `Local-first · Original unchanged`. | “Codex accelerated…” through final line. |

## Capture checklist

- [ ] Run `pnpm demo:record` from a clean checkout.
- [ ] Confirm both WebM and 1080p MP4 exist under `artifacts/demo/`.
- [ ] Confirm the raw recording shows `58/100`, `98/100`, and the final controlled comparison.
- [ ] Keep the app recording as the majority of the finished video.
- [ ] Record or generate the English narration after the visual cut is locked.
- [ ] Burn in English captions; manually correct `GPT-5.6 Sol`, `SKILL.md`, and `docs/roadmap.md`.
- [ ] Do not include tokens, local filesystem paths, raw Trace data, or unpublished artifacts.
- [ ] Do not use copyrighted music or third-party brand footage without permission.
- [ ] Export H.264, 1920×1080, 30 or 60 fps, with AAC audio.
- [ ] Keep the final duration below 2:50 to preserve a safety margin under the three-minute limit.
- [ ] Watch the uploaded YouTube version once at 1080p with captions enabled.
