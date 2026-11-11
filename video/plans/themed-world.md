# Open plan: themed worlds for run videos (humanization phase 4)

**Status:** parked. Last phase of video humanization: do it after phases
1 (characters), 5 (recurring cast), 3 (narrator and series identity) and 2
(data-driven atmosphere). Evaluate strategies carefully and apply them in
parts. Nothing here is decided until it moves to `video/DIRECTION.md`.

## Goal
Show a run in a world the general audience understands. For example,
`power-struggle` becomes "five people in a spaceship must survive 50 days,
with only 4 oxygen capsules": a ship layout, rooms and people instead of a
grid of dots. The underlying run stays exactly the same.

## Fixed constraints (already decided)
- **Presentation only.** Scenarios, prompts and experiments stay abstract;
  any existing run can be rendered in any compatible theme without being
  rerun (README §21, "Option A").
- The narrator says the people are AI agents represented as humans, and
  introduces the glossary.
- **Dialogue stays verbatim.** Agents will say "battery", so the theme shows
  an on-screen glossary (battery = oxygen capsule) instead of rewriting
  words.
- A theme changes how events look, never what happened. Expressions and
  atmosphere map to observable state, never to inferred feelings.
- Everything stays generic: no build code keyed on a run, scenario or
  agent id. A theme is data (config and assets) consumed by `build.mjs`.

## Why it is the most expensive phase
- **Art per scenario:** layout, rooms, cell-type visuals, glossary.
- **Maps change:** `power-struggle` already went 7x7 → 5x5 → 4x4, so art
  drawn for one size breaks on the next.
- **Coherent movement:** characters walking between rooms, with doors and
  walls that match the matrix.
- **It repeats:** every new scenario needs its own world.

## Strategy options (to evaluate)
| Strategy | How | Pros | Cons |
|---|---|---|---|
| **A. Hand-drawn layout** | One illustrated map per scenario/size; cells mapped to pixel regions | Best look | Breaks when the map changes; most art per theme |
| **B. Procedural from the matrix** | Each cell becomes a module (floor, wall, item) drawn from a tile kit; rooms named automatically; walls drawn from cell edges | Any map size; cheap new scenarios; consistent | Can look "gamey"; needs a good kit |
| **C. Hybrid** | Procedural layout plus hand-made hero assets (backdrop, a few landmark rooms, props) | Good look at moderate cost | Two systems to keep in sync |

Initial leaning: **B, possibly growing into C.** It needs validating with a
prototype before committing.

## Parts (apply one at a time; each must be useful on its own)
1. **Vocabulary layer:** a theme file with the glossary (state fields,
   actions, cell types, turn → day), used by labels, panel, callouts and the
   narrator; on-screen glossary card. *No new art. Validates the honest
   framing with the audience.*
2. **Tile kit + procedural board:** replace the grid with themed modules
   generated from the matrix (floor or corridor, wall or machinery,
   battery/capsule on the ground). Agents are still tokens or portraits from
   phase 1.
3. **Room naming and landmarks:** deterministic names per cell or region
   (e.g. "Bridge", "Airlock") and optional landmark assets; used by
   narration ("in the galley…").
4. **Movement and staging:** walking animation between cells, doors, camera
   moves that follow the theme; shutdown visuals in theme ("cryo pod").
5. **Second theme / second scenario:** prove the system is generic (e.g.
   the same run as "miners trapped underground", or a new scenario).

## Open questions
- Which art source? AI-generated images (consistency, license, style
  drift), icon/tile packs (license, coverage), or commissioned art.
- Is the style top-down 2D, isometric, or flat illustrated? It decides
  everything about the kit.
- Should rooms carry meaning (e.g. the item spawn room), or stay purely
  decorative?
- How do shared cells (several agents) and items on the ground look in
  theme?
- Is the glossary card enough for verbatim dialogue full of lab terms, or
  do themed episodes also need on-screen subtitles that translate terms,
  explicitly labeled as translation?
- Does the narrator mention theme terms only, or both ("capsule — a
  battery in the lab")?
- Which scenarios get themes, and when is it worth it (enough episodes of
  one scenario)?

## How to evaluate before committing
- Prototype part 2 on two different map sizes of the same run, and compare
  readability against the current board (review sheets via
  `video/review.mjs`).
- Criteria:
  - a viewer can follow who is where and what happened;
  - no rule in `video/DIRECTION.md` §1 is weakened;
  - the cost of adding a theme is under ~1 day once the kit exists.

## Done means
At least one scenario renders in a theme, from any run, with no
scenario-specific build code. The decisions made along the way are recorded
in `video/DIRECTION.md`, and this plan is updated or closed.
