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

## 2b. Characters (humanization phase 1)

- Each agent has a character, for presentation only (`src/story/cast.ts`).
  - **Mixed models:** the name is the model family, numbered within the
    family in agent order ("Claude", "Qwen 1", "Qwen 2"); policies get
    their policy name ("Random", "Talker").
  - **One model for every agent:** each character's short fictional name
    (roster: Anna, Maya, Lena, Zoe, Iris; John, Fred, Omar, Leo, Kai).
    Lesson (dead-end-bonsai/00001): five "Bonsai 1..5" made the narration
    repetitive and hard to follow.
  - Renaming one agent (script `cast`) never renumbers the others.
  - The **id stays visible** next to the name everywhere ("Bonsai 3 · b3"),
    because verbatim dialogue refers to agents by id.
- **Fixed roster** (`ROSTER` in `src/story/cast.ts`): ten recurring
  characters, five women and five men. Each group has one white, one
  Asian, one Black, one brown (pardo) and one red-haired character, each
  with a hand-set portrait and its own Kokoro voice (`af_`/`bf_` for
  women, `am_`/`bm_` for men; `bm_george` is the narrator's).
  - Agents draw characters in agent order, alternating woman/man:
    f1 Black woman, m1 Asian man, f2 white woman, m2 pardo man,
    f3 red-haired woman, m3 Black man, f4 Asian woman, m4 red-haired man,
    f5 pardo woman, m5 white man. The first five agents cover all five
    looks.
  - Pick a character in the script `cast`: `{"b1": {"character": "m3"}}`;
    other agents skip it. Past ten agents, characters repeat (id badge
    and color still tell them apart).
  - Lesson: faces and voices chosen independently mismatched
    (power-struggle-bonsai-00002, b1 and b5); and two characters with the
    same skin and hair read as one person (m2/f5 first draft). Check new
    characters on a roster contact sheet before a render.
- **Portraits** are illustrated SVG faces (`video/portrait.mjs`): face
  shape, skin, hair style and color, accessory, eye shape (round or
  almond) and freckles, on the character's color. No external art; any
  part can be overridden.
- **Expressions follow observable state only:**
  - `off` when shut down (closed eyes, grayscale);
  - `tense` when the tension field is low;
  - otherwise `neutral`.

  The tension field defaults to the first per-agent numeric field, tense
  at ≤ 15% of its max in the video; override it with
  `direction.json` `"tension": {"field": "charge", "at_or_below": 3}`.
  Expressions switch at the start of the turn and again when it resolves.
- **Where characters appear:**
  - tokens: portrait with an id badge;
  - dialogue box: speaker portrait, plus "name · id → heard by name · id";
  - panel rows: mini portrait, name, id and role;
  - intro cast: portrait, name, id, role and model;
  - outcome chart: portrait (off or neutral) and name;
  - shutdown stamp: names.
- The intro always shows the line "Every character is an AI agent; names
  and faces are illustrative.", followed by "All of them run the same
  model, <model>." (fictional names) or "Names come from each agent's
  model." (mixed models).
- The narration introduces each character once with its id, then uses the
  name (strategist rule). Callouts keep ids, to stay compact.
- Lesson: the intro narration must be confined to the strip under the board
  (`.narration.intro-narration`). Spanning the full width, it collided with
  a taller title + cast block.

## 2c. Series identity (humanization phase 3)

- Series config: `video/series.json`, the same for every episode: series
  name ("AI Lab Rats"), project name, narrator persona and its fixed lines,
  optional public `logs` link. Change identity there, never per episode.
- **Narrator persona: the Observer**, a voice that watches the lab, not a
  pretend human. Its greeting opens the intro card, before the script's
  intro narration, and carries the disclosure: AI agents, a simulated world,
  dialogue shown exactly as said. Scripts never repeat or rewrite it.
- **Experiment card** (intro): brand badge "AI LAB RATS · experiment card",
  title, logline, run meta, then a Rules row (grid, turns, perception,
  numeric scenario params, all from `experiment.started`) and an Actions
  row, then the cast. Nothing on it is typed by hand.
- **End card** (`series-end`, after the outcome, ≥ 6 s): logo, the outcome
  line, the Observer's sign-off (voiced) and the run reference (run, seed,
  project; logs link only when `logs` is set). The board fades out.
