import { TraceEventSchema, type TraceEvent } from "../protocol/index.js";

export type RunEventListener = (event: Readonly<TraceEvent>) => void | Promise<void>;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function immutableEvent(event: TraceEvent): Readonly<TraceEvent> {
  return deepFreeze(structuredClone(TraceEventSchema.parse(event)));
}

/**
 * A best-effort live projection of events which have already been persisted.
 * RunStore remains the source of truth.
 */
export class EventBus {
  readonly #listeners = new Map<string, Set<RunEventListener>>();

  subscribe(runId: string, listener: RunEventListener): () => void {
    const listeners = this.#listeners.get(runId) ?? new Set<RunEventListener>();
    listeners.add(listener);
    this.#listeners.set(runId, listeners);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(runId);
    };
  }

  /** Called only after RunStore.appendEvent has succeeded. */
  publishPersisted(event: TraceEvent): void {
    const parsed = TraceEventSchema.parse(event);
    const listeners = [...(this.#listeners.get(parsed.run_id) ?? [])];
    for (const listener of listeners) {
      try {
        const outcome = listener(immutableEvent(parsed));
        void Promise.resolve(outcome).catch(() => undefined);
      } catch {
        // A UI/SSE listener cannot change persisted arena truth.
      }
    }
  }
}
