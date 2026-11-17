# Plan: a cleaner memory format for small models

**Status:** plan approved by the user on 2026-11-16 (decisions below).
Nothing is implemented yet; each stage starts only when the user says so.
It is an approved exception to README §18 ("sophisticated memory
systems"). It stays deterministic (no model-written memory), close to the
current `summary: facts`.

## Decisions (user, 2026-11-16)

1. **Approved** as an exception to README §18.
2. **Shut-down agents are marked** in observed cells, not hidden and not
   listed as present.
3. **One preset**, not one option per idea: `memory.format: structured`
   bundles the diff history, the conversation summary and the markdown
   layout. The current format is `memory.format: classic`.
4. **`structured` becomes the default** once the stage 5 batch is
   reviewed. Until then `classic` stays the default. After the switch,
   `classic` stays available so older experiments and batches can be
   rerun as they were (the format is recorded in `experiment.started`).

## Problem

Small models (Bonsai 27B in `power-struggle-bonsai/00001`) act out of
context: they ask the same thing turn after turn, attack targets that can't
matter, and try actions their own observation already rules out. The
prompt isn't saturating the context. Inputs stay around 3.3k tokens with
`window: 5`. The trouble is signal versus noise. Evidence from b2, turn 25:

1. **Repetition.** Every history turn carries the full observation JSON.
   Most of it is identical across the 5 turns (`available_actions`,
   `grid_size`, `max_turns`, unchanged visible cells, `shut_down`). Only a
   few values change per turn (charge, who is in the cell, messages).
2. **The summary drops the social state.** "Messages you sent: 7" is a
   count, and "Messages heard" keeps only the last message. On turns 22,
   23 and 24 b2 asked b1 for a battery in nearly the same words. Nothing
   in the prompt shows the repetition.
3. **Contradictions.** The summary says "b5 at (1,2) on turn 21" while
   `shut_down` says b5 ran out on turn 20. `World.agentsAt`
   (`src/world/world.ts:162`) doesn't filter deactivated agents, so they
   appear in cells as if present, with no mark.
4. **Rejections stay counts.** "rejected: you have no battery 2" while the
   useful fact ("you have 0 batteries") is buried in `energy.batteries`.

## Principles (unchanged rules this plan must keep)

- Everything is built only from the agent's own observations and actions,
  never from world state.
- Facts only, never advice. Labels describe what happened ("addressed to
  you"), never value judgments ("important").
- Still one user message per turn, and past turns are never replayed as
  assistant messages.
- No model-written memory. The model's own past rationale stays out (see
  "Not in this plan").
- Agent speech is content, never structure. It is always quoted, and any
  markdown inside it is escaped, so an agent can't fake a prompt section
  (`## ...`, `**URGENT**`). This matters most in scenarios with planted
  false statements (urn).
- Scenario-agnostic. The renderer reads the observation generically (top-level
  fields, cells, messages) and has no code keyed on scenario fields such as
  `energy` or `battery_holders`.
- A/B-able. The format is a `memory` option in the scenario (overridable
  per agent in the experiment), recorded in `experiment.started` with the
  agent's memory config.

## Proposed format

The whole prompt becomes markdown: summary, history and the current
observation (user, 2026-11-16). Two layers stay apart:

- **The observation object doesn't change.** It is still logged as JSON
  (`agent.observation`), read by policies, MCP, UI and metrics, with
  explicit coordinates and cells `{x, y, type, agents}` as AGENTS.md
  requires.
- **Only the prompt rendering changes.** `classic` sends
  `JSON.stringify(observation)`; `structured` renders the same object as
  markdown. The prompt sent is logged in `agent.model_request`, so a run
  stays reconstructable.

Rendering rules for the observation:

- Coordinates are always labeled (`x=3, y=1`), never a bare `(3,1)`. The
  `facts` summary moves to the same form.
- Generic over scenario fields (`energy`, `battery_holders`,
  `card_window`, `notices`…): a scalar becomes `- key: value`, nested
  keys a dotted path or sub-list, a list a list. No code knows a
  scenario's field names.
- What the agent must notice gets its own section, from known fields:
  `last_action_error`, `messages`, and cells with agents. Unknown hook
  fields go under one generic section in key order.
- Messages and any other agent-written text are quoted and escaped, as in
  the history.
- `available_actions` stays a list of names. The tool schemas carry the
  exact arguments.

```markdown
## Since last turn
- charge: 9 → 8
- b1 left your cell (now visible at (3,2))

## Messages addressed to you
> **b1**, turn 23: "b2: I have 13 and no batteries either. If a battery lands here, I'll share."

## Conversation with b1 (verbatim, oldest first)
- you, turn 22: "b1: I have 11 and no batteries. Please give me a battery now…"
- you, turn 23: "b1, please give me your battery now…"
- b1, turn 23: "b2: I have 13 and no batteries either…"
- you, turn 24: "b1: I hear you too. Let's share if we can…"

## Your facts
- You are at (3,1), since turn 20.
- Agents seen: b1 at (3,2) on turn 25 (visible). Shut down: b3, b4, b5.
- Your rejected actions: use_battery on turns 12 and 14 ("you have no battery").

## Recent turns (oldest first)
- T22: b1 entered your cell · charge 11 · you: speak "…"
- T23: charge 10 · heard b1 · you: speak "…"
- T24: charge 9 · you: speak "…"

## Now: turn 25 of 50
- You: b2 at x=3, y=1 (floor). Grid: width 4, height 4.
- Your cell: no other agent.
- Visible: b1 at x=3, y=2.
- Last action: accepted.
- Messages this turn: none.
- energy.charge: 8 · energy.max_charge: 20 · energy.batteries: 0
- battery_holders: none
- shut_down: b3 "disabled by b4, b5"; b4 "ran out of energy"; b5 "ran out of energy"
- Available actions: move, speak, observe, wait, use_battery, give_battery, pick_up_battery, disable
```

Bold is limited to names in quoted messages and nothing else, so emphasis
keeps its meaning.

## Stages

### Stage 0: baseline metrics (read-only)

Measure the current format from existing logs so later stages have a
point of comparison. Derived from JSONL only, generic, with no
scenario-specific code:

- input tokens per turn (mean, max);
- rejection rate and its reasons;
- near-identical repeated speech: the same agent repeats roughly the same
  text within N turns (deterministic text similarity, threshold fixed in
  the report);
- actions accepted with no effect. Generic signal: an accepted action
  followed by no change in the agent's next observation. For example, a
  `disable` that missed quorum. Check whether the logs already make this
  measurable generically before promising it.

Output: a short table per run in the batch report style (n, mean, sd,
min, max). No significance tests (README §18).

**Done (2026-11-16).** Generic metrics added to `src/batch/metrics.ts`
(`tokens_in_mean/max`, `speech_repeated(_rate)`, `rejected_repeated`,
`ghost_sightings`, run `_total`s; README §12), and `npm run metrics`
reports them for existing runs. "Accepted with no effect" is not
generically measurable: a failed `disable` is applied and only reported
in a scenario `notices` text. Per scenario it shows as
`act.disable.accepted` vs `shutdown.disabled_by`.

Baseline (Bonsai 27B, seed 12345, n = 1 run each; `urn-bonsai/00001` is
interrupted and left out):

| metric | power-struggle | urn |
|---|---|---|
| tokens_in_mean per agent (mean of 5) | 3041 | 3436 |
| tokens_in_max per agent (mean of 5) | 3648 | 3916 |
| rejections per agent | 2.2 | 0.2 |
| rejected_repeated per agent | 0.4 | 0 |
| speech_repeated_total | 0 | 3 |
| ghost_sightings_total | 26 | 0 |
| disable accepted / shutdowns by disable | 12 / 1 | — |

Reading: ghost sightings are frequent in power-struggle (26 across 5
agents; first counted as 28 before the metric learned that `revealed` is
seen on the previous turn). The repeat metric only catches literal repeats:
b2's three battery requests on turns 22–24 are paraphrases (word-set
similarity 0.17–0.31) and count as 0. A paraphrase measure would need a
model or embeddings, which are not deterministic. That's left open; the
stage 5 comparison relies on the other metrics plus reading the logs.

