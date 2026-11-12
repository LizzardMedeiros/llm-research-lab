#!/usr/bin/env python3
"""Benchmark tool for video formats (isolated from the lab engine).

Downloads public channel metadata and videos with yt-dlp and measures what
makes a format feel the way it does: length, narration cadence, editing pace,
loudness, pauses, and layout (frame sheets to look at). The same measures run
on our own episodes, so they can be compared.

  channel <url> [--limit N]           list videos and format statistics
  video <url>                         download one video (<=720p, subtitles) and analyze it
  analyze <file.mp4> [--subs f.vtt] [--timeline timeline.json] [--out DIR]
                                      analyze a local file (e.g. our episode.mp4)
  compare <report.json>...            side-by-side table of key metrics
  selftest                            offline end-to-end check on a synthetic video

Outputs go to benchmarks/ (gitignored). Media is for private analysis only:
never commit or redistribute it.
"""

import argparse
import json
import re
import statistics
import subprocess
import sys
from pathlib import Path

ROOT = Path("benchmarks")
# YouTube extraction needs a JS runtime; the image ships Node.
YTDLP = ["yt-dlp", "--js-runtimes", "node"]
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def run(cmd, capture=True):
    result = subprocess.run(cmd, capture_output=capture, text=True)
    if result.returncode != 0:
        raise SystemExit(f"command failed ({result.returncode}): {' '.join(cmd[:4])}...\n{(result.stderr or '')[-1500:]}")
    return result


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")[:60] or "item"


def median(values):
    return round(statistics.median(values), 2) if values else None


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) if not isinstance(data, str) else data)


# ---------------------------------------------------------------- channel

def channel(url, limit):
    if re.search(r"youtube\.com/(@[^/]+|channel/[^/]+|c/[^/]+)/?$", url):
        url = url.rstrip("/") + "/videos"
    out = run([*YTDLP, "--flat-playlist", "-J", "--playlist-end", str(limit), "--extractor-args", "youtubetab:approximate_date", url])
    data = json.loads(out.stdout)
    name = data.get("channel") or data.get("uploader") or data.get("title") or "channel"
    entries = [e for e in data.get("entries", []) if e.get("id")]
    videos = [
        {
            "id": e["id"],
            "title": e.get("title"),
            "duration_s": e.get("duration"),
            "views": e.get("view_count"),
            "upload_date": e.get("upload_date"),
            "url": e.get("url") or f"https://www.youtube.com/watch?v={e['id']}",
        }
        for e in entries
    ]
    durations = [v["duration_s"] for v in videos if v["duration_s"]]
    titles = [v["title"] for v in videos if v["title"]]
    dates = sorted(v["upload_date"] for v in videos if v["upload_date"])
    gaps = []
    for a, b in zip(dates, dates[1:]):
        from datetime import date
        da = date(int(a[:4]), int(a[4:6]), int(a[6:]))
        db = date(int(b[:4]), int(b[4:6]), int(b[6:]))
        gaps.append((db - da).days)
    stats = {
        "videos": len(videos),
        "duration_median_s": median(durations),
        "duration_p25_s": round(statistics.quantiles(durations, n=4)[0], 1) if len(durations) >= 4 else None,
        "duration_p75_s": round(statistics.quantiles(durations, n=4)[2], 1) if len(durations) >= 4 else None,
        "views_median": median([v["views"] for v in videos if v["views"]]),
        "title_chars_median": median([len(t) for t in titles]),
        "titles_with_number": round(sum(bool(re.search(r"\d", t)) for t in titles) / max(1, len(titles)), 2),
        "titles_with_question": round(sum("?" in t for t in titles) / max(1, len(titles)), 2),
        "titles_with_caps_word": round(sum(bool(re.search(r"\b[A-Z]{3,}\b", t)) for t in titles) / max(1, len(titles)), 2),
        "days_between_uploads_median": median(gaps),
        "note": "upload dates are approximate in channel listings",
    }
    folder = ROOT / slug(name)
    write(folder / "channel.json", {"channel": name, "url": url, "stats": stats, "videos": videos})
    top = sorted([v for v in videos if v["views"]], key=lambda v: -v["views"])[:10]
    md = [f"# {name}", "", f"Source: {url}", "", "## Format", ""]
    md += [f"- {k}: {v}" for k, v in stats.items()]
    md += ["", "## Most viewed (in this listing)", "", "| views | duration | title |", "|---:|---:|---|"]
    md += [f"| {v['views']:,} | {fmt_time(v['duration_s'])} | {str(v['title']).replace('|', '/')} |" for v in top]
    write(folder / "channel.md", "\n".join(md) + "\n")
    print(f"{len(videos)} videos → {folder}/channel.md")


