---
name: video-direction
description: Render, review and adjust an LLM Research Lab run video (HyperFrames) following the house style in video/DIRECTION.md, and record every new direction decision there. Use when the user wants a video of a run, wants to fix or improve how a video looks or moves, or reviews a rendered episode.
argument-hint: <story.json | script.resolved.json | production folder>
---

# video-direction

How we direct run videos. **`video/DIRECTION.md` is the source of truth**
for the style and the rules: read it fully before changing anything. This
skill is the procedure; it does not repeat the rules.

For a full YouTube episode (script, approval, copy), use the
`youtube-episode` skill. This skill is the video part of it, and it also
works on its own.

## 0. Inputs
- **Automatic story:** `docker compose run --rm lab npm run -s story -- <exp>/<run> [--scenes N]`
  writes `video/build/<exp>-<run>/story.json`.
- **Written script:** `script.json` checked with
  `docker compose run --rm lab npm run -s script:check -- <folder>/script.json`,
  which writes `script.resolved.json`. Never edit the resolved file by hand.
- **Optional direction overrides:** `direction.json` next to the input
  (DIRECTION.md §9): `panel`, `camera`, `pace`, `transition` per scene id.

## 1. Draft render
```bash
docker compose --profile video build video      # once / after video/ changes
docker compose --profile video run --rm video node /app/video/build.mjs /app/<folder>/<input>.json --quality draft
```
The build prints each card (id, kind, turn, start, duration) and writes
`timeline.json`.

## 2. Review
```bash
docker compose --profile video run --rm video node /app/video/review.mjs /app/<folder> [--at 29.5,112]
```
This writes `review/sheet-NN.png` (start, middle and end of every card, each
labeled with card and time) and `review/index.txt`. Use `--at` to add the
moments that matter: each dialogue, shutdown and callout. Read the sheets.

Check, at least:
- [ ] **Legibility:** no text over text (narration vs panel or chart, title
      vs logline), nothing cut at the frame or viewport edge.
- [ ] **Layout mode:** side mode (panel) only where DIRECTION.md §3 allows
      it; dialogue and drama on the stage.
- [ ] **Turn time:** the scene opens on the start of its turn; moves,
      shutdowns and state changes come after the speeches (§4).
- [ ] **Attribution:** callouts sit on the acting agent and name it;
      rejected attempts are grey; listeners are ringed.
- [ ] **Camera:** close-ups frame speaker and listeners; tokens are readable
      (a wide camera next to the panel makes them tiny).
- [ ] **Pacing:** big moments breathe, filler is tight, no dead air at the
      end of a card.
- [ ] **Integrity:** dialogue verbatim with "heard by", and the footer names
      the narration source (§1).

## 3. Fix, in this order
1. **`direction.json`** for this video only (panel, camera, pace,
   transition). Re-render the draft and review again; stop after about 3
   rounds.
2. **`video/build.mjs`** only for a problem that would happen in any video.
   Make the change general (never keyed on a run, scenario or agent id),
   then re-render this video and one other input, and review both.
3. If you are acting as a sub-agent that must not edit `build.mjs` (e.g. the
   `video-director` agent), write the problem and the proposed rule under
   **DIRECTION.md §8 "Proposed adjustments"** instead.

## 4. Final render and verification
```bash
docker compose --profile video run --rm video node /app/video/build.mjs /app/<folder>/<input>.json --quality looks
```
Verify the file, not the log:
- `ffprobe` video and audio durations ≈ `timeline.json` `total_seconds`;
- `ffmpeg -af volumedetect` shows the audio is not silent;
- `hyperframes lint` reports 0 errors. Contrast warnings on dimmed
  elements are accepted.

## 5. Record the decision (mandatory)
Every adjustment that changed how videos look or move goes into
`video/DIRECTION.md`:
- a new rule → the matching section (§3 layout, §4 motion, §5 voices,
  §6 HyperFrames lessons, §7 review);
- an adopted proposal → move it from §8 to "Adopted", with the date and the
  run where it was seen;
- a known issue you chose not to fix → the "Known minor issues" line.

Tell the user what you changed, show one review sheet of the result, and
give the video path.
