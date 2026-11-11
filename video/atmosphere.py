"""Data-driven atmosphere for run videos: one WAV with music bed and sound effects.

Everything is synthesized here (numpy), no third-party audio. The input is a
cue file written by build.mjs from OBSERVABLE run state only:

  {"duration": s, "sample_rate": 48000,
   "agents": n,                                   # one chord note per agent
   "active": [[agent_index, [[t0, t1], ...]]],    # when each agent is running on screen
   "tension": [[t0, t1, share]],                  # share of running agents with a low resource
   "voice": [[t0, t1]],                           # narration/dialogue: duck the music
   "sfx": [[t, kind]],                            # whoosh | action | rejected | shutdown | chime
   "music": 1.0, "effects": 1.0}                  # levels (direction.json "atmosphere")

Mapping (DIRECTION.md §5b): each running agent is a note of a soft chord; a
shutdown removes its note. A low heartbeat pulse speeds up with the tension
share. Music ducks under every voice clip.
"""

import json
import sys

import numpy as np
import soundfile as sf

cues = json.load(open(sys.argv[1]))
out = sys.argv[2]
SR = cues.get("sample_rate", 48000)
N = int(cues["duration"] * SR) + SR
t = np.arange(N) / SR
rng = np.random.default_rng(7)  # fixed: the same cues always give the same file

# A minor pentatonic voicing, low to high: one note per agent (wraps an octave up).
SCALE = [110.0, 164.81, 220.0, 261.63, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25]


def envelope(spans, fade):
    """0/1 gate from [t0, t1] spans, with linear fades in seconds."""
    gate = np.zeros(N)
    for t0, t1 in spans:
        a, b = int(t0 * SR), int(t1 * SR)
        gate[max(a, 0):min(b, N)] = 1.0
    k = max(1, int(fade * SR))
    kernel = np.ones(k) / k
    return np.convolve(gate, kernel, mode="same")


def pad_note(freq):
    """Warm, slowly breathing tone: two detuned sines plus a soft octave."""
    lfo = 0.75 + 0.25 * np.sin(2 * np.pi * (0.07 + freq / 9000) * t + freq)
    tone = np.sin(2 * np.pi * freq * t) + np.sin(2 * np.pi * freq * 1.003 * t) + 0.3 * np.sin(2 * np.pi * freq * 2 * t)
    return tone * lfo / 2.3


# ---- Music: base drone + one note per running agent ----
music = 0.35 * pad_note(55.0)
for index, spans in cues["active"]:
    freq = SCALE[index % len(SCALE)] * (2 if index >= len(SCALE) else 1)
    music += pad_note(freq) * envelope(spans, 1.2) * 0.5

# ---- Tension pulse: heartbeat-like thumps, faster with the tension share ----
pulse = np.zeros(N)
for t0, t1, share in cues["tension"]:
    if share <= 0:
        continue
    period = 60.0 / (54 + 66 * share)  # 54..120 bpm
    beat = t0 + 0.2
    while beat < t1 - 0.2:
        for offset, gain in ((0.0, 1.0), (0.22, 0.6)):  # lub-dub
            a = int((beat + offset) * SR)
            n = int(0.18 * SR)
            if a + n < N:
                k = np.arange(n) / SR
                pulse[a:a + n] += gain * (0.4 + 0.6 * share) * np.sin(2 * np.pi * 52 * k) * np.exp(-k * 28)
        beat += period
music += pulse * 1.6

# Duck under voices, and fade the whole bed in and out.
duck = 1.0 - 0.6 * envelope(cues["voice"], 0.25)
music *= duck
music *= np.clip(t / 2.0, 0, 1) * np.clip((cues["duration"] - t) / 2.5, 0, 1)
# Normalize so the level does not depend on how many agents are playing.
music *= 0.08 * cues.get("music", 1.0) / max(1e-9, float(np.percentile(np.abs(music), 99.5)))

# ---- Sound effects ----
fx = np.zeros(N)


def place(at, sound):
    a = int(at * SR)
    if a < 0 or a >= N:
        return
    b = min(N, a + len(sound))
    fx[a:b] += sound[: b - a]


def whoosh():
    n = int(0.55 * SR)
    k = np.arange(n) / SR
    noise = rng.standard_normal(n)
    # Moving one-pole low-pass: cutoff rises then falls.
    cutoff = 300 + 3500 * np.sin(np.pi * k / k[-1])
    alpha = 1 - np.exp(-2 * np.pi * cutoff / SR)
    y = np.zeros(n)
    acc = 0.0
    for i in range(n):
        acc += alpha[i] * (noise[i] - acc)
        y[i] = acc
    return y * np.sin(np.pi * k / k[-1]) ** 2 * 0.5


def blip(f0, f1, length=0.12):
    n = int(length * SR)
    k = np.arange(n) / SR
    freq = np.linspace(f0, f1, n)
    return np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-k * 22) * 0.35


def buzz():
    n = int(0.22 * SR)
    k = np.arange(n) / SR
    return np.tanh(3 * np.sin(2 * np.pi * 110 * k)) * np.exp(-k * 12) * 0.18


def power_down():
    n = int(1.1 * SR)
    k = np.arange(n) / SR
    freq = 520 * np.exp(-k * 3.2) + 40
    tone = np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-k * 2.2) * 0.45
    hit = rng.standard_normal(n) * np.exp(-k * 30) * 0.25
    return tone + hit


def chime():
    n = int(2.2 * SR)
    k = np.arange(n) / SR
    return sum(np.sin(2 * np.pi * f * k) * np.exp(-k * d) * g for f, d, g in ((440, 2.0, 0.25), (659.25, 2.6, 0.15), (880, 3.5, 0.1)))


SOUNDS = {"whoosh": whoosh, "action": lambda: blip(880, 1320), "rejected": buzz, "shutdown": power_down, "chime": chime}
cache = {}
for at, kind in cues["sfx"]:
    if kind not in cache:
        cache[kind] = SOUNDS[kind]()
    place(at, cache[kind])
fx *= cues.get("effects", 1.0)

mix = np.clip(music + fx * 0.5, -0.95, 0.95)
# Slight stereo width: delay one channel by a few ms.
d = int(0.012 * SR)
right = np.concatenate([np.zeros(d), mix[:-d]])
sf.write(out, np.stack([mix, right], axis=1)[: int(cues["duration"] * SR)], SR, subtype="PCM_16")
print(f"atmosphere: {out} ({cues['duration']:.1f}s, {len(cues['sfx'])} effects)")