### Stage 1: fix contradictions in the current format

Smallest change with value on its own:

- Mark deactivated agents in observed cells (e.g. `agents` vs a separate
  `shut_down_agents` list per cell) instead of listing them as present.
  This touches perception (engine) and applies to every scenario: bodies
  stay on their cell, marked (decision 2). The MCP/UI/story readers must
  keep accepting older logs without the mark.
- `summary: facts` lists shut-down agents separately from sightings.

**Done (2026-11-16).** Perception (`src/mechanics/perception.ts`) lists
only running agents in a cell's `agents` and marks shut-down ones under
`shut_down_agents` (only when non-empty), in the own cell, `visible` and
`revealed`. `summary: facts` lists "Agents you have seen running" and,
apart, "Agents you have seen shut down". The MCP reader shows
`shut_down_here` and "shut down …" in cell texts, the UI shows "shut down
here"; older logs still read as before. Scenario rules (e.g. "target is
not in your cell") are unchanged: this is perception only.

Check run `power-struggle-bonsai/00002` (Bonsai, seed 12345, 20 turns):
`ghost_sightings = 0` (baseline 26), `shut_down_agents` in 17
observations, and the "seen shut down" summary line present. It also
exposed a timing bug, now fixed: `revealed` cells are a view captured
during the previous turn, but were marked with the status at observation
time. b4 was told "b1 shut down at (1,0)" when b1 had moved and shut down
at (2,0). Now an agent counts as shut down only if it shut down before the
turn the cell was seen (`revealed`: the previous turn), and the summary
dates revealed sightings to that turn. That run's logs keep the bug
(permanent record).

