# LLM Research Lab — Claude instructions

A POC laboratory for controlled multi-agent LLM experiments. `README.md` is the
spec; read it before architectural changes and keep it in sync with decisions.

## Conventions

- Talk to the user in Portuguese (pt-BR). Code, identifiers, comments, commit
  messages, docs and YAML keys are in English.
- Stack: TypeScript (Node). Tests run with the mock provider only — never call
  real LLM APIs in unit tests.
- Runtime: everything runs in Docker (Node 22 image). The host Node is not
  used. Services in `compose.yaml`: `lab` (app, source bind-mounted), and the
  local model servers `ollama` and `llamacpp` (Bonsai), each behind a profile
  of the same name. They share a 6 GB GPU: run only one at a time.
  `compose.gpu.yaml` enables the GPU for Ollama; llamacpp always uses it.
  Secrets come from `.env` (see `.env.example`); never commit `.env`.
- Commands (prefix with `docker compose run --rm lab`):
  - `npm test` — run tests (vitest)
  - `npm run test:watch` — tests in watch mode
  - `npm run typecheck` — `tsc` (strict, no emit)
  - `npm run experiment -- <experiment.yaml>` — run an experiment
  - `npm run model:check -- <endpoint> <model> [--repeat N]` — check a model
    produces valid tool calls (calls the real model)
  - `npm run batch -- <batch.yaml> [--report]` — conditions × seeds × replicates, resumable; report in `batches/<name>/`
  - `npm run story -- <exp>/<run> [--narrator <endpoint>/<model>]` — story.json for a video
  - `docker compose --profile video run --rm video node /app/video/build.mjs <story.json>` — render it
  - `npm run script:check -- <script.json>` — validate a written episode script, resolve quotes, write facts.md
  - `npm run mcp` — observer MCP server on stdio (`LAB_EVENTS_DIR`, default `events`)
  - `docker compose up -d ui` — replay/live UI at http://localhost:3100 (`LAB_PORT`;
    3000 is taken by another project on this machine)
- Local model servers:
  - `docker compose -f compose.yaml -f compose.gpu.yaml --profile ollama up -d`
  - `docker compose --profile ollama exec ollama ollama pull <model>`
  - `docker compose --profile llamacpp up -d` (downloads ~6 GB on first start)
- Adding a dependency: `docker compose run --rm --no-deps lab npm install <pkg>`
  so the lockfile is resolved on Node 22, then `docker compose build lab`.
- ESM (`"type": "module"`, NodeNext): relative imports use the `.js` extension.
- Config files are parsed with `yaml` and validated with `zod`.

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
  - call arguments are validated against the tool's JSON Schema (`ajv`,
    `src/actions/args.ts`) before the action's own `validate`; extra, missing
    or mistyped arguments are rejections, not silently ignored;
  - rejected actions become `wait`, emit `environment.action_rejected` with a
    reason, and the reason appears in the agent's next observation;
  - observations use explicit coordinates (`position: {x, y}`,
    `grid_size: {width, height}`, cells `{x, y, type, agents}`), never bare pairs;
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
- Prompt: one user message per turn (optional summary + history block +
  current observation). Memory = scenario `memory` ({window, summary}),
  overridable per agent in the experiment.
- `summary: facts` (`src/agents/memory-summary.ts`) is built only from the
  agent's own observations (never world state) and states facts, never
  advice. A model-written summary is not implemented; if added, it must not
  absorb unreliable turns (war-game finding: hallucinations become permanent).
  Never replay past turns as assistant text messages: it trains models to
  stop calling tools (measured, README §5).
- Hooks (`src/engine/scenario-rules.ts`) mutate the world only in `setup`,
  custom action `apply` and `afterTurn`; new state goes in `world.state`.
  Numbers go in scenario `params` and reach the prompt via `{{name}}` (plus
  `{{max_turns}}`) — never duplicate them in prompt text. Agents are told
  apart by experiment `role`, never by id. Eliminate agents with
  `world.deactivate` (engine skips them and logs `agent.deactivated`).

### Events and observation
- The event log is the single source of truth for UI and MCP.
- `environment.transition` carries a full world snapshot; a run must be
  reconstructable from the JSONL alone.
- Do not change the event envelope without updating README §8.
- Terminal events: `experiment.finished`, `experiment.failed`,
  `experiment.interrupted` (written on SIGINT/SIGTERM; the `lab` service needs
  `init: true` + `TINI_KILL_PROCESS_GROUP=1` for signals to reach node).
  A run with no terminal event and no growth for `LAB_STALE_MINUTES` (10) is
  reported `interrupted` with `inferred: true` — inferred by readers, never
  written into the log. Incomplete runs never enter batch metrics.
