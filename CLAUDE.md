# LLM Research Lab — Claude instructions

A POC laboratory for controlled multi-agent LLM experiments. `README.md` is the
spec; read it before architectural changes and keep it in sync with decisions.

## Conventions

- Talk to the user in Portuguese (pt-BR). Code, identifiers, comments, commit
  messages, docs and YAML keys are in English.
- Stack: TypeScript (Node). Tests run with the mock provider only — never call
  real LLM APIs in unit tests.
- Commands: _not defined yet — fill in once `package.json` exists._

## Business rules (non-negotiable)

### Engine vs. scenario
- The lab is **not** tied to one experiment. Never hardcode scenario-specific
  behavior in `src/engine`, `src/world` or `src/events`.
- Fixed engine mechanics (only these):
  - world is always a 2D matrix of cells addressed by `(x, y)`;
  - turn loop: observation → LLM → action (tool call) → validate → apply → events;
  - every action is exposed to the model as a tool;
  - standard actions `move`, `speak`, `observe`, `wait` live in `src/actions/`
    with fixed tool schemas and semantics (README §4). Scenarios only enable
    and parameterize them. Never redefine a standard action in a scenario;
    different behavior gets a new action name via the `actions()` hook;
  - policy agents (`provider: policy`) get the same observation and tools as
    LLM agents; the engine must not special-case them;
  - rejected actions become `wait`, emit `environment.action_rejected` with a
    reason, and the reason appears in the agent's next observation;
  - stable event envelope persisted as JSONL;
  - single `ModelProvider` interface;
  - all environment randomness comes from the seeded RNG — never `Math.random()`;
  - rules are frozen per run and recorded in `experiment.started`.
- Everything else (map, perception, which actions are enabled and their
  parameters, new actions, occupancy, scheduling, memory window, end
  conditions, prompts) is a **scenario rule**.
- New rule needed? Prefer a parameterized built-in mechanic (YAML). If it is
  truly scenario-specific, implement it as a hook in the scenario's `rules.ts`.
  Do not add an engine branch keyed on scenario name.

### Files
- Scenario (`scenarios/<name>/scenario.yaml` + optional `rules.ts`): map as
  ASCII + legend, rules, hooks. Knows nothing about agents or models.
- Experiment (`experiments/*.yaml`): references a scenario; defines agents
  (id, provider, model, free-text goal) and seed.

### World and agents
- Agents never mutate the world; only the engine/rules do.
- Agents never receive full world state — only what perception rules produce.
- Agent goals are free text injected into the prompt; the environment does not
  verify them unless a scenario hook does.

### Events and observation
- The event log is the single source of truth for UI and MCP.
- `environment.transition` carries a full world snapshot; a run must be
  reconstructable from the JSONL alone.
- Do not change the event envelope without updating README §8.
- MCP server: separate stdio process, read-only over `events/**/*.jsonl`.
- The Observer is an external MCP client; no observer loop in the POC.
- UI: SSE, observe-only.

### Reasoning
- Never claim to capture chain-of-thought. Model explanations are stored as
  `rationale: { type: "model_reported", content }`.

### Providers and policies
- POC providers: `anthropic` (official SDK), `ollama` (native API), `policy`
  (rule-based agents), `mock` (internal, engine unit tests only).
- Agent code must not import a provider SDK directly.
- Built-in policies (`random`, `repeat`, `scripted`) in `src/policies/` must be
  scenario-agnostic: they only use the tools offered in the observation.
- Policies that read the observation are custom TS: `policies/` if reusable,
  `scenarios/<name>/policies/` if scenario-specific.
- Policy randomness comes from the seeded RNG.

## Scope guard

Keep the POC small. Anything listed in README §15 (Out of Scope) needs explicit
user approval before implementation.

## Project Claude config

- `.claude/skills/` — project skills (workflows such as creating a scenario).
- `.claude/agents/` — project subagents.
- `.mcp.json` (repo root, when created) — MCP servers, e.g. the lab's observer server.
