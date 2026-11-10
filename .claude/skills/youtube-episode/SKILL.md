---
name: youtube-episode
description: Produce a 3-6 minute YouTube episode (video + copy) from an LLM Research Lab run, with three agents - content-strategist (script), video-director (render), copywriter (title, description, chapters). Use when the user wants a YouTube video, episode or package from a simulated run.
argument-hint: <experiment_id>/<run_id>
---

# youtube-episode

Orchestrates three project agents (`.claude/agents/`) to turn one run log
into an English YouTube episode:

```
content-strategist → [fact-check gate] → USER APPROVAL → video-director → copywriter
   brief.md, script.json      facts.md                       episode.mp4,     youtube.md
                                                             timeline.json
```

Everything lives in `video/productions/<experiment_id>-<run_id>/`, which is
gitignored. Never upload anything: the user publishes.

Non-negotiable (see CLAUDE.md "Run videos" and `video/DIRECTION.md` §1):
dialogue is verbatim (quotes are `event_id` references resolved from the
log), narration is factual, and the agents are presented as AI agents.

## 0. Preconditions
- The run exists: `mcp__lab-observer__list_runs`, or
  `ls events/<experiment_id>/<run_id>.jsonl`. If the run is still
  `running`, ask the user before continuing.
- The video image exists: `docker compose --profile video build video`
  (fast when cached).
- `slug = <experiment_id>-<run_id>`; create `video/productions/<slug>/`.

## 1. Script: content-strategist
Spawn the `content-strategist` agent. Give it the run reference, the
production folder, the target (English, 3–6 min, cold open allowed) and any
user notes. Wait for its report.

## 2. Fact-check gate (you, not an agent)
1. Run `docker compose run --rm lab npm run -s script:check -- video/productions/<slug>/script.json`.
   It must pass with no errors. It writes `script.resolved.json` and
   `facts.md`.
2. Read `facts.md` and check **every NARRATION line** against the FACTS of
   its scene. Typical errors:
   - an attempt described as a success, or the reverse;
   - who said what to whom swapped;
   - numbers or positions that are not in the facts;
   - motives presented as facts.
3. If anything is wrong, send precise corrections to the strategist
   (SendMessage, or spawn it again with the notes) and repeat. Stop after 3
   rounds and show the user what remains.

## 3. User approval (required)
Show the user, concisely:
- title, logline and estimated length;
- the scene list: id, turn, out-of-order flag, narration lines, quotes
  (speaker → listeners, first words);
- `script:check` warnings and anything the gate corrected.

Ask for approval (AskUserQuestion: approve / request changes). Do not
render before approval. Relay requested changes to the strategist, then
repeat steps 2–3.

## 4. Video: video-director
Spawn the `video-director` agent with the production folder. It writes
`direction.json`, renders drafts, reviews frames, and delivers
`episode.mp4`, `timeline.json` and `direction-notes.md`. Afterwards,
verify it yourself: `episode.mp4` exists, and ffprobe video and audio
durations match `timeline.json` `total_seconds` (±0.5 s).

## 5. Copy: copywriter
Spawn the `copywriter` agent with the production folder. Then check
`youtube.md` yourself:
- chapters start at `0:00`, there are at least 3, each ≥ 10 s, and they
  match `timeline.json`;
- no claim contradicts `facts.md`;
- the transparency block is present.

## 6. Report to the user
- The full paths of `episode.mp4` and `youtube.md`, the duration and the
  recommended title.
- The chapter list.
- Proposals the director added to `video/DIRECTION.md` §8 (ask whether to
  adopt them).
- A reminder to watch the episode before publishing. Nothing was uploaded.

## Cost note
The three agents run on the Claude Code model. Each episode spends tokens
roughly proportional to the run log size and the number of review rounds.
Rendering is local and free.