- Not adopted (user choice, 2026-11-11): opening sting, episode numbers.
- The footer starts with the series and project names.

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

## 5b. Atmosphere (humanization phase 2)

- One synthesized track (`video/atmosphere.py`, numpy; no third-party
  audio), built from cues that `build.mjs` derives from OBSERVABLE state
  only. Same cues → same file (cached by cue and script hash).
- **The chord is the cast:** a quiet base drone, plus one note per
  running agent (A minor pentatonic, in agent order). An agent's note
  fades out when it shuts down on screen and comes back in flashbacks
  where it is still running. When nobody is left, only the drone remains.
- **Tension pulse:** a low heartbeat whose rate (54 to 120 bpm) and weight
  follow the share of running agents whose expression is `tense` (the
  same rule as the portraits, §2b). No pulse when nobody is low.
- **Effects:** whoosh on the turn wipe, a blip per action attempt (a dull
  buzz when rejected), a power-down on each SHUT DOWN stamp, a chime on
  the end-card logo.
- Music ducks 60% under every voice clip. Measured: voice mean ≈ −21 dB
  unchanged, bed ≈ −32 dB.
- `direction.json` `"atmosphere": false` turns it off; `{"music": 0.7,
  "effects": 1.2}` scales the levels (1 = default).
- Music never claims feelings: it follows the counts it is built from.

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

- The procedure is the `video-direction` skill
  (`.claude/skills/video-direction/SKILL.md`): draft render, review,
  fix (`direction.json` first, `build.mjs` only for general problems),
  final render, verification, and recording here.
- `video/review.mjs <folder> [--at s,…]` builds labeled contact sheets
  from `timeline.json`: start, middle and end of every card, plus chosen
  moments. Check at least a panel scene during narration, the same scene
  during dialogue, a stage scene, a shutdown, and the outcome.
- Verify the file, not the log: `ffprobe` stream durations and
  `volumedetect` for audio.

## 7b. Format benchmark (reference videos)

- After the final render, measure the episode with the format benchmark
  (`benchmark/bench.py analyze <episode.mp4> --timeline <timeline.json>`,
  README §16) and compare it with the reference reports
  (`bench.py compare`). Report the gaps in `direction-notes.md`.
- Reference so far (n = 1, a guide, not a norm): Limiar, "Uma IA Incendiou
  a Cidade…" (2026, 14:12), compared with conflict-window-bonsai/00002:

  | measure | reference | ours |
  |---|---:|---:|
  | still share (no visible change) | 4.6% | 90.3% |
  | median still stretch | 1.5 s | 7.3 s |
  | integrated loudness | −14 LUFS | −18.9 LUFS |
  | narration words/min | 154 | 148 |
  | chapters | 17 (one per ~50 s) | 0 |

- What the gaps mean: the narration pace already matches. The picture
  is what's different. The reference keeps the frame alive all the time
  (drifting grid, particles, slow push-ins), while ours sits frozen on
  the board between beats. Its audio is also mastered to YouTube's
  −14 LUFS, and ours plays ~5 dB quieter.
- Reference visual grammar worth borrowing (see §8 proposals): a
  "big number" card for one striking count, quote cards headed by source
  and time ("// diary · last entry · 19:57"), and a two-portrait face-off
  for an exchange between two agents.
- Targets for our renders until we have more references: still share
  ≤ 30%, no still stretch > 4 s, −14 LUFS ± 1. These need the §8 build
  changes; `direction.json` alone (`pace`, `transition: "cut"`) only
  shortens holds.

## 8. Proposed adjustments

### Open (2026-11-12, from the format benchmark, §7b)