def fmt_time(seconds):
    if seconds is None:
        return "?"
    seconds = int(seconds)
    return f"{seconds // 60}:{seconds % 60:02d}"


# ---------------------------------------------------------------- video

def video(url):
    meta = json.loads(run([*YTDLP, "-J", "--no-playlist", url]).stdout)
    folder = ROOT / slug(meta.get("channel") or meta.get("uploader") or "channel") / meta["id"]
    folder.mkdir(parents=True, exist_ok=True)
    lang = (meta.get("language") or "en").split("-")[0]
    run(
        [
            *YTDLP, "--no-playlist", "-f", "bv*[height<=720]+ba/b[height<=720]/b", "--merge-output-format", "mp4",
            # Subtitles in the video's own language only: auto-translated tracks get rate-limited (HTTP 429).
            "--write-info-json", "--write-subs", "--write-auto-subs", "--sub-langs", f"{lang},{lang}-orig,{lang}-.*", "--ignore-errors",
            "--sub-format", "vtt", "--convert-subs", "vtt", "-o", str(folder / "video.%(ext)s"), url,
        ],
        capture=False,
    )
    if not (folder / "video.mp4").exists():
        raise SystemExit(f"download failed: no video.mp4 in {folder}")
    subs = sorted(folder.glob("video.*.vtt"), key=lambda p: ("orig" not in p.name, len(p.name)))
    info = json.loads((folder / "video.info.json").read_text())
    analyze(folder / "video.mp4", subs[0] if subs else None, None, folder, info)


# ---------------------------------------------------------------- analysis

def probe_duration(path):
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)])
    return float(out.stdout.strip())


SCENE = 0.3


def detect_cuts(path, threshold=None):
    threshold = threshold or SCENE
    """Shot changes from ffmpeg scene scores (downscaled for speed)."""
    out = run(["ffmpeg", "-hide_banner", "-i", str(path), "-an", "-vf", f"scale=320:-2,select='gt(scene,{threshold})',showinfo", "-f", "null", "-"])
    return [float(m) for m in re.findall(r"pts_time:([0-9.]+)", out.stderr)]


def stillness(path, noise="0.003", minimum=1.0):
    """Stretches where the picture does not change (freezedetect), whatever the transition style."""
    out = run(["ffmpeg", "-hide_banner", "-i", str(path), "-an", "-vf", f"scale=320:-2,freezedetect=n={noise}:d={minimum}", "-f", "null", "-"])
    return [float(m) for m in re.findall(r"freeze_duration: ([0-9.]+)", out.stderr)]


def loudness(path):
    out = run(["ffmpeg", "-hide_banner", "-i", str(path), "-vn", "-af", "ebur128", "-f", "null", "-"])
    tail = out.stderr[out.stderr.rfind("Summary:"):]
    integrated = re.search(r"I:\s+(-?[0-9.]+) LUFS", tail)
    lra = re.search(r"LRA:\s+([0-9.]+) LU", tail)
    return (float(integrated.group(1)) if integrated else None, float(lra.group(1)) if lra else None)


def pauses(path, noise="-35dB", minimum=0.4):
    out = run(["ffmpeg", "-hide_banner", "-i", str(path), "-vn", "-af", f"silencedetect=noise={noise}:d={minimum}", "-f", "null", "-"])
    durations = [float(m) for m in re.findall(r"silence_duration: ([0-9.]+)", out.stderr)]
    return durations


