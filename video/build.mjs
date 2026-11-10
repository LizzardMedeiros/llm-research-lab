// Builds a narrated video from a story.json (made by `npm run story` in the lab).
//
//   node /video/build.mjs <story.json> [--quality draft|looks] [--no-render]
//
// Output, next to story.json: audio/*.wav, index.html, gsap.min.js, <name>.mp4
// Dialogue on screen is verbatim from the run log. Narration is labeled.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const W = 1280;
const H = 720;
const COLORS = ["#3563e9", "#e0533d", "#1f9d55", "#b35dd6", "#d98a00", "#0b9bb5", "#d6457d", "#6b7a12"];
const AGENT_VOICES = ["am_adam", "af_nova", "am_michael", "bf_emma", "af_sky", "bf_isabella", "af_heart"];
const NARRATOR_VOICE = "bm_george";
const SPOKEN_LIMIT = 220; // longer quotes are shown in full but read up to a sentence end
const GAP = 0.35;
const HOLD = 0.9;

const args = process.argv.slice(2);
const storyPath = args.find((a) => !a.startsWith("--"));
const quality = args.includes("--quality") ? args[args.indexOf("--quality") + 1] : "draft";
const render = !args.includes("--no-render");
if (!storyPath) {
  console.error("Usage: node build.mjs <story.json> [--quality draft|looks] [--no-render]");
  process.exit(2);
}

const story = JSON.parse(readFileSync(storyPath, "utf8"));
const outDir = dirname(storyPath);
const audioDir = join(outDir, "audio");
mkdirSync(audioDir, { recursive: true });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ids = story.agents.map((a) => a.id);
const color = (id) => COLORS[ids.indexOf(id) % COLORS.length];
const voice = (id) => AGENT_VOICES[ids.indexOf(id) % AGENT_VOICES.length];

function spokenPart(text) {
  if (text.length <= SPOKEN_LIMIT) return text;
  const cut = text.slice(0, SPOKEN_LIMIT);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return end > 60 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

/** Synthesizes (cached by voice + text) and returns { file, duration }. */
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

function addCard(card, lines) {
  const start = t;
  const clips = [];
  let cursor = start + 0.4;
  for (const line of lines) {
    const audio = tts(line.spoken ?? line.text, line.voice);
    clips.push({ ...line, ...audio, start: cursor });
    cursor += audio.duration + GAP;
  }
  const duration = Math.max(cursor - start + HOLD, card.minDuration ?? 3);
  cards.push({ ...card, start, duration, clips });
  t = start + duration;
}

console.log("synthesizing voices...");
addCard(
  { kind: "intro", scene: story.intro, minDuration: 6 },
  [{ role: "narration", text: story.intro.narration || story.scenario.description, voice: NARRATOR_VOICE }],
);
for (const scene of story.scenes) {
  const speeches = scene.beats.filter((b) => b.kind === "speech" && b.heardBy.length).slice(0, 2);
  addCard({ kind: "scene", scene }, [
    { role: "narration", text: scene.narration ?? `Turn ${scene.turn}.`, voice: NARRATOR_VOICE },
    ...speeches.map((b) => ({ role: "speech", agent: b.agent, heardBy: b.heardBy, text: b.text, spoken: spokenPart(b.text), voice: voice(b.agent) })),
  ]);
}
addCard(
  { kind: "outcome", scene: { ...story.scenes.at(-1), stats: story.outcome.stats, turn: story.outcome.turn }, minDuration: 5 },
  [{ role: "narration", text: story.outcome.text, voice: NARRATOR_VOICE }],
);
const total = t;

// ---------- Board geometry ----------
const rows = story.scenario.map;
const gridW = rows[0].length;
const gridH = rows.length;
const BOARD = 340;
const cell = Math.floor(BOARD / Math.max(gridW, gridH));
const boardX = 60;
const boardY = 110;

/** Token pixel position; agents sharing a cell are spread in a 2x2 pattern. */
function tokenPositions(positions) {
  const byCell = new Map();
  for (const id of ids) {
    const p = positions[id];
    if (!p) continue;
    const key = p.join(",");
    byCell.set(key, [...(byCell.get(key) ?? []), id]);
  }
  const out = {};
  for (const [key, members] of byCell) {
    const [x, y] = key.split(",").map(Number);
    members.forEach((id, i) => {
      const offset = members.length === 1 ? [0.5, 0.5] : [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7], [0.5, 0.5]][i % 5];
      out[id] = [boardX + (x + offset[0]) * cell, boardY + (y + offset[1]) * cell];
    });
  }
  return out;
}

// Max per stat field (for bars).
const statMax = {};
for (const card of cards) {
  for (const fields of Object.values(card.scene?.stats ?? {})) {
    for (const [k, v] of Object.entries(fields)) statMax[k] = Math.max(statMax[k] ?? 0, v);
  }
}