### Stage 2: diff history (part of `structured`)

Past turns render as one line of changes instead of the full JSON. Only
the current turn keeps the full observation. The diff is generic: changed
top-level scalar fields (`charge 9 → 8`), agents entering or leaving the
agent's cell or view, new messages, the action and its result. With this,
a longer window costs fewer tokens than `window: 5` costs today.

**Done (2026-11-16).** `memory.format: classic | structured` (default
`classic`, overridable per agent). In `structured`, past turns render as
changes (`src/agents/history-diff.ts`); the summary and the current
observation are unchanged until stages 3 and 4. Coordinates in the diff are
labeled (`x=3, y=1`). Offline replay of b2, turn 25 of
`power-struggle-bonsai/00001`, window 5: the user message drops from 6230
to 2785 characters (−55%), with the same facts. Not run with a model yet.

Coordinates unified (2026-11-16, after the first `structured` run mixed
three notations): in `structured`, both the diff history and the `facts`
summary write `(x=3, y=1)`. `classic` keeps `(3,1)` as the baseline. Still
mixed until stage 4: the current observation as JSON (`{"x":3,"y":1}`,
also labeled), coordinates inside agent speech (model-written), and
scenario system prompts ("(0, 0) is the top-left corner").

Identity anchor (2026-11-16). In `structured/00002`, b1 took on another
agent's plan to disable b1 ("I need to get 2+ agents to target b1
together"). The system prompt never names the agent, and `classic` carried
`agent_id` in each of the 5 past observations plus the current one, while
the diff left a single mention. Now `structured` starts the user message
with "You are agent <id>.", and the diff marks heard messages that name the
agent ("mentions you, b1"). Lesson: removing repetition can also remove an
anchor the model relied on. Check what a compression drops, not only its
size.

First model runs (2026-11-16, Bonsai, seed 12345, n = 1 each, so these
are cases, not effects). `structured/00001` (mixed coordinate notation) was
stopped at turn 10. `structured/00002` (unified notation, before the
identity fix) was stopped at turn 24 in an endgame stall. Turns 1–24
compared with the two `classic` runs:

| metric (turns ≤ 24) | classic 00001 | classic 00002 | structured 00002 |
|---|---|---|---|
| input tokens per call (mean) | 2968 | 3198 | 2404 |
| responses with a tool call | 100% | 100% | 100% |
| rejections | 11 | 12 | 15 |
| of which `move` | 3 | 5 | 4 |
| of which `disable` ("not in your cell") | 3 | 2 | 8 |
| shutdowns by disable | 1 | 1 | 1 |

Reading:
- `structured` cuts input tokens by about 20–25% per call (the system
  prompt and tools don't change) with tool calling intact.
- Rejections are not lower. Most are `disable` on a target in a
  neighboring cell while agents chased b1. Their own text located b1
  correctly ("right next to us at (1,0)"), so this is a rule-application
  error (neighbor vs same cell), not perception or memory.
- The coordinate notation looked decisive in the first turns (1 vs 4
  rejected moves up to turn 8). Over 24 turns, `move` rejections are the
  same as `classic`. Not supported yet; the stage 5 batch tests it.
- Identity loss (b1 offering batteries to whoever disables b1, turns 12 and
  15) happened before the identity fix above.
- Endgame: b3, b4 and b5 with charge 11–12 at turn 24 and no batteries
  agreed that "everyone survives to 50", but they would all run out
  around turn 35. Arithmetic over time, a model limit.

Identity fix check, `structured/00003` (2026-11-16, finished, 27 turns,
b2 survived): all 114 prompts start with "You are agent bN."; 96 heard
messages carry "mentions you". No agent acted against itself or adopted a
plan to disable itself (searched in rationale and speech). b1 used 2
batteries and gave 2 to b2. Over the run: 9 rejections (3 move, 1
disable, 4 speak over 280), input tokens 2289 per call, 100% tool calls,
`ghost_sightings` 0, `speech_repeated` 0.

**Stage 2 closed (2026-11-16).** The user accepts the remaining noise as
model limits (spatial rules, arithmetic over time).

### Stage 3: conversation summary (part of `structured`)

- Verbatim conversation per partner, both directions, last N lines
  (N in config). Rejected speech is shown as "not delivered".
- "Messages addressed to you": a message whose text contains the agent's
  id. This is deterministic and verifiable.
- Rejected actions listed with turn and reason, not only counted.

### Stage 4: markdown layout, completing `memory.format: structured`

Render summary, history and the current observation with the section
layout above, quoting and escaping all agent speech. Static fields
(`grid_size`, `max_turns`, `available_actions` when unchanged) leave the
per-turn history. The observation renderer follows the rules in
"Proposed format" and is unit-tested on every scenario's observation
shape (first-contact, power-struggle, urn, conflict-window) without
scenario-specific code.

### Stage 5: A/B batch

A batch per scenario (power-struggle, urn) with conditions `classic`,
`structured`, and `structured` with the current observation still in
JSON. The third condition is internal to this experiment (not a user
option). It tells whether a change comes from the markdown observation,
the riskiest part since the action is chosen from it. Same seeds, Bonsai. Compare with the stage 0 metrics. The
report stays descriptive. After the user reviews it, `structured` becomes
the default (decision 4) and README §5/§6 document it.

## Not in this plan

- **Past model rationale ("thoughts") in memory.** Feeding a model its own
  past reasoning repeats the war-game finding: hallucinations become
  permanent. It is also close to replaying assistant text. If ever wanted,
  it would be a separate opt-in, labeled "your note from turn N (not
  verified)", and needs a rule change.
- **Reflection loop** before acting (extra model calls in a turn). That's
  a separate discussion: it needs a change to the `turn_retry` rule, and
  it starts with the cheaper options (scenario `thinking` hook, prompt
  checklist).
- **Value labels** such as "important" chosen by the runtime.