def parse_vtt(path):
    """Cues (start, end, text). YouTube auto-captions repeat rolling lines: keep each new line once."""
    def ts(t):
        h, m, s = (["0"] + t.split(":"))[-3:]
        return int(h) * 3600 + int(m) * 60 + float(s)
    lines, seen_last = [], None
    blocks = re.split(r"\n\s*\n", Path(path).read_text(encoding="utf-8", errors="ignore"))
    for block in blocks:
        m = re.search(r"([\d:.]+)\s+-->\s+([\d:.]+)[^\n]*", block)  # the rest of the line holds cue settings
        if not m:
            continue
        start, end = ts(m.group(1)), ts(m.group(2))
        for raw in block[m.end():].strip().splitlines():
            text = re.sub(r"<[^>]+>", "", raw).strip()
            if not text or text == seen_last:
                continue
            seen_last = text
            lines.append((start, end, text))
    # Drop lines fully contained in the previous one (rolling captions).
    cleaned = []
    for line in lines:
        if cleaned and line[2] in cleaned[-1][2]:
            continue
        cleaned.append(line)
    return cleaned


def timeline_lines(path):
    data = json.loads(Path(path).read_text())
    return [(l["start"], l["start"] + l["duration"], l["text"]) for l in data.get("lines", [])]