- MCP server (`src/mcp/`): separate stdio process, read-only over
  `events/**/*.jsonl`. Derive everything from events (`run-reader.ts`, pure
  functions); never import engine state. Registered for Claude Code in
  `.mcp.json` as `lab-observer` (runs in the `lab` container). The reader must
  keep accepting older log formats (e.g. `[x, y]` positions): logs are
  permanent records. After changing `src/mcp/`, reconnect the server (`/mcp`)
  — a running instance keeps the old code.
- The Observer is an external MCP client; no observer loop in the POC.
- UI (`src/ui/`): SSE, observe-only, reads only JSONL (like MCP). Vanilla JS,
  no build step; `public/model.js` is pure and unit-tested. Insert model output
  as text only (never innerHTML). Bound to 127.0.0.1 (logs hold full prompts).

### Run videos
- `npm run story` (`src/story/`) reads only JSONL. Dialogue in stories and
  videos is always verbatim, with event_id traceability; never paraphrase
  or invent dialogue.
- Narration states facts only. Model narrators get scene facts with actions
  marked as attempts; the video footer must name who wrote the narration.
- Written scripts (`script.json`) never contain dialogue text: quotes are
  `event_id` references resolved verbatim by `script:check`
  (`src/story/script.ts`). Narration passes a fact-check against `facts.md`
  and user approval before any render.
- `video/` is a separate package and image (HyperFrames 0.9.31, GSAP, ffmpeg,
  Chrome, Kokoro). Keep telemetry disabled; no HeyGen account or cloud render.
- `video/DIRECTION.md` is the running log of video direction decisions (layout
  modes, panel visibility, motion language, HyperFrames lessons, review
  process). Follow it, and record every new adjustment there: it will become
  a skill.

### Batches
- `src/batch/`: a batch only orchestrates normal runs (seed override +
  `batch` field in `experiment.started`) and derives everything else from the
  logs. Metrics stay generic (no scenario-specific code); scenario state
  enters only as `final.<field>` from per-agent numeric state.
- Reports are descriptive (n, mean, sd, min, max). Do not add significance
  tests or claims of effects without explicit user approval (README §18).

### Reasoning
- Never claim to capture chain-of-thought. Model explanations are stored as
  `rationale: { type: "model_reported", content }`.
- Server-exposed reasoning fields (Ollama `reasoning`, llama.cpp
  `reasoning_content`) are recorded on `agent.model_response` as
  `reasoning: { type: "model_reported", source: "provider_reasoning_field", content }`
  and presented with that caveat (UI, Observer).

### Providers and policies
- Protocols (code, `src/models/`) are separate from endpoints (config,
  `providers.yaml`). Protocols: `anthropic` (official SDK) and
  `openai-compatible` (`fetch`, covers Ollama /v1, llama.cpp/Bonsai, Gemini,
  umaraiz, and others). Plus `policy` (rule-based agents) and `mock` (internal,
  engine unit tests only).
- A new server or model is a `providers.yaml` entry, not a new adapter. Add a
  protocol adapter only for a genuinely different wire protocol. Keep README
  §15 (Adding Models) and §14 (Getting Started) in sync with such changes.
- Agents pick `provider: <endpoint>` and `model: <name>` independently.
- One request per agent turn; tool results are never replayed, so adapters
  have no tool loop.
- Claude: never send `temperature` (current API rejects it); `tool_choice`
  stays `auto`; no server-side refusal fallback (it would break per-agent
  model attribution). Refusals are logged as `stopReason: "refusal"`.
- Agent and engine code must not import a provider SDK directly.
- Built-in policies (`random`, `repeat`, `scripted`) in `src/policies/` must be
  scenario-agnostic: they only use the tools offered in the observation.
- Policies that read the observation are custom TS: `policies/` if reusable,
  `scenarios/<name>/policies/` if scenario-specific.
- Policy randomness comes from the seeded RNG.

## Scope guard

Keep the POC small. Anything listed in README §18 (Out of Scope) needs explicit
user approval before implementation.

## Project Claude config

- `.claude/skills/` — project skills (workflows such as creating a scenario).
- `.claude/agents/` — project subagents: `content-strategist`, `video-director`,
  `copywriter` (used by the `youtube-episode` skill).
- `.claude/skills/youtube-episode/` — run → YouTube episode pipeline (script,
  fact-check gate, user approval, render, copy).
- `.claude/skills/video-direction/` — render → review (`video/review.mjs`
  contact sheets) → fix → verify → record in `video/DIRECTION.md`.
- `.mcp.json` — MCP servers for Claude Code: `lab-observer` (read-only run analysis).