1. **Ambient motion.** The frame is still 90% of the time (reference
   5%). Proposed rule: a background layer that always moves slowly
   (drifting grid or particles, low contrast, behind the board), plus a
   slow camera drift (scale +2% over each card) when no close-up is
   active. It is decoration only, never tied to state, so it cannot
   claim anything.
   User direction (2026-11-12): nothing should feel static. The background
   is never flat black. It is a 3D scene with depth and little motion,
   like the reference's neon perspective grid that undulates gently toward
   the horizon. Build our own look (series colors), not a copy. Explore
   three.js for this layer, and later for giving the board and tokens
   depth and motion.
   Open technical question (spike first): HyperFrames renders by seeking
   a paused GSAP timeline frame by frame, so a three.js scene must be
   drawn from timeline time (a deterministic `render(t)` per seek, no
   `requestAnimationFrame` clock). WebGL must work in the headless Chrome
   of the `video` image. Bundle three.js locally like GSAP (§6).
2. **Loudness mastering.** Ours is −18.9 LUFS, the reference −14 (the
   YouTube target). Proposed rule: a final two-pass `loudnorm` to
   −14 LUFS, true peak −1 dBTP, in `build.mjs`, and verify it with the
   benchmark.
3. **Big-number card.** A scene option that shows one count from
   `facts.md` (e.g. "3 of 5 shut down by turn 10") large on screen with
   its label. The number must come from the logged facts, never be
   typed by hand.
4. **Quote card header.** Show the source above long verbatim quotes,
   as "// turn 12 · b3 → b1, b4", like the reference's
   "// diary · 19:57". It adds traceability, and the timestamp builds
   suspense.
5. **Face-off layout.** For an exchange between two agents, put the two
   portraits on opposite sides with the line between them, instead of the
   bottom dialogue box. A `direction.json` option per scene.

Proposals from the video-director agent (or from reviews) that need a
`build.mjs` change. Each entry: date, problem seen (scene and timestamp),
proposed rule. They become part of §1–§7 once adopted.

### Under discussion (2026-11-12, user review of conflict-window v2): board-first layout

User direction: the state panel still takes too much screen time. Focus
on the board instead. Show energy as a bar under each actor's token and
inventory as small icons next to it. Keep the panel for scenes that need
a detailed explanation. Not decided yet; points to settle:

- **Generic, not scenario-specific.** The bar is the tension field
  (§2b: the first per-agent numeric field, or `direction.json`
  `tension`). Icons only for built-in mechanics (batteries, card
  charges as pips, permits). Any other per-agent fields stay panel-only.
- **Crowded cells.** In conflict-window, 3–4 agents share a cell
  (turns 8–10 at (1,2), turns 25–30 at (3,2)). Tokens are 42% of a
  cell, so the bar and icons need a stacked or fanned layout per cell,
  or they only show at close-up scale.
- **Changes must read.** The bar animates from the last shown value when
  the turn resolves, as panel bars do now (§4). An item that changes
  hands (a battery from Anna to Lena) could fly from token to token.
  The movement is sourced from the snapshot diff, never invented.
- **Panel becomes opt-in.** Proposed default: the intro card and
  `panel: true` scenes only. This would also free the frame for a bigger
  board (known issue: ~30% of the width in dialogue scenes) and helps
  the still-share target (§7b).
- Shut-down agents: empty grey bar, icons removed (their items went to
  the striker, which the fly-over would show).

### Open (2026-11-12, from conflict-window-bonsai/00002 v2)

The v2 script (cadence rules, `video/SCRIPTING.md`) splits turn 6 into two
scenes (s2, s3) and opens cold on turn 29 instead of turn 30. Open #1, #2 and
#4 below are still seen (stamp over row 2 at 3:41.8; the s8 move lands
0.6 s before the cut at 4:33.4; "only b5 still running"). These are new:

1. **A turn split across scenes shows all its callouts in every card.**
   s2 (turn 6, 1:43 to 2:04) shows "b5: use rfid → b2 (rejected)" from its
   first frame, while its narration is still about the turn-5 move. The
   attempt is narrated only in s3 ("it tries to use its card on John"), so
   s2 gives away s3's reveal. Quotes are already filtered per card (by
   `event_id`), but callouts are not. The wide callout also stays in every
   speech framing, so John's line (s2, 2:00) and Fred's (s3, 2:24) play at
   camera scale ~1 with tiny tokens. `camera` cannot help, because `frame()`
   always adds the visible callout boxes.
   Proposed rule: when several cards share a turn, a callout (attempt or
   rejection) appears only in the card whose script names it. For example,
   add an optional script `beats: ["evt_…"]` per scene, and by default put
   it in the last card of the turn. Quotes keep their current per-card
   filter.
