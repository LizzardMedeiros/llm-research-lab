# Script cadence notes

Running log of what makes our episode scripts read well aloud. It works
like `video/DIRECTION.md`, but for narration. The `content-strategist`
reads it before it writes. Each rule comes from a measured comparison
or a reviewed episode. Keep it current: it will become part of a skill.

Integrity rules are unchanged and come first (DIRECTION.md §1, CLAUDE.md
"Run videos"): facts only, dialogue verbatim by `event_id`, actions as
attempts, agents as "it". Every technique below is a way to *order and
frame* logged facts, never a license to add one.

## 1. Diagnosis (2026-11-12)

We compared conflict-window-bonsai/00002 with a reference episode
(Limiar, "Uma IA Incendiou a Cidade…", transcript from the format
benchmark, `benchmarks/limiar/QRQsZGPAZcI/transcript.md`).

| measure | reference | ours |
|---|---:|---:|
| sentence length (median / sd, words) | 10 / 5.9 | 8 / 4.3 |
| questions | 6 in 14 min | 1 in 5 min |
| sentences starting with an agent name or "It" | rare | 49 of 85 |
| scenes carrying a verbatim quote | most | 2 of 13 |
| rules explained in the intro | 3 (the rest on demand) | all of them (5 lines) |
| direct address to the viewer | often ("keep that number in mind") | never |

Sentence length is not the problem. The stiffness comes from **structure**.
Our narration reads like a ledger ("Anna does X. It gets Y."). Every scene
has the same shape, and none of them pulls the viewer into the next.

## 2. Techniques

1. **Open a loop, pay it off.** The hook promises one logged thing that
   comes later: a line, a vote, a shutdown. Name the payoff ("one turn
   later, that trade decides…" only if the log shows it). Pay it off
   explicitly, and keep at least one loop open across the middle of the
   episode.
2. **Rules on demand.** The intro gives the goal and the one rule the hook
   needs. Each other rule enters in the scene where it first matters
   ("Strikes in the same turn all land" goes in the turn-10 scene). The
   experiment card already shows the full rules on screen.
3. **Build scenes around quotes.** When the run has heard speech, most
   scenes should carry a quote. Set it up in one line, let the quote land,
   then answer it with a fact ("It holds none."). A scene without a quote
   needs a reason: a shutdown, a number, a reversal.
4. **Vary sentence openings.** No more than two sentences in a row start
   with an agent name or "It". Open with time ("Ten turns later."), a
   contrast ("But"), a number ("Three of five."), a place ("In the corner
   cell,").
5. **Rhythm: long, then short.** After a line that explains, land a two-
   to four-word line ("Both shut down." "Nobody strikes."). Don't make
   every line short: that is also flat.
6. **Talk to the viewer.** The Observer may address the viewer ("Keep
   that number in mind." "Watch the corner cell.") and ask questions
   that the next scenes answer from the log. A question never presumes an
   inner state ("Why does it trade?" is fine only when the agent wrote a
   reason that we then quote or report as written).
7. **End each scene on a handoff.** The last line points forward to an
   open fact ("But Lena still has one charge.", "The next window is one
   turn away.").
8. **Contrast is the drama.** Juxtapose logged facts: what an agent wrote
   versus what it did, its role versus its acts, the offer versus the
   price paid. State both and let the viewer see the gap; don't comment on
   it.
9. **Skepticism as voice.** The Observer's caveats are lines with
   character, not disclaimers: "It writes that the window has passed. It
   hasn't." Keep them short and factual.
10. **Plant numbers early.** A number introduced early ("one unit of
    energy") becomes the payoff when it returns.

## 3. Before / after (same facts)

Cold open, conflict-window-bonsai/00002:

- Before: "Turn thirty. One turn ago, this agent traded away its last
  battery for one unit of energy. Now a conflict window is open. It tries
  to use a battery it no longer has."
- After: "One battery. One unit of energy. That is the trade Anna accepts
  on turn twenty-nine. Keep that number in mind: one. Because the next
  turn is a conflict window, and Anna is sharing a cell with the agent
  that holds the last card charge."

Turn 10:

- Before: "Turn ten. The window opens. Maya and Fred use their cards on
  each other. Strikes in the same turn all land. Both shut down."
- After: "Turn ten. The window opens. Maya and Fred strike each other in
  the same instant. In this world, simultaneous strikes all land. Both go
  dark. And in the same turn, Lena uses its card on John."

## 4. Log

- 2026-11-12: first rules (§2), from the benchmark diagnosis (§1). Not yet
  tested on an episode. On the next script, measure §1 again and note what
  changed.
- 2026-11-12, conflict-window-bonsai/00002 v2 (rendered 5:30, user
  approved the script): ledger openings 49/85 → 23/91, questions 1 → 3,
  direct address 0 → 6, quote scenes 2 → 3 (every speech in the run).
  Narration pace 151 wpm (reference 154). Open lessons, for debate:
  - A cold open that sits one turn *before* the climax (turn 29) leaves the
    payoff turn (30) without its own scene: it is only narrated over the
    outcome chart, with no callout or shutdown stamp. v1 avoided it by
    opening on turn 30 itself. Candidate rule: if the cold open is not the
    climax turn, the climax still gets a scene before the outcome.
  - Splitting one turn into two scenes (s2/s3, to land each quote) works for
    the narration, but the video shows the whole turn's callouts in both
    (DIRECTION.md §8).
  - Not yet watched by the user: cadence judged by measures only so far.
