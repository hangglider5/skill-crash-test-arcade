import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
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
    try {
      const existing = await lstat(destination);
      if (existing.isSymbolicLink()) {
        throw new Error(`Run record must not be a symbolic link: ${destination}`);
      }
      if (!existing.isFile()) {
        throw new Error(`Run record must be a regular file: ${destination}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    await writeFile(temporaryPath, `${canonicalJson(value)}\n`, { flag: "wx" });
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readRegularFile(filePath: string): Promise<string> {
  const stats = await lstat(filePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Run record must not be a symbolic link: ${filePath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Run record must be a regular file: ${filePath}`);
  }

  return readFile(filePath, "utf8");
}

function directChild(root: string, name: string): string {
  const child = path.resolve(root, name);
  if (path.dirname(child) !== root || path.basename(child) !== name) {
    throw new Error(`Run path escapes configured root: ${name}`);
  }

  return child;
}

export class RunStore {
  readonly #configuredRoot: string;
  #canonicalRoot: Promise<string> | undefined;
  readonly #appendLocks = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.#configuredRoot = path.resolve(root);
  }

  async create(envelope: RunEnvelope): Promise<void> {
    const parsed = RunEnvelopeSchema.parse(envelope);
    const root = await this.#rootDirectory();
    const runDirectory = this.#runPath(root, parsed.run_id);

    await mkdir(runDirectory);
    await this.#assertRunDirectory(root, runDirectory);
    await writeAtomically(directChild(runDirectory, "run.json"), parsed);
    await writeFile(directChild(runDirectory, "trace.jsonl"), "", { flag: "wx" });
  }

  async appendEvent(runId: string, event: TraceEvent): Promise<void> {
    this.#validateRunId(runId);
    const parsed = TraceEventSchema.parse(event);
    if (parsed.run_id !== runId) {
      throw new Error(`Trace event run_id ${parsed.run_id} does not match ${runId}`);
    }

    await this.#withAppendLock(runId, async () => {
      const root = await this.#rootDirectory();
      const runDirectory = this.#runPath(root, runId);
      await this.#assertRunDirectory(root, runDirectory);
      const events = await this.readEvents(runId);
      const expectedSequence = (events.at(-1)?.seq ?? -1) + 1;
      if (parsed.seq !== expectedSequence) {
        throw new Error(
          `Trace sequence expected seq ${expectedSequence}, received ${parsed.seq}`
        );
      }

      await this.#assertRunDirectory(root, runDirectory);
      const tracePath = directChild(runDirectory, "trace.jsonl");
      const traceContents = await readRegularFile(tracePath);
      const separator = traceContents.length > 0 && !traceContents.endsWith("\n")
        ? "\n"
        : "";
      await writeFile(
        tracePath,
        `${separator}${canonicalJson(parsed)}\n`,
        { flag: "a" }
      );
    });
  }

  async readEvents(runId: string): Promise<TraceEvent[]> {
    const root = await this.#rootDirectory();
    const runDirectory = this.#runPath(root, runId);
    await this.#assertRunDirectory(root, runDirectory);
    const tracePath = directChild(runDirectory, "trace.jsonl");
    const contents = await readRegularFile(tracePath);
    if (contents.length === 0) {
      return [];
    }

    const lines = contents.split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }

    return lines.map((line, index) => {
      if (line.length === 0) {
        throw new Error(`Trace contains an empty line at line ${index + 1}`);
      }

      const event = TraceEventSchema.parse(JSON.parse(line));
      if (event.run_id !== runId) {
        throw new Error(`Trace event run_id ${event.run_id} does not match ${runId}`);
      }
      if (event.seq !== index) {
        throw new Error(
          `Trace sequence expected seq ${index}, received ${event.seq}`
        );
      }

      return event;
    });
  }

  async writeRecord(
    runId: string,
    name: RunRecordName,
    value: unknown
  ): Promise<void> {
    if (!RUN_RECORD_NAMES.has(name)) {
      throw new Error(`Unsupported run record: ${name}`);
    }

    const root = await this.#rootDirectory();
    const runDirectory = this.#runPath(root, runId);
    await this.#assertRunDirectory(root, runDirectory);
    const persistedEnvelope = RunEnvelopeSchema.parse(JSON.parse(
      await readRegularFile(directChild(runDirectory, "run.json"))
    ));
    if (persistedEnvelope.run_id !== runId) {
      throw new Error(
        `Persisted run_id ${persistedEnvelope.run_id} does not match ${runId}`
      );
    }

    let record = value;
    if (name === "run.json") {
      const parsed = RunEnvelopeSchema.parse(value);
      if (parsed.run_id !== runId) {
        throw new Error(`Run record run_id ${parsed.run_id} does not match ${runId}`);
      }
      record = parsed;
    }

    await writeAtomically(directChild(runDirectory, name), record);
  }

  #validateRunId(runId: string): void {
    if (runId.length === 0 || runId.includes("\0")) {
      throw new Error(`Invalid run id: ${runId}`);
    }
  }

  #runPath(root: string, runId: string): string {
    this.#validateRunId(runId);
    const runDirectory = path.resolve(root, runId);
    if (
      path.dirname(runDirectory) !== root
      || path.basename(runDirectory) !== runId
    ) {
      throw new Error(`Invalid run id: ${runId}`);
    }

    return runDirectory;
  }

  async #rootDirectory(): Promise<string> {
    this.#canonicalRoot ??= (async () => {
      await mkdir(this.#configuredRoot, { recursive: true });
      const root = await realpath(this.#configuredRoot);
      const stats = await lstat(root);
      if (!stats.isDirectory()) {
        throw new Error(`Run root is not a directory: ${root}`);
      }
      return root;
    })();

    return this.#canonicalRoot;
  }

  async #assertRunDirectory(root: string, runDirectory: string): Promise<void> {
    const stats = await lstat(runDirectory);
    if (stats.isSymbolicLink()) {
      throw new Error(`Run directory must not be a symbolic link: ${runDirectory}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Run path must be a directory: ${runDirectory}`);
    }

    const canonicalRunDirectory = await realpath(runDirectory);
    if (
      canonicalRunDirectory !== runDirectory
      || path.dirname(canonicalRunDirectory) !== root
    ) {
      throw new Error(`Run directory escapes configured root: ${runDirectory}`);
    }
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
