# Final Video Asset Package v3

Published demo: https://youtu.be/O-eEYYi42qc

This package is the motion-polished Visual Arcade submission cut for OpenAI
Build Week. It preserves the approved narration and caption clock, keeps the
final sentence on the controlled comparison, and replaces the long silent tail
with a five-second animated architecture sign-off. Generated binary assets live
under ignored `artifacts/submission/`; editable source copy and vector cards
remain in the repository.

## Review cuts

- `artifacts/submission/video/skill-crash-test-arcade-final-preview-captioned.mp4`
  — 2:37.72, 1920×1080 H.264/AAC, reference English narration, burned captions.
- `artifacts/submission/video/skill-crash-test-arcade-final-preview-clean.mp4`
  — identical picture and narration without burned captions.

Versioned copies are retained as
`skill-crash-test-arcade-final-motion-v3-captioned.mp4` and
`skill-crash-test-arcade-final-motion-v3-clean.mp4`.

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
5. Upload the captioned MP4 to YouTube and watch the processed 1080p version
   from a signed-out browser before pasting its URL into Devpost. Completed for
   https://youtu.be/O-eEYYi42qc.

## Media verification recorded for v3

- Duration: 157.72 seconds (2:37.72), under the three-minute limit.
- Video: H.264, 1920×1080, 25 fps, `yuv420p`.
- Audio: AAC, 48 kHz, mono.
- Full decode check: passed with no invalid packets or broken frames.
- Visual samples checked at the motion title, defeat arena and evidence, repair
  review, victory score reveal, final controlled-comparison line, clean outro,
  and fade to black. Caption wrapping and safe-area placement also passed.