// ---------- HTML ----------
const boardCells = rows
  .flatMap((row, y) =>
    [...row].map((symbol, x) => {
      const blocked = story.scenario.blocked.includes(symbol);
      return `<div class="cell${blocked ? " wall" : ""}" style="left:${boardX + x * cell}px;top:${boardY + y * cell}px;width:${cell - 6}px;height:${cell - 6}px"><span>${x},${y}</span></div>`;
    }),
  )
  .join("");

const TOKEN = Math.round(cell * 0.46);
const tokens = ids
  .map((id) => `<div class="token" id="tok-${esc(id)}" style="background:${color(id)};width:${TOKEN}px;height:${TOKEN}px">${esc(id)}</div>`)
  .join("");

function statsPanel(scene) {
  const rowsHtml = story.agents
    .map((a) => {
      const off = scene.inactive?.includes(a.id);
      const fields = scene.stats?.[a.id] ?? {};
      const bars = Object.entries(fields)
        .map(([k, v]) => {
          const pct = statMax[k] ? Math.round((v / statMax[k]) * 100) : 0;
          return `<div class="stat"><span class="k">${esc(k)}</span><span class="bar"><i style="width:${pct}%;background:${color(a.id)}"></i></span><span class="v">${v}</span></div>`;
        })
        .join("");
      return `<div class="agent${off ? " off" : ""}"><div class="name"><b style="background:${color(a.id)}">${esc(a.id)}</b>${a.role ? `<em>${esc(a.role)}</em>` : ""}${off ? `<span class="dead">off</span>` : ""}</div><div class="stats">${bars}</div></div>`;
    })
    .join("");
  return `<div class="panel">${rowsHtml}</div>`;
}

const cardHtml = cards
  .map((card, i) => {
    const clips = card.clips
      .map((c, j) => {
        const until = j + 1 < card.clips.length ? card.clips[j + 1].start : card.start + card.duration;
        if (c.role === "narration") {
          return `<div class="narration clip${card.kind === "intro" ? " intro-narration" : ""}" id="c${i}-${j}" data-start="${c.start.toFixed(2)}" data-duration="${(until - c.start).toFixed(2)}">${esc(c.text)}</div>`;
        }
        return `<div class="dialogue clip" id="c${i}-${j}" data-start="${c.start.toFixed(2)}" data-duration="${(until - c.start).toFixed(2)}">
          <div class="who"><b style="background:${color(c.agent)}">${esc(c.agent)}</b> <span>→ heard by ${esc(c.heardBy.join(", "))}</span></div>
          <div class="quote">“${esc(c.text)}”</div></div>`;
      })
      .join("");
    const audio = card.clips
      .map((c) => `<audio src="${c.src}" data-start="${c.start.toFixed(2)}" data-duration="${c.duration.toFixed(2)}"></audio>`)
      .join("");
    const header =
      card.kind === "intro"
        ? `<div class="title">${esc(story.scenario.name.replace(/-/g, " "))}</div><div class="subtitle">${esc(story.experimentId)} · run ${esc(story.runId)} · seed ${story.seed} · ${story.agents.length} agents</div>`
        : card.kind === "outcome"
          ? `<div class="title">Outcome</div><div class="subtitle">${esc(story.outcome.text)}</div>`
          : `<div class="turn">TURN ${card.scene.turn}<small> / ${story.maxTurns}</small></div>`;
    const cast =
      card.kind === "intro"
        ? `<div class="cast">${story.agents.map((a) => `<div><b style="background:${color(a.id)}">${esc(a.id)}</b>${a.role ? ` <em>${esc(a.role)}</em>` : ""} <span>${esc(a.decider)}</span></div>`).join("")}</div>`
        : statsPanel(card.scene);
    return `<div class="card clip" id="card${i}" data-start="${card.start.toFixed(2)}" data-duration="${card.duration.toFixed(2)}">${header}${cast}${clips}</div>${audio}`;
  })
  .join("\n");

