import type { CellSpec, LoadedScenario, Position } from "../config/scenario.js";

export type { Position } from "../config/scenario.js";

export interface AgentState {
  id: string;
  position: Position;
}

export interface Message {
  from: string;
  text: string;
  turn: number;
}

export interface CellView {
  position: Position;
  type: string;
  agents: string[];
}

/** What an agent receives at its next observation, then cleared. */
export interface Mailbox {
  messages: Message[];
  revealed: CellView[] | null;
  lastActionError: string | null;
}

export interface WorldSnapshot {
  turn: number;
  agents: Record<string, { position: Position }>;
  mailboxes: Record<string, Mailbox>;
  /** Scenario-defined mutable state (written by hooks). */
  state: Record<string, unknown>;
}

const emptyMailbox = (): Mailbox => ({ messages: [], revealed: null, lastActionError: null });

/** Chebyshev distance: 8-neighborhood rings. */
export const distance = (a: Position, b: Position) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

/**
 * The world: a fixed matrix of cells plus mutable state (agent positions,
 * mailboxes, hook state). Only the engine and scenario rules mutate it.
 */
export class World {
  readonly width: number;
  readonly height: number;
  readonly cells: readonly (readonly CellSpec[])[];
  readonly agents = new Map<string, AgentState>();
  readonly mailboxes = new Map<string, Mailbox>();
  /** Scenario hook state; included in every snapshot. Must be JSON-serializable. */
  state: Record<string, unknown> = {};

  constructor(scenario: Pick<LoadedScenario, "width" | "height" | "cells">) {
    this.width = scenario.width;
    this.height = scenario.height;
    this.cells = scenario.cells;
  }

  addAgent(id: string, position: Position) {
    this.agents.set(id, { id, position });
    this.mailboxes.set(id, emptyMailbox());
  }

  agent(id: string): AgentState {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Unknown agent ${id}`);
    return agent;
  }

  inBounds([x, y]: Position) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  cellAt([x, y]: Position): CellSpec | undefined {
    return this.cells[y]?.[x];
  }

  agentsAt(position: Position, excludeId?: string): string[] {
    return [...this.agents.values()]
      .filter((a) => a.id !== excludeId && a.position[0] === position[0] && a.position[1] === position[1])
      .map((a) => a.id);
  }

  /** Cells within a Chebyshev radius (in bounds), row-major order. */
  cellsWithin(center: Position, radius: number, includeCenter = true): CellView[] {
    const views: CellView[] = [];
    const r = Math.min(radius, Math.max(this.width, this.height));
    for (let y = center[1] - r; y <= center[1] + r; y++) {
      for (let x = center[0] - r; x <= center[0] + r; x++) {
        const position: Position = [x, y];
        if (!this.inBounds(position)) continue;
        if (!includeCenter && x === center[0] && y === center[1]) continue;
        views.push({ position, type: this.cellAt(position)!.type, agents: this.agentsAt(position) });
      }
    }
    return views;
  }

  mailbox(id: string): Mailbox {
    const box = this.mailboxes.get(id);
    if (!box) throw new Error(`Unknown agent ${id}`);
    return box;
  }

  /** Returns and clears what was waiting for the agent. */
  takeMailbox(id: string): Mailbox {
    const box = this.mailbox(id);
    this.mailboxes.set(id, emptyMailbox());
    return box;
  }

  snapshot(turn: number): WorldSnapshot {
    return structuredClone({
      turn,
      agents: Object.fromEntries([...this.agents.values()].map((a) => [a.id, { position: a.position }])),
      mailboxes: Object.fromEntries(this.mailboxes),
      state: this.state,
    });
  }
}
