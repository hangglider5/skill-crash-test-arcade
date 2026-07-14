import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useRunStream } from "../../apps/web/src/hooks/useRunStream.js";

interface SourceLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

class FakeEventSource implements SourceLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly close = vi.fn();

  open(): void {
    this.onopen?.(new Event("open"));
  }

  message(value: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  error(): void {
    this.onerror?.(new Event("error"));
  }
}

function trace(runId: string, seq: number): Record<string, unknown> {
  return {
    v: 1,
    run_id: runId,
    seq,
    phase: "inspect",
    kind: "phase.entered",
    actor: "arena",
    data: {},
    artifacts: []
  };
}

describe("useRunStream", () => {
  it("sorts replay and live events by sequence and ignores duplicates", () => {
    const source = new FakeEventSource();
    const api = { openRunStream: vi.fn(() => source) };
    const { result } = renderHook(() => useRunStream("run_01", api));

    act(() => {
      source.open();
      source.message(trace("run_01", 2));
      source.message(trace("run_01", 0));
      source.message(trace("run_01", 1));
      source.message(trace("run_01", 1));
    });

    expect(result.current.connection).toBe("open");
    expect(result.current.events.map((event) => event.seq)).toEqual([0, 1, 2]);
  });

  it("rejects invalid and wrong-run events without contaminating valid events", () => {
    const source = new FakeEventSource();
    const api = { openRunStream: vi.fn(() => source) };
    const { result } = renderHook(() => useRunStream("run_01", api));

    act(() => {
      source.message(trace("run_01", 0));
      source.message({ private: "server-secret" });
      source.message(trace("run_02", 1));
    });

    expect(result.current.events.map((event) => event.seq)).toEqual([0]);
    expect(result.current.lastError).toBe("Invalid run event");
    expect(result.current.lastError).not.toContain("server-secret");
  });

  it("keeps EventSource reconnectable on error and closes it when dependencies change", () => {
    const first = new FakeEventSource();
    const second = new FakeEventSource();
    const firstApi = { openRunStream: vi.fn(() => first) };
    const secondApi = { openRunStream: vi.fn(() => second) };
    const { result, rerender, unmount } = renderHook(
      ({ runId, api }) => useRunStream(runId, api),
      { initialProps: { runId: "run_01", api: firstApi } }
    );

    act(() => first.error());
    expect(result.current.connection).toBe("error");
    expect(first.close).not.toHaveBeenCalled();

    rerender({ runId: "run_02", api: secondApi });
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(result.current.events).toEqual([]);
    expect(result.current.connection).toBe("connecting");

    unmount();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it("closes a terminal run stream instead of reconnecting it", () => {
    const source = new FakeEventSource();
    const api = { openRunStream: vi.fn(() => source) };
    const { result } = renderHook(() => useRunStream("run_01", api));

    act(() => source.message({ ...trace("run_01", 0), kind: "run.finished" }));

    expect(result.current.events.map((value) => value.seq)).toEqual([0]);
    expect(result.current.connection).toBe("closed");
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it("reports a safe error when EventSource construction fails", () => {
    const api = {
      openRunStream: vi.fn(() => {
        throw new Error("server-secret EventSource failure");
      })
    };

    const { result } = renderHook(() => useRunStream("run_01", api));

    expect(result.current.events).toEqual([]);
    expect(result.current.connection).toBe("error");
    expect(result.current.lastError).toBe("Run stream connection error");
    expect(result.current.lastError).not.toContain("server-secret");
  });
});