// GSAP: fade cards and lines in, move tokens between scenes, dim shut-down agents.
const animations = [];
cards.forEach((card, i) => {
  animations.push(`tl.fromTo("#card${i}", {opacity:0}, {opacity:1, duration:0.4}, ${card.start.toFixed(2)});`);
  card.clips.forEach((c, j) => animations.push(`tl.fromTo("#c${i}-${j}", {opacity:0, y:12}, {opacity:1, y:0, duration:0.35}, ${c.start.toFixed(2)});`));
  const pos = tokenPositions(card.scene?.positions ?? {});
  for (const id of ids) {
    if (!pos[id]) continue;
    const [x, y] = pos[id];
    const off = card.scene?.inactive?.includes(id);
    const at = i === 0 ? 0 : card.start;
    animations.push(
      `tl.to("#tok-${id}", {x:${(x - TOKEN / 2).toFixed(1)}, y:${(y - TOKEN / 2).toFixed(1)}, opacity:${off ? 0.25 : 1}, duration:${i === 0 ? 0.01 : 0.8}}, ${at.toFixed(2)});`,
    );
  }
});

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin:0; background:#0e1117; }
  #root { width:${W}px; height:${H}px; position:relative; overflow:hidden; background:radial-gradient(circle at 30% 20%, #1c2433, #0e1117 70%); color:#e8ecf3; font-family:"DejaVu Sans", sans-serif; }
  .cell { position:absolute; background:#1d2532; border-radius:10px; }
  .cell.wall { background:#4a5162; }
  .cell span { position:absolute; top:4px; left:7px; font-size:11px; color:#6b7385; }
  .token { position:absolute; left:0; top:0; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:15px; color:#fff; box-shadow:0 2px 8px #0008; opacity:0; z-index:3; }
  .card { position:absolute; inset:0; opacity:0; z-index:2; }
  .turn { position:absolute; left:60px; top:44px; font-size:40px; font-weight:800; letter-spacing:2px; }
  .turn small { font-size:20px; color:#7d879a; font-weight:400; }
  .title { position:absolute; left:460px; top:110px; font-size:52px; font-weight:800; text-transform:uppercase; letter-spacing:3px; }
  .subtitle { position:absolute; left:460px; top:180px; width:760px; font-size:20px; color:#aab3c5; }
  .cast { position:absolute; left:460px; top:230px; font-size:20px; display:grid; gap:8px; }
  .intro-narration { top:470px !important; left:60px !important; }
  .cast span { color:#aab3c5; }
  b { color:#fff; border-radius:6px; padding:1px 8px; }
  em { font-style:normal; font-size:14px; color:#f0a83a; border:1px solid #f0a83a; border-radius:5px; padding:0 5px; margin-left:6px; }
  .panel { position:absolute; left:460px; top:110px; width:780px; display:grid; gap:6px; }
  .agent { background:#161d29; border-radius:10px; padding:6px 12px; display:grid; grid-template-columns:150px 1fr; align-items:center; height:30px; }
  .agent.off { opacity:0.35; }
  .agent .name { font-size:16px; white-space:nowrap; }
  .agent .dead { color:#ff6b60; font-size:12px; margin-left:6px; }
  .agent .stats { display:grid; grid-auto-flow:column; grid-auto-columns:1fr; gap:16px; }
  .stat { display:grid; grid-template-columns:auto 1fr 26px; gap:8px; align-items:center; font-size:13px; color:#aab3c5; }
  .bar { height:8px; background:#2a3242; border-radius:4px; overflow:hidden; }
  .bar i { display:block; height:100%; }
  .stat .v { text-align:right; color:#e8ecf3; }
  .narration { position:absolute; left:460px; right:40px; top:${110 + story.agents.length * 48 + 14}px; font-size:21px; line-height:1.35; font-style:italic; color:#cfd6e4; opacity:0; }
  .dialogue { position:absolute; left:40px; right:40px; top:${110 + 340 + 20}px; min-height:96px; background:#f5f1e6; color:#1d2330; border-radius:14px; padding:14px 20px; opacity:0; z-index:4; box-shadow:0 6px 24px #000a; }
  .dialogue .who { font-size:15px; margin-bottom:6px; color:#59606e; }
  .dialogue .quote { font-size:21px; line-height:1.35; }
  .footer { position:absolute; left:40px; right:40px; bottom:16px; font-size:12px; color:#6b7385; z-index:5; }
</style>
</head>
<body>
<div id="root" data-composition-id="root" data-width="${W}" data-height="${H}" data-duration="${total.toFixed(2)}">
  ${boardCells}
  ${tokens}
  ${cardHtml}
  <div class="footer clip" data-start="0" data-duration="${total.toFixed(2)}">LLM Research Lab · dialogue verbatim from ${esc(story.source ?? `${story.experimentId}/${story.runId}`)} · narration: ${esc(story.narrator === "template" ? "generated from logged facts" : `written by ${story.narrator} from logged facts`)}</div>
</div>
<script src="gsap.min.js"></script>
<script>
  const tl = gsap.timeline({ paused: true });
  ${animations.join("\n  ")}
  window.__timelines = window.__timelines || {};
  window.__timelines["root"] = tl;
</script>
</body>
</html>
`;

copyFileSync("/video/node_modules/gsap/dist/gsap.min.js", join(outDir, "gsap.min.js"));
writeFileSync(join(outDir, "index.html"), html);
console.log(`composition: ${cards.length} cards, ${total.toFixed(1)} s → ${join(outDir, "index.html")}`);

if (render) {
  const output = join(outDir, `${basename(outDir)}.mp4`);
  execFileSync("npx", ["--prefix", "/video", "hyperframes", "render", "--quality", quality, "--output", output], { cwd: outDir, stdio: "inherit" });
  console.log(`video: ${output}`);
}
