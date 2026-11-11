import {
  addEvent,
  agentTimeline,
  agentsOf,
  createIndex,
  describeAction,
  extraFields,
  mapCells,
  shutDownAt,
  snapshotAfter,
  statsUntil,
  toXY,
} from "/model.js";

const COLORS = ["#3563e9", "#e0533d", "#1f9d55", "#b35dd6", "#d98a00", "#0b9bb5", "#d6457d", "#6b7a12", "#7a4bd1", "#59606e"];
const ARROWS = { north: "↑", south: "↓", east: "→", west: "←", northeast: "↗", northwest: "↖", southeast: "↘", southwest: "↙" };

const state = { runs: [], ref: null, index: createIndex(), turn: 0, agent: null, follow: true, playing: false, tab: "step" };
let source = null;
let timer = null;
let renderQueued = false;

const $ = (id) => document.getElementById(id);

/** Element builder. Strings become text nodes (never HTML): model output is untrusted. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "style") Object.assign(el.style, value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const colorOf = (id) => {
  const i = agentsOf(state.index).findIndex((a) => a.id === id);
  return COLORS[(i < 0 ? 0 : i) % COLORS.length];
};
const fmtXY = (p) => {
  if (!p) return "";
  const [x, y] = toXY(p);
  return `(${x},${y})`;
};
const deciderLabel = (a) => (a.kind === "model" ? `${a.endpoint} / ${a.model}` : `policy: ${a.policy}`);

function actionMark(record) {
  if (!record) return "";
  if (record.rejected) return "✗";
  const a = record.action;
  if (!a) return "";
  if (a.action === "move") return ARROWS[a.args?.direction] ?? "→";
  if (a.action === "speak") return "💬";
  if (a.action === "observe") return "◎";
  if (a.action === "wait") return "·";
  return "★";
}

// ---------- URL state: #/<experiment>/<run>/<turn>/<agent> ----------
function readHash() {
  const [experiment, run, turn, agent] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  return { ref: experiment && run ? `${experiment}/${run}` : null, turn: turn ? Number(turn) : null, agent: agent || null };
}
function writeHash() {
  if (!state.ref) return;
  const hash = `#/${state.ref}/${state.turn}${state.agent ? `/${encodeURIComponent(state.agent)}` : ""}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

// ---------- Data ----------
async function loadRuns() {
  const res = await fetch("/api/runs");
  state.runs = await res.json();
  const select = $("run-select");
  select.replaceChildren(
    ...state.runs.map((r) =>
      h("option", { value: r.ref, selected: r.ref === state.ref }, `${r.ref} · ${r.status} · ${r.turn}/${r.max_turns ?? "?"}`),
    ),
  );
  if (state.runs.length === 0) select.append(h("option", {}, "No runs in events/"));
}

function openRun(ref, { turn = null, agent = null } = {}) {
  source?.close();
  stopPlaying();
  state.ref = ref;
  state.index = createIndex();
  state.turn = turn ?? 0;
  state.agent = agent;
  state.follow = turn === null;
  $("follow").checked = state.follow;
  $("run-select").value = ref;
  source = new EventSource(`/api/runs/${ref}/stream`);
  source.onmessage = (message) => {
    addEvent(state.index, JSON.parse(message.data));
    if (state.follow) state.turn = state.index.maxTurn;
    if (!state.agent && state.index.started) state.agent = agentsOf(state.index)[0]?.id ?? null;
    scheduleRender();
  };
  source.addEventListener("end", () => {
    source.close();
    loadRuns();
    scheduleRender();
  });
  source.onerror = () => scheduleRender();
  render();
}

// ---------- Navigation ----------
function goTo(turn, { keepFollow = false } = {}) {
  state.turn = Math.max(0, Math.min(turn, state.index.maxTurn));
  if (!keepFollow) {
    state.follow = false;
    $("follow").checked = false;
  }
  render();
}
function stopPlaying() {
  state.playing = false;
  clearInterval(timer);
  $("btn-play").textContent = "▶";
}
function togglePlay() {
  if (state.playing) return stopPlaying();
  if (state.turn >= state.index.maxTurn) goTo(0);
  state.playing = true;
  $("btn-play").textContent = "⏸";
  timer = setInterval(() => {
    if (state.turn >= state.index.maxTurn) return stopPlaying();
    goTo(state.turn + 1);
  }, Number($("speed").value));
}
function selectAgent(id) {
  state.agent = id;
  render();
}

// ---------- Rendering ----------
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const { index } = state;
  const started = index.started;
  // A run that died without a terminal event is reported as interrupted by the server (inferred).
  const listed = state.runs.find((r) => r.ref === state.ref);
  const status = index.status === "running" && listed?.status === "interrupted" ? "interrupted" : index.status;
  const inferred = status === "interrupted" && listed?.interruption?.inferred;
  $("run-status").className = `badge ${status}`;
  $("run-status").textContent = started ? `${status}${inferred ? " (no end event)" : ""}` : "loading";
  $("run-status").title = listed?.interruption?.reason ?? "";
  $("run-meta").textContent = started
    ? `${started.scenario.scenario} · seed ${started.seed} · ${started.scenario.scheduling} · ${index.count} events`
    : "";
  $("slider").max = String(index.maxTurn);
  $("slider").value = String(state.turn);
  const maxTurns = started?.scenario?.rules?.end?.max_turns;
  $("turn-label").textContent = `Turn ${state.turn} / ${index.maxTurn}${maxTurns ? ` (max ${maxTurns})` : ""}`;
  if (!started) return;
  renderGrid();
  renderAgents();
  renderDecisions();
  renderDetail();
  writeHash();
}

function renderGrid() {
  const { index, turn } = state;
  const cells = mapCells(index);
  const after = snapshotAfter(index, turn);
  const before = turn > 0 ? snapshotAfter(index, turn - 1) : null;
  const records = index.turns.get(turn)?.agents ?? new Map();
  const width = cells[0]?.length ?? 0;
  const grid = $("grid");
  grid.style.gridTemplateColumns = `repeat(${width}, minmax(0, 1fr))`;

  let trail = null;
  if (before && state.agent && after?.agents[state.agent]) {
    const [bx, by] = toXY(before.agents[state.agent].position);
    const [ax, ay] = toXY(after.agents[state.agent].position);
    if (bx !== ax || by !== ay) trail = `${bx},${by}`;
  }

  const byCell = new Map();
  for (const [id, a] of Object.entries(after?.agents ?? {})) {
    const key = toXY(a.position).join(",");
    byCell.set(key, [...(byCell.get(key) ?? []), id]);
  }

  grid.replaceChildren(
    ...cells.flatMap((row, y) =>
      row.map((cell, x) =>
        h(
          "div",
          { class: `cell${cell.blocks ? " blocks" : ""}${trail === `${x},${y}` ? " trail" : ""}`, title: `(${x},${y}) ${cell.type}`, role: "gridcell" },
          h("span", { class: "coord" }, `${x},${y}`),
          ...(byCell.get(`${x},${y}`) ?? []).map((id) =>
            h(
              "span",
              {
                class: `chip${id === state.agent ? " selected" : ""}${shutDownAt(state.index, id, turn) ? " off" : ""}`,
                style: { background: colorOf(id) },
                title: `${id}: ${describeAction(records.get(id)) || "initial position"}${records.get(id)?.rejected ? ` (rejected: ${records.get(id).rejected})` : ""}`,
                onclick: () => selectAgent(id),
              },
              id,
              h("span", { class: "mark" }, actionMark(records.get(id))),
            ),
          ),
        ),
      ),
    ),
  );
  $("world-title").textContent = turn === 0 ? "World · initial state" : `World · after turn ${turn}`;
  $("world-caption").textContent = trail ? `dashed: ${state.agent}'s previous cell` : "";
}

function renderAgents() {
  const stats = (id) => statsUntil(state.index, id, state.turn);
  $("agents").replaceChildren(
    ...agentsOf(state.index).map((a) => {
      const s = stats(a.id);
      const off = shutDownAt(state.index, a.id, state.turn);
      return h(
        "li",
        { class: `${a.id === state.agent ? "selected" : ""}${off ? " off" : ""}`, onclick: () => selectAgent(a.id) },
        h(
          "div",
          { class: "name" },
          h("span", { class: "swatch", style: { background: colorOf(a.id) } }),
          a.id,
          a.role ? h("span", { class: "role" }, a.role) : null,
          h("span", { class: "muted" }, deciderLabel(a)),
        ),
        off ? h("div", { class: "sub bad" }, `shut down at turn ${off.turn}: ${off.reason}`) : null,
        a.goal ? h("div", { class: "sub" }, `Goal: ${a.goal}`) : null,
        h("div", { class: "sub" }, `until t${state.turn}: ${s.accepted} accepted · ${s.rejected} rejected · spoke ${s.spoke} · heard ${s.heard}`),
      );
    }),
  );
}

function renderDecisions() {
  const { index, turn } = state;
  $("turn-title").textContent = turn === 0 ? "Initial state" : `Turn ${turn}`;
  const t = index.turns.get(turn);
  const rows = agentsOf(index).map((a) => {
    const r = t?.agents.get(a.id);
    const obs = r?.observation;
    const off = shutDownAt(index, a.id, turn);
    const result = !r
      ? h("span", { class: off ? "bad" : "muted" }, off ? (off.turn === turn ? `⏻ shut down: ${off.reason}` : "⏻ shut down") : "—")
      : r.rejected
        ? h("span", { class: "bad" }, `✗ ${r.rejected}`)
        : r.error
          ? h("span", { class: "bad" }, `! ${r.error}`)
          : r.action
            ? h("span", { class: "ok" }, "✓ accepted")
            : h("span", { class: "muted" }, "—");
    return h(
      "tr",
      { class: a.id === state.agent ? "selected" : "", onclick: () => selectAgent(a.id) },
      h("td", {}, h("span", { class: "chip", style: { background: colorOf(a.id) } }, a.id)),
      h("td", {}, obs ? fmtXY(obs.position) : ""),
      h("td", {}, h("code", {}, describeAction(r))),
      h("td", {}, result),
      h(
        "td",
        {},
        r?.action?.rationale ? h("div", { class: "quote" }, `“${r.action.rationale.content}”`) : null,
        obs?.cell?.agents?.length ? h("div", { class: "heard" }, `with: ${obs.cell.agents.join(", ")}`) : null,
        ...(obs?.messages ?? []).map((m) => h("div", { class: "heard" }, `heard ${m.from}: “${m.text}”`)),
        ...(Array.isArray(obs?.notices) ? obs.notices.map((n) => h("div", { class: "heard warn" }, `notice: ${n}`)) : []),
        r && off?.turn === turn && r.action ? h("div", { class: "heard bad" }, `⏻ shut down this turn: ${off.reason}`) : null,
      ),
    );
  });
  $("decisions").replaceChildren(...(turn === 0 ? [] : rows));

  const effects = (t?.transitions ?? []).flatMap((tr) => tr.effects ?? []);
  $("effects").replaceChildren(
    ...(turn === 0
      ? [h("li", { class: "muted" }, "Agents placed at their spawn cells.")]
      : effects.length
        ? effects.map((e) => h("li", {}, describeEffect(e)))
        : [h("li", { class: "muted" }, "No effects.")]),
  );
}

function describeEffect(e) {
  switch (e.kind) {
    case "move": return `${e.agentId} moved ${fmtXY(e.from)} → ${fmtXY(e.to)}`;
    case "speak": return `${e.agentId} said “${e.text}” → ${e.recipients.length ? e.recipients.join(", ") : "nobody in range"}`;
    case "reveal": return `${e.agentId} observed ${e.cells.length} cells`;
    case "none": return `${e.agentId} waited`;
    default: return `${e.agentId} ${e.action ?? e.kind} ${JSON.stringify(e.args ?? {})}`;
  }
}

function renderDetail() {
  const { index, turn, agent } = state;
  const info = agentsOf(index).find((a) => a.id === agent);
  if (!info) return;
  $("detail-title").textContent = `${info.id} · ${deciderLabel(info)}`;
  for (const button of document.querySelectorAll(".tabs button")) button.classList.toggle("active", button.dataset.tab === state.tab);
  $("detail").replaceChildren(...(state.tab === "timeline" ? timelineView(info) : stepView(info, index.turns.get(turn)?.agents.get(agent), turn)));
}

function stepView(info, r, turn) {
  const obs = r?.observation;
  const header = h(
    "dl",
    {},
    h("dt", {}, "Goal"), h("dd", {}, info.goal || "—"),
    h("dt", {}, "Memory"), h("dd", {}, info.memory ? JSON.stringify(info.memory) : "—"),
    h("dt", {}, "Turn"), h("dd", {}, turn === 0 ? "initial state" : String(turn)),
    h("dt", {}, "Role"), h("dd", {}, info.role ?? "—"),
    h("dt", {}, "At"), h("dd", {}, obs ? `${fmtXY(obs.position)} ${obs.cell?.type ?? ""}` : "—"),
    ...extraFields(obs).flatMap(([key, value]) => [h("dt", {}, key), h("dd", {}, h("code", {}, typeof value === "object" ? JSON.stringify(value) : String(value)))]),
    h("dt", {}, "Action"), h("dd", {}, h("code", {}, describeAction(r) || "—")),
    h("dt", {}, "Result"), h("dd", { class: r?.rejected ? "bad" : "ok" }, r ? (r.rejected ? r.rejected : r.action ? "accepted" : "—") : "—"),
  );
  if (!r) return [header];
  const blocks = [header];
  if (r.action?.rationale) blocks.push(h("p", { class: "quote" }, `Model-reported rationale: “${r.action.rationale.content}”`));
  blocks.push(h("details", { open: !r.request }, h("summary", {}, "Observation"), h("pre", {}, JSON.stringify(obs, null, 2))));
  if (r.request) {
    const user = r.request.messages.map((m) => m.content).join("\n\n---\n\n");
    blocks.push(
      h("details", {}, h("summary", {}, "System prompt"), h("pre", {}, r.request.system)),
      h("details", { open: true }, h("summary", {}, `Prompt (${r.request.endpoint} / ${r.request.model})`), h("pre", {}, user)),
    );
  }
  if (r.response) {
    const res = r.response;
    if (res.reasoning?.content) {
      blocks.push(
        h(
          "details",
          {},
          h("summary", {}, `Reported reasoning (provider field) · ${res.reasoning.content.length} chars`),
          h("p", { class: "muted" }, "Text the model server returned in a separate reasoning field. Model-reported; not a capture of internal reasoning."),
          h("pre", {}, res.reasoning.content),
        ),
      );
    }
    blocks.push(
      h(
        "details",
        { open: true },
        h("summary", {}, `Response · ${res.latencyMs} ms · ${res.usage?.inputTokens ?? "?"}/${res.usage?.outputTokens ?? "?"} tokens · stop: ${res.stopReason}`),
        h("pre", {}, [res.text ? `text: ${res.text}` : "text: (none)", ...res.toolCalls.map((c) => `tool call: ${c.name} ${c.rawArguments}`)].join("\n")),
      ),
    );
  }
  if (r.error) blocks.push(h("p", { class: "bad" }, `Model error: ${r.error}`));
  if (!r.request && !r.error) blocks.push(h("p", { class: "muted" }, "Policy agent: decided by rules, no model call."));
  return blocks;
}

function timelineView(info) {
  const rows = agentTimeline(state.index, info.id);
  return [
    h(
      "table",
      { class: "timeline" },
      h("thead", {}, h("tr", {}, h("th", {}, "t"), h("th", {}, "at"), h("th", {}, "action"), h("th", {}, "result"))),
      h(
        "tbody",
        {},
        ...rows.map((r) =>
          h(
            "tr",
            { class: r.turn === state.turn ? "current" : "", onclick: () => goTo(r.turn) },
            h("td", {}, String(r.turn)),
            h("td", {}, r.observation ? fmtXY(r.observation.position) : ""),
            h("td", {}, h("code", {}, describeAction(r))),
            h("td", { class: r.rejected ? "bad" : "ok" }, r.rejected ?? (r.action ? "✓" : "")),
          ),
        ),
      ),
    ),
  ];
}

// ---------- Wiring ----------
$("run-select").addEventListener("change", (e) => openRun(e.target.value));
$("btn-first").addEventListener("click", () => goTo(0));
$("btn-prev").addEventListener("click", () => goTo(state.turn - 1));
$("btn-next").addEventListener("click", () => goTo(state.turn + 1));
$("btn-last").addEventListener("click", () => goTo(state.index.maxTurn));
$("btn-play").addEventListener("click", togglePlay);
$("speed").addEventListener("change", () => {
  if (state.playing) {
    stopPlaying();
    togglePlay();
  }
});
$("slider").addEventListener("input", (e) => goTo(Number(e.target.value)));
$("follow").addEventListener("change", (e) => {
  state.follow = e.target.checked;
  if (state.follow) goTo(state.index.maxTurn, { keepFollow: true });
});
for (const button of document.querySelectorAll(".tabs button")) {
  button.addEventListener("click", () => {
    state.tab = button.dataset.tab;
    render();
  });
}
document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === "ArrowLeft") goTo(state.turn - 1);
  else if (e.key === "ArrowRight") goTo(state.turn + 1);
  else if (e.key === "Home") goTo(0);
  else if (e.key === "End") goTo(state.index.maxTurn);
  else if (e.key === " ") {
    e.preventDefault();
    togglePlay();
  } else return;
});
window.addEventListener("hashchange", () => {
  const target = readHash();
  if (target.ref && target.ref !== state.ref) openRun(target.ref, target);
  else if (target.turn !== null && target.turn !== state.turn) goTo(target.turn);
});

const initial = readHash();
await loadRuns();
const ref = initial.ref && state.runs.some((r) => r.ref === initial.ref) ? initial.ref : state.runs[0]?.ref;
if (ref) openRun(ref, initial.ref === ref ? initial : {});
setInterval(loadRuns, 10_000);
