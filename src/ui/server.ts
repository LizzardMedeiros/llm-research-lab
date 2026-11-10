/**
 * Observe-only UI server. Reads run logs (never engine state) and streams
 * them to the browser over SSE; live runs are tailed as they are written.
 *
 *   LAB_EVENTS_DIR=events PORT=3000 tsx src/ui/server.ts
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listRunFiles, loadRun } from "../mcp/run-reader.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const TERMINAL = ['"type":"experiment.finished"', '"type":"experiment.failed"'];

export interface UiServerOptions {
  eventsDir: string;
  /** Tail polling interval for live runs. */
  pollMs?: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function serveStatic(res: ServerResponse, path: string) {
  const file = resolve(PUBLIC_DIR, path === "/" ? "index.html" : `.${path}`);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    return sendJson(res, 404, { error: "not found" });
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
  createReadStream(file).pipe(res);
}

/** Streams every line of a run log, then keeps tailing until a terminal event. */
function streamRun(req: IncomingMessage, res: ServerResponse, path: string, pollMs: number) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  let offset = 0;
  let partial = "";
  let done = false;

  const flush = () => {
    const size = statSync(path).size;
    if (size <= offset) return;
    const chunk = readFileSync(path).subarray(offset, size).toString("utf8");
    offset = size;
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      res.write(`data: ${line}\n\n`);
      if (TERMINAL.some((t) => line.includes(t))) done = true;
    }
  };

  const stop = () => {
    clearInterval(timer);
    clearInterval(heartbeat);
  };
  const tick = () => {
    try {
      flush();
    } catch {
      // file briefly unavailable; retry next tick
    }
    if (done) {
      res.write("event: end\ndata: {}\n\n");
      stop();
      res.end();
    }
  };
  const timer = setInterval(tick, pollMs);
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  req.on("close", stop);
  tick();
}

export function createUiServer({ eventsDir, pollMs = 500 }: UiServerOptions): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (req.method !== "GET") return sendJson(res, 405, { error: "read-only" });

      if (url.pathname === "/api/runs") {
        const runs = listRunFiles(eventsDir).map((info) => {
          const run = loadRun(eventsDir, info.ref);
          return { ref: run.ref, experiment_id: run.experimentId, run_id: run.runId, status: run.status, turn: run.lastTurn, max_turns: run.maxTurns, modified_at: run.modifiedAt };
        });
        return sendJson(res, 200, runs);
      }

      // /api/runs/<experiment_id>/<run_id>/stream
      if (parts[0] === "api" && parts[1] === "runs" && parts.length === 5 && parts[4] === "stream") {
        const [experimentId, runId] = [parts[2]!, parts[3]!];
        if (!SEGMENT.test(experimentId) || !/^\d+$/.test(runId)) return sendJson(res, 400, { error: "invalid run" });
        const path = join(eventsDir, experimentId, `${runId}.jsonl`);
        if (!existsSync(path)) return sendJson(res, 404, { error: `run ${experimentId}/${runId} not found` });
        return streamRun(req, res, path, pollMs);
      }

      if (parts[0] === "api") return sendJson(res, 404, { error: "not found" });
      return serveStatic(res, url.pathname);
    } catch (error) {
      return sendJson(res, 500, { error: (error as Error).message });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env["PORT"] ?? 3000);
  const eventsDir = process.env["LAB_EVENTS_DIR"] ?? "events";
  createUiServer({ eventsDir }).listen(port, "0.0.0.0", () => {
    console.log(`LLM Research Lab UI listening on :${port} (events: ${eventsDir}); compose publishes it on http://localhost:${process.env["LAB_PORT"] ?? 3100}`);
  });
}