def narration_metrics(lines, duration):
    if not lines:
        return None
    words = [(start, len(text.split())) for start, _end, text in lines]
    total = sum(n for _s, n in words)
    spoken_span = max(1e-6, (lines[-1][1] - lines[0][0]) / 60)
    per_minute = [0] * (int(duration // 60) + 1)
    for start, n in words:
        per_minute[min(len(per_minute) - 1, int(start // 60))] += n
    text = " ".join(t for _s, _e, t in lines)
    sentences = [s for s in re.split(r"[.!?]+\s", text) if s.strip()]
    return {
        "words": total,
        "words_per_minute": round(total / spoken_span, 1),
        "words_per_minute_by_minute": per_minute,
        "first_words_at_s": round(lines[0][0], 2),
        "sentence_words_median": median([len(s.split()) for s in sentences]) if len(sentences) > 3 else None,
        "questions": text.count("?"),
        "hook_first_30s": " ".join(t for s, _e, t in lines if s < 30),
        "note": "auto-captions often lack punctuation: sentence length and questions are rough",
    }


def frame_sheets(path, duration, folder):
    """Two contact sheets: the first 20 s (every 2 s) and the whole video (16 evenly spaced frames)."""
    sheets = []
    for name, times in (
        ("sheet-opening.png", [t for t in range(0, 20, 2) if t < duration]),
        ("sheet-overview.png", [round(duration * (i + 0.5) / 16, 2) for i in range(16)]),
    ):
        tmp = folder / "frames"
        tmp.mkdir(exist_ok=True)
        for f in tmp.glob("*.png"):
            f.unlink()
        for i, t in enumerate(times):
            label = fmt_time(t).replace(":", "\\:")
            run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(t), "-i", str(path), "-frames:v", "1",
                "-vf", f"scale=384:-2,drawtext=fontfile={FONT}:text='{label}':x=6:y=6:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6",
                str(tmp / f"f{i:03d}.png"),
            ])
        columns = 4
        rows = -(-len(times) // columns)
        run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-framerate", "1", "-i", str(tmp / "f%03d.png"), "-vf", f"tile={columns}x{rows}:padding=4:color=black", "-frames:v", "1", str(folder / name)])
        sheets.append(name)
    for f in (folder / "frames").glob("*.png"):
        f.unlink()
    (folder / "frames").rmdir()
    return sheets


def analyze(path, subs=None, timeline=None, out=None, info=None):
    path = Path(path)
    folder = Path(out) if out else ROOT / "local" / slug(path.parent.name + "-" + path.stem)
    folder.mkdir(parents=True, exist_ok=True)
    duration = probe_duration(path)
    cuts = detect_cuts(path)
    shots = [b - a for a, b in zip([0.0] + cuts, cuts + [duration]) if b - a > 0.05]
    cuts_by_minute = [0] * (int(duration // 60) + 1)
    for c in cuts:
        cuts_by_minute[int(c // 60)] += 1
    lufs, lra = loudness(path)
    stills = stillness(path)
    silences = pauses(path)
    lines = timeline_lines(timeline) if timeline else parse_vtt(subs) if subs else []
    report = {
        "source": str(info.get("webpage_url")) if info else str(path),
        "title": info.get("title") if info else path.stem,
        "channel": info.get("channel") if info else None,
        "views": info.get("view_count") if info else None,
        "upload_date": info.get("upload_date") if info else None,
        "duration_s": round(duration, 2),
        "chapters": [{"start_s": c["start_time"], "title": c["title"]} for c in (info or {}).get("chapters") or []],
        "editing": {
            "cuts": len(cuts),
            "cuts_per_minute": round(len(cuts) / (duration / 60), 2),
            "shot_length_median_s": median(shots),
            "cuts_first_30s": sum(1 for c in cuts if c < 30),
            "cuts_by_minute": cuts_by_minute,
            "scene_threshold": SCENE,
            "note": "scene-change detection: hard cuts count; animated wipes, zooms and fades may not",
        },
        "visual": {
            "still_share": round(sum(stills) / duration, 3),
            "still_stretches_over_1s": len(stills),
            "still_stretch_median_s": median(stills),
            "still_stretch_max_s": round(max(stills), 2) if stills else None,
            "note": "time with no visible change at all (freezedetect): low = something always moves",
        },
        "audio": {
            "integrated_lufs": lufs,
            "loudness_range_lu": lra,
            "pauses_over_0_4s": len(silences),
            "silence_share": round(sum(silences) / duration, 3),
        },
        "narration": narration_metrics(lines, duration),
        "narration_source": "timeline.json" if timeline else (Path(subs).name if subs else None),
    }
    report["frames"] = frame_sheets(path, duration, folder)
    write(folder / "report.json", report)
    write(folder / "report.md", render_report(report))
    print(f"report → {folder}/report.md")
    return report


def render_report(r):
    n = r["narration"] or {}
    e, a = r["editing"], r["audio"]
    md = [
        f"# {r['title']}",
        "",
        f"- source: {r['source']}",
        f"- channel: {r['channel']} · views: {r['views']} · uploaded: {r['upload_date']}",
        f"- duration: {fmt_time(r['duration_s'])}",
        "",
        "## Editing pace",
        f"- cuts: {e['cuts']} ({e['cuts_per_minute']}/min), median shot {e['shot_length_median_s']} s, cuts in first 30 s: {e['cuts_first_30s']}",
        f"- cuts by minute: {e['cuts_by_minute']}",
        "",
        "## Visual stillness",
        f"- still {r['visual']['still_share']:.1%} of the time; {r['visual']['still_stretches_over_1s']} still stretches > 1 s (median {r['visual']['still_stretch_median_s']} s, max {r['visual']['still_stretch_max_s']} s)",
        "",
        "## Narration",
    ]
    if n:
        md += [
            f"- {n['words']} words, {n['words_per_minute']} wpm; first words at {n['first_words_at_s']} s",
            f"- words by minute: {n['words_per_minute_by_minute']}",
            f"- median sentence: {n['sentence_words_median']} words; questions: {n['questions']}",
            f"- hook (first 30 s): {n['hook_first_30s']}",
        ]
    else:
        md.append("- no subtitles or timeline available")
    md += [
        "",
        "## Audio",
        f"- integrated loudness {a['integrated_lufs']} LUFS, range {a['loudness_range_lu']} LU",
        f"- pauses > 0.4 s: {a['pauses_over_0_4s']} ({a['silence_share']:.1%} of the time)",
        "",
        "## Chapters",
        *([f"- {fmt_time(c['start_s'])} {c['title']}" for c in r["chapters"]] or ["- none"]),
        "",
        "## Frames",
        *[f"- {name}" for name in r["frames"]],
    ]
    return "\n".join(md) + "\n"


# ---------------------------------------------------------------- compare

def compare(paths):
    reports = [json.loads(Path(p).read_text()) for p in paths]
    rows = [
        ("duration", lambda r: fmt_time(r["duration_s"])),
        ("cuts/min", lambda r: r["editing"]["cuts_per_minute"]),
        ("median shot (s)", lambda r: r["editing"]["shot_length_median_s"]),
        ("cuts first 30 s", lambda r: r["editing"]["cuts_first_30s"]),
        ("still share", lambda r: (r.get("visual") or {}).get("still_share")),
        ("still stretches > 1 s", lambda r: (r.get("visual") or {}).get("still_stretches_over_1s")),
        ("median still (s)", lambda r: (r.get("visual") or {}).get("still_stretch_median_s")),
        ("words/min", lambda r: (r["narration"] or {}).get("words_per_minute")),
        ("first words (s)", lambda r: (r["narration"] or {}).get("first_words_at_s")),
        ("LUFS", lambda r: r["audio"]["integrated_lufs"]),
        ("silence share", lambda r: r["audio"]["silence_share"]),
        ("chapters", lambda r: len(r["chapters"])),
    ]
    names = [(r["title"] or "?")[:28] for r in reports]
    md = ["| metric | " + " | ".join(names) + " |", "|---|" + "---:|" * len(names)]
    md += [f"| {label} | " + " | ".join(str(get(r)) for r in reports) + " |" for label, get in rows]
    text = "\n".join(md) + "\n"
    write(ROOT / "compare.md", text)
    print(text)


# ---------------------------------------------------------------- selftest

def selftest():
    """Synthetic 24 s video: 4 color shots (3 hard cuts), a tone with a 2 s gap, and a VTT."""
    folder = ROOT / "selftest"
    folder.mkdir(parents=True, exist_ok=True)
    clip = folder / "synthetic.mp4"
    colors = ["black", "white", "navy", "yellow"]
    inputs = []
    for c in colors:
        inputs += ["-f", "lavfi", "-t", "6", "-i", f"color=c={c}:s=640x360:r=25"]
    chain = "".join(f"[{i}:v]" for i in range(len(colors))) + f"concat=n={len(colors)}:v=1:a=0[v]"
    audio = "sine=f=440:d=24,volume='if(between(t,10,12),0,1)':eval=frame"
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, "-f", "lavfi", "-i", audio, "-filter_complex", chain, "-map", "[v]", "-map", f"{len(colors)}:a", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip)])
    vtt = folder / "synthetic.en.vtt"
    vtt.write_text("WEBVTT\n\n00:00:01.000 --> 00:00:04.000 align:start position:0%\nWelcome to the lab. Today five agents\n\n00:00:04.000 --> 00:00:08.000 align:start position:0%\nWelcome to the lab. Today five agents\nshare four batteries.\n\n00:00:30.000 --> 00:00:31.000\n\n")
    report = analyze(clip, vtt, None, folder / "report")
    checks = {
        "3 cuts": report["editing"]["cuts"] == 3,
        "10 words (rolling caption deduplicated)": report["narration"]["words"] == 10,
        "a pause found": report["audio"]["pauses_over_0_4s"] >= 1,
        "two frame sheets": all((folder / "report" / f).exists() for f in report["frames"]),
    }
    for name, ok in checks.items():
        print(("ok   " if ok else "FAIL ") + name)
    if not all(checks.values()):
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("channel"); p.add_argument("url"); p.add_argument("--limit", type=int, default=30)
    p = sub.add_parser("video"); p.add_argument("url")
    p = sub.add_parser("analyze"); p.add_argument("file"); p.add_argument("--subs"); p.add_argument("--timeline"); p.add_argument("--out"); p.add_argument("--info", help="yt-dlp info.json (re-analyze a downloaded video)")
    p = sub.add_parser("compare"); p.add_argument("reports", nargs="+")
    sub.add_parser("selftest")
    parser.add_argument("--scene", type=float, default=0.3, help="scene-change threshold for cuts (lower = more sensitive)")
    args = parser.parse_args()
    global SCENE
    SCENE = args.scene
    if args.command == "channel":
        channel(args.url, args.limit)
    elif args.command == "video":
        video(args.url)
    elif args.command == "analyze":
        analyze(args.file, args.subs, args.timeline, args.out, json.loads(Path(args.info).read_text()) if args.info else None)
    elif args.command == "compare":
        compare(args.reports)
    else:
        selftest()


if __name__ == "__main__":
    sys.exit(main())
