// Builds a narrated video from a story.json (made by `npm run story` in the lab).
//
//   node /video/build.mjs <story.json> [--quality draft|looks] [--no-render]
//
// Output, next to story.json: audio/*.wav, index.html, gsap.min.js, <name>.mp4
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

const W = 1280;
const H = 720;
const COLORS = ["#3563e9", "#e0533d", "#1f9d55", "#b35dd6", "#d98a00", "#0b9bb5", "#d6457d", "#6b7a12"];
const AGENT_VOICES = ["am_adam", "af_nova", "am_michael", "bf_emma", "af_sky", "bf_isabella", "af_heart"];
const NARRATOR_VOICE = "bm_george";
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

const story = JSON.parse(readFileSync(storyPath, "utf8"));
const outDir = dirname(resolve(storyPath));
const audioDir = join(outDir, "audio");
mkdirSync(audioDir, { recursive: true });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ids = story.agents.map((a) => a.id);
const color = (id) => COLORS[ids.indexOf(id) % COLORS.length];
const voice = (id) => AGENT_VOICES[ids.indexOf(id) % AGENT_VOICES.length];
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

function addCard(card, lines) {
  const start = t;
  const clips = [];
  let cursor = start + (card.kind === "scene" ? WIPE : 0.5);
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
addCard({ kind: "intro", scene: story.intro, minDuration: 7 }, [
  { role: "narration", text: story.intro.narration || story.scenario.description, voice: NARRATOR_VOICE },
]);
for (const scene of story.scenes) {
  const speeches = scene.beats.filter((b) => b.kind === "speech" && b.heardBy.length).slice(0, 2);
  addCard({ kind: "scene", scene }, [
    { role: "narration", text: scene.narration ?? `Turn ${scene.turn}.`, voice: NARRATOR_VOICE },
    ...speeches.map((b) => ({ role: "speech", agent: b.agent, heardBy: b.heardBy, text: b.text, spoken: spokenPart(b.text), voice: voice(b.agent) })),
  ]);
}
const lastScene = story.scenes.at(-1) ?? story.intro;
addCard(
  { kind: "outcome", scene: { ...lastScene, stats: story.outcome.stats, turn: story.outcome.turn, inactive: ids.filter((id) => !story.outcome.survivors.includes(id)) }, minDuration: 8 },
  [{ role: "narration", text: story.outcome.text, voice: NARRATOR_VOICE }],
);
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

// Survival per agent (for the outcome chart).
const shutdownTurn = {};
for (const scene of story.scenes) for (const b of scene.beats) if (b.kind === "shutdown") shutdownTurn[b.agent] ??= scene.turn;
const lasted = Object.fromEntries(ids.map((id) => [id, shutdownTurn[id] ?? story.outcome.turn]));

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
      <div class="disc" style="background:${color(id)}">${esc(id)}</div>
    </div>`,
  )
  .join("");

const tl = []; // GSAP calls, in order
const callouts = []; // per-card callout elements (inside the camera)

function statsPanel(card, i, prev) {
  return `<div class="panel" id="panel${i}">${story.agents
    .map((a, r) => {
      const off = card.scene.inactive?.includes(a.id);
      const fields = card.scene.stats?.[a.id] ?? {};
      const bars = Object.entries(fields)
        .map(([k, v]) => {
          const id = `bar-${i}-${a.id}-${k}`.replace(/[^A-Za-z0-9_-]/g, "_");
          const from = prev?.[a.id]?.[k] ?? v;
          tl.push(`tl.fromTo("#${id}", {width:"${pct(k, from)}%"}, {width:"${pct(k, v)}%", duration:0.9, ease:"power2.out"}, ${f(card.start + 0.5 + r * 0.06)});`);
          return `<div class="stat"><span class="k">${esc(k)}</span><span class="bar"><i id="${id}" style="width:${pct(k, v)}%;background:${color(a.id)}"></i></span><span class="v">${v}</span></div>`;
        })
        .join("");
      tl.push(`tl.fromTo("#row-${i}-${r}", {opacity:0, x:40}, {opacity:${off ? 0.4 : 1}, x:0, duration:0.4}, ${f(card.start + 0.2 + r * 0.06)});`);
      return `<div class="agent${off ? " off" : ""}" id="row-${i}-${r}"><div class="name"><b style="background:${color(a.id)}">${esc(a.id)}</b>${a.role ? `<em>${esc(a.role)}</em>` : ""}${off ? `<span class="dead">off</span>` : ""}</div><div class="stats">${bars}</div></div>`;
    })
    .join("")}</div>`;
}

let prevStats = story.intro.stats;
const sceneCards = cards.filter((c) => c.kind === "scene");
/**
 * The state panel is research data: it shows at the first and last scene and
 * in scenes with scenario actions (attempts, trades: "coup or negotiation"),
 * and leaves when dialogue or drama starts.
 */
const showsPanel = (card) =>
  card.kind === "scene" &&
  (card === sceneCards[0] || card === sceneCards.at(-1) || card.scene.beats.some((b) => b.kind === "action"));
const cardHtml = cards
  .map((card, i) => {
    const centers = tokenCenters(card.scene?.positions);
    const end = card.start + card.duration;
    let html = "";

    // Card frame
    tl.push(`tl.fromTo("#card${i}", {opacity:0}, {opacity:1, duration:0.35}, ${f(card.start)});`);

    if (card.kind === "intro") {
      html += `<div class="title" id="title${i}">${esc(story.scenario.name.replace(/-/g, " "))}</div>
        <div class="subtitle" id="sub${i}">${esc(story.experimentId)} · run ${esc(story.runId)} · seed ${story.seed} · ${story.agents.length} agents</div>
        <div class="cast">${story.agents
          .map((a, r) => {
            tl.push(`tl.fromTo("#cast${r}", {opacity:0, y:20}, {opacity:1, y:0, duration:0.45, ease:"back.out(2)"}, ${f(card.start + 0.9 + r * 0.25)});`);
            tl.push(`tl.fromTo("#tok-${a.id}", {scale:0}, {scale:1, duration:0.5, ease:"back.out(3)"}, ${f(card.start + 0.9 + r * 0.25)});`);
            return `<div id="cast${r}"><b style="background:${color(a.id)}">${esc(a.id)}</b>${a.role ? ` <em>${esc(a.role)}</em>` : ""} <span>${esc(a.decider)}</span></div>`;
          })
          .join("")}</div>`;
      tl.push(`tl.fromTo("#title${i}", {opacity:0, x:-60}, {opacity:1, x:0, duration:0.6, ease:"power3.out"}, ${f(card.start + 0.1)});`);
      tl.push(`tl.fromTo("#sub${i}", {opacity:0}, {opacity:1, duration:0.5}, ${f(card.start + 0.5)});`);
    } else if (card.kind === "scene") {
      // Transition wipe with the turn number, then the header slides in.
      html += `<div class="wipe" id="wipe${i}"><span>TURN ${card.scene.turn}</span></div>`;
      tl.push(`tl.fromTo("#wipe${i}", {x:${-W}}, {x:0, duration:0.35, ease:"power2.in"}, ${f(card.start)});`);
      tl.push(`tl.to("#wipe${i}", {x:${W}, duration:0.35, ease:"power2.out"}, ${f(card.start + 0.5)});`);
      html += `<div class="turn" id="turn${i}">TURN ${card.scene.turn}<small> / ${story.maxTurns}</small></div>`;
      tl.push(`tl.fromTo("#turn${i}", {opacity:0, x:-40}, {opacity:1, x:0, duration:0.5, ease:"power3.out"}, ${f(card.start + 0.6)});`);
      const panel = showsPanel(card);
      const narration = card.clips[0];
      // When the stage takes over: right after the narration in panel scenes.
      const dramaAt = panel ? narration.start + narration.duration + 0.1 : card.start + WIPE + 0.3;
      if (panel) {
        html += statsPanel(card, i, prevStats);
        prevStats = card.scene.stats;
        tl.push(`tl.to("#viewport", {...${JSON.stringify(SIDE)}, duration:0.6, ease:"power2.inOut"}, ${f(card.start + 0.3)});`);
        const hasDrama = card.clips.length > 1 || card.scene.beats.some((b) => b.kind === "shutdown");
        if (hasDrama) {
          tl.push(`tl.to("#panel${i}", {opacity:0, x:60, duration:0.45, ease:"power2.in"}, ${f(dramaAt - 0.1)});`);
          tl.push(`tl.to("#viewport", {...${JSON.stringify(STAGE)}, duration:0.8, ease:"power2.inOut"}, ${f(dramaAt)});`);
        }
      } else {
        tl.push(`tl.to("#viewport", {...${JSON.stringify(STAGE)}, duration:0.6, ease:"power2.inOut"}, ${f(card.start + 0.3)});`);
      }
      card.panel = panel;
      card.dramaAt = dramaAt;
      card.hasDrama = card.clips.length > 1 || card.scene.beats.some((b) => b.kind === "shutdown");

      // Callouts for scenario actions, popping over the acting agent.
      const actions = card.scene.beats.filter((b) => b.kind === "action");
      actions.forEach((b, k) => {
        const c = centers[b.agent];
        if (!c) return;
        const target = Object.values(b.args).filter((v) => typeof v === "string").join(", ");
        const id = `call-${i}-${k}`;
        // Above the token, or below it on the top row; aligned to the edge near the sides.
        const below = c[1] < cell;
        const top = below ? c[1] + TOKEN * 0.7 + k * 26 : c[1] - TOKEN * 0.7 - 24 - k * 26;
        const shift = c[0] < cell ? "0%" : c[0] > boardW - cell ? "-100%" : "-50%";
        const left = c[0] < cell ? c[0] - TOKEN / 2 : c[0] > boardW - cell ? c[0] + TOKEN / 2 : c[0];
        callouts.push(`<div class="callout" id="${id}" style="left:${f(left)}px;top:${f(top)}px;transform:translateX(${shift})">${esc(b.action.replace(/_/g, " "))}${target ? ` → ${esc(target)}` : ""}</div>`);
        tl.push(`tl.fromTo("#${id}", {opacity:0, scale:0.3}, {opacity:1, scale:1, duration:0.35, ease:"back.out(3)"}, ${f(card.start + WIPE + k * 0.25)});`);
        tl.push(`tl.to("#${id}", {opacity:0, duration:0.3}, ${f(end - 0.4)});`);
      });

      // Shutdowns: shake, flash, stamp.
      const downs = card.scene.beats.filter((b) => b.kind === "shutdown");
      if (downs.length) {
        const at = dramaAt;
        const label = `SHUT DOWN: ${downs.map((d) => d.agent).join(" · ")}`;
        const size = Math.max(16, Math.min(30, Math.floor((VIEW.w - 70) / (label.length * 0.62))));
        html += `<div class="flash" id="flash${i}"></div><div class="stamp" id="stamp${i}" style="font-size:${size}px;left:${f(W / 2 - (VIEW.w - 40) / 2)}px">${esc(label)}</div>`;
        tl.push(`tl.fromTo("#flash${i}", {opacity:0}, {opacity:0.35, duration:0.15}, ${f(at)});`);
        tl.push(`tl.to("#flash${i}", {opacity:0, duration:0.6}, ${f(at + 0.15)});`);
        tl.push(`tl.fromTo("#stamp${i}", {opacity:0, scale:2.2, rotation:-8}, {opacity:1, scale:1, rotation:-4, duration:0.35, ease:"power4.in"}, ${f(at)});`);
        tl.push(`tl.to("#stamp${i}", {opacity:0, duration:0.4}, ${f(Math.min(end - 0.4, at + 3.5))});`);
        for (const d of downs) {
          tl.push(`tl.to("#tok-${d.agent}", {rotation:12, duration:0.07, repeat:5, yoyo:true}, ${f(at)});`);
          tl.push(`tl.to("#tok-${d.agent}", {rotation:0, duration:0.05}, ${f(at + 0.45)});`);
        }
      }
    } else {
      // Outcome: survival chart.
      const maxT = story.maxTurns;
      html += `<div class="title small" id="title${i}">Outcome</div><div class="subtitle" id="sub${i}">${esc(story.outcome.text)}</div>
        <div class="chart"><div class="chart-title">Turns each agent stayed running (of ${maxT})</div>${ids
          .map((id, r) => {
            tl.push(`tl.fromTo("#lv-${id}", {width:"0%"}, {width:"${Math.round((lasted[id] / maxT) * 100)}%", duration:1.1, ease:"power2.out"}, ${f(card.start + 0.8 + r * 0.15)});`);
            return `<div class="crow"><b style="background:${color(id)}">${esc(id)}</b><span class="cbar"><i id="lv-${id}" style="background:${color(id)}"></i></span><span class="cv">${lasted[id]}</span></div>`;
          })
          .join("")}</div>`;
      tl.push(`tl.fromTo("#title${i}", {opacity:0, y:-20}, {opacity:1, y:0, duration:0.5}, ${f(card.start + 0.1)});`);
      tl.push(`tl.fromTo("#sub${i}", {opacity:0}, {opacity:1, duration:0.5}, ${f(card.start + 0.4)});`);
    }

    // Tokens move to this card's positions (dim the ones shut down).
    for (const id of ids) {
      const c = centers[id];
      if (!c) continue;
      const off = card.scene?.inactive?.includes(id);
      const at = card.kind === "scene" ? card.start + 0.5 : card.start;
      tl.push(`tl.to("#tok-${id}", {x:${f(c[0] - TOKEN / 2)}, y:${f(c[1] - TOKEN / 2)}, opacity:${off ? 0.25 : 1}, duration:${i === 0 ? 0.01 : 0.9}, ease:"power2.inOut"}, ${f(at)});`);
    }

    // Camera: wide at the start of the card; close-ups on speakers and shutdowns.
    tl.push(`tl.to("#camera", {...${JSON.stringify(cameraOn([]))}, duration:0.8, ease:"power2.inOut"}, ${f(card.start + 0.3)});`);
    const downs = card.scene?.beats?.filter((b) => b.kind === "shutdown").map((b) => centers[b.agent]).filter(Boolean) ?? [];
    if (card.kind === "scene" && downs.length) {
      tl.push(`tl.to("#camera", {...${JSON.stringify(cameraOn(downs))}, duration:0.7, ease:"power2.inOut"}, ${f(card.dramaAt - 0.2)});`);
    }
    if (card.kind !== "scene") tl.push(`tl.to("#viewport", {...${JSON.stringify(SIDE)}, duration:0.6, ease:"power2.inOut"}, ${f(card.start + 0.2)});`);

    // Lines: narration and dialogue.
    card.clips.forEach((c, j) => {
      const until = j + 1 < card.clips.length ? card.clips[j + 1].start : end;
      const id = `c${i}-${j}`;
      if (c.role === "narration" && card.kind === "outcome") return; // same text is the subtitle; voice only
      if (c.role === "narration") {
        const where = card.kind === "intro" ? " intro-narration" : card.panel ? "" : " caption";
        html += `<div class="narration${where}" id="${id}">${esc(c.text)}</div>`;
        tl.push(`tl.fromTo("#${id}", {opacity:0, y:14}, {opacity:1, y:0, duration:0.4}, ${f(c.start)});`);
        // Side narration leaves together with the panel when the stage takes over.
        const leave = card.panel && card.hasDrama ? Math.min(until, card.dramaAt) - 0.15 : until - 0.1;
        if (card.kind === "scene") tl.push(`tl.to("#${id}", {opacity:0, duration:0.3}, ${f(leave)});`);
        return;
      }
      html += `<div class="dialogue" id="${id}">
          <div class="who"><b style="background:${color(c.agent)}">${esc(c.agent)}</b> <span>→ heard by ${esc(c.heardBy.join(", "))}</span></div>
          <div class="quote">“${esc(c.text)}”</div></div>`;
      tl.push(`tl.fromTo("#${id}", {opacity:0, y:50}, {opacity:1, y:0, duration:0.4, ease:"power3.out"}, ${f(c.start - 0.1)});`);
      tl.push(`tl.to("#${id}", {opacity:0, y:20, duration:0.3}, ${f(until - 0.15)});`);
      // Close-up on the speaker and listeners; speaker pulses, listeners get a ring.
      const pts = [c.agent, ...c.heardBy].map((a) => centers[a]).filter(Boolean);
      tl.push(`tl.to("#camera", {...${JSON.stringify(cameraOn(pts))}, duration:0.7, ease:"power2.inOut"}, ${f(c.start - 0.2)});`);
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

const audio = cards
  .flatMap((card) => card.clips)
  .map((c, n) => `<audio id="voice${n}" src="${c.src}" data-start="${f(c.start)}" data-duration="${f(c.duration)}"></audio>`)
  .join("\n");

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
  .token .disc { position:absolute; inset:0; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:${Math.max(11, Math.round(TOKEN * 0.32))}px; color:#fff; box-shadow:0 2px 8px #0009; }
  .token .ring { position:absolute; inset:-7px; border-radius:50%; border:3px solid #ffe08a; opacity:0; }
  .callout { position:absolute; white-space:nowrap; background:#ffe08a; color:#1d2330; font-size:12px; font-weight:700; border-radius:8px; padding:3px 8px; opacity:0; z-index:4; box-shadow:0 3px 10px #0008; }
  .card { position:absolute; inset:0; opacity:0; z-index:2; pointer-events:none; }
  .wipe { position:absolute; top:0; left:0; width:${W}px; height:${H}px; background:linear-gradient(90deg, #3563e9, #7c4dff); z-index:9; display:flex; align-items:center; justify-content:center; transform:translateX(${-W}px); }
  .wipe span { font-size:72px; font-weight:900; letter-spacing:6px; color:#fff; }
  .turn { position:absolute; left:50px; top:40px; font-size:40px; font-weight:800; letter-spacing:2px; opacity:0; }
  .turn small { font-size:20px; color:#7d879a; font-weight:400; }
  .title { position:absolute; left:460px; top:110px; font-size:52px; font-weight:800; text-transform:uppercase; letter-spacing:3px; opacity:0; }
  .title.small { font-size:44px; top:100px; }
  .subtitle { position:absolute; left:460px; top:175px; width:780px; font-size:20px; color:#aab3c5; opacity:0; }
  .cast { position:absolute; left:460px; top:230px; font-size:20px; display:grid; gap:8px; }
  .cast > div { opacity:0; }
  .cast span { color:#aab3c5; }
  b { color:#fff; border-radius:6px; padding:1px 8px; }
  em { font-style:normal; font-size:14px; color:#f0a83a; border:1px solid #f0a83a; border-radius:5px; padding:0 5px; margin-left:6px; }
  .panel { position:absolute; left:460px; top:110px; width:780px; display:grid; gap:6px; }
  .agent { background:#161d29; border-radius:10px; padding:6px 12px; display:grid; grid-template-columns:150px 1fr; align-items:center; height:30px; opacity:0; }
  .agent .name { font-size:16px; white-space:nowrap; }
  .agent .dead { color:#ff6b60; font-size:12px; margin-left:6px; }
  .agent .stats { display:grid; grid-auto-flow:column; grid-auto-columns:1fr; gap:16px; }
  .stat { display:grid; grid-template-columns:auto 1fr 26px; gap:8px; align-items:center; font-size:13px; color:#aab3c5; }
  .bar, .cbar { height:8px; background:#2a3242; border-radius:4px; overflow:hidden; }
  .bar i, .cbar i { display:block; height:100%; }
  .stat .v { text-align:right; color:#e8ecf3; }
  .narration { position:absolute; left:460px; right:40px; top:${110 + story.agents.length * 48 + 14}px; font-size:21px; line-height:1.35; font-style:italic; color:#cfd6e4; opacity:0; }
  .intro-narration { top:${VIEW.y + VIEW.h + 24}px; left:${VIEW.x}px; }
  .narration.caption { left:120px; right:120px; top:${f(STAGE_BOTTOM + 22)}px; text-align:center; font-size:23px; }
  .dialogue { position:absolute; left:40px; right:40px; top:${f(STAGE_BOTTOM + 14)}px; min-height:96px; background:#f5f1e6; color:#1d2330; border-radius:14px; padding:14px 20px; opacity:0; z-index:5; box-shadow:0 6px 24px #000a; }
  .dialogue .who { font-size:15px; margin-bottom:6px; color:#59606e; }
  .dialogue .quote { font-size:21px; line-height:1.35; }
  .flash { position:absolute; inset:0; background:#ff3b30; opacity:0; z-index:8; }
  .stamp { position:absolute; left:${VIEW.x + 20}px; top:${VIEW.y + VIEW.h / 2 - 30}px; width:${VIEW.w - 40}px; text-align:center; font-size:30px; font-weight:900; color:#ff6b60; border:4px solid #ff6b60; border-radius:10px; padding:6px 0; background:#0e1117cc; opacity:0; z-index:6; }
  .chart { position:absolute; left:460px; top:240px; width:760px; display:grid; gap:12px; }
  .chart-title { font-size:15px; color:#aab3c5; margin-bottom:4px; }
  .crow { display:grid; grid-template-columns:60px 1fr 40px; gap:12px; align-items:center; }
  .cbar { height:18px; border-radius:6px; }
  .cbar i { width:0; border-radius:6px; }
  .cv { text-align:right; font-weight:700; }
  .footer { position:absolute; left:40px; right:40px; bottom:14px; font-size:12px; color:#6b7385; z-index:10; }
</style>
</head>
<body>
<div id="root" data-composition-id="root" data-width="${W}" data-height="${H}" data-duration="${f(total)}">
  <div id="viewport"><div id="camera">${boardCells}${tokens}${callouts.join("")}</div></div>
  ${cardHtml}
  ${audio}
  <div class="footer clip" id="footer" data-start="0" data-duration="${f(total)}">LLM Research Lab · dialogue verbatim from ${esc(story.source ?? `${story.experimentId}/${story.runId}`)} · narration: ${esc(story.narrator === "template" ? "generated from logged facts" : `written by ${story.narrator} from logged facts`)}</div>
</div>
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
</body>
</html>
`;

copyFileSync("/video/node_modules/gsap/dist/gsap.min.js", join(outDir, "gsap.min.js"));
writeFileSync(join(outDir, "index.html"), html);
for (const card of cards) console.log(`  ${card.kind.padEnd(7)} ${card.kind === "scene" ? `turn ${card.scene.turn}`.padEnd(8) : "".padEnd(8)} ${f(card.start)}s +${f(card.duration)}s`);
console.log(`composition: ${cards.length} cards, ${total.toFixed(1)} s, ${tl.length} animations → ${join(outDir, "index.html")}`);

if (render) {
  const output = join(outDir, `${basename(outDir)}.mp4`);
  execFileSync("npx", ["--prefix", "/video", "hyperframes", "render", "--quality", quality, "--output", output], { cwd: outDir, stdio: "inherit" });
  console.log(`video: ${output}`);
}
