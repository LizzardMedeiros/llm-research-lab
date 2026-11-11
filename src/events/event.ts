import { mkdirSync, openSync, readdirSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";

export const EVENT_TYPES = [
  "experiment.started",
  "experiment.finished",
  "experiment.failed",
  "experiment.interrupted",
  "agent.observation",
  "agent.model_request",
  "agent.model_response",
  "agent.model_error",
  "agent.action",
  "agent.deactivated",
  "environment.action_rejected",
  "environment.transition",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Stable envelope (README §8). */
export interface LabEvent {
  event_id: string;
  experiment_id: string;
  run_id: string;
  turn: number;
  type: EventType;
  agent_id?: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface EventSink {
  write(event: LabEvent): void;
  close(): void;
}

export class MemorySink implements EventSink {
  readonly events: LabEvent[] = [];
  write(event: LabEvent) {
    this.events.push(event);
  }
  close() {}
}

/** Appends one JSON object per line to events/<experiment_id>/<run_id>.jsonl. */
export class JsonlSink implements EventSink {
  readonly path: string;
  private fd: number | null;

  constructor(path: string) {
    this.path = path;
    this.fd = openSync(path, "a");
  }

  write(event: LabEvent) {
    if (this.fd === null) throw new Error("JsonlSink is closed");
    writeSync(this.fd, `${JSON.stringify(event)}\n`);
  }

  close() {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

/** Next run id for an experiment: 00001, 00002, ... based on existing logs. */
export function nextRunId(eventsDir: string, experimentId: string): { runId: string; path: string } {
  const dir = join(eventsDir, experimentId);
  mkdirSync(dir, { recursive: true });
  const existing = readdirSync(dir)
    .map((file) => /^(\d+)\.jsonl$/.exec(file)?.[1])
    .filter((id): id is string => id !== undefined)
    .map(Number);
  const runId = String(Math.max(0, ...existing) + 1).padStart(5, "0");
  return { runId, path: join(dir, `${runId}.jsonl`) };
}

export type Listener = (event: LabEvent) => void;

/** Builds envelopes and fans events out to a sink and live listeners (UI). */
export class EventLog {
  private seq = 0;
  private closed = false;
  private readonly listeners = new Set<Listener>();

  constructor(
    readonly experimentId: string,
    readonly runId: string,
    private readonly sink: EventSink,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  emit(type: EventType, turn: number, payload: Record<string, unknown>, agentId?: string): LabEvent {
    const event: LabEvent = {
      event_id: `evt_${String(++this.seq).padStart(6, "0")}`,
      experiment_id: this.experimentId,
      run_id: this.runId,
      turn,
      type,
      ...(agentId ? { agent_id: agentId } : {}),
      timestamp: this.clock().toISOString(),
      payload,
    };
    // After close (e.g. an interruption), nothing more is recorded.
    if (this.closed) return event;
    this.sink.write(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.sink.close();
  }
}
