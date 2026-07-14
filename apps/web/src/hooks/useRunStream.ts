import { useEffect, useState } from "react";

import { TraceEventSchema, type TraceEvent } from "../../../../src/protocol/schema.js";

import type { ArenaEventSource } from "../api.js";

export type RunStreamConnection = "connecting" | "open" | "error" | "closed";

export interface RunStreamApi {
  openRunStream(runId: string): ArenaEventSource;
}

export interface RunStreamState {
  readonly events: readonly TraceEvent[];
  readonly connection: RunStreamConnection;
  readonly lastError: string | null;
}

const initialState: RunStreamState = {
  events: [],
  connection: "connecting",
  lastError: null
};

function ordered(values: Map<number, TraceEvent>): TraceEvent[] {
  return [...values.values()].sort((left, right) => left.seq - right.seq);
}

function isTerminal(event: TraceEvent): boolean {
  return event.kind === "run.finished" || event.kind === "run.errored";
}

export function useRunStream(runId: string, api: RunStreamApi): RunStreamState {
  const [state, setState] = useState<RunStreamState>(initialState);

  useEffect(() => {
    const bySequence = new Map<number, TraceEvent>();
    let disposed = false;
    let sourceClosed = false;
    setState(initialState);
    let source: ArenaEventSource;
    try {
      source = api.openRunStream(runId);
    } catch {
      setState({ ...initialState, connection: "error", lastError: "Run stream connection error" });
      return;
    }
    const closeSource = (): void => {
      if (sourceClosed) return;
      sourceClosed = true;
      source.close();
    };

    source.onopen = () => {
      if (disposed || sourceClosed) return;
      setState((current) => ({ ...current, connection: "open" }));
    };
    source.onmessage = (message) => {
      if (disposed || sourceClosed) return;
      let event: TraceEvent;
      try {
        event = TraceEventSchema.parse(JSON.parse(message.data));
      } catch {
        setState((current) => ({ ...current, lastError: "Invalid run event" }));
        return;
      }
      if (event.run_id !== runId) {
        setState((current) => ({ ...current, lastError: "Invalid run event" }));
        return;
      }
      if (bySequence.has(event.seq)) return;
      bySequence.set(event.seq, event);
      const terminal = isTerminal(event);
      setState((current) => ({
        ...current,
        events: ordered(bySequence),
        connection: terminal ? "closed" : current.connection
      }));
      if (terminal) closeSource();
    };
    source.onerror = () => {
      if (disposed || sourceClosed) return;
      setState((current) => ({
        ...current,
        connection: "error",
        lastError: "Run stream connection error"
      }));
    };

    return () => {
      disposed = true;
      source.onopen = null;
      source.onmessage = null;
      source.onerror = null;
      closeSource();
    };
  }, [api, runId]);

  return state;
}
