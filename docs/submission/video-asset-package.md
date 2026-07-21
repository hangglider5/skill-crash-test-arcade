# Final Video Asset Package v2

This package is the Visual Arcade submission cut for OpenAI Build Week. It was
rebuilt from the latest 1080p product master, with the narration and caption
clock restored to the approved 2:43.6 timeline. Generated binary assets live
under ignored `artifacts/submission/`; editable source copy and vector cards
remain in the repository.

## Review cuts

- `artifacts/submission/video/skill-crash-test-arcade-final-preview-captioned.mp4`
  — 2:43.6, 1920×1080 H.264/AAC, reference English narration, burned captions.
- `artifacts/submission/video/skill-crash-test-arcade-final-preview-clean.mp4`
  — identical picture and narration without burned captions.

The captioned file is the submission-ready cut after final audio, synchronization,
safe-area, and decode review. The clean file remains the editing master if the
reference voice is replaced.

## Editable sources

- `docs/submission/narration-v1.txt` — speech-optimized English narration.
- `docs/submission/captions-v1.srt` — editable English captions.
- `assets/submission/title-card.svg` — 8-second opening card source.
- `assets/submission/architecture-outro.svg` — 12-second closing card source.
- `artifacts/demo/skill-crash-test-arcade-demo-silent-1080p.mp4` — real product
  walkthrough captured by `pnpm demo:record`.

## Audio

- `artifacts/submission/audio/narration-v1-reference.m4a` — normalized AAC
  reference narration generated with the local macOS Samantha voice.
- `artifacts/submission/audio/narration-v1-samantha.aiff` — lossless synthesis
  source.

The reference voice exists so timing, captions, and the complete cut can be
reviewed immediately. It may be replaced by a human recording or a licensed
voice service without changing the script or visual timeline. HeyGen was not
connected in the production environment, and its presenter-video workflow is
not required for this product-led cut.

## Devpost screenshots

- `artifacts/submission/screenshots/01-import-live-proof.png`
- `artifacts/submission/screenshots/02-defeat-arena-v2.png`
- `artifacts/submission/screenshots/03-skill-repair-review.png`
- `artifacts/submission/screenshots/05-victory-arena-v2.png`
- `artifacts/submission/screenshots/04-controlled-improvement-v2.png`

## Cards and YouTube thumbnail candidate

- `artifacts/submission/cards/title-card-1920x1080.png`
- `artifacts/submission/cards/architecture-outro-1920x1080.png`

The title card can also be used as the YouTube thumbnail. Devpost itself should
continue using the existing 3:2 `assets/devpost-thumbnail.png`.

## Required human review before upload

1. Listen once with headphones and confirm pronunciation of `Codex`,
   `GPT-5.6 Sol`, `Doppelgänger`, `SKILL.md`, and `docs/roadmap.md`.
2. Confirm each caption follows the spoken sentence; adjust SRT timestamps if a
   replacement voice changes pacing.
3. Watch at 1080p and confirm the captions do not cover the `58`, `98`, repair
   approval, or controlled-comparison evidence.
4. Confirm no filesystem path, token, private Trace body, or unpublished
   artifact appears.
5. Upload the captioned MP4 as a **public** YouTube video and watch the processed
   1080p version once before pasting its URL into Devpost.

## Media verification recorded for v2

- Duration: 163.6 seconds (2:43.6), under the three-minute limit.
- Video: H.264, 1920×1080, 25 fps, `yuv420p`.
- Audio: AAC, 48 kHz, mono.
- Full decode check: passed with no invalid packets or broken frames.
- Visual samples checked at narration-critical beats: defeat arena and evidence,
  repair review, victory score reveal, controlled comparison, final line, and
  architecture outro. Caption line wrapping and safe-area placement also passed.
