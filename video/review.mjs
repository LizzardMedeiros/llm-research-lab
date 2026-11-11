// Review sheets for a rendered video: frames at the start, middle and end of
// every card (from timeline.json), labeled and tiled 2×3 per sheet.
//
//   node /video/review.mjs <folder> [--video <file.mp4>] [--at <seconds,...>]
//
// <folder> holds timeline.json and the video (episode.mp4, or <folder-name>.mp4).
// Output: <folder>/review/sheet-01.png … and review/index.txt (what each tile shows).
// --at adds extra moments (e.g. a dialogue or shutdown you want to check).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--video" && args[args.indexOf(a) - 1] !== "--at");
if (!folder) {
  console.error("Usage: node review.mjs <folder> [--video <file.mp4>] [--at <seconds,...>]");
  process.exit(2);
}
const dir = resolve(folder);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const video = resolve(dir, opt("--video") ?? (existsSync(join(dir, "episode.mp4")) ? "episode.mp4" : `${basename(dir)}.mp4`));
if (!existsSync(video)) throw new Error(`video not found: ${video}`);
const timeline = JSON.parse(readFileSync(join(dir, "timeline.json"), "utf8"));
const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]).toString().trim());

// Moments to look at: start (after the transition), middle and end of each card.
const shots = [];
for (const card of timeline.cards) {
  const s = card.start;
  const d = card.duration;
  shots.push({ t: s + Math.min(1.5, d * 0.2), label: `${card.id} · start` });
  if (d > 6) shots.push({ t: s + d / 2, label: `${card.id} · middle` });
  shots.push({ t: s + d - 0.8, label: `${card.id} · end` });
}
for (const t of (opt("--at") ?? "").split(",").filter(Boolean).map(Number)) {
  const card = timeline.cards.find((c) => t >= c.start && t < c.start + c.duration);
  shots.push({ t, label: `${card?.id ?? "?"} · at ${t}s` });
}
shots.sort((a, b) => a.t - b.t);
for (const shot of shots) shot.t = Math.max(0, Math.min(duration - 0.1, shot.t));

const out = join(dir, "review");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const esc = (text) => text.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019");

const frames = shots.map((shot, i) => {
  const file = join(out, `f-${String(i).padStart(3, "0")}.png`);
  const label = esc(`${shot.label} · ${fmt(shot.t)}`);
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-ss", shot.t.toFixed(2), "-i", video, "-frames:v", "1",
    "-vf", `scale=700:-1,drawtext=fontfile=${font}:text='${label}':x=10:y=10:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=6`,
    file,
  ]);
  return file;
});

// Tile 2 columns × 3 rows per sheet (the last sheet may have fewer tiles).
const index = [];
const PER = 6;
for (let sheet = 0; sheet * PER < frames.length; sheet++) {
  const group = frames.slice(sheet * PER, sheet * PER + PER);
  const inputs = group.flatMap((f) => ["-i", f]);
  const n = group.length;
  const layout = Array.from({ length: n }, (_, k) => `${(k % 2) * 700}_${Math.floor(k / 2) * 394}`).join("|");
  const name = `sheet-${String(sheet + 1).padStart(2, "0")}.png`;
  execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", n === 1 ? "[0:v]copy" : `${group.map((_, k) => `[${k}:v]`).join("")}xstack=inputs=${n}:layout=${layout}:fill=black`, join(out, name)]);
  index.push(`${name}: ${shots.slice(sheet * PER, sheet * PER + PER).map((s) => `${s.label} @ ${fmt(s.t)}`).join(" | ")}`);
}
for (const f of frames) rmSync(f);
writeFileSync(join(out, "index.txt"), `${index.join("\n")}\n`);
console.log(`${shots.length} frames in ${index.length} sheets → ${out}`);
console.log(index.join("\n"));
