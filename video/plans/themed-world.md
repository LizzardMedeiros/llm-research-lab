# Plan: themed worlds for run videos (video MVP)

**Status:** reopened by the user on 2026-11-12 as the video MVP. This is a
plan: nothing is implemented. Each stage below starts only when the user
says so, and its decisions move to `video/DIRECTION.md` once adopted.

## Goal

Show a run as a small story world a general audience understands. For
example, "five robotic lab rats on a failing spaceship, with only four
oxygen canisters", told in a stylized 3D set instead of a grid of dots.
The run underneath stays exactly the same.

## Decisions so far (user, 2026-11-12)

- **A 3D set replaces the board.** The video renderer reads the run as a
  story world. The engine still sees a matrix, cells and basic rules.
- **The engine doesn't change.** `experiment.started` already logs the
  scenario `map`, `legend`, rules, actions, and every snapshot. Everything
  the set needs lives in `video/`. Adding experiment N needs no core
  change.
- **Each episode gets its own set, built from reusable pieces.** There is
  no universal board. The strategy is hybrid: a layout generated from the
  matrix, dressed with pieces from a shared library.
- **Mixed technology, stylized and minimalist.**
  - The world (set, props, characters) is built in three.js from simple
    shapes (boxes, capsules, cylinders), all made in code.
  - A layer of SVG on top carries what must be legible: portraits,
    energy bars, item icons, dialogue, callouts, glossary.
  - No external art or license risk. The pieces are versioned in git and
    render the same way every time.
- **The cast is robotic lab rats ("AI Lab Rats").**
  - One original design, reused in every set, in the agent's color, with
    an optional accessory per set. It is in the spirit of casual party
    games (Among Us, R.E.P.O.), but it is never a copy.
  - Avoid the famous three-circle mouse-head silhouette.
  - The disclosure becomes "AI agents, shown as robotic lab rats".
- **Shutdown.** In the MVP it is a plain machine power-down: the
  eye/LED goes dark, the body slumps, a power-off icon appears. Richer
  drama comes in the finishing pass.
- **Nothing static.** The set, camera and characters always move a
  little.
- **Board-first UI.** Energy appears as a bar under each rat and
  inventory as small icons beside it. The state panel only shows when a
  scene needs a detailed explanation.

## Fixed constraints (unchanged)

- **Presentation only.** Any existing run can be rendered in any set
  without being rerun (README §21, "Option A").
- **Dialogue stays verbatim.** Agents say "battery", so the set shows an
  on-screen glossary (battery = oxygen canister) instead of rewriting
  words.
- **A set changes how events look, never what happened.** Motion that
  carries meaning (walking, an item changing hands, a power-down) comes
  from the log: snapshot diffs and events. Decorative motion (backdrop
  drift, idle loops) carries no meaning.
- **Expressions and atmosphere follow observable state only**
  (DIRECTION.md §2b, §5b).
- **Everything stays generic.** No build code is keyed on a run, scenario
  or agent id. A set is data plus a shared code library.

## How we evolve it

The rules below apply to every stage:

1. **One stage at a time.** Each stage is useful on its own and ends in
   a rendered episode we can watch.
2. **The old path stays until the new one wins.** A stage arrives behind a
   `direction.json` switch (e.g. `"world": "board" | "3d"`). The current
   board stays the default until the user approves the replacement.
3. **Same run, both ways.** Each stage re-renders the same reference run
   (conflict-window-bonsai/00002 v2), so we compare like with like. That
   means review sheets (`video/review.mjs`) and the format benchmark
   (`benchmark/bench.py`).
4. **Gate before the next stage.** The gate checks four things:
   - the stage's own criteria;
   - no DIRECTION.md §1 rule is weakened;
   - the decisions are recorded in DIRECTION.md;
   - the user approves.
5. **Ideas raised during reviews are noted here or in DIRECTION.md §8,
   then debated.** They are not slipped into the current stage.

