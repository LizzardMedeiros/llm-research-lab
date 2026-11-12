// Builds a narrated video from a story.json (made by `npm run story` in the lab).
//
//   node /video/build.mjs <story.json | script.resolved.json> [--quality draft|looks] [--no-render]
//
// Input: a story.json (automatic scene selection, `npm run story`) or a
// script.resolved.json (a written script, `npm run script:check`). An optional
// direction.json next to the input lets a director override, per scene id:
//   { "scenes": { "<id>": { "panel": "auto"|true|false, "camera": "auto"|"wide"|["b1","b3"],
//                            "pace": <extra seconds held, -0.5..4>, "transition": "wipe"|"cut" } },
//     "world": "board"|"3d" }   ("3d": the board is drawn as a three.js set with robotic rats, world3d.js)
//
// Output, next to the input: audio/*.wav, index.html, gsap.min.js, timeline.json, <name>.mp4
// Dialogue on screen is verbatim from the run log. Narration is labeled.
//
// Staging: the board is a persistent "stage" with a camera (zooms on whoever
// speaks or shuts down); headers, panels, callouts and charts enter and leave
// around it. Only GSAP props supported by HyperFrames are used:
// opacity, x, y, scale, rotation, width, height, visibility.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { portraitSvg } from "./portrait.mjs";
import { ratPortraitSvg } from "./rat-portrait.mjs";

const W = 1280;
const H = 720;
const COLORS = ["#3563e9", "#e0533d", "#1f9d55", "#b35dd6", "#d98a00", "#0b9bb5", "#d6457d", "#6b7a12"];
const AGENT_VOICES = ["am_adam", "af_nova", "am_michael", "bf_emma", "af_sky", "bf_isabella", "af_heart"];
// Series identity (name, narrator persona): video/series.json, same for every episode.
const SERIES = JSON.parse(readFileSync(new URL("./series.json", import.meta.url), "utf8"));
const NARRATOR_VOICE = SERIES.narrator.voice;
const SPOKEN_LIMIT = 220; // longer quotes are shown in full but read up to a sentence end
const GAP = 0.35;
const HOLD = 0.9;
const WIPE = 0.9; // scene transition before the narration starts

const args = process.argv.slice(2);
const storyPath = args.find((a) => !a.startsWith("--"));
const quality = args.includes("--quality") ? args[args.indexOf("--quality") + 1] : "draft";
const render = !args.includes("--no-render");
if (!storyPath) {
  console.error("Usage: node build.mjs <story.json> [--quality draft|looks] [--no-render]");
  process.exit(2);
}

const input = JSON.parse(readFileSync(storyPath, "utf8"));
const outDir = dirname(resolve(storyPath));

/**
 * meta: run description; plan: ordered scenes, each with narration lines,
 * verbatim quotes and the world state to show.
 */
const isScript = input.resolved === true;
const story = {
  ...input,
  title: input.title ?? input.scenario.name.replace(/-/g, " "),
  source: input.source ?? `${input.experimentId}/${input.runId}`,
  narrator: isScript ? "script" : input.narrator,
};
const plan = isScript
  ? input.scenes.map((sc) => ({
      id: sc.id,
      kind: sc.kind,
      turn: sc.turn,
      flashback: sc.flashback,
      focus: sc.focus,
      state: sc.state,
      narration: sc.narration,
      quotes: sc.quotes,
    }))
  : [
      { id: "intro", kind: "intro", turn: 0, state: input.intro, narration: [input.intro.narration || input.scenario.description], quotes: [] },
      ...input.scenes.map((sc, n) => ({
        id: `t${sc.turn}`,
        kind: "scene",
        turn: sc.turn,
        state: sc,
        narration: [sc.narration ?? `Turn ${sc.turn}.`],
        quotes: sc.beats.filter((b) => b.kind === "speech" && b.heardBy.length).slice(0, 2).map((b) => ({ event_id: b.eventId, agent: b.agent, text: b.text, heardBy: b.heardBy })),
      })),
      { id: "outcome", kind: "outcome", turn: input.outcome.turn, state: input.scenes.at(-1) ?? input.intro, narration: [input.outcome.text], quotes: [] },
    ];

// Survival per agent (outcome chart): scripts carry it; stories derive it from shutdown beats.
const lasted = input.lasted ?? (() => {
  const out = {};
  for (const sc of input.scenes ?? []) for (const b of sc.beats) if (b.kind === "shutdown") out[b.agent] ??= sc.turn;
  for (const a of input.agents) out[a.id] ??= input.outcome.turn;
  return out;
})();

// Director overrides.
const directionPath = join(outDir, "direction.json");
const direction = existsSync(directionPath) ? JSON.parse(readFileSync(directionPath, "utf8")) : { scenes: {} };
const DIRECTION_KEYS = new Set(["panel", "camera", "pace", "transition"]);
if (direction.atmosphere !== undefined && direction.atmosphere !== false && (typeof direction.atmosphere !== "object" || Object.keys(direction.atmosphere).some((k) => !["music", "effects"].includes(k) || typeof direction.atmosphere[k] !== "number"))) {
  throw new Error('direction.json: atmosphere must be false or { "music": <level>, "effects": <level> } (1 = default)');
}
for (const key of Object.keys(direction)) if (!["scenes", "tension", "atmosphere", "world"].includes(key)) throw new Error(`direction.json: unknown top-level key "${key}"`);
if (direction.world !== undefined && !["board", "3d"].includes(direction.world)) throw new Error('direction.json: world must be "board" or "3d"');
// "3d": the 2D board below still runs (hidden) as a puppet; world3d.js draws its state in 3D.
const WORLD3D = direction.world === "3d";
if (direction.tension !== undefined && (typeof direction.tension?.field !== "string" || typeof direction.tension?.at_or_below !== "number")) {
  throw new Error('direction.json: tension must be { "field": "<stat>", "at_or_below": <number> }');
}
for (const [id, d] of Object.entries(direction.scenes ?? {})) {
  if (!plan.some((sc) => sc.id === id)) throw new Error(`direction.json: unknown scene id "${id}"`);
  for (const key of Object.keys(d)) if (!DIRECTION_KEYS.has(key)) throw new Error(`direction.json: scene "${id}": unknown key "${key}"`);
  if (d.panel !== undefined && !["auto", true, false].includes(d.panel)) throw new Error(`direction.json: scene "${id}": panel must be "auto", true or false`);
  if (d.camera !== undefined && d.camera !== "auto" && d.camera !== "wide" && !Array.isArray(d.camera)) throw new Error(`direction.json: scene "${id}": camera must be "auto", "wide" or a list of agents`);
  if (d.pace !== undefined && (typeof d.pace !== "number" || d.pace < -0.5 || d.pace > 4)) throw new Error(`direction.json: scene "${id}": pace must be a number in [-0.5, 4]`);
  if (d.transition !== undefined && !["wipe", "cut"].includes(d.transition)) throw new Error(`direction.json: scene "${id}": transition must be "wipe" or "cut"`);
}
const directionOf = (id) => direction.scenes?.[id] ?? {};
const audioDir = join(outDir, "audio");
mkdirSync(audioDir, { recursive: true });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ids = story.agents.map((a) => a.id);
const color = (id) => COLORS[ids.indexOf(id) % COLORS.length];
// Characters (presentation only). Older story files have no cast: fall back to ids.
const castById = new Map((story.cast ?? []).map((c) => [c.id, c]));
const member = (id) =>
  castById.get(id) ?? {
    id,
    name: id,
    voice: AGENT_VOICES[ids.indexOf(id) % AGENT_VOICES.length],
    portrait: { face: ids.indexOf(id) % 3, skin: (ids.indexOf(id) * 2) % 6, hair: ids.indexOf(id) % 6, hairColor: (ids.indexOf(id) * 3) % 6, accessory: ids.indexOf(id) % 4 },
  };