2. **Callouts cover other agents' tokens.** s2/s3 (1:44 to 2:16): the b5
   callout band at row 1 (columns 0 to 2) covers the lower half of Anna's
   token at (2,1) and hides its "b1" badge. Bands are chosen against other
   callouts only. Proposed rule: treat token boxes (with badge) as occupied
   when choosing a band. If no band is free, take the band that covers the
   fewest tokens, and never cover a speaker or listener while its line
   plays.
3. **The final turn has no picture when the cold open is not the final
   turn.** v2's cold open is turn 29 (the trade). Turn 30 (Anna's rejected
   battery, Lena's card on Anna, Anna's shutdown) is only narrated over the
   outcome card (5:00 to 5:23). The board there already shows Anna dimmed,
   with no callout, shake or stamp. It is the payoff of the main loop, and
   it has the least motion in the episode. v1 showed it because its cold
   open was turn 30.
   Proposed rule: when no scene covers the last turn and that turn has a
   shutdown, the outcome card first plays the last turn's beats on its board
   (callouts, then shake, flash and stamp after the first narration line),
   then shows the chart. Alternative, no build change: the strategist adds
   a final-turn scene before the outcome (a script decision, reported to
   the user).
4. **The panel never shows how a drama scene resolves.** s6 (turn 10): the
   panel leaves when the stamp sequence starts (3:41), before the turn
   resolves. So "its last battery goes to Lena" is never seen on the bars:
   at s7's start, Lena already shows 1 battery, after using one on turn 11.
   Proposed rule: in panel scenes with drama, after the stamp, bring the
   panel back for ~1.5 s with the resolved bars (changed rows highlighted),
   or show a compact "after" strip under the stamp.

### Open (2026-11-12, from conflict-window-bonsai/00002)

The 2026-11-11 fixes behaved in this run: no callout leaked into a later
card, the callouts of a turn never overlapped (s4: three, s5: five), the
cold-open and turn-10 stamps landed after the narration, and the camera
followed movers on resolve (s1). These issues remain:

1. **The SHUT DOWN stamp covers the tokens that shut down.** Seen in the
   cold open (0:17.6, Anna under the stamp) and s5 (3:17.3 to 3:20,
   turn 10: b1, b2 and b5 at (1,2) and b3/b4 at (3,2) are all hidden
   behind "SHUT DOWN: Fred · Maya · John"). The stamp sits at the vertical
   center of the viewport (`.stamp` top = VIEW.y + VIEW.h/2 − 30), and the
   shutdown close-up centers the shut-down agents there. So the shake and
   the dimming, which are the point of the beat, play under the stamp.
   No `camera` setting avoids it: on a 5×5 board, row 2 is the center row
   even at scale 1.
   Proposed rule: place the stamp in the band of the viewport farthest from
   the shut-down tokens' screen positions after the camera move (above
   them, or below them when they sit in the top half), never over them.
2. **A narrated move in a scene with no drama lands at the card cut.** s8
   (turn 25, 4:12.9 to 4:13.8): "Lena steps into Anna's cell" is spoken at
   ~4:06, but the move starts at `resolveAt = end − 1.1` and is still in
   flight 0.6 s before the cut. `pace` does not help, because `resolveAt`
   moves with the card end (tried +0.6 s in draft 2: same result).
   Proposed rule: in scenes without a stamp, resolve at
   `max(start + lead + 1, narrationEnd − 0.5)` (as for the panel), and make
   the card last at least until the move has landed plus 0.8 s.
3. **The callout width estimate is a few pixels short.** s7 draft 1
   (3:46.9, close-up camera in side mode): the left end of the
   "b5: use battery" pill (b5 at column 1) was cut at the viewport edge;
   s4 (2:38): "b4: use rfid → b3 (rejected)" touches the right edge. The
   text stayed readable, but the pill edge was cut. Worked around with
   `camera: "wide"` on s7. Proposed rule: add the pill padding and border
   plus ~8% to the estimated width (or measure the text with the render
   font) before you clamp a callout and frame the camera on it.
