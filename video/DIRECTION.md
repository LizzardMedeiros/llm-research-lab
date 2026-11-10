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
- **Turn time:** a scene shows the start of its turn first (speeches and
  actions), then the turn resolves (moves, shutdowns, state changes).
  Shutdown drama always comes after the scene's speeches.
- **Scenario actions:** a yellow callout "agent: action → target" pops
  (back-out ease) over the acting agent at its start-of-turn position, or
  below it on the top row, aligned to the board edge near
  the sides so it is never clipped.
- **Rejected attempts:** a grey callout marked "(rejected)", so attempts the
  environment refused stay distinct from attempts that failed.
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

## 8. Proposed adjustments

Proposals from the video-director agent (or from reviews) that need a
`build.mjs` change. Each entry: date, problem seen (scene and timestamp),
proposed rule. They become part of §1–§7 once adopted.

_(no open proposals)_

### Adopted 2026-11-10 (from the first e2e run, power-struggle-bonsai/00002)

All six proposals from the video-director were implemented in `build.mjs`
and verified on a re-render (frames checked at each fixed point).

1. **Tokens on the first card.** Tokens pop in on the first card of the
   video, whatever it is (a cold open used to show an empty board). The
   intro pops them only when it opens the video.
2. **Outcome narration** is a caption under the chart
   (`.narration.outcome-narration`, declared after `.narration` because the
   old rule lost on CSS order). It is skipped when it repeats the subtitle.
3. **Beat order.** A shutdown (shake, flash, stamp, close-up) plays after the
   scene's last speech. The card gets 2.2 s more so the stamp has room.
4. **Start-of-turn state.** Every scene opens on the world at the start of
   its turn (`state.before`, from the previous turn's snapshot), where its
   speeches and actions happened:
   - tokens, close-ups and callouts use those positions;
   - the turn then resolves: tokens move and dim at the stamp, or near the
     end of the scene; panel bars, numbers and "off" labels change ~1 s
     before the narration ends.
5. **Rejected attempts** are story beats (`kind: "rejected"`). They show as
   grey callouts "agent: action → target (rejected)", and they appear in
   `facts.md` as `rejected_attempt` with the reason. This also closes the
   fact-check gap the strategist reported.
6. **Callouts name the actor** ("b1: disable → b3") and are anchored at the
   actor's start-of-turn position.

Known minor issues (not fixed): a callout can be clipped at the viewport
edge during a close-up (s9); in dialogue scenes the board uses ~30% of the
frame width.

## 9. Scripts and direction (multi-agent pipeline)

- The `youtube-episode` skill chains `content-strategist` → fact-check
  gate → user approval → `video-director` → `copywriter`.
- `script.json` (strategist) sets the scenes, their order (cold open and
  flashbacks are labeled on screen), the narration lines and the quotes by
  `event_id`. `npm run script:check` resolves the quotes verbatim and writes
  `facts.md` for the gate.
- `direction.json` (director) overrides per scene: `panel`, `camera`
  ("auto" | "wide" | agent list), `pace` (extra hold seconds) and
  `transition` ("wipe" | "cut"). Script `focus` agents frame the camera when
  `camera` is "auto".
- Each build writes `timeline.json` (card id, kind, turn, label, start,
  duration) for chapters.
- Intro: the title size adapts to its length; title, logline and cast stack
  in one flow block (a long title used to overlap the logline).
- A quote nobody heard shows "heard by nobody (no agent in range)".