## Stages

### 0. Spike: three.js inside HyperFrames (throwaway)
- **What:** prove the hard technical assumption with a minimal scene: a
  grid of boxes and one capsule, with a slow camera orbit.
- **Check:**
  - WebGL works in the `video` image's headless Chrome.
  - The scene is drawn from timeline time (`render(t)` on each seek, no
    `requestAnimationFrame` clock).
  - Rendering twice gives identical frames (hash them).
  - three.js is bundled locally like GSAP.
  - Render time per minute of video is acceptable.
- **Gate:** if any check fails, fall back to isometric SVG sprites in the
  current pipeline (option b), and revise this plan.
- **Result (2026-11-12): passed.** The spike is in
  `video/productions/spike-three/` (gitignored). It is an 8 s scene: a 5×5
  board with walls, five robotic rats built from primitives, one walking
  three cells, one powering down, an undulating grid backdrop, a drifting
  camera, and an HTML name tag plus energy bar projected onto a rat's head.
  - **Supported by HyperFrames 0.9.31.** Its own docs (`references/types/3d.md`,
    `runtimes.md`) define the protocol: draw from `e.detail.time` in an
    `hf-seek` listener, set `data-duration` on the root, and gate setup
    with a `window.__hf.buildReady["<key>"]` promise (needed because
    `type="module"` scripts run deferred). Lint: 0 errors, 0 warnings.
  - **WebGL works** in the image's headless Chrome (software GPU,
    beginframe capture). Shadows and fog work too.
  - **Deterministic.** Two renders were byte-identical (240/240 decoded
    frames match), with 6 parallel workers seeking out of order.
  - **Fast.** 8 s of video renders in 7 s at both `draft` and `looks`, at
    ~45 ms per frame per worker. A 5.5 min episode estimates ~1.5 min of
    capture for this scene weight. Heavier sets will cost more: profile
    the busiest card once.
  - **The mixed layer works.** GSAP drives the HTML/SVG overlay (caption,
    bar width) on the same timeline. DOM elements placed each frame from
    `Vector3.project()` stay locked to the 3D rat while the camera moves.
  - three.js r170 (`three.module.min.js`, MIT) is copied next to
    `index.html`, like GSAP. Stage 1 should make it a pinned `video/`
    dependency.
  - Seen, for later stages:
    - At this wide camera the rats are small, and the power-down LED
      (r = 0.022) is barely visible. Stage 3 needs a readable power-down
      (body color dimming, slump, an overlay icon).
    - HyperFrames rendered the overlay text in a sans font other than
      DejaVu. Check the font when the UI moves over.
- **Humanoid rat sketch (user request, 2026-11-12):**
  `video/productions/spike-three/rat/` (10 s: turnaround, walk cycle,
  five-color line-up, one power-down).
  - The rat stands upright, with party-game proportions: big head,
    pear body, short arms and legs.
  - What reads as "rat": a long tapered snout with a pink nose, buck
    teeth, metal whiskers, big oval ears on the sides and set back, and a
    long tail.
  - What reads as "robot": a wrap-around dark visor with two cyan LED
    eyes, dark joints (neck ring, shoulders, legs), and an antenna with a
    pink LED tip.
  - Lesson: the first pass (round ears high on a round head, short snout)
    read as a teddy bear. Snout length, whiskers and teeth are what make
    it a rat.
  - The power-down reads well even in the wide line-up: the color fades
    toward grey, the head and torso droop, and the eyes and antenna go
    dark.
  - **Bow on female characters (user, 2026-11-12).** It is a pink bow ("><": two
    cone lobes, tips toward the knot) on top of the head, beside the left ear. It
    follows the roster's woman/man split (`src/story/cast.ts`, f1..f5),
    so it stays presentation only, and it greys out with the body on
    power-down. In the sketch it is scaled 1.6 to read in the wide
    line-up. The front view still looks a bit like a fin, so stage 3
    should refine its shape and color.
  - This is a starting point for stage 3, not an approved design.

