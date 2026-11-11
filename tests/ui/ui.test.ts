import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runExperiment } from "../../src/engine/runner.js";
import { createUiServer } from "../../src/ui/server.js";
// @ts-expect-error plain browser module, no types
import { addEvent, agentTimeline, createIndex, mapCells, snapshotAfter, statsUntil, toXY } from "../../src/ui/public/model.js";

let eventsDir: string;
let base: string;
let close: () => void;

beforeAll(async () => {
  eventsDir = mkdtempSync(join(tmpdir(), "lab-ui-"));
  await runExperiment("experiments/first-contact-mock.yaml", { eventsDir });
  const server = createUiServer({ eventsDir, pollMs: 20 }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

/** Reads SSE data lines until `end` or until `count` messages arrived. */
async function readStream(url: string, stopAfter?: number, onMessage?: (n: number) => void) {
  const res = await fetch(url);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const messages: unknown[] = [];
  let buffer = "";
  let ended = false;
  while (!ended) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (block.startsWith("event: end")) ended = true;
      else if (block.startsWith("data: ")) {
        messages.push(JSON.parse(block.slice(6)));
        onMessage?.(messages.length);
      }
    }
    if (stopAfter && messages.length >= stopAfter) break;
  }
  await reader.cancel().catch(() => {});
  return { messages, ended };
}

describe("UI server", () => {
  it("serves the page and lists runs", async () => {
    expect((await fetch(`${base}/`)).headers.get("content-type")).toMatch(/text\/html/);
    expect(await (await fetch(`${base}/model.js`)).text()).toContain("export function addEvent");
    const runs = await (await fetch(`${base}/api/runs`)).json();
    expect(runs).toMatchObject([{ ref: "first-contact-mock/00001", status: "finished", turn: 50 }]);
  });

  it("streams a finished run and ends", async () => {
    const { messages, ended } = await readStream(`${base}/api/runs/first-contact-mock/00001/stream`);
    const lines = readFileSync(join(eventsDir, "first-contact-mock/00001.jsonl"), "utf8").trim().split("\n");
    expect(messages).toHaveLength(lines.length);
    expect(ended).toBe(true);
  });

  it("tails a live run, including lines written after connecting", async () => {
    const lines = readFileSync(join(eventsDir, "first-contact-mock/00001.jsonl"), "utf8").trim().split("\n");
    mkdirSync(join(eventsDir, "live"));
    const path = join(eventsDir, "live/00001.jsonl");
    writeFileSync(path, lines.slice(0, 10).join("\n") + "\n" + lines[10]!.slice(0, 20)); // partial line
    const { messages, ended } = await readStream(`${base}/api/runs/live/00001/stream`, undefined, (n) => {
      if (n === 10) appendFileSync(path, lines[10]!.slice(20) + "\n" + lines.slice(11).join("\n") + "\n");
    });
    expect(messages).toHaveLength(lines.length);
    expect(ended).toBe(true);
  });

  it("ends the stream of a dead run (no end event, no growth)", async () => {
    const lines = readFileSync(join(eventsDir, "first-contact-mock/00001.jsonl"), "utf8").trim().split("\n");
    mkdirSync(join(eventsDir, "dead"));
    const path = join(eventsDir, "dead/00001.jsonl");
    writeFileSync(path, lines.slice(0, 20).join("\n") + "\n");
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(path, old, old);
    const { messages, ended } = await readStream(`${base}/api/runs/dead/00001/stream`);
    expect(messages).toHaveLength(20);
    expect(ended).toBe(true);
    const runs = await (await fetch(`${base}/api/runs`)).json();
    expect(runs.find((r: { ref: string }) => r.ref === "dead/00001")).toMatchObject({ status: "interrupted", interruption: { inferred: true } });
  });

  it("rejects bad paths and writes", async () => {
    expect((await fetch(`${base}/api/runs/..%2Fetc/00001/stream`)).status).toBe(400);
    expect((await fetch(`${base}/api/runs/nope/00001/stream`)).status).toBe(404);
    expect((await fetch(`${base}/../package.json`)).status).toBe(404);
    expect((await fetch(`${base}/api/runs`, { method: "POST" })).status).toBe(405);
  });
});

describe("UI run model", () => {
  const load = () => {
    const index = createIndex();
    for (const line of readFileSync(join(eventsDir, "first-contact-mock/00001.jsonl"), "utf8").trim().split("\n")) {
      addEvent(index, JSON.parse(line));
    }
    return index;
  };

  it("indexes turns, agents and status", () => {
    const index = load();
    expect(index.status).toBe("finished");
    expect(index.maxTurn).toBe(50);
    expect([...index.turns.get(1).agents.keys()]).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    expect(mapCells(index)[1][1]).toEqual({ symbol: "#", type: "wall", blocks: true });
  });

  it("reconstructs the world at any turn, consistent with observations", () => {
    const index = load();
    for (const turn of [1, 10, 49]) {
      const after = snapshotAfter(index, turn);
      for (const [id, a] of Object.entries(after.agents) as Array<[string, { position: number[] }]>) {
        const next = index.turns.get(turn + 1).agents.get(id).observation.position;
        expect(toXY(a.position)).toEqual(toXY(next));
      }
    }
    expect(snapshotAfter(index, 0)).toEqual(index.started.snapshot);
  });

  it("builds per-agent timelines and stats", () => {
    const index = load();
    const timeline = agentTimeline(index, "a5");
    expect(timeline).toHaveLength(50);
    expect(timeline[0].action.action).toBe("move");
    const s = statsUntil(index, "a5", 50);
    expect(s.accepted + s.rejected).toBe(50);
  });
});
