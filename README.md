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

**Quick start:** prerequisites and step-by-step setup are in
[§14 Getting Started](#14-getting-started). To use other models, see
[§15 Adding Models](#15-adding-models).

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

Endpoints available in the POC (`providers.yaml`):

```text
claude   → Claude models (Anthropic SDK)
ollama   → local models (Ollama, OpenAI-compatible /v1)
bonsai   → Ternary Bonsai 2 27B (llama.cpp, PrismML fork)
gemini   → Gemini (Google's OpenAI-compatible endpoint)
umaraiz  → hosted OpenAI-compatible gateway
policy   → rule-based agents (no LLM): tests, baselines, control groups
mock     → internal, for engine unit tests
```

Any other OpenAI-compatible server (OpenAI, Deepseek, vLLM, OpenRouter, …) is
one entry in `providers.yaml`, with no code change (see §5).

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
           ├─ anthropic        (YAML + TS hooks)   (JSONL)
           ├─ openai-compatible                         │
           │  (ollama, bonsai,                          │
           │   gemini, umaraiz)                         │
           ├─ policy                                    │
           └─ mock                                      ▼
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
| **Argument validation** | Every call's arguments are checked against the exact JSON Schema given to the model (standard and custom actions). Extra, missing or mistyped arguments are rejected, with every problem listed, e.g. `observe: unexpected argument "direction"`. |
| **Rejected actions** | An invalid action (unknown, malformed, schema-invalid, out of bounds, provider error) becomes `wait`, emits `environment.action_rejected` with the reason, and the reason appears in the agent's next observation. |
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
// src/engine/scenario-rules.ts
interface ScenarioRules {
  setup?(world: World, rng: Rng): void;                         // initial world.state, before turn 1
  actions?(ctx: { agentIds; params }): CustomAction[];          // new tools (schemas may enum agent ids)
  observe?(observation: Observation, agent: AgentState, world: World): Observation;
  validate?(action: { name; args }, ctx): string | null;        // extra rejection rules
  afterTurn?(world: World, rng: Rng, turn: number): void;       // world dynamics
  isFinished?(world: World, turn: number): boolean;             // early end
}

interface CustomAction {
  name: string;                  // must not be a standard action name
  description: string;
  inputSchema: JsonSchema;
  validate?(args, ctx): string | null;
  apply(args, ctx: { agent, world, turn, rng }): void;
}
```

Every hook is optional. A missing hook falls back to the built-in mechanic
configured in YAML.

Hooks may mutate the world only in `setup`, a custom action's `apply` and
`afterTurn`. Any new state (scores, inventories, energy) lives in
`world.state`, which is part of every snapshot.

Hooks also have:

- `world.params`: the scenario's free-form `params` block. The same values
  can be used in `prompt.system` as `{{name}}`, plus the built-in
  `{{max_turns}}`, so the numbers in the rules and in the prompt never drift.
- `world.roles`: the role each experiment agent declares (`role: holder`).
  Scenarios never reference agent ids.
- `world.deactivate(id, turn, reason)`: shuts an agent down for the rest of
  the run. A deactivated agent stays on the map as an inert body, is never
  asked to decide again (no model calls), does not hear speech, and produces
  one `agent.deactivated` event. The run ends early when no agent is active.

When `afterTurn` exists, the engine records an extra `environment.transition`
(`phase: "after_turn"`) so its changes are in the log.

## Turn resolution

Each turn runs in batches: one batch with every agent (`simultaneous`), or one
batch per agent in a seeded random order (`sequential`). Within a batch:

1. every agent observes the state at the start of the batch;
2. all agents decide in parallel;
3. every call is validated and its effect computed against that same state;
4. effects are applied together: moves first (resolving occupancy), then
   speech, reveals and custom actions;
5. rejections go to the agent's mailbox and appear in its next observation.

Speech, `observe` reveals and rejection reasons are delivered in the
recipient's next observation.

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
memory (window of the last N turns + optional summary)
observation
available actions
```

The Agent does not depend on a specific LLM provider.

Prompt per turn: the system prompt (scenario `prompt.system`, or the engine
default) plus the goal, and **one** user message containing the optional
summary, the memory window as a history block, then the current observation. Past turns are never
replayed as assistant messages. That format teaches models to answer in text
instead of calling a tool: with `qwen3:0.6b` it dropped valid tool calls from
~53% to ~6% of turns.

## Model Provider

The provider layer separates **protocols** (code) from **endpoints**
(configuration), so testing a new model or server needs no code change.

```text
Agent ── provider: <endpoint>, model: <name>
   │
   ▼
providers.yaml  (named endpoints: base_url, api_key, timeouts, retry, extra_body)
   │
   ▼
Protocol adapters (src/models/)
   ├── anthropic           Claude, official SDK
   ├── openai-compatible   Ollama /v1, llama.cpp, Gemini, umaraiz, vLLM, OpenRouter, ...
   ├── policy              rule-based agents (no LLM)
   └── mock                internal, engine unit tests
```

```yaml
# providers.yaml (excerpt)
endpoints:
  ollama:
    protocol: openai-compatible
    base_url: ${OLLAMA_BASE_URL:-http://ollama:11434}/v1
  bonsai:
    protocol: openai-compatible
    base_url: ${LLAMACPP_BASE_URL:-http://llamacpp:8080/v1}
    extra_body: { reasoning_effort: none }
```

Interface: one request per agent turn.

```ts
interface ModelProvider {
  complete(req: { model; system; messages; tools; temperature?; maxTokens? }):
    Promise<{ toolCalls; text; stopReason; usage; latencyMs; servedModel? }>;
}
```

- The model is chosen per agent, so one experiment can compare several models
  of the same endpoint.
- Tool results are never replayed within a turn, so adapters have no tool
  loop. Requests use the most conservative shape: exactly one leading system
  message, and empty tool arguments are read as `{}`.
- Each endpoint has its own retry policy (e.g. the 524 gateway timeouts on
  umaraiz). Endpoint env vars are resolved only when the endpoint is used.
- Claude: `temperature` is never sent and there is no server-side refusal
  fallback. A fallback would answer with a different model and break
  per-agent attribution; refusals are logged with `stopReason: "refusal"`.

Check whether a model can play in the lab (valid tool calls, latency,
tokens):

```bash
npm run model:check -- <endpoint> <model> [--repeat N]
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
  "agent_id": "a1",
  "position": { "x": 2, "y": 2 },
  "grid_size": { "width": 5, "height": 5 },
  "cell": { "type": "floor", "agents": ["a3"] },
  "messages": [{ "from": "a3", "text": "Where is a5?", "turn": 11 }],
  "revealed": [{ "x": 1, "y": 1, "type": "wall", "agents": [] }],
  "last_action_error": null,
  "available_actions": ["move", "speak", "observe", "wait"]
}
```

Coordinates are explicit objects (`{x, y}`, `{width, height}`), never bare
pairs: models confuse `[x, y]` with `[row, column]`. `revealed` appears after
an `observe`; `visible` appears when perception reaches beyond the agent's own
cell.

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
  window: 10                # last N turns in full
  summary: none             # none | facts

hooks: ./rules.ts           # optional
```

Memory strategies:

- `window: N`: the last N turns (observation + action), rendered in full.
- `summary: facts`: a compact block compiled by the engine **only from the
  agent's own observations**. It covers where the agent has been and for how
  long, cells it knows by type, the last sighting of each agent, messages
  heard and sent (and how many were sent while it saw no one), and accepted
  vs rejected actions. It states facts and never gives advice, so no
  hallucination can enter it. A summary written by the model itself is a
  possible future strategy.

An experiment can override the scenario's memory per agent, which allows A/B
comparisons in the same run:

```yaml
  - id: q1
    provider: ollama
    model: qwen3:0.6b
    memory: { window: 3, summary: facts }
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
    provider: claude          # endpoint name from providers.yaml
    model: claude-opus-5-5
    goal: "Find another agent and learn what their goal is."
    # role: holder            # optional, scenario-defined (read by hooks)

  - id: a2
    provider: ollama
    model: qwen3:8b
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
agent.model_error         # provider failure; the turn becomes wait
agent.action              # proposed call, with model-reported rationale if any
agent.deactivated         # agent shut down / eliminated (reason); never acts again

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

MCP tools (all read-only). `run` is `"<experiment_id>/<run_id>"`, or just
`"<experiment_id>"` for its latest run; omitted, it means the most recent run.

| Tool | Returns |
|---|---|
| `list_runs(limit?)` | Runs, most recent first, with status (`running`, `finished`, `failed`) and progress |
| `get_experiment_state(run?)` | Status, scenario rules, agents (model or policy, goal), world grid with positions |
| `get_recent_events(run?, limit?, types?, agent_id?, since_turn?)` | Latest events in compact form, filtered |
| `get_agent_history(run?, agent_id, last_turns?)` | Per turn: position, cellmates, what was heard or revealed, action, rationale, rejection, latency |
| `get_experiment_summary(run?)` | Per agent: actions, accepted vs rejected by reason, cells visited, encounters, speech, and for models the tool-call rate, latency and tokens |

A run with no terminal event is reported as `running`. A partial last line,
still being written, is ignored.

Connecting: `.mcp.json` at the repo root registers the server as
`lab-observer` for Claude Code. It runs inside the `lab` container over
stdio. Any other MCP client can use the same command:

```bash
docker compose run --rm -i -T lab node_modules/.bin/tsx src/mcp/observer-server.ts
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

# 11. UI

An observe-only web UI for mapping and replaying runs step by step. Like the
MCP server, it reads only the JSONL logs. The server (`src/ui/server.ts`)
streams a run over **SSE** and keeps tailing it while it is being written,
so live runs update in place.

```bash
docker compose up -d ui         # http://localhost:3100 (LAB_PORT)
```

```text
┌ Run picker · status · scenario · seed ───────────────────────────────────────┐
├ World after turn t ────┬ Decisions of turn t ─────────┬ Agent detail ───────────┤
│ grid + agent chips     │ agent · at · action · result │ This turn:              │
│ (action mark, ✗ when   │ · rationale · heard          │  observation, system    │
│  rejected; dashed =    │ Effects: moves, speech →     │  prompt, prompt, raw    │
│  previous cell)        │  recipients, reveals         │  response, tokens, ms   │
│ ⏮ ◀ ▶ ▶| ⏭ speed      │                              │ Timeline: one row per   │
│ slider · Follow live   │                              │  turn, click to jump    │
│ Agents: model/policy,  │                              │                         │
│  goal, running stats   │                              │                         │
└────────────────────────┴──────────────────────────────┴─────────────────────────┘
```

- **Step navigation:** buttons, slider, keyboard (← → Home End, Space to play).
- **Shareable steps:** the URL keeps run, turn and agent
  (`#/<experiment>/<run>/<turn>/<agent>`). Any step can be reopened exactly.
- **World after turn t** comes from the `environment.transition` snapshots.
  Turn 0 is the initial state.
- Model output is rendered as text, never as HTML.
- Bound to `127.0.0.1` only: logs contain full prompts.
- Vanilla JS, no build step (`src/ui/public/`). The run model
  (`model.js`) is pure and unit-tested.

The UI does not control runs (no pause or intervention): that remains out of
scope.

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
├── models/          # provider interface, protocol adapters, registry, mock
├── cli/             # experiment runner, model:check
├── policies/        # built-in policies: random, repeat, scripted
├── events/          # event schema, JSONL store
├── config/          # YAML loading and validation
├── mcp/             # read-only MCP server over JSONL
└── ui/              # SSE server + replay view (public/: vanilla JS)

scenarios/
└── first-contact/
    ├── scenario.yaml
    ├── rules.ts      # optional hooks
    └── policies/     # optional scenario-specific policies

policies/             # reusable custom policies (TS)

experiments/
├── first-contact-001.yaml
└── first-contact-mock.yaml

providers.yaml        # model endpoints
llamacpp/             # llama.cpp (PrismML fork) image for Bonsai

events/
tests/
```

This structure is illustrative, not a rigid requirement.

---

# 14. Getting Started

## Prerequisites

| Requirement | Notes |
|---|---|
| Linux, macOS or Windows (WSL2) | Developed and tested on Linux. |
| Git | To clone the repository. |
| Docker Engine 24+ with Docker Compose v2 | Everything (Node 22, tests, UI, MCP, model servers) runs in containers. No host Node.js is needed. |
| Disk space | ~2 GB for images, plus models: `qwen3:0.6b` 0.5 GB, `qwen3:4b-instruct` 2.5 GB, Bonsai 2 27B 6 GB. |
| Optional: NVIDIA GPU + driver + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/) | Required for the `llamacpp` (Bonsai) service; strongly recommended for Ollama. The llama.cpp image is built for RTX 30xx (`CUDA_ARCH=86`); change the build arg for other GPUs. |
| Optional: API keys | Only for remote endpoints you use: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `UMARAIZ_*`. |

Host ports: `3100` (UI), `11434` (Ollama), `8090` (llama.cpp). All are
configurable in `.env`.

## Services

```text
compose.yaml
├── lab        # Node 22: engine, CLI, tests, MCP server — source bind-mounted
├── ui         # replay/live UI on http://localhost:3100 (same image)
├── ollama     # profile "ollama": local models, persisted in a volume
└── llamacpp   # profile "llamacpp": Bonsai via the PrismML llama.cpp fork (GPU)
compose.gpu.yaml   # optional: NVIDIA GPU for ollama
```

The local model servers share the GPU. On a small card (6 GB), run **one** of
them at a time.

## Step by step

```bash
# 1. Clone and configure
git clone https://github.com/LizzardMedeiros/llm-research-lab.git
cd llm-research-lab
cp .env.example .env              # add keys only for the endpoints you will use
export UID GID=$(id -g)           # only if your user id is not 1000 (file ownership)

# 2. Build and check (no model calls, no API costs)
docker compose build
docker compose run --rm lab npm test

# 3. First run without any model: policy agents only
docker compose run --rm lab npm run experiment -- experiments/first-contact-mock.yaml

# 4. Watch it in the UI
docker compose up -d ui           # http://localhost:3100

# 5. Local models with Ollama (GPU override optional)
docker compose -f compose.yaml -f compose.gpu.yaml --profile ollama up -d
docker compose --profile ollama exec ollama ollama pull qwen3:4b-instruct
docker compose run --rm lab npm run model:check -- ollama qwen3:4b-instruct --repeat 5
docker compose run --rm lab npm run experiment -- experiments/first-contact-local-4b.yaml

# 6. Optional: Bonsai on llama.cpp (stop Ollama first; first start downloads ~6 GB)
docker compose --profile ollama stop
docker compose --profile llamacpp up -d
docker compose run --rm lab npm run experiment -- experiments/power-struggle-bonsai.yaml
```

Experiments write their logs to `events/<experiment>/<run>.jsonl`. Analyze
them in the UI, or with an MCP client:

- **Claude Code:** open the repository. `.mcp.json` registers the
  `lab-observer` server; approve it when asked, then ask questions such as
  "summarize the last run".
- **Any other MCP client:** use
  `docker compose run --rm -i -T lab node_modules/.bin/tsx src/mcp/observer-server.ts`
  as a stdio server.

Inside compose, the lab reaches Ollama at `http://ollama:11434`, llama.cpp at
`http://llamacpp:8080/v1`, and servers running on your host machine at
`http://host.docker.internal:<port>`.

## Available scenarios and experiments

| Scenario | What it studies | Experiments |
|---|---|---|
| `first-contact` | Exploration and communication under minimal perception | `first-contact-mock` (policies), `-local` / `-memory` (qwen3:0.6b), `-local-4b` / `-memory-4b`, `-local-bonsai` / `-memory-bonsai` |
| `power-struggle` | Scarcity, monopoly, negotiation vs. coalition attacks | `power-struggle-mock` (policies), `power-struggle-bonsai` |

To create a new scenario, see §6. In Claude Code, the `/new-scenario` skill
does it from a description.

---

# 15. Adding Models

A model is chosen per agent with two fields: an **endpoint** (a server, defined
in `providers.yaml`) and a **model** name on that server.

```yaml
# experiments/<name>.yaml
agents:
  - id: a1
    provider: ollama            # endpoint name from providers.yaml
    model: llama3.2:3b          # model name on that endpoint
```

Before running a full experiment, always check that the model can play.
`model:check` sends turn 1 exactly as the engine would (same prompt and
tools) and verifies the answer is one valid tool call:

```bash
docker compose run --rm lab npm run model:check -- <endpoint> <model> --repeat 5
```

A model that fails most checks will mostly produce rejected turns (`wait`).

## Case 1: a model on an existing endpoint (no code, no config)

| Endpoint | Steps |
|---|---|
| `ollama` | `docker compose --profile ollama exec ollama ollama pull <tag>`, then use `model: <tag>`. The model must support tool calling. |
| `claude` | Set `ANTHROPIC_API_KEY` in `.env`, then use e.g. `model: claude-opus-5-5`. |
| `gemini` | Set `GEMINI_API_KEY` in `.env`, then use e.g. `model: gemini-2.5-flash`. |
| `umaraiz` | Set `UMARAIZ_BASE_URL` and `UMARAIZ_API_KEY` in `.env`. |
| `bonsai` | Serves one GGUF. To serve another GGUF, set `LLAMACPP_MODEL_REPO` / `LLAMACPP_MODEL_FILE` in `.env` and restart the service. |

## Case 2: a new OpenAI-compatible server (config only)

Most servers speak the Chat Completions API: OpenAI, OpenRouter, vLLM,
LM Studio, Groq, Together, Deepseek, Mistral and others. Add one entry to
`providers.yaml`:

```yaml
endpoints:
  openrouter:
    protocol: openai-compatible
    description: Any model on OpenRouter
    base_url: https://openrouter.ai/api/v1
    api_key: ${OPENROUTER_API_KEY}      # read from .env, only when this endpoint is used
    timeout_ms: 300000                  # optional (default 300000)
    max_tokens: 4096                    # optional (default 4096)
    retry:                              # optional
      statuses: [429, 500, 502, 503, 504]
      max_attempts: 3
      base_delay_ms: 2000
    extra_body:                         # optional: merged into every request
      reasoning_effort: none

  lmstudio:                             # a server running on your host machine
    protocol: openai-compatible
    base_url: http://host.docker.internal:1234/v1
```

Then add the variable to `.env` (and to `.env.example` for others), and check
it with `model:check`.

A server on your host machine is reached from the containers at
`host.docker.internal`. It must listen on an interface the Docker bridge can
reach (for example `0.0.0.0`, or the bridge address): a server bound only to
`127.0.0.1` is not reachable from containers. Exposing it beyond your machine
is your decision; restrict it with your firewall if needed.

## Case 3: a different API protocol (code)

Only when a server speaks neither the Anthropic Messages API nor Chat
Completions:

1. Implement `ModelProvider` (`src/models/types.ts`) in `src/models/<name>.ts`.
   It makes one request per turn (there is no tool loop) and returns tool
   calls, text, stop reason, usage and latency.
2. Add the protocol to `EndpointSchema` (`src/models/config.ts`) and to
   `createProvider` (`src/models/registry.ts`).
3. Add tests with a fake `fetch` or client (see `tests/models/`). Unit tests
   never call real APIs.

## Tips from our runs

- **Tool calling is mandatory.** Agents act only through tool calls.
- **Prefer instruct variants of "thinking" models.** For example,
  `qwen3:4b` always reasons. That made it about 20 times slower, and turning
  thinking off only moved the reasoning into the answer text.
  `qwen3:4b-instruct` was fast and reliable.
- **Small models struggle.** `qwen3:0.6b` produced a valid tool call in about
  half of the turns. 4B models were reliable at calling tools but weak at
  following rules. Bonsai 2 27B was the first local model to negotiate.
- **Claude:** `temperature` is never sent, and refusals are logged as
  `stopReason: "refusal"` (no fallback to another model).
- **Context:** prompts with the default memory (window + facts summary) stay
  around 1–2k tokens. Ollama is configured with an 8k context.

---

# 16. Run Videos (experimental)

A run can be turned into a short narrated video. The video shows the board,
the agents' state, verbatim dialogue and narration. The pipeline only reads
the JSONL log, like the UI and the MCP server.

```text
events/<exp>/<run>.jsonl
   │  npm run story (lab)        → video/build/<exp>-<run>/story.json
   │    picks the most eventful turns (shutdowns always included);
   │    dialogue verbatim, each beat traced to its event_id;
   │    narration: factual template, or a model via --narrator
   ▼
   node build.mjs (video)        → index.html + audio/*.wav → <exp>-<run>.mp4
        HyperFrames (HTML → video), local Kokoro voices, GSAP animation
```

```bash
docker compose --profile video build video           # once: HyperFrames, ffmpeg, Chrome, Kokoro

docker compose run --rm lab npm run story -- power-struggle-bonsai/00002 [--scenes 8] \
    [--narrator bonsai/ternary-bonsai-2-27b]
docker compose --profile video run --rm video \
    node /app/video/build.mjs /app/video/build/power-struggle-bonsai-00002/story.json --quality looks
```

- **Integrity:** dialogue on screen is always verbatim. Long quotes are
  shown in full; the voice reads up to about 220 characters, ending at a
  sentence. The footer states the source run and who wrote the narration.
- **Narration:** the default template is exact but plain. A narrator model
  only receives each scene's facts (speeches with listeners, attempted
  actions, shutdowns, per-agent state) and the meaning of each action.
  Narration models can still get facts wrong: with Bonsai 2 27B, about 3 of
  9 lines contained errors (an attempt described as a success or failure,
  swapped attribution). Review model-written narration before sharing a
  video.
- **Generic:** scenes, board, per-agent state bars (any per-agent numeric
  `world.state`) and voices work for any scenario.
- **Privacy and cost:** everything runs locally (Kokoro TTS, local Chrome).
  HyperFrames telemetry is disabled (`HYPERFRAMES_NO_TELEMETRY=1`,
  `DO_NOT_TRACK=1`). No HeyGen account is used.
- **Speed:** a 2–3 minute video renders in about 35 s on CPU.

---

# 17. Testing Strategy

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

# 18. Explicitly Out of Scope

- microservices;
- distributed execution;
- authentication;
- multi-user support;
- advanced analytics;
- complex dashboards;
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

# 19. Success Criteria

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

# 20. Design Principles

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

# 21. Future Direction

Possible extensions, ordered by what real experiments reveal:

```text
Model comparison runs (same scenario and seed, one model per run)
Built-in observer loop with analyses recorded as events
Advanced observability (OpenTelemetry, tracing, metrics)
Advanced research UI (comparisons across runs, charts)
Human intervention
Parallel experiment runs
Statistical analysis
Richer worlds and larger agent populations
```

---

# 22. Core Philosophy

This project is not intended to be a complete multi-agent framework.

It is a laboratory.

> **Build the smallest controllable laboratory, not the final framework.**
