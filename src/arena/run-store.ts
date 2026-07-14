import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import {
  RunEnvelopeSchema,
  TraceEventSchema,
  canonicalJson,
  type RunEnvelope,
  type TraceEvent
} from "../protocol/index.js";

type RunRecordName =
  | "run.json"
  | "verdict.json"
  | "diagnosis.json"
  | "repair.json";

const RUN_RECORD_NAMES: ReadonlySet<string> = new Set<RunRecordName>([
  "run.json",
  "verdict.json",
  "diagnosis.json",
  "repair.json"
]);

async function writeAtomically(destination: string, value: unknown): Promise<void> {
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, `${canonicalJson(value)}\n`, { flag: "wx" });
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export class RunStore {
  readonly #root: string;
  readonly #appendLocks = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  async create(envelope: RunEnvelope): Promise<void> {
    const parsed = RunEnvelopeSchema.parse(envelope);
    const runDirectory = this.#runDirectory(parsed.run_id);

    await mkdir(this.#root, { recursive: true });
    await mkdir(runDirectory);
    await writeAtomically(path.join(runDirectory, "run.json"), parsed);
    await writeFile(path.join(runDirectory, "trace.jsonl"), "", { flag: "wx" });
  }

  async appendEvent(runId: string, event: TraceEvent): Promise<void> {
    const runDirectory = this.#runDirectory(runId);
    const parsed = TraceEventSchema.parse(event);
    if (parsed.run_id !== runId) {
      throw new Error(`Trace event run_id ${parsed.run_id} does not match ${runId}`);
    }

    await this.#withAppendLock(runId, async () => {
      const events = await this.readEvents(runId);
      const expectedSequence = (events.at(-1)?.seq ?? -1) + 1;
      if (parsed.seq !== expectedSequence) {
        throw new Error(
          `Trace sequence expected seq ${expectedSequence}, received ${parsed.seq}`
        );
      }

      await writeFile(
        path.join(runDirectory, "trace.jsonl"),
        `${canonicalJson(parsed)}\n`,
        { flag: "a" }
      );
    });
  }

  async readEvents(runId: string): Promise<TraceEvent[]> {
    const tracePath = path.join(this.#runDirectory(runId), "trace.jsonl");
    const contents = await readFile(tracePath, "utf8");

    return contents
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => TraceEventSchema.parse(JSON.parse(line)));
  }

  async writeRecord(
    runId: string,
    name: RunRecordName,
    value: unknown
  ): Promise<void> {
    if (!RUN_RECORD_NAMES.has(name)) {
      throw new Error(`Unsupported run record: ${name}`);
    }

    const runDirectory = this.#runDirectory(runId);
    await readFile(path.join(runDirectory, "run.json"));
    await writeAtomically(path.join(runDirectory, name), value);
  }

  #runDirectory(runId: string): string {
    if (runId.length === 0 || runId.includes("\0")) {
      throw new Error(`Invalid run id: ${runId}`);
    }

    const runDirectory = path.resolve(this.#root, runId);
    if (
      path.dirname(runDirectory) !== this.#root
      || path.basename(runDirectory) !== runId
    ) {
      throw new Error(`Invalid run id: ${runId}`);
    }

    return runDirectory;
  }

  async #withAppendLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#appendLocks.get(runId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.#appendLocks.set(runId, tail);

    try {
      return await result;
    } finally {
      if (this.#appendLocks.get(runId) === tail) {
        this.#appendLocks.delete(runId);
      }
    }
  }
}