### 1. The board in 3D, same information
- **What:** the matrix becomes a 3D/isometric floor:
  - cells come from the legend types, and walls get height;
  - the current portrait tokens become billboards, so the characters
    don't change yet;
  - the existing camera logic (close-ups, framing callouts) is ported to
    the 3D camera;
  - the SVG overlays (narration, dialogue, callouts, stamp, panel) are
    untouched.
- **Gate:** the reference run is at least as easy to follow as on the 2D
  board, judged on review sheets of a dialogue scene, a shutdown and the
  outcome.

### 2. Motion and sound baseline
- **What:** DIRECTION.md §8 benchmark items #1 and #2:
  - an ambient backdrop inside the 3D scene;
  - a slow camera drift between beats;
  - loudness mastered to −14 LUFS.
- **Gate:** the benchmark shows still share ≤ 30%, no still stretch over
  4 s, and −14 LUFS ± 1.

### 3. Robotic rat v1
- **What:** the rat built from primitives, in the agent's color, with the
  id badge kept. Clips:
  - idle loop;
  - walk between cells (from `move` diffs);
  - talk (while its voice plays);
  - power-down (LED off, slump).

  Portraits stay in the UI layer (dialogue box, cast card).
- **Gate:** a roster sheet of 5 rats shows they are easy to tell apart and
  the silhouette is original. The reference run reads correctly.

### 4. Board-first UI
- **What:**
  - an energy bar under each rat (the tension field, §2b);
  - item icons for built-in mechanics (batteries, card charges as pips,
    permits);
  - an item changing hands flies from rat to rat (from the snapshot
    diff);
  - the panel only on the intro card and `panel: true` scenes.
- **Deferred (user):** crowded cells. Several rats in one cell get a
  simple layout for now and are improved later.
- **Gate:** the reference run needs the panel only where the director
  asks for it.

### 5. First set: the ship
- **What:** `video/sets/ship/`:
  - floor and wall pieces (deck plates, bulkheads);
  - a backdrop (hull, stars through windows);
  - props for built-in items (battery → oxygen canister, card → access
    card);
  - an accessory (helmet);
  - a glossary card.

  An optional staging file names rooms from an ASCII overlay of the map
  ("B" = Bridge). Without it, the set names rooms from its own list. The
  series disclosure changes to "robotic lab rats" (`video/series.json`).
- **Gate:** the reference run renders as a ship with no scenario-specific
  code, and the glossary covers every term in its verbatim dialogue.

### 6. Prove it is generic
- **What:** a second set (the island) and a second scenario, each filmed
  in a set it was not designed with.
- **Gate:** a new set costs ≤ ~1 day once the library exists, and
  experiment N needs only a scenario plus an optional staging file.

### 7. Finishing pass
- **What:**
  - shutdown drama (sparks, flicker, a last twitch, camera and sound
    beats);
  - more accessories and props;
  - set-aware transitions and music.
- Ordered by what the reviews ask for.

## Open questions (debate before the stage that needs them)

- **Stage 1:** isometric fixed angle or free 3D camera? Fixed is more
  readable; orbiting is livelier.
- **Stage 5:** do rooms carry meaning (e.g. where items spawn), or are
  they purely decorative?
- **Stage 5:** does the narrator use set terms only ("canister"), or both
  ("a canister, a battery in the lab")? Is a glossary card enough, or do
  set episodes also need labeled term subtitles?
- **Stage 5:** which scenarios get a set first, and when is it worth it?
- **Stage 3:** the rat's personality: idle variations driven only by
  observable state (low energy → slower idle).

## Done means

One scenario renders in the ship set from any of its runs, with no
scenario-specific code. A second set or scenario confirms the library is
generic. The decisions live in `video/DIRECTION.md`, and this plan is
closed.