4. **Outcome line uses ids only.** The outcome subtitle and the end card show
   the logged finish reason verbatim ("only b5 still running"), while the
   narration uses names ("Lena"). Keep the logged text, and add the
   character chip next to it (portrait + "Lena · b5") so viewers can link
   the two. Minor.

### Adopted 2026-11-11 (from dead-end-bonsai/00001)

Implemented in `build.mjs`, verified on dead-end-bonsai/00001 (without the
`panel: true` workarounds) and on a policy run (dead-end-mock/00002):
- the stamp plays at max(drama start, end of narration + 0.1 s), and every
  card with a shutdown gets 2.2 s of stamp room;
- a callout hides at max(pop + 1.5, min(end − 0.4, resolve − 0.1)), capped
  at the card end; the build fails if a callout would hide before it pops;
- callouts have a fixed height (22 px) and an estimated width; each takes
  the nearest free band above its cell (below on the top row, then any
  free band), so no two callouts of a turn overlap; they are clamped
  inside the board by measured width, not by column;
- every camera framing includes the callouts visible at that moment;
- when the turn resolves, the camera frames the agents that shut down and
  the agents that move (start and end cells).

The original proposals:


1. **Shutdown stamp before the narration in stage scenes without speech.**
   Seen: cold open (turn 9) and s11 (turn 20) in the first draft. With
   `panel: false` (or no panel by rule) and no speech, `stampAt = dramaAt =
   start + lead + 0.3`, so the red flash and "SHUT DOWN" land at ~1.2 s,
   before the narration has said what happened. Worked around with
   `panel: true` (the stamp then follows the narration).
   Proposed rule: in a scene without speech, the stamp plays after the
   first narration line that names the shutdown, or after all narration
   (as in panel scenes), never before the first line ends.
2. **Callouts that never hide (leak into every later card).** Same cause:
   the callout hide time is `min(end - 0.4, resolveAt - 0.1)`, and with an
   early `resolveAt` (point 1) it lands *before* the staggered pop
   (`start + lead + k × 0.25`). The later `fromTo` wins, so the cold-open
   callouts "b2: disable → b1" and "b3: disable → b1" stayed on the board
   for the whole video (wrong actions shown on later turns: an integrity
   problem). Proposed rule: a callout hides at
   `max(pop + 1.5, min(end - 0.4, resolveAt - 0.1))`, and the build fails if
   any callout's hide time precedes its pop.
3. **Callouts of agents in the same cell overlap.** Seen: cold open / s7
   (turn 9: b1, b2 and b3 act from (2,3); "b2: disable → b1" is half
   covered by "b3: disable → b1"), s8 (four pick-up/use callouts in one
   cell). The 26 px stack step is less than a callout's height plus
   margin. Proposed rule: stack step = callout height + 4 px, measured per
   font size, and stack per cell (not per action index), so callouts from
   one cell never overlap.
4. **Callouts clipped at the viewport during close-ups** (already a known
   minor issue, now seen hiding the actor id): s4 "b4: disable → b1
   (rejected)" shows as ": disable → b1 (rejected)" during the dialogue
   close-up; s9 "(rejecte"; s11 first draft hid "b3:" on a rejected
   use battery. Proposed rule: when the camera moves, clamp each visible
   callout inside the viewport (or let `cameraOn` include visible callout
   boxes in its framing), so the actor id is never cut.
   Also at scale 1: only column-0 agents get a left-aligned callout, so a
   column-1 callout wider than ~1.5 cells crosses the board's left edge and
   loses its first character even with `camera: "wide"` (s11, turn 20:
   "3: use battery (rejected)" for b3). Proposed rule: align by measured
   overflow (left-align whenever the centered box would cross the board
   edge), not by column index.
5. **Moves that the narration names happen off camera.** s2 (turn 3) and
   s3 (turn 5): "Bonsai 1 steps south / moves west" resolves near the end of
   the card, while the camera is still in the dialogue close-up on another
   agent, so b1's move is not seen. Proposed rule: when the turn resolves
   (token moves), return the camera to the scene's opening framing (or a
   framing that includes the moving tokens) for the move.

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
