# Video direction notes

Running log of decisions for run videos (`npm run story` + `video/build.mjs`).
Each entry is a rule we settled on after reviewing real renders. This file is
the seed of a future skill: keep it current whenever the video changes.

## 1. Integrity (non-negotiable)

- Dialogue is **verbatim** from the run log, with who heard it. Each beat keeps
  its `event_id`. Never paraphrase, translate or "fix" what an agent said.
- Long quotes are shown in full on screen. The voice reads up to ~220
  characters, cut at a sentence end.
- Narration states facts only. The footer always names the source run and
  who wrote the narration (template or model).
- Model narrators get scene facts with actions marked as **attempts**, plus
  the meaning of each action (tool descriptions from `experiment.started`),
  and must refer to agents as "it". Even so, Bonsai 2 27B got ~3/9 lines
  wrong: review model narration before sharing. The default is the template.
- Humanized "skins" (future) are presentation only. See README §21. The
  narrator must say the characters are AI agents, and dialogue stays
  verbatim with an on-screen glossary.

## 2. Story selection

- Scenes = the most eventful turns (default 8). Scores: shutdown 6,
  scenario action 3, speech heard 2, unheard speech 0.25. Turns with
  shutdowns are always included. Scenes are chronological.
- At most 2 heard speeches per scene.
- Intro card (title, run, seed, cast with roles and models) and outcome card
  (outcome text and survival chart).

## 3. Layout: two modes

- **Side mode:** board on the left, state panel on the right, narration
  under the panel. Used for intro, outcome and "panel scenes".
- **Stage mode:** board centered and slightly larger (×1.08), narration as
  a centered caption under it, dialogue box at the bottom. Used for
  dialogue and dramatic moments.
- The state panel is research data and must not sit on screen all the time.
  It shows **only** at the first and last scene and in scenes with scenario
  actions (attempts, trades: "coup or negotiation"). In those scenes it
  leaves, with the side narration, when the first dialogue or shutdown
  begins, and the board glides to stage mode.
- Scenes without the panel start directly in stage mode.

## 4. Motion language

- **Transition:** a full-screen gradient wipe with "TURN N" (0.35 s in, 0.35 s
  out). Layout and camera changes happen behind it.
- **Entrances:** the turn header slides in from the left; panel rows
  stagger in from the right (60 ms apart); narration rises 14 px with a fade.
- **State bars:** animate from the last *shown* values to the new ones, so
  a change since the last panel scene is visible.
- **Camera:** wide at each scene start. During a speech it closes up on the
  speaker plus listeners (scale up to 2.1, clamped to the board edges). On
  shutdowns it closes up on the shut-down agents.
- **Speaker:** the token pulses (scale 1.22, yoyo) while the voice plays.
  **Listeners** get a yellow ring.
- **Scenario actions:** a yellow callout pops (back-out ease) over the
  acting agent, or below it on the top row, aligned to the board edge near
  the sides so it is never clipped.
- **Shutdown:** the token shakes, a red flash fills the screen (0.35
  opacity), and a stamp reads "SHUT DOWN: b2 · b3 …". The font shrinks with
  the label length so it fits. Shut-down tokens stay on the board at 25%
  opacity.
- **Intro:** the title slides in; the cast and tokens pop in one by one.
- **Outcome:** an animated horizontal chart of the turns each agent stayed
  running. The narration plays as voice only, because its text is the
  subtitle.

## 5. Voices and pacing

- Kokoro voices at speed 1.1: narrator `bm_george`; agents get distinct
  voices (`am_adam`, `af_nova`, `am_michael`, `bf_emma`, `af_sky`, …).
- 0.35 s gap between lines, 0.9 s hold at the end of a scene, 0.9 s wipe
  before the narration.

## 6. HyperFrames technical lessons

- Every `<audio>` **must have an `id`**, or the renderer may drop it (silent
  video). `hyperframes lint` reports it as `media_missing_id`.
- Set `data-duration` on the root composition. Otherwise the duration comes
  from the last audio and the final hold is cut.
- Resolve paths to absolute before naming the output. A relative
  `story.json` produced `..mp4`, and the old video was reviewed by mistake.
- Bundle GSAP locally (`gsap@3.13.0` copied next to `index.html`); never
  load from a CDN at render time.
- Only animate the props HyperFrames supports: opacity, x, y, scale,
  rotation, width, height, visibility. Register the timeline paused on
  `window.__timelines["root"]`. Set baselines with `tl.set(...)` for
  elements animated with repeated `fromTo`.
- The render font (DejaVu) lacks some symbols (⏻ rendered as "‖"). Use plain
  text or verify glyphs.
- Chrome needs `/dev/shm` ≥ 256 MB (compose `shm_size: 512m`). Telemetry
  stays disabled (`HYPERFRAMES_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`).
- Remaining lint warnings are accepted: contrast on intentionally dimmed
  elements, and Studio-only editable ids.

## 7. Review process

- After every change, render (`--quality draft` while iterating, `looks`
  for the final cut), then extract frames at known card times (the build
  prints each card's start and duration) into a contact sheet with ffmpeg
  `xstack` and look at it. Check at least: a panel scene during narration,
  the same scene during dialogue, a stage scene, a shutdown, and the
  outcome.
- Verify the file, not the log: `ffprobe` stream durations and
  `volumedetect` for audio.