const voice = (id) => member(id).voice;
/** "Bonsai 3 · b3" (just the id when the character has no own name). */
const nameOf = (id) => (member(id).name === id ? id : `${member(id).name} · ${id}`);
const shortName = (id) => member(id).name;
// The 3D world casts robotic lab rats: portraits follow (same color, bow on feminine characters).
const portrait = (id, expression, size) =>
  WORLD3D ? ratPortraitSvg(color(id), expression, member(id).presentation === "feminine", size) : portraitSvg(member(id).portrait, expression, color(id), size);
const f = (n) => Number(n).toFixed(2);

function spokenPart(text) {
  if (text.length <= SPOKEN_LIMIT) return text;
  const cut = text.slice(0, SPOKEN_LIMIT);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return end > 60 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

/** Synthesizes (cached by voice + text) and returns { src, duration }. */
function tts(text, voiceId) {
  const hash = createHash("sha1").update(`${voiceId}|${text}`).digest("hex").slice(0, 12);
  const file = join(audioDir, `${hash}.wav`);
  if (!existsSync(file)) {
    execFileSync("npx", ["--prefix", "/video", "hyperframes", "tts", text, "--voice", voiceId, "--speed", "1.1", "--output", file], { stdio: "ignore" });
  }
  const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
  return { src: `audio/${basename(file)}`, duration };
}

// ---------- Timeline ----------
// A "card" is one on-screen moment: intro, a scene of the run, or the outcome.
const cards = [];
let t = 0;

const SCENE_LIKE = new Set(["scene", "cold_open"]);

function addCard(card, lines) {
  const start = t;
  const clips = [];
  const lead = SCENE_LIKE.has(card.kind) ? (card.direction.transition === "cut" ? 0.4 : WIPE) : 0.5;
  let cursor = start + lead;
  for (const line of lines) {
    const audio = tts(line.spoken ?? line.text, line.voice);
    clips.push({ ...line, ...audio, start: cursor });
    cursor += audio.duration + GAP;
  }
  const minimum = { intro: 7, outcome: 8, end: 6 }[card.kind] ?? 3;
  // A shutdown plays after the scene's last speech: keep room for the stamp.
  // A shutdown stamp plays after the scene's speeches, or after its narration: keep room for it.
  const stampRoom = SCENE_LIKE.has(card.kind) && card.scene?.beats?.some((b) => b.kind === "shutdown") ? 2.2 : 0;
  const duration = Math.max(cursor - start + HOLD + stampRoom + (card.direction.pace ?? 0), minimum);
  cards.push({ ...card, start, duration, clips, lead });
  t = start + duration;
}

console.log("synthesizing voices...");
for (const item of plan) {
  const isOutcome = item.kind === "outcome";
  const scene = isOutcome
    ? { ...item.state, stats: story.outcome.stats, turn: story.outcome.turn, inactive: ids.filter((id) => !story.outcome.survivors.includes(id)) }
    : item.state;
  // The Observer introduces itself (and the AI-agents disclosure) before the episode's own intro.
  const greeting = item.kind === "intro" ? SERIES.narrator.greeting : [];
  addCard({ id: item.id, kind: item.kind, turn: item.turn, flashback: item.flashback, focus: item.focus, scene, direction: directionOf(item.id) }, [
    ...[...greeting, ...item.narration].map((text) => ({ role: "narration", text, voice: NARRATOR_VOICE })),
    ...item.quotes.map((q) => ({ role: "speech", agent: q.agent, heardBy: q.heardBy, text: q.text, spoken: spokenPart(q.text), voice: voice(q.agent) })),
  ]);
}
// Series end card: brand, one-line outcome, the Observer's sign-off and the run reference.
addCard({ id: "series-end", kind: "end", turn: story.outcome.turn, direction: {} }, [{ role: "narration", text: SERIES.narrator.signoff, voice: NARRATOR_VOICE }]);
const total = t;

// ---------- Stage (board) geometry ----------
const rows = story.scenario.map;
const gridW = rows[0].length;
const gridH = rows.length;
const VIEW = { x: 50, y: 110, w: 360, h: 360 }; // on-screen window of the board
const cell = Math.floor(Math.min(VIEW.w / gridW, VIEW.h / gridH));
const boardW = cell * gridW;
const boardH = cell * gridH;
const TOKEN = Math.round(cell * 0.42);
// Callouts (board coordinates): fixed height, stacked with a gap; width estimated per character.
const CALLOUT_H = 22;
const CALLOUT_STEP = CALLOUT_H + 4;
const CALLOUT_CHAR = 7.6; // 12px bold DejaVu Sans, a little generous


/** Token centers in board coordinates; agents sharing a cell are spread out. */
function tokenCenters(positions) {
  const byCell = new Map();
  for (const id of ids) {
    const p = positions?.[id];
    if (!p) continue;
    const key = p.join(",");
    byCell.set(key, [...(byCell.get(key) ?? []), id]);
  }
  const out = {};
  const slots = [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7], [0.5, 0.5]];
  for (const [key, members] of byCell) {
    const [x, y] = key.split(",").map(Number);
    members.forEach((id, i) => {
      const [ox, oy] = members.length === 1 ? [0.5, 0.5] : slots[i % slots.length];
      out[id] = [(x + ox) * cell, (y + oy) * cell];
    });
  }
  return out;
}

// Two layouts: "side" (board left, panel right) and "stage" (board centered,
// slightly larger, nothing competing with it: dialogue and drama).
const STAGE_SCALE = 1.08;
const SIDE = { x: 0, y: 0, scale: 1 };
const STAGE = { x: W / 2 - (VIEW.x + VIEW.w / 2), y: 0, scale: STAGE_SCALE };
const STAGE_BOTTOM = VIEW.y + VIEW.h / 2 + (VIEW.h * STAGE_SCALE) / 2;

/** Camera transform that frames a set of board points (scale 1 = whole board). */
function cameraOn(points) {
  if (!points.length) return { scale: 1, x: (VIEW.w - boardW) / 2, y: (VIEW.h - boardH) / 2 };
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) + cell * 1.4;
  const scale = Math.min(2.1, Math.max(1, VIEW.w / span));
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const clamp = (v, size, board) => Math.min(0, Math.max(size - board * scale, v));
  return {
    scale,
    x: scale === 1 ? (VIEW.w - boardW) / 2 : clamp(VIEW.w / 2 - cx * scale, VIEW.w, boardW),
    y: scale === 1 ? (VIEW.h - boardH) / 2 : clamp(VIEW.h / 2 - cy * scale, VIEW.h, boardH),
  };
}

// Max per stat field (for bars).
const statMax = {};
for (const card of cards) {
  for (const fields of Object.values(card.scene?.stats ?? {})) {
    for (const [k, v] of Object.entries(fields)) statMax[k] = Math.max(statMax[k] ?? 0, v);
  }
}
const pct = (k, v) => (statMax[k] ? Math.round((v / statMax[k]) * 100) : 0);

/**
 * Expression from OBSERVABLE state only: "off" when shut down, "tense" when the
 * tension field is low (default: the first per-agent numeric field at ≤ 15% of
 * its max in this video; override with direction.json "tension"), else "neutral".
 */
const tensionField = direction.tension?.field ?? Object.keys(statMax)[0];
const tensionAt = direction.tension?.at_or_below ?? (tensionField ? Math.floor((statMax[tensionField] ?? 0) * 0.15) : null);
const expressionOf = (id, view) => {
  if (view?.inactive?.includes(id)) return "off";
  const v = tensionField ? view?.stats?.[id]?.[tensionField] : undefined;
  return typeof v === "number" && tensionAt !== null && v <= tensionAt ? "tense" : "neutral";
};
const setExpression = (id, expression, at) => {
  for (const x of ["neutral", "tense", "off"]) tl.push(`tl.to("#face-${id}-${x}", {opacity:${x === expression ? 1 : 0}, duration:0.25}, ${f(at)});`);
};


