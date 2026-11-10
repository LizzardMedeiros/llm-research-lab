# LLM Research Lab

> Proof of Concept — Controlled Multi-Agent LLM Experimentation Environment

A lightweight experimental environment for running controlled experiments with
multiple LLM agents, observing their interactions, recording structured events,
and using an independent LLM observer to analyze experiments in real time.

The primary goal is **not** to build a production-ready multi-agent framework.

The goal is to build the smallest controllable laboratory capable of answering:

> Can we define a controlled environment, connect multiple LLM agents, observe
> their behavior through structured events, and have another LLM analyze the
> experiment through MCP?

---

## 1. Motivation

Experimenting with multi-agent LLM systems usually requires building a
significant amount of application-specific infrastructure before the actual
experiment can even begin.

This project explores a different approach.

Instead of implementing a complete game, simulation, or application for every
experiment, we provide a small experimental engine where:

- scenarios define the world and its rules;
- agents interact with the world;
- LLM providers can be swapped;
- actions and state transitions are recorded;
- experiments are configured declaratively;
- an observer agent can inspect the experiment through MCP.

The lab is **not tied to any single experiment**. Rules and environments must
be easy to edit. Only a small set of core mechanics is standardized by the
engine (see [§4](#4-engine-mechanics-vs-scenario-rules)).

The same infrastructure should eventually support experiments such as:

- social deduction;
- cooperation and competition;
- negotiation;
- moral dilemmas;
- incomplete information;
- tool-use experiments;
- multi-agent decision making;
- human-vs-agent experiments.

For the POC, however, the scope is intentionally much smaller.

---

# 2. POC Goals

The POC must demonstrate six capabilities:

### 1. Controlled Environment

A deterministic environment where agents cannot directly modify the world.

### 2. Multiple Agents

Support approximately five simultaneous agents.

### 3. Multiple LLM Providers

Agents can use different providers without changing the experiment engine.

POC providers:

```text
anthropic  → Claude models via the official SDK
ollama     → local models via the native Ollama API
policy     → rule-based agents (no LLM): tests, baselines, control groups
mock       → internal, for engine unit tests
```

Other providers (OpenAI, Deepseek, OpenAI-compatible endpoints, …) are future
additions behind the same interface.

### 4. Structured Observability

Every relevant interaction produces a structured event.

### 5. Real-Time Observation

A researcher can observe the experiment while it is running.

### 6. Observer Agent

A separate LLM can inspect the experiment through MCP and produce analysis
without participating in the experiment itself.

---

# 3. Architecture

The POC uses a modular monolithic architecture.

```text
   ┌──────────────┐        ┌──────────────────────┐
   │  Researcher  │◄─SSE───│    Experiment API    │
   │      UI      │        └──────────┬───────────┘
   └──────────────┘                   │
                                      ▼
                          ┌──────────────────────┐
                          │   Experiment Engine  │
                          │                      │
                          │  Turn loop           │
                          │  Agents              │
                          │  World (matrix)      │
                          │  Scenario rules      │
                          └──────────┬───────────┘
                                     │
                 ┌───────────────────┼──────────────────┐
                 ▼                   ▼                  ▼
           LLM Providers       Scenario files      Event Log
           ├─ Anthropic        (YAML + TS hooks)   (JSONL)
           ├─ Ollama                                    │
           └─ Mock                                      ▼
                                              MCP Server (stdio,
                                              read-only, separate
                                              process)
                                                        │
                                                        ▼
                                              Observer Agent
                                              (any MCP client)
```

The architecture should remain simple.

Do **not** introduce microservices during the POC.

---

# 4. Engine Mechanics vs. Scenario Rules

This is the central design decision of the lab.

## Fixed by the engine

These mechanics are standardized and shared by every scenario:

| Mechanic | Definition |
|---|---|
| **World is a matrix** | Every scenario is a 2D grid of cells addressed by `(x, y)`. Cells have a type and attributes. Agents occupy cells. |
| **Turn loop** | `observation → LLM → action → validate → apply → events`. |
| **Actions are tools** | Every action is exposed to the LLM as a tool (tool calling). |
| **Standard actions** | `move`, `speak`, `observe` and `wait` are built into the engine with fixed semantics and tool schemas, reusable by any scenario (see below). |
| **Policy agents** | Rule-based agents (no LLM) receive the same observation and tools as LLM agents; the engine treats both identically. |
| **Environment owns reality** | Agents only propose actions; the environment validates and applies them. |
| **Rejected actions** | An invalid action (unknown, malformed, out of bounds, provider error) becomes `wait`, emits `environment.action_rejected` with the reason, and the reason appears in the agent's next observation. |
| **Event envelope** | Stable event schema persisted as JSONL. |
| **Provider interface** | A single interface for all LLM providers. |
| **Seeded randomness** | All environment randomness comes from a seeded RNG. |
| **Frozen rules per run** | Rules are resolved at start, recorded in `experiment.started`, and never change during a run. |
| **Read-only observation** | The MCP server only reads the event log. |

## Editable per scenario

Everything else is a scenario rule:

- matrix size and layout, cell types and their attributes;
- spawn positions;
- which standard actions are enabled and their parameters;
- new scenario-specific actions (via hooks);
- perception (what an agent can see);
- cell occupancy (shared or exclusive);
- scheduling (simultaneous or sequential);
- agent memory window;
- end conditions;
- prompts.

## Standard actions

The basic actions are part of the engine so every experiment speaks the same
language. Their tool schema and semantics never change between scenarios; a
scenario only enables them and sets their parameters.

| Action | Tool arguments | Semantics | Scenario parameters |
|---|---|---|---|
| `move` | `direction` | Move one cell. Rejected by borders, cells with `blocks_movement`, or the occupancy rule. | `directions: cardinal \| eight` |
| `speak` | `text` | Deliver a message to agents within range. | `range: same_cell \| radius:<n> \| global`, `delivery: next_turn`, `max_length` |
| `observe` | — | Spend the turn to perceive beyond the normal perception. | `reveals: neighbors_8 \| radius:<n>` |
| `wait` | — | Do nothing. Also the result of any rejected action. | — |

Scenarios add new actions (e.g. `vote`, `trade`, `pick_up`) through the
`actions()` hook. They must not redefine a standard action; a different
behavior gets a different name.

## How rules are written: hybrid model

1. **Built-in mechanics, parameterized in YAML.** Standard actions and common
   rules (perception, occupancy, scheduling, memory, end conditions) are
   ready-made and configured declaratively. Most scenarios need only YAML.
2. **TypeScript hooks for anything new.** A scenario may point to a small TS
   module that overrides specific steps:

```ts
interface ScenarioRules {
  actions?(): ActionDef[];                          // define new tools
  observe?(agent: AgentState, world: World): Observation;
  validate?(action: Action, agent: AgentState, world: World): ValidationResult;
  apply?(actions: Action[], world: World, rng: Rng): Transition;
  isFinished?(world: World, turn: number): boolean;
}
```

Every hook is optional. A missing hook falls back to the built-in mechanic
configured in YAML.

---

# 5. Core Concepts

```text
Experiment ──references──► Scenario
    │                        ├── Map (matrix)
    ├── Agents               ├── Rules (YAML)
    ├── Seed                 └── Hooks (TS, optional)
    └── Events
```

## Scenario

A reusable definition of a world and its rules. It does not know which agents
or models will play it.

## Experiment

A concrete run configuration: which scenario, which agents, which models,
which goals, which seed. The same scenario can be run with different casts.

## World

The matrix and everything in it: cells, agent positions, pending messages.
Only the engine and the scenario rules may change it.

## Agent

An independent participant.

```text
id
provider / model
goal (free text, injected into the prompt)
memory (window of the last N observations/actions)
observation
available actions
```

The Agent does not depend on a specific LLM provider.

## Model Provider

```text
Agent
   │
   ▼
ModelProvider
   ├── Anthropic
   ├── Ollama
   ├── Policy  (rule-based, no LLM)
   ├── Mock    (internal, engine unit tests)
   └── Future providers
```

## Policy

A policy is a rule-based agent behind the `policy` provider. It receives the
same observation and tools as an LLM agent and returns a tool call, so the
engine cannot tell them apart. Policy randomness comes from the seeded RNG.

Uses:

- **testing** without API costs;
- **control groups**: compare LLM behavior against a known baseline on the same
  scenario and seed;
- **mixed experiments**: LLM agents alongside agents with fixed, known
  behavior.

Built-in policies are scenario-agnostic and operate only on the tools offered:

| Policy | Parameters | Behavior |
|---|---|---|
| `random` | `actions?` (filter) | Seeded random choice among available tools and valid arguments. |
| `repeat` | `action`, `args` | Always the same tool call. |
| `scripted` | `steps`, `then` | Fixed sequence of tool calls, one per turn; `then` sets what happens after the last one (`wait`, `loop`, `repeat_last`). |

Policies that need to read the observation (e.g. "speak when someone is in my
cell") are custom TypeScript policies, in `policies/` (reusable) or
`scenarios/<name>/policies/` (scenario-specific). An experiment fails
validation before starting if a policy uses an action the scenario does not
enable.

## Observation

Agents never receive the complete world state. The scenario's perception rules
generate an observation describing what the agent is allowed to know.

Example (first scenario):

```json
{
  "turn": 12,
  "position": [2, 2],
  "grid_size": [5, 5],
  "cell": { "type": "floor", "agents": ["a3"] },
  "messages": [{ "from": "a3", "text": "Where is a5?" }],
  "last_action_error": null,
  "available_actions": ["move", "speak", "observe", "wait"]
}
```

## Action

An agent produces an action through a tool call:

```json
{ "action": "move", "direction": "north" }
```

The environment determines whether the action is valid and what happens.

---

# 6. Scenario and Experiment Files

## Scenario file

```yaml
# scenarios/first-contact/scenario.yaml
scenario: first-contact

map: |
  .....
  .#...
  .....
  ...#.
  .....

legend:
  ".": { type: floor }
  "#": { type: wall, blocks_movement: true }

spawn: random               # or a list of coordinates

scheduling: simultaneous    # simultaneous | sequential

actions:                    # standard actions enabled + parameters
  move:    { directions: cardinal }
  speak:   { range: same_cell, delivery: next_turn }
  observe: { reveals: neighbors_8 }
  wait:    {}

rules:
  perception: { mode: same_cell }
  occupancy:  { shared: true }
  end:        { max_turns: 50 }

memory:
  window: 10

hooks: ./rules.ts           # optional
```

The map is drawn as ASCII; the legend maps each symbol to a cell type and its
attributes.

## Experiment file

```yaml
# experiments/first-contact-001.yaml
scenario: ../scenarios/first-contact/scenario.yaml
seed: 12345

agents:
  - id: a1
    provider: anthropic
    model: claude-sonnet-5-5
    goal: "Find another agent and learn what their goal is."

  - id: a2
    provider: ollama
    model: <local-model>
    goal: "..."

  - id: a3
    provider: policy        # control agent, no LLM
    policy: random
    params: { actions: [move] }

  # ... ~5 agents
```

Running an experiment:

```bash
npm run experiment -- ./experiments/first-contact-001.yaml
```

New experiments and new scenarios must not require changes to the engine.

---

# 7. First Scenario: First Contact

Intentionally simple. Its purpose is to validate the lab, not to be a game.

| Rule | Value |
|---|---|
| Map | 5×5 matrix (configurable) |
| Scheduling | Simultaneous: all agents observe the same state, models are called in parallel, actions are applied together |
| Occupancy | Shared: any number of agents can be in the same cell |
| Perception | Only the agent's own cell (who else is there), plus its position and the grid size |
| `move` | One cell in a cardinal direction; walls and borders reject the move |
| `observe` | Spends the turn to see the contents of the 8 neighboring cells |
| `speak` | Heard only by agents in the same cell, delivered next turn |
| `wait` | Does nothing |
| Goals | Free text per agent; not verified by the environment |
| End | After `max_turns` |
| Memory | Last N turns in the prompt |

Restricted perception and communication make encounters rare. This is
deliberate: it creates an incomplete-information setting from the start.

---

# 8. Event System

The event log is the primary observability mechanism and the single source of
truth for the UI and the MCP server.

Initial event types:

```text
experiment.started        # includes resolved scenario rules, agents, seed, run_id
experiment.finished
experiment.failed

agent.observation
agent.model_request
agent.model_response
agent.action

environment.action_rejected
environment.transition    # includes a full world snapshot
```

Envelope:

```json
{
  "event_id": "evt_001",
  "experiment_id": "first-contact-001",
  "run_id": "00042",
  "turn": 12,
  "type": "agent.action",
  "agent_id": "a3",
  "timestamp": "2026-11-10T15:30:00Z",
  "payload": { "action": "move", "direction": "north" }
}
```

Persistence:

```text
events/
└── <experiment_id>/<run_id>.jsonl
```

Because the MCP server and the UI read only events, `environment.transition`
carries a full snapshot of the world (agent positions and any mutable cell
state). The state at any turn can be reconstructed from the log alone.

The envelope must remain stable even if storage changes in the future.

---

# 9. Observer Agent

The Observer:

- does not participate in the experiment;
- does not modify experiment state;
- accesses the experiment only through MCP;
- analyzes events and agent behavior.

For the POC the Observer is **any external MCP client** (Claude Code, Claude
Desktop, …). The lab provides the MCP server, not an observer loop.

```text
 Engine ──writes──► events/*.jsonl ◄──reads── MCP Server (stdio) ◄── Observer
```

The MCP server is a separate process that reads JSONL. It works both while a
run is in progress (tailing the file) and after it has finished.

Initial MCP tools:

```text
list_runs()
get_experiment_state(run_id)
get_recent_events(run_id, limit)
get_agent_history(run_id, agent_id)
get_experiment_summary(run_id)
```

Example interaction:

```text
Observer:  What is currently happening in the experiment?
MCP:       get_recent_events(...)
MCP:       get_agent_history(..., "a3")
Observer:  Agent a3 appears to have changed its behavior during the last three turns...
```

---

# 10. Reasoning and Chain-of-Thought

The system does **not** assume it can capture or expose a model's internal
chain-of-thought.

The POC may record model input, model output, tool calls, tool results,
observations, actions and model-reported explanations.

A model's explanation is always represented as a reported rationale:

```json
{
  "rationale": {
    "type": "model_reported",
    "content": "I suspect Agent 3 because..."
  }
}
```

This must not be interpreted as direct access to the model's internal
reasoning process.

---

# 11. Minimal UI

A lightweight real-time view fed by **Server-Sent Events**. The UI only
observes; it never controls the run.

```text
Experiment: first-contact-001
Run: 00042   Status: RUNNING   Turn: 37

WORLD

┌────┬────┬────┬────┬────┐
│    │ a1 │    │    │    │
├────┼────┼────┼────┼────┤
│    │ ## │a3a5│    │    │
├────┼────┼────┼────┼────┤
│    │ a2 │    │ a4 │    │
├────┼────┼────┼────┼────┤
│    │    │    │ ## │    │
├────┼────┼────┼────┼────┤
│    │    │    │    │    │
└────┴────┴────┴────┴────┘

EVENTS

12:31:01  a1  move north
12:31:03  a3  speak "Where is a5?"
12:31:05  a5  move west  ✗ rejected: wall
12:31:07  a2  observe
```

The UI is intentionally not a full research dashboard.

---

# 12. Reproducibility

Each run records, in `experiment.started`:

```text
experiment_id
run_id
resolved scenario (map + rules + hooks reference)
agent configuration
model configuration
seed
timestamp
```

The same configuration produces the same environment behavior. LLM
stochasticity is intentionally not eliminated.

---

# 13. Initial Project Structure

Approximately:

```text
src/
├── engine/          # turn loop, scheduler, runner, rule resolution
├── world/           # matrix, cells, map parser (ASCII + legend)
├── actions/         # standard actions: move, speak, observe, wait
├── mechanics/       # built-in parameterized rules (perception, occupancy, ...)
├── agents/          # agent, memory window, prompt building
├── models/          # provider interface, anthropic, ollama, policy, mock
├── policies/        # built-in policies: random, repeat, scripted
├── events/          # event schema, JSONL store
├── config/          # YAML loading and validation
├── mcp/             # read-only MCP server over JSONL
└── ui/              # SSE server + minimal view

scenarios/
└── first-contact/
    ├── scenario.yaml
    ├── rules.ts      # optional hooks
    └── policies/     # optional scenario-specific policies

policies/             # reusable custom policies (TS)

experiments/
├── first-contact-001.yaml
└── first-contact-mock.yaml

events/
tests/
```

This structure is illustrative, not a rigid requirement.

---

# 14. Testing Strategy

The POC must be testable without calling real LLM APIs.

```text
Policy / Mock provider → deterministic tool calls → Engine → Events
```

Engine unit tests use the internal mock provider. Scenario smoke tests use
experiment files whose agents are all policies (e.g.
`experiments/first-contact-mock.yaml`).

This allows testing map parsing, standard actions, mechanics, action
validation, scheduling, hooks, event generation, the MCP server and the
experiment lifecycle without consuming API credits.

Real providers are used only for integration tests and actual experiments.

---

# 15. Explicitly Out of Scope

- microservices;
- distributed execution;
- authentication;
- multi-user support;
- advanced analytics;
- complex dashboards;
- visual replay;
- human intervention;
- hundreds of agents;
- sophisticated memory systems;
- a custom experiment DSL beyond YAML + TS hooks;
- non-matrix worlds;
- changing rules during a run;
- a built-in observer loop;
- production-grade infrastructure;
- advanced tracing infrastructure;
- automatic statistical analysis.

These may become future extensions after the POC demonstrates value.

---

# 16. Success Criteria

A successful demonstration allows a researcher to:

1. define a scenario (map + rules) and an experiment (agents + seed) in YAML;
2. start the experiment;
3. connect approximately five agents across providers;
4. observe their actions in real time;
5. inspect the event stream;
6. observe world state transitions;
7. query the run through MCP;
8. ask an Observer LLM to analyze the run;
9. inspect the resulting logs;
10. create a second scenario with different rules **without changing the engine**.

---

# 17. Design Principles

### Keep the POC small
Do not build infrastructure before it is justified by an experiment.

### The engine fixes mechanics, scenarios own rules
Never hardcode scenario-specific behavior in the engine.

### Environment owns reality
Agents decide what to do. The environment decides what actually happens.

### Providers are replaceable
The experiment does not care whether an agent uses Claude or a local model.

### Events are first-class
Every important state transition is observable, and the log alone is enough to
reconstruct a run.

### Observation is not reality
Agents receive controlled observations, never unrestricted access to the world.

### Observer is separate
The Observer analyzes experiments but never participates in them.

### Reproducibility matters
Each run records enough information to understand how it was configured.

### Extensibility without premature complexity
Allow future growth without implementing it during the POC.

---

# 18. Future Direction

Possible extensions, ordered by what real experiments reveal:

```text
More providers (OpenAI, OpenAI-compatible)
Built-in observer loop with analyses recorded as events
Advanced observability (OpenTelemetry, tracing, metrics)
Advanced research UI and replay
Human intervention
Parallel experiment runs
Statistical analysis
Richer worlds and larger agent populations
```

---

# 19. Core Philosophy

This project is not intended to be a complete multi-agent framework.

It is a laboratory.

> **Build the smallest controllable laboratory, not the final framework.**
