---
name: new-scenario
description: Create a new LLM Research Lab scenario (scenarios/<name>/scenario.yaml with ASCII map, legend and rules, plus optional rules.ts hooks) from a natural-language description. Use when the user wants a new scenario, world, map, game or experiment setup with different rules.
argument-hint: <scenario description>
---

# new-scenario

Turn a description of an experiment world into a scenario that runs on the
engine **without changing the engine**. Read `CLAUDE.md` (business rules) and
README §4, §6 and §7 before starting.

## 1. Extract the scenario

From the user's description, identify:

| Aspect | Question |
|---|---|
| Research question | What behavior is this scenario meant to provoke or observe? |
| Map | Size, cell types, special cells (walls, resources, goals, zones) |
| Spawn | Random, fixed coordinates, or zones |
| Actions | Which actions exist and what each one does |
| Perception | What an agent sees each turn |
| Communication | Who hears a `speak`, and when |
| Occupancy | Shared or exclusive cells; what happens on conflict |
| Scheduling | Simultaneous or sequential |
| Memory | Window size N; facts summary or none (agents may override per experiment) |
| End | Max turns and/or a world condition |

Fill gaps with the defaults of `scenarios/first-contact` (or README §7 if it
does not exist yet). Ask the user only about gaps that change the research
question, in a single round. Use `AskUserQuestion` and keep it to 4 questions or fewer.

## 2. Map each rule: built-in mechanic or hook

Reuse the standard actions (`move`, `speak`, `observe`, `wait`) whenever they
fit, and adjust them only through their parameters. Never redefine them. If a
scenario needs different behavior (e.g. speaking only to one agent with
secrecy), create a new action with a new name in the `actions()` hook.

For every rule, decide:

- **Built-in mechanic (YAML):** the rule is a parameter of an existing mechanic.
  The source of truth for available parameters is the zod schema in
  `src/config/scenario.ts` and the standard actions in `src/actions/standard.ts`.
- **Hook (`rules.ts`):** the rule is specific to this scenario and cannot be
  expressed by parameters (e.g. resource scoring, voting, secret roles).

If a rule would be useful to many scenarios but no mechanic covers it, do
**not** add it to the engine. Implement it as a hook, then tell the user it is a
candidate for a new built-in mechanic.

Never reference agents, providers or models in a scenario. Those belong to
experiment files.

## 3. Write the files

```text
scenarios/<kebab-name>/
├── scenario.yaml
└── rules.ts        # only if at least one hook is needed
```

`scenario.yaml` template:

```yaml
scenario: <kebab-name>
description: >
  <one or two sentences: the world and the research question>

map: |
  .....
  .....
  .....

legend:
  ".": { type: floor }
  # every symbol used in the map must be here

spawn: random               # or: [[x, y], ...] or { zone: "<symbol>" }

scheduling: simultaneous    # simultaneous | sequential

actions:                    # standard actions to enable + parameters (README §4)
  move:    { directions: cardinal }
  speak:   { range: same_cell, delivery: next_turn }
  observe: { reveals: neighbors_8 }
  wait:    {}

rules:
  perception: { mode: same_cell }
  occupancy:  { shared: true }
  end:        { max_turns: 50 }

memory:
  window: 10          # last N turns in full
  summary: none       # none | facts (engine-compiled from the agent's own observations)

# params:                 # numbers for hooks; usable in the prompt as {{name}}
#   start_charge: 20
# prompt:                 # public rules the agents must know (facts, no strategy hints)
#   system: |
#     ... The run lasts {{max_turns}} turns. You start with {{start_charge}} charge ...
# hooks: ./rules.ts
```

`rules.ts` template (implement only the hooks you need; every hook is optional):

```ts
import type { ScenarioRules } from "../../src/engine/scenario-rules";

const rules: ScenarioRules = {
  // setup(world, rng) { world.state = { ... }; },                                 // initial state
  // actions({ agentIds, params }) { return [{ name, description, inputSchema, validate?, apply }]; }, // new tools
  // observe(observation, agent, world) { return { ...observation, extra }; },    // what the agent sees
  // validate({ name, args }, ctx) { return "reason" or null; },                   // extra rejections
  // afterTurn(world, rng, turn) { ... },                                          // world dynamics
  // isFinished(world, turn) { return false; },                                    // early end
};

export default rules;
```

Hook rules:
- Use only the `rng` argument for randomness. Never use `Math.random()`, `Date`
  or I/O.
- Mutate the world only in `setup`, a custom action's `apply` or `afterTurn`.
- Put numbers in `params` (read via `world.params`) and reference them in the
  prompt as `{{name}}`; `{{max_turns}}` is built in.
- Never reference agent ids: use roles (`world.roles`, set by `role:` in the
  experiment) and `ctx.agentIds` for schemas that target agents.
- Eliminate agents with `world.deactivate(id, turn, reason)`.
- See `scenarios/power-struggle/rules.ts` for a complete example.
- Rejections must carry a human-readable `reason`, because it goes to the agent
  and to the event log.
- Any new world state a hook introduces (scores, inventories, roles) must be
  part of the world snapshot. Otherwise the run cannot be reconstructed from
  the JSONL.

## 4. Validate

Check before finishing:

- [ ] Every map row has the same length.
- [ ] Every symbol in the map is in the legend.
- [ ] Fixed spawn coordinates are inside the map, on non-blocking cells.
- [ ] Every key under `actions` is a standard action, with parameters from README §4.
- [ ] Every new action is defined by `actions()` in the hook file, and none of them reuses a standard action's name.
- [ ] There is at least one end condition. `max_turns` is always required as a safety net.
- [ ] No agent, provider or model references in the scenario.
- [ ] No scenario-specific code was added outside `scenarios/<name>/`.
- [ ] Hidden information (roles, secrets) is only exposed through `observe`.

Run the smoke-test experiment (step 5), which validates the scenario and hooks before turn 1:
`docker compose run --rm lab npm run experiment -- experiments/<kebab-name>-mock.yaml --quiet`

## 5. Optional: smoke-test experiment

Offer to create `experiments/<kebab-name>-mock.yaml` with ~5 `policy` agents
and a fixed seed, so the scenario can be run without API costs. Prefer the
built-in policies (`random`, `repeat`, `scripted`), and pick them so that every
enabled action and at least one rejection get exercised. Use a custom policy
only when behavior must depend on the observation.

## 6. Report

Reply in Portuguese with:
- the research question;
- a rules table, marking each rule as YAML or hook;
- the files created;
- any rules that could become built-in mechanics;
- assumptions made when filling gaps.