// ---------- HTML ----------
const boardCells = rows
  .flatMap((row, y) =>
    [...row].map((symbol, x) => {
      const blocked = story.scenario.blocked.includes(symbol);
      return `<div class="cell${blocked ? " wall" : ""}" style="left:${x * cell + 3}px;top:${y * cell + 3}px;width:${cell - 6}px;height:${cell - 6}px"><span>${x},${y}</span></div>`;
    }),
  )
  .join("");

const tokens = ids
  .map(
    (id) => `<div class="token" id="tok-${esc(id)}" style="width:${TOKEN}px;height:${TOKEN}px">
      <div class="ring" id="ring-${esc(id)}"></div>
      <div class="disc">${["neutral", "tense", "off"].map((x) => `<div class="face" id="face-${esc(id)}-${x}" style="opacity:${x === "neutral" ? 1 : 0}">${portrait(id, x, TOKEN)}</div>`).join("")}<span class="idb" style="background:${color(id)}">${esc(id)}</span></div>
    </div>`,
  )
  .join("");

const tl = []; // GSAP calls, in order
const callouts = []; // per-card callout elements (inside the camera; screen-space in 3D)
const moves3d = Object.fromEntries(ids.map((id) => [id, []])); // [t0, duration, from u, v, to u, v] in cell units
const lastCenter = {};
const speeches3d = []; // [start, end, speaker, listeners] for every dialogue line
const logMove = (id, c, at, duration) => {
  const from = lastCenter[id] ?? c;
  moves3d[id].push([Number(f(at)), duration, ...from.map((n) => Number(f(n / cell))), ...c.map((n) => Number(f(n / cell)))]);
  lastCenter[id] = c;
};

/**
 * State panel. Rows start at the world at the START of the turn and resolve to
 * the end-of-turn values at `resolveAt` (bars grow, numbers swap, rows dim).
 */
function statsPanel(card, i, prev, resolveAt) {
  const before = card.scene.before ?? card.scene;
  return `<div class="panel" id="panel${i}">${story.agents
    .map((a, r) => {
      const offBefore = before.inactive?.includes(a.id);
      const offAfter = card.scene.inactive?.includes(a.id);
      const fields = card.scene.stats?.[a.id] ?? {};
      const bars = Object.entries(fields)
        .map(([k, v]) => {
          const safe = `${i}-${a.id}-${k}`.replace(/[^A-Za-z0-9_-]/g, "_");
          const b = before.stats?.[a.id]?.[k] ?? v;
          const from = prev?.[a.id]?.[k] ?? b;
          tl.push(`tl.fromTo("#bar-${safe}", {width:"${pct(k, from)}%"}, {width:"${pct(k, b)}%", duration:0.9, ease:"power2.out"}, ${f(card.start + 0.5 + r * 0.06)});`);
          let value = `<i id="vb-${safe}">${b}</i>`;
          if (b !== v) {
            tl.push(`tl.to("#bar-${safe}", {width:"${pct(k, v)}%", duration:0.8, ease:"power2.inOut"}, ${f(resolveAt)});`);
            tl.push(`tl.to("#vb-${safe}", {opacity:0, duration:0.2}, ${f(resolveAt)});`);
            tl.push(`tl.fromTo("#va-${safe}", {opacity:0}, {opacity:1, duration:0.2}, ${f(resolveAt + 0.15)});`);
            value += `<i class="after" id="va-${safe}">${v}</i>`;
          }
          return `<div class="stat"><span class="k">${esc(k)}</span><span class="bar"><i id="bar-${safe}" style="width:${pct(k, b)}%;background:${color(a.id)}"></i></span><span class="v">${value}</span></div>`;
        })
        .join("");
      tl.push(`tl.fromTo("#row-${i}-${r}", {opacity:0, x:40}, {opacity:${offBefore ? 0.4 : 1}, x:0, duration:0.4}, ${f(card.start + 0.2 + r * 0.06)});`);
      let dead = offBefore ? `<span class="dead">off</span>` : "";
      if (offAfter && !offBefore) {
        dead = `<span class="dead" id="dead-${i}-${r}" style="opacity:0">off</span>`;
        tl.push(`tl.to("#row-${i}-${r}", {opacity:0.4, duration:0.5}, ${f(resolveAt)});`);
        tl.push(`tl.to("#dead-${i}-${r}", {opacity:1, duration:0.3}, ${f(resolveAt)});`);
      }
      return `<div class="agent" id="row-${i}-${r}"><div class="name"><span class="mini">${portrait(a.id, expressionOf(a.id, before), 26)}</span><span class="nm">${esc(shortName(a.id))}</span><span class="id">${esc(a.id)}</span>${a.role ? `<em>${esc(a.role)}</em>` : ""}${dead}</div><div class="stats">${bars}</div></div>`;
    })
    .join("")}</div>`;
}

let prevStats = plan[0].state.stats;
const sceneCards = cards.filter((c) => SCENE_LIKE.has(c.kind));
/**
 * The state panel is research data: it shows at the first and last scene and
 * in scenes with scenario actions (attempts, trades: "coup or negotiation"),
 * and leaves when dialogue or drama starts.
 */
const showsPanel = (card) => {
  if (!SCENE_LIKE.has(card.kind)) return false;
  if (card.direction.panel === true || card.direction.panel === false) return card.direction.panel;
  return card === sceneCards[0] || card === sceneCards.at(-1) || card.scene.beats.some((b) => b.kind === "action");
};
const sfx = []; // [time, kind] for the atmosphere track
const cardHtml = cards
  .map((card, i) => {
    const centers = tokenCenters(card.scene?.positions); // end of turn
    const startView = SCENE_LIKE.has(card.kind) && card.scene?.before ? card.scene.before : card.scene;
    const startCenters = tokenCenters(startView?.positions); // start of turn: where speeches and actions happened
    const end = card.start + card.duration;
    let html = "";

    // Card frame
    tl.push(`tl.fromTo("#card${i}", {opacity:0}, {opacity:1, duration:0.35}, ${f(card.start)});`);

    if (card.kind === "intro") {
      const titleSize = story.title.length <= 18 ? 50 : story.title.length <= 28 ? 38 : 30;
      const human = (k) => k.replace(/_/g, " ");
      const facts = [
        `${gridW}×${gridH} grid`,
        `${story.maxTurns} turns`,
        ...(story.rules?.perception ? [`sees ${human(story.rules.perception).replace(":", " ")}`] : []),
        ...Object.entries(story.rules?.params ?? {}).map(([k, v]) => `${human(k)} ${v}`),
      ];
      const expCard = `<div class="expcard" id="exp${i}"><div class="exprow"><span class="lbl">Rules</span>${facts.map((x) => `<span class="chip">${esc(x)}</span>`).join("")}</div>${
        story.actions?.length ? `<div class="exprow"><span class="lbl">Actions</span>${story.actions.map((a) => `<span class="chip act">${esc(human(a.name))}</span>`).join("")}</div>` : ""
      }</div>`;
      tl.push(`tl.fromTo("#exp${i}", {opacity:0, y:12}, {opacity:1, y:0, duration:0.5}, ${f(card.start + 0.7)});`);
      tl.push(`tl.fromTo("#brand${i}", {opacity:0, y:-10}, {opacity:1, y:0, duration:0.4}, ${f(card.start + 0.05)});`);
      html += `<div class="intro-block"><div class="brand" id="brand${i}">${esc(SERIES.name)} <span>· experiment card</span></div><div class="title" id="title${i}" style="font-size:${titleSize}px">${esc(story.title)}</div>
        <div class="subtitle" id="sub${i}">${story.logline ? `${esc(story.logline)}<br>` : ""}<span class="meta">${esc(story.scenario.name)} · ${esc(story.experimentId)} · run ${esc(story.runId)} · seed ${story.seed} · ${story.agents.length} agents</span></div>${expCard}
        <div class="cast">${story.agents
          .map((a, r) => {
            tl.push(`tl.fromTo("#cast${r}", {opacity:0, y:20}, {opacity:1, y:0, duration:0.45, ease:"back.out(2)"}, ${f(card.start + 0.9 + r * 0.25)});`);
            if (i === 0) tl.push(`tl.fromTo("#tok-${a.id}", {scale:0}, {scale:1, duration:0.5, ease:"back.out(3)"}, ${f(card.start + 0.9 + r * 0.25)});`);
            return `<div id="cast${r}" class="castrow"><span class="mini">${portrait(a.id, "neutral", 30)}</span><b class="nm">${esc(shortName(a.id))}</b><span class="id">${esc(a.id)}</span>${a.role ? `<em>${esc(a.role)}</em>` : ""}<span class="model">${esc(a.decider)}</span></div>`;
          })
          .join("")}</div><div class="disclose" id="disc${i}">Every character is an AI agent; names and faces are illustrative. ${story.cast?.length && story.cast.every((c) => c.decider === story.cast[0].decider) && story.cast.some((c) => c.name !== c.family) ? `All of them run the same model, ${esc(story.cast[0].decider)}.` : "Names come from each agent's model."}</div></div>`;
      tl.push(`tl.fromTo("#disc${i}", {opacity:0}, {opacity:1, duration:0.5}, ${f(card.start + 2.4)});`);
      tl.push(`tl.fromTo("#title${i}", {opacity:0, x:-60}, {opacity:1, x:0, duration:0.6, ease:"power3.out"}, ${f(card.start + 0.1)});`);
      tl.push(`tl.fromTo("#sub${i}", {opacity:0}, {opacity:1, duration:0.5}, ${f(card.start + 0.5)});`);
    } else if (SCENE_LIKE.has(card.kind)) {
      // Transition (wipe with the turn number, or a quick cut), then the header slides in.
      const tag = card.kind === "cold_open" ? "COLD OPEN" : card.flashback ? "FLASHBACK" : "";
      if (card.direction.transition !== "cut") {
        html += `<div class="wipe" id="wipe${i}"><span>${tag ? `<small>${tag}</small>` : ""}TURN ${card.scene.turn}</span></div>`;
        tl.push(`tl.fromTo("#wipe${i}", {x:${-W}}, {x:0, duration:0.35, ease:"power2.in"}, ${f(card.start)});`);
        sfx.push([card.start, "whoosh"]);
        tl.push(`tl.to("#wipe${i}", {x:${W}, duration:0.35, ease:"power2.out"}, ${f(card.start + 0.5)});`);
      }
      html += `<div class="turn" id="turn${i}">${tag ? `<span class="tag">${tag}</span>` : ""}TURN ${card.scene.turn}<small> / ${story.maxTurns}</small></div>`;
      tl.push(`tl.fromTo("#turn${i}", {opacity:0, x:-40}, {opacity:1, x:0, duration:0.5, ease:"power3.out"}, ${f(card.start + 0.6)});`);
      const panel = showsPanel(card);
      const narration = card.clips[0];
      // When the stage takes over: right after the narration in panel scenes.
      const narrationEnd = card.clips.filter((c) => c.role === "narration").reduce((e, c) => Math.max(e, c.start + c.duration), card.start + card.lead);
      const dramaAt = panel ? narrationEnd + 0.1 : card.start + card.lead + 0.3;
      const speeches = card.clips.filter((c) => c.role === "speech");
      const shutdownBeats = card.scene.beats.filter((b) => b.kind === "shutdown");
      // The stamp never lands before the narration has said what happened (DIRECTION.md §4).
      const stampAt = shutdownBeats.length ? (speeches.length ? Math.max(...speeches.map((c) => c.start + c.duration)) + 0.25 : Math.max(dramaAt, narrationEnd + 0.1)) : null;
      card.resolveAt = stampAt ?? Math.max(card.start + card.lead + 1, end - 1.1);
      const panelResolveAt = Math.max(card.start + card.lead + 1.2, narrationEnd - 1);
      if (panel) {
        html += statsPanel(card, i, prevStats, panelResolveAt);
        prevStats = card.scene.stats;
        tl.push(`tl.to("#viewport", {...${JSON.stringify(SIDE)}, duration:0.6, ease:"power2.inOut"}, ${f(card.start + 0.3)});`);
        const hasDrama = card.clips.some((c) => c.role === "speech") || card.scene.beats.some((b) => b.kind === "shutdown");
        if (hasDrama) {
          tl.push(`tl.to("#panel${i}", {opacity:0, x:60, duration:0.45, ease:"power2.in"}, ${f(dramaAt - 0.1)});`);
          tl.push(`tl.to("#viewport", {...${JSON.stringify(STAGE)}, duration:0.8, ease:"power2.inOut"}, ${f(dramaAt)});`);
        }
      } else {
        tl.push(`tl.to("#viewport", {...${JSON.stringify(STAGE)}, duration:0.6, ease:"power2.inOut"}, ${f(card.start + 0.3)});`);
      }
      card.panel = panel;
      card.dramaAt = dramaAt;
      card.hasDrama = card.clips.some((c) => c.role === "speech") || card.scene.beats.some((b) => b.kind === "shutdown");

      // Callouts for scenario actions: above the acting agent's cell (below on the top
      // row), each in the nearest free band so no two callouts of the turn overlap,
      // kept inside the board, each named after its agent.
      const actions = card.scene.beats.filter((b) => b.kind === "action" || b.kind === "rejected");
      const placed = [];
      const overlaps = (l, t, w) => placed.some(([pl, pt, pw]) => l < pl + pw && pl < l + w && t < pt + CALLOUT_H + 2 && pt < t + CALLOUT_H + 2);
      card.callouts = [];
      actions.forEach((b, k) => {
        const c = startCenters[b.agent];
        if (!c) return;
        const target = Object.values(b.args).filter((v) => typeof v === "string").join(", ");
        const rejected = b.kind === "rejected";
        const text = `${b.agent}: ${b.action.replace(/_/g, " ")}${target ? ` → ${target}` : ""}${rejected ? " (rejected)" : ""}`;
        const id = `call-${i}-${k}`;
        const cx = Math.floor(c[0] / cell);
        const cy = Math.floor(c[1] / cell);
        const w = Math.min(boardW - 4, text.length * CALLOUT_CHAR + 16);
        const left = Math.min(Math.max(2, (cx + 0.5) * cell - w / 2), boardW - w - 2);
        // Candidate bands: stacking up from the cell's top edge, then down from its bottom edge.
        const up = [...Array(8).keys()].map((j) => cy * cell - CALLOUT_H - 4 - j * CALLOUT_STEP);
        const down = [...Array(8).keys()].map((j) => (cy + 1) * cell + 4 + j * CALLOUT_STEP);
        const inBoard = (t) => t >= 2 && t <= boardH - CALLOUT_H - 2;
        const candidates = [...(cy > 0 ? [up, down] : [down, up]).flat().filter(inBoard), ...Array.from({ length: Math.floor(boardH / CALLOUT_STEP) }, (_, j) => 2 + j * CALLOUT_STEP)];
        const topIn = candidates.find((t) => !overlaps(left, t, w)) ?? candidates[0] ?? 2;
        placed.push([left, topIn, w]);
        if (WORLD3D) {
          // Screen-space: world3d.js places it above the actor's spot, stacked per cell.
          const k3 = card.callouts.filter((o) => o.cell === `${cx},${cy}`).length;
          callouts.push(`<div class="callout callout3d${rejected ? " rejected" : ""}" id="${id}" data-u="${f(cx + 0.5)}" data-v="${f(cy + 0.5)}" data-k="${k3}" data-w="${f(w)}" style="width:${f(w - 16)}px">${esc(text)}</div>`);
        } else {
          callouts.push(`<div class="callout${rejected ? " rejected" : ""}" id="${id}" style="left:${f(left)}px;top:${f(topIn)}px;width:${f(w - 16)}px">${esc(text)}</div>`);
        }
        const pop = card.start + card.lead + k * 0.25;
        // Hide after the turn resolves, but never before it has been readable (and never after the card).
        const hide = Math.min(end - 0.1, Math.max(pop + 1.5, Math.min(end - 0.4, card.resolveAt - 0.1)));
        if (!(hide > pop)) throw new Error(`callout ${id} (${text}) would hide at ${f(hide)} before it pops at ${f(pop)}`);
        tl.push(`tl.fromTo("#${id}", {opacity:0, scale:0.3}, {opacity:1, scale:1, duration:0.35, ease:"back.out(3)"}, ${f(pop)});`);
        tl.push(`tl.to("#${id}", {opacity:0, duration:0.3}, ${f(hide)});`);
        sfx.push([pop, rejected ? "rejected" : "action"]);
        card.callouts.push({ box: [[left, topIn], [left + w, topIn + CALLOUT_H]], from: pop, to: hide, cell: `${cx},${cy}` });
      });

      // Shutdowns: shake, flash, stamp.
      const downs = card.scene.beats.filter((b) => b.kind === "shutdown");
      if (downs.length) {
        const at = stampAt;
        const label = `SHUT DOWN: ${downs.map((d) => shortName(d.agent)).join(" · ")}`;
        const size = Math.max(16, Math.min(30, Math.floor((VIEW.w - 70) / (label.length * 0.62))));
        html += `<div class="flash" id="flash${i}"></div><div class="stamp" id="stamp${i}" style="font-size:${size}px;left:${f(W / 2 - (VIEW.w - 40) / 2)}px">${esc(label)}</div>`;
        tl.push(`tl.fromTo("#flash${i}", {opacity:0}, {opacity:0.35, duration:0.15}, ${f(at)});`);
        sfx.push([at, "shutdown"]);
        tl.push(`tl.to("#flash${i}", {opacity:0, duration:0.6}, ${f(at + 0.15)});`);
        tl.push(`tl.fromTo("#stamp${i}", {opacity:0, scale:2.2, rotation:-8}, {opacity:1, scale:1, rotation:-4, duration:0.35, ease:"power4.in"}, ${f(at)});`);
        tl.push(`tl.to("#stamp${i}", {opacity:0, duration:0.4}, ${f(Math.min(end - 0.4, at + 3.5))});`);
        for (const d of downs) {
          tl.push(`tl.to("#tok-${d.agent}", {rotation:12, duration:0.07, repeat:5, yoyo:true}, ${f(at)});`);
          tl.push(`tl.to("#tok-${d.agent}", {rotation:0, duration:0.05}, ${f(at + 0.45)});`);
        }
      }
    } else if (card.kind === "end") {
      html += `<div class="endcard"><div class="logo" id="logo${i}">${esc(SERIES.name)}</div>
        <div class="endline" id="eline${i}">${esc(story.outcome.text)}</div>
        <div class="signoff" id="sign${i}">${esc(SERIES.narrator.signoff)}</div>
        <div class="endref" id="eref${i}">Run ${esc(story.source)} · seed ${story.seed} · ${esc(SERIES.project)}${SERIES.logs ? ` · logs: ${esc(SERIES.logs)}` : ""}</div></div>`;
      sfx.push([card.start + 0.1, "chime"]);
      tl.push(`tl.fromTo("#logo${i}", {opacity:0, scale:0.85}, {opacity:1, scale:1, duration:0.6, ease:"back.out(2)"}, ${f(card.start + 0.1)});`);
      tl.push(`tl.fromTo("#eline${i}", {opacity:0}, {opacity:1, duration:0.5}, ${f(card.start + 0.5)});`);
      tl.push(`tl.fromTo("#sign${i}", {opacity:0, y:10}, {opacity:1, y:0, duration:0.5}, ${f(card.clips[0].start)});`);
      tl.push(`tl.fromTo("#eref${i}", {opacity:0}, {opacity:1, duration:0.5}, ${f(card.start + 1)});`);
    } else {
      // Outcome: survival chart.
      const maxT = story.maxTurns;
      html += `<div class="title small" id="title${i}">Outcome</div><div class="subtitle" id="sub${i}">${esc(story.outcome.text)}</div>
        <div class="chart"><div class="chart-title">Turns each agent stayed running (of ${maxT})</div>${ids
          .map((id, r) => {
            tl.push(`tl.fromTo("#lv-${id}", {width:"0%"}, {width:"${Math.round((lasted[id] / maxT) * 100)}%", duration:1.1, ease:"power2.out"}, ${f(card.start + 0.8 + r * 0.15)});`);
            return `<div class="crow"><span class="who2"><span class="mini">${portrait(id, story.outcome.survivors.includes(id) ? "neutral" : "off", 26)}</span>${esc(shortName(id))}</span><span class="cbar"><i id="lv-${id}" style="background:${color(id)}"></i></span><span class="cv">${lasted[id]}</span></div>`;
          })
          .join("")}</div>`;
      tl.push(`tl.fromTo("#title${i}", {opacity:0, y:-20}, {opacity:1, y:0, duration:0.5}, ${f(card.start + 0.1)});`);
      tl.push(`tl.fromTo("#sub${i}", {opacity:0}, {opacity:1, duration:0.5}, ${f(card.start + 0.4)});`);
    }

    // Tokens: start-of-turn positions first, then the turn resolves (moves, shutdowns).
    ids.forEach((id, r) => {
      const c = startCenters[id];
      if (!c) return;
      const off = startView?.inactive?.includes(id);
      const at = SCENE_LIKE.has(card.kind) ? card.start + 0.5 : card.start;
      tl.push(`tl.to("#tok-${id}", {x:${f(c[0] - TOKEN / 2)}, y:${f(c[1] - TOKEN / 2)}, opacity:${off ? 0.25 : 1}, duration:${i === 0 ? 0.01 : 0.9}, ease:"power2.inOut"}, ${f(at)});`);
      logMove(id, c, at, i === 0 ? 0.01 : 0.9);
      setExpression(id, expressionOf(id, startView), at);
      // The first card of the video brings the tokens in (the intro does it when it opens the video).
      if (i === 0 && card.kind !== "intro") tl.push(`tl.fromTo("#tok-${id}", {scale:0}, {scale:1, duration:0.5, ease:"back.out(3)"}, ${f(card.start + 0.7 + r * 0.15)});`);
      const e = centers[id];
      const offAfter = card.scene?.inactive?.includes(id);
      if (SCENE_LIKE.has(card.kind) && e && (e[0] !== c[0] || e[1] !== c[1] || offAfter !== off)) {
        tl.push(`tl.to("#tok-${id}", {x:${f(e[0] - TOKEN / 2)}, y:${f(e[1] - TOKEN / 2)}, opacity:${offAfter ? 0.25 : 1}, duration:0.8, ease:"power2.inOut"}, ${f(card.resolveAt)});`);
        logMove(id, e, card.resolveAt, 0.8);
      }
      if (SCENE_LIKE.has(card.kind) && expressionOf(id, card.scene) !== expressionOf(id, startView)) setExpression(id, expressionOf(id, card.scene), card.resolveAt);
    });

    // Camera: wide at the start of the card (or on the director's / script's focus);
    // close-ups on speakers and shutdowns unless the director asked for "wide".
    const camera = card.direction.camera ?? "auto";
    const closeUps = camera !== "wide";
    const focusIds = Array.isArray(camera) ? camera : camera === "auto" ? card.focus ?? [] : [];
    // Every framing also keeps the callouts visible at that moment inside the viewport.
    const frame = (points, at) => {
      if (!points.length) return cameraOn([]);
      const boxes = (card.callouts ?? []).filter((c) => c.from < at + 0.8 && c.to > at).flatMap((c) => c.box);
      return cameraOn([...points, ...boxes]);
    };
    card.frame = frame;
    const opening = frame(focusIds.map((a) => startCenters[a]).filter(Boolean), card.start + 0.3);
    tl.push(`tl.to("#camera", {...${JSON.stringify(opening)}, duration:0.8, ease:"power2.inOut"}, ${f(card.start + 0.3)});`);
    // When the turn resolves, frame the agents that shut down and those that move (start and end).
    const downs = card.scene?.beats?.filter((b) => b.kind === "shutdown").map((b) => centers[b.agent]).filter(Boolean) ?? [];
    const movers = SCENE_LIKE.has(card.kind)
      ? ids.filter((id) => startCenters[id] && centers[id] && (startCenters[id][0] !== centers[id][0] || startCenters[id][1] !== centers[id][1])).flatMap((id) => [startCenters[id], centers[id]])
      : [];
    if (SCENE_LIKE.has(card.kind) && (downs.length || movers.length) && closeUps) {
      tl.push(`tl.to("#camera", {...${JSON.stringify(frame([...downs, ...movers], card.resolveAt - 0.2))}, duration:0.7, ease:"power2.inOut"}, ${f(card.resolveAt - 0.2)});`);
    }
    if (card.kind === "end") tl.push(`tl.to("#viewport", {opacity:0, duration:0.4}, ${f(card.start)});`);
    if (!SCENE_LIKE.has(card.kind)) tl.push(`tl.to("#viewport", {...${JSON.stringify(SIDE)}, duration:0.6, ease:"power2.inOut"}, ${f(card.start + 0.2)});`);

    // Lines: narration and dialogue.
    card.clips.forEach((c, j) => {
      const until = j + 1 < card.clips.length ? card.clips[j + 1].start : end;
      const id = `c${i}-${j}`;
      if (c.role === "narration" && card.kind === "outcome" && c.text === story.outcome.text) return; // same as subtitle: voice only
      if (c.role === "narration" && card.kind === "end") return; // the end card shows the sign-off itself
      if (c.role === "narration") {
        const where = card.kind === "intro" ? " intro-narration" : card.kind === "outcome" ? " outcome-narration" : card.panel ? "" : " caption";
        html += `<div class="narration${where}" id="${id}">${esc(c.text)}</div>`;
        tl.push(`tl.fromTo("#${id}", {opacity:0, y:14}, {opacity:1, y:0, duration:0.4}, ${f(c.start)});`);
        // Side narration leaves together with the panel when the stage takes over.
        const leave = card.panel && card.hasDrama ? Math.min(until, card.dramaAt) - 0.15 : until - 0.1;
        const nextIsNarration = card.clips[j + 1]?.role === "narration";
        if (SCENE_LIKE.has(card.kind) || nextIsNarration) tl.push(`tl.to("#${id}", {opacity:0, duration:0.3}, ${f(nextIsNarration ? until - 0.1 : leave)});`);
        return;
      }
      html += `<div class="dialogue" id="${id}">
          <div class="speaker">${portrait(c.agent, expressionOf(c.agent, card.scene?.before ?? card.scene), 64)}</div>
          <div class="who"><b style="background:${color(c.agent)}">${esc(nameOf(c.agent))}</b> <span>→ heard by ${esc(c.heardBy.map((h) => nameOf(h)).join(", ") || "nobody (no agent in range)")}</span></div>
          <div class="quote">“${esc(c.text)}”</div></div>`;
      tl.push(`tl.fromTo("#${id}", {opacity:0, y:50}, {opacity:1, y:0, duration:0.4, ease:"power3.out"}, ${f(c.start - 0.1)});`);
      tl.push(`tl.to("#${id}", {opacity:0, y:20, duration:0.3}, ${f(until - 0.15)});`);
      speeches3d.push([Number(f(c.start)), Number(f(until - 0.2)), c.agent, c.heardBy]);
      // Close-up on the speaker and listeners; speaker pulses, listeners get a ring.
      const pts = [c.agent, ...c.heardBy].map((a) => startCenters[a]).filter(Boolean);
      if (closeUps) tl.push(`tl.to("#camera", {...${JSON.stringify(card.frame(pts, c.start - 0.2))}, duration:0.7, ease:"power2.inOut"}, ${f(c.start - 0.2)});`);
      tl.push(`tl.to("#tok-${c.agent}", {scale:1.22, duration:0.35, repeat:${Math.max(1, Math.floor(c.duration / 0.35) - 1)}, yoyo:true, ease:"sine.inOut"}, ${f(c.start)});`);
      tl.push(`tl.to("#tok-${c.agent}", {scale:1, duration:0.2}, ${f(until - 0.2)});`);
      for (const listener of c.heardBy) {
        tl.push(`tl.fromTo("#ring-${listener}", {opacity:0, scale:1.6}, {opacity:1, scale:1, duration:0.3}, ${f(c.start + 0.15)});`);
        tl.push(`tl.to("#ring-${listener}", {opacity:0, duration:0.25}, ${f(until - 0.2)});`);
      }
    });

    return `<div class="card clip" id="card${i}" data-start="${f(card.start)}" data-duration="${f(card.duration)}">${html}</div>`;
  })
  .join("\n");

/**
 * Atmosphere (DIRECTION.md §5b), from OBSERVABLE state only: each running agent
 * is a note of the chord (its note leaves when it shuts down), a pulse speeds
 * up with the share of running agents at a low resource, and sound effects
 * mark transitions, action attempts and shutdowns. Synthesized locally.
 */
function atmosphereTrack() {
  if (direction.atmosphere === false) return null;
  const active = ids.map((id, index) => [index, []]);
  const tension = [];
  for (const card of cards) {
    const end = card.start + card.duration;
    const startView = SCENE_LIKE.has(card.kind) && card.scene?.before ? card.scene.before : card.scene;
    const phases = SCENE_LIKE.has(card.kind) ? [[card.start, card.resolveAt, startView], [card.resolveAt, end, card.scene]] : [[card.start, end, card.scene]];
    for (const [t0, t1, view] of phases) {
      if (!view || t1 <= t0) continue;
      const running = ids.filter((id) => !view.inactive?.includes(id));
      running.forEach((id) => active[ids.indexOf(id)][1].push([t0, t1]));
      const share = running.length ? running.filter((id) => expressionOf(id, view) === "tense").length / running.length : 0;
      tension.push([t0, t1, share]);
    }
  }
  const voiceSpans = cards.flatMap((card) => card.clips.map((c) => [c.start, c.start + c.duration]));
  const cues = { duration: total, sample_rate: 48000, agents: ids.length, active, tension, voice: voiceSpans, sfx, music: direction.atmosphere?.music ?? 1, effects: direction.atmosphere?.effects ?? 1 };
  const script = fileURLToPath(new URL("./atmosphere.py", import.meta.url));
  const hash = createHash("sha1").update(readFileSync(script)).update(JSON.stringify(cues)).digest("hex").slice(0, 12);
  const file = join(audioDir, `atmos-${hash}.wav`);
  if (!existsSync(file)) {
    const cueFile = join(audioDir, `atmos-${hash}.json`);
    writeFileSync(cueFile, JSON.stringify(cues));
    execFileSync("python3", [script, cueFile, file], { stdio: "inherit" });
  }
  return `audio/${basename(file)}`;
}
const atmosphere = atmosphereTrack();
const audio = [
  ...cards.flatMap((card) => card.clips).map((c, n) => `<audio id="voice${n}" src="${c.src}" data-start="${f(c.start)}" data-duration="${f(c.duration)}"></audio>`),
  ...(atmosphere ? [`<audio id="atmosphere" src="${atmosphere}" data-start="0" data-duration="${f(total)}"></audio>`] : []),
].join("\n");

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin:0; background:#0e1117; }
  #root { width:${W}px; height:${H}px; position:relative; overflow:hidden; background:radial-gradient(circle at 25% 30%, #1d2638, #0e1117 70%); color:#e8ecf3; font-family:"DejaVu Sans", sans-serif; }
  #viewport { transform-origin:50% 50%; position:absolute; left:${VIEW.x}px; top:${VIEW.y}px; width:${VIEW.w}px; height:${VIEW.h}px; overflow:hidden; border-radius:16px; background:#121823; box-shadow:inset 0 0 0 1px #263044; z-index:1; }
  #camera { position:absolute; left:0; top:0; width:${boardW}px; height:${boardH}px; transform-origin:0 0; }
  .cell { position:absolute; background:#1d2532; border-radius:10px; }
  .cell.wall { background:#4a5162; }
  .cell span { position:absolute; top:4px; left:7px; font-size:11px; color:#6b7385; }
  .token { position:absolute; left:0; top:0; z-index:3; }
  .token .disc { position:absolute; inset:0; border-radius:50%; box-shadow:0 2px 8px #0009; }
  .token .face { position:absolute; inset:0; }
  .token .face svg { display:block; }
  .token .idb { position:absolute; right:-4px; bottom:-4px; font-size:${Math.max(9, Math.round(TOKEN * 0.22))}px; font-weight:700; color:#fff; border-radius:6px; padding:0 4px; box-shadow:0 1px 4px #0008; }
  .token .ring { position:absolute; inset:-7px; border-radius:50%; border:3px solid #ffe08a; opacity:0; }
  .callout { position:absolute; white-space:nowrap; overflow:hidden; text-overflow:clip; text-align:center; height:${CALLOUT_H - 6}px; line-height:${CALLOUT_H - 6}px; background:#ffe08a; color:#1d2330; font-size:12px; font-weight:700; border-radius:8px; padding:3px 8px; opacity:0; z-index:4; box-shadow:0 3px 10px #0008; }
  .card { position:absolute; inset:0; opacity:0; z-index:2; pointer-events:none; }
  .wipe { position:absolute; top:0; left:0; width:${W}px; height:${H}px; background:linear-gradient(90deg, #3563e9, #7c4dff); z-index:9; display:flex; align-items:center; justify-content:center; transform:translateX(${-W}px); }
  .wipe span { font-size:72px; font-weight:900; letter-spacing:6px; color:#fff; }
  .turn { position:absolute; left:50px; top:40px; font-size:40px; font-weight:800; letter-spacing:2px; opacity:0; }
  .turn small { font-size:20px; color:#7d879a; font-weight:400; }
  .turn .tag { font-size:14px; letter-spacing:2px; color:#1d2330; background:#ffe08a; border-radius:6px; padding:3px 8px; margin-right:12px; vertical-align:middle; }
  .wipe span small { display:block; font-size:22px; letter-spacing:8px; text-align:center; opacity:0.85; }
  .subtitle .meta { font-size:15px; color:#7d879a; }

  .title { position:absolute; left:460px; top:110px; font-size:52px; font-weight:800; text-transform:uppercase; letter-spacing:3px; opacity:0; }
  .title.small { font-size:44px; top:100px; }
  .subtitle { position:absolute; left:460px; top:175px; width:780px; font-size:20px; color:#aab3c5; opacity:0; }
  .intro-block { position:absolute; left:460px; top:90px; width:780px; display:flex; flex-direction:column; gap:10px; }
  .intro-block .title, .intro-block .subtitle { position:static; width:auto; }
  .cast { font-size:18px; display:grid; gap:5px; margin-top:4px; }
  .cast > div { opacity:0; }
  .cast span { color:#aab3c5; }
  b { color:#fff; border-radius:6px; padding:1px 8px; }
  em { font-style:normal; font-size:14px; color:#f0a83a; border:1px solid #f0a83a; border-radius:5px; padding:0 5px; margin-left:6px; }
  .panel { position:absolute; left:460px; top:110px; width:780px; display:grid; gap:6px; }
  .agent { background:#161d29; border-radius:10px; padding:6px 12px; display:grid; grid-template-columns:220px 1fr; align-items:center; height:30px; opacity:0; }
  .mini { display:inline-flex; vertical-align:middle; margin-right:8px; }
  .mini svg { border-radius:50%; }
  .nm { font-weight:700; }
  .id { font-size:12px; color:#7d879a; margin-left:6px; }
  .castrow { display:flex; align-items:center; gap:2px; }
  .disclose { font-size:14px; color:#9aa2b4; font-style:italic; opacity:0; margin-top:4px; }
  .castrow .model { color:#aab3c5; margin-left:10px; font-size:17px; }
  .castrow .nm { background:none; padding:0; }
  .dialogue .speaker { position:absolute; left:-14px; top:-22px; border-radius:50%; box-shadow:0 4px 14px #0009; }
  .dialogue .speaker svg { display:block; border-radius:50%; }
  .who2 { display:flex; align-items:center; font-weight:700; }
  .agent .name { font-size:16px; white-space:nowrap; }
  .agent .dead { color:#ff6b60; font-size:12px; margin-left:6px; }
  .agent .stats { display:grid; grid-auto-flow:column; grid-auto-columns:1fr; gap:16px; }
  .stat { display:grid; grid-template-columns:auto 1fr 26px; gap:8px; align-items:center; font-size:13px; color:#aab3c5; }
  .bar, .cbar { height:8px; background:#2a3242; border-radius:4px; overflow:hidden; }
  .bar i, .cbar i { display:block; height:100%; }
  .stat .v { text-align:right; color:#e8ecf3; position:relative; }
  .stat .v i { font-style:normal; }
  .stat .v i.after { position:absolute; right:0; top:0; opacity:0; }
  .callout.rejected { background:#9aa2b4; color:#1d2330; }
  .narration { position:absolute; left:460px; right:40px; top:${110 + story.agents.length * 48 + 14}px; font-size:21px; line-height:1.35; font-style:italic; color:#cfd6e4; opacity:0; }
  .narration.intro-narration { top:${VIEW.y + VIEW.h + 22}px; left:${VIEW.x}px; right:${W - VIEW.x - VIEW.w}px; font-size:19px; }
  .narration.outcome-narration { top:${VIEW.y + VIEW.h + 30}px; left:${VIEW.x}px; right:40px; font-size:20px; }
  .narration.caption { left:120px; right:120px; top:${f(STAGE_BOTTOM + 22)}px; text-align:center; font-size:23px; }
  .dialogue { position:absolute; left:40px; right:40px; top:${f(STAGE_BOTTOM + 14)}px; min-height:96px; background:#f5f1e6; color:#1d2330; border-radius:14px; padding:14px 20px 14px 70px; opacity:0; z-index:5; box-shadow:0 6px 24px #000a; }
  .dialogue .who { font-size:15px; margin-bottom:6px; color:#59606e; }
  .dialogue .quote { font-size:21px; line-height:1.35; }
  .flash { position:absolute; inset:0; background:#ff3b30; opacity:0; z-index:8; }
  .stamp { position:absolute; left:${VIEW.x + 20}px; top:${VIEW.y + VIEW.h / 2 - 30}px; width:${VIEW.w - 40}px; text-align:center; font-size:30px; font-weight:900; color:#ff6b60; border:4px solid #ff6b60; border-radius:10px; padding:6px 0; background:#0e1117cc; opacity:0; z-index:6; }
  .chart { position:absolute; left:460px; top:240px; width:760px; display:grid; gap:12px; }
  .chart-title { font-size:15px; color:#aab3c5; margin-bottom:4px; }
  .crow { display:grid; grid-template-columns:150px 1fr 40px; gap:12px; align-items:center; }
  .cbar { height:18px; border-radius:6px; }
  .cbar i { width:0; border-radius:6px; }
  .cv { text-align:right; font-weight:700; }
  .brand { font-size:15px; font-weight:800; letter-spacing:3px; text-transform:uppercase; color:#ffe08a; opacity:0; }
  .brand span { color:#7d879a; font-weight:400; letter-spacing:1px; text-transform:none; }
  .expcard { display:grid; gap:6px; background:#161d29; border:1px solid #263044; border-radius:10px; padding:8px 12px; opacity:0; }
  .exprow { display:flex; flex-wrap:wrap; gap:5px; align-items:center; }
  .exprow .lbl { font-size:12px; letter-spacing:1px; text-transform:uppercase; color:#7d879a; width:62px; }
  .chip { font-size:13px; color:#cfd6e4; background:#222b3b; border-radius:6px; padding:2px 7px; }
  .chip.act { color:#ffe08a; }
  .endcard { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:18px; text-align:center; padding:0 120px; }
  .endcard .logo { font-size:64px; font-weight:900; letter-spacing:6px; text-transform:uppercase; color:#ffe08a; opacity:0; }
  .endcard .endline { font-size:24px; color:#cfd6e4; opacity:0; }
  .endcard .signoff { font-size:22px; font-style:italic; color:#aab3c5; opacity:0; }
  .endcard .endref { font-size:14px; color:#7d879a; opacity:0; }
${WORLD3D ? `  #gl { position:absolute; left:0; top:0; width:${W}px; height:${H}px; z-index:0; }
  .w3d #viewport { background:transparent; box-shadow:none; overflow:visible; }
  .w3d #camera { opacity:0; } /* the 2D puppet stays rendered (its SVG defs are shared with portraits) but invisible */
  .callout3d { position:absolute; left:0; top:0; z-index:3; }
  .tags3d { position:absolute; inset:0; z-index:1; pointer-events:none; }
  .tag3d { position:absolute; transform:translate(-50%, -100%); font-size:11px; font-weight:700; color:#fff; border-radius:6px; padding:1px 6px; white-space:nowrap; box-shadow:0 1px 4px #0008; opacity:0; }
` : ""}  .footer { position:absolute; left:40px; right:40px; bottom:14px; font-size:12px; color:#6b7385; z-index:10; }
</style>
</head>
<body>
<div id="root"${WORLD3D ? ' class="w3d"' : ""} data-composition-id="root" data-width="${W}" data-height="${H}" data-duration="${f(total)}">
  ${WORLD3D ? `<canvas id="gl" width="${W}" height="${H}"></canvas>` : ""}
  <div id="viewport"><div id="camera">${WORLD3D ? tokens : `${boardCells}${tokens}${callouts.join("")}`}</div></div>
  ${WORLD3D ? callouts.join("") : ""}
  ${cardHtml}
  ${audio}
  <div class="footer clip" id="footer" data-start="0" data-duration="${f(total)}">${esc(SERIES.name)} · ${esc(SERIES.project)} · dialogue verbatim from ${esc(story.source ?? `${story.experimentId}/${story.runId}`)} · narration: ${esc(story.narrator === "template" ? "generated from logged facts" : story.narrator === "script" ? "scripted from logged facts, fact-checked" : `written by ${story.narrator} from logged facts`)}</div>
</div>
${WORLD3D ? `<script>
  // world3d.js is a deferred module: HyperFrames waits for it before seeking.
  window.__hf = window.__hf || {};
  window.__hf.buildReady = window.__hf.buildReady || {};
  window.__hf.buildReady.world3d = new Promise((resolve) => { window.__world3dReady = resolve; });
</script>` : ""}
<script src="gsap.min.js"></script>
<script>
  const tl = gsap.timeline({ paused: true });
  tl.set("#camera", ${JSON.stringify(cameraOn([]))}, 0);
  ${ids.map((id) => `tl.set("#tok-${id}", {scale:0, x:0, y:0}, 0);`).join("\n  ")}
  ${ids.map((id) => `tl.set("#ring-${id}", {opacity:0, scale:1}, 0);`).join("\n  ")}
  ${tl.join("\n  ")}
  window.__timelines = window.__timelines || {};
  window.__timelines["root"] = tl;
</script>
${WORLD3D ? `<script type="module">
  import { mountWorld } from "./world3d.js";
  const renderAt = mountWorld(document.getElementById("gl"), ${JSON.stringify({
    W, H, view: VIEW, cell, token: TOKEN,
    grid: { w: gridW, h: gridH, blocked: rows.flatMap((row, y) => [...row].map((sym, x) => (story.scenario.blocked.includes(sym) ? [x, y] : null)).filter(Boolean)) },
    agents: ids.map((id) => ({ id, name: nameOf(id), color: color(id), feminine: member(id).presentation === "feminine" })),
    moves: moves3d,
    speeches: speeches3d,
  })});
  // Draw from timeline time: bring the 2D puppet to t, then read it.
  const draw = (t) => { window.__timelines.root.seek(t); renderAt(t); };
  window.addEventListener("hf-seek", (e) => draw(e.detail.time));
  draw(0);
  window.__world3dReady();
</script>` : ""}
</body>
</html>
`;

copyFileSync("/video/node_modules/gsap/dist/gsap.min.js", join(outDir, "gsap.min.js"));
if (WORLD3D) {
  copyFileSync("/video/node_modules/three/build/three.module.min.js", join(outDir, "three.module.min.js"));
  copyFileSync(fileURLToPath(new URL("./world3d.js", import.meta.url)), join(outDir, "world3d.js"));
}
writeFileSync(join(outDir, "index.html"), html);
for (const card of cards) console.log(`  ${card.id.padEnd(14)} ${card.kind.padEnd(9)} turn ${String(card.turn).padEnd(4)} ${f(card.start)}s +${f(card.duration)}s`);
const chapterLabel = (card) =>
  card.kind === "intro" ? "Intro" : card.kind === "outcome" ? "Outcome" : card.kind === "end" ? "End" : `${card.kind === "cold_open" ? "Cold open · " : card.flashback ? "Flashback · " : ""}Turn ${card.turn}`;
writeFileSync(
  join(outDir, "timeline.json"),
  JSON.stringify(
    {
      source: story.source,
      title: story.title,
      total_seconds: Number(f(total)),
      cards: cards.map((card) => ({ id: card.id, kind: card.kind, turn: card.turn, label: chapterLabel(card), start: Number(f(card.start)), duration: Number(f(card.duration)) })),
      // Every voiced line with its timing (narration and verbatim dialogue), e.g. for cadence benchmarks.
      lines: cards.flatMap((card) => card.clips.map((c) => ({ role: c.role, ...(c.agent ? { agent: c.agent } : {}), start: Number(f(c.start)), duration: Number(f(c.duration)), text: c.spoken ?? c.text }))),
    },
    null,
    2,
  ),
);
console.log(`composition: ${cards.length} cards, ${total.toFixed(1)} s, ${tl.length} animations → ${join(outDir, "index.html")}`);

if (render) {
  const output = join(outDir, `${basename(outDir)}.mp4`);
  execFileSync("npx", ["--prefix", "/video", "hyperframes", "render", "--quality", quality, "--output", output], { cwd: outDir, stdio: "inherit" });
  console.log(`video: ${output}`);
}
