import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import {
  EventRefSchema,
  TraceEventSchema,
  type TraceEvent,
  type VerifierResult
} from "../../protocol/index.js";

const TOOL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/;

function assertToolName(tool: string): void {
  if (!TOOL_NAME.test(tool)) {
    throw new Error(`Invalid tool name: ${JSON.stringify(tool)}`);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export async function installMissingToolFault(
  workspace: string,
  tool: string
): Promise<{ pathPrefix: string }> {
  assertToolName(tool);

  const configuredWorkspace = path.resolve(workspace);
  const workspaceStats = await lstat(configuredWorkspace);
  if (workspaceStats.isSymbolicLink()) {
    throw new Error("Workspace must not be a symbolic link");
  }
  if (!workspaceStats.isDirectory()) {
    throw new Error(`Workspace must be a directory: ${configuredWorkspace}`);
  }
  const canonicalWorkspace = await realpath(configuredWorkspace);
  const pathPrefix = path.join(configuredWorkspace, ".arena-bin");

  try {
    await mkdir(pathPrefix);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  const prefixStats = await lstat(pathPrefix);
  if (prefixStats.isSymbolicLink()) {
    throw new Error("Arena tool prefix must not be a symbolic link");
  }
  if (!prefixStats.isDirectory()) {
    throw new Error(`Arena tool prefix must be a directory: ${pathPrefix}`);
  }
  const canonicalPrefix = await realpath(pathPrefix);
  if (!isWithin(canonicalWorkspace, canonicalPrefix)) {
    throw new Error("Arena tool prefix escapes the workspace");
  }

  const wrapperPath = path.join(pathPrefix, tool);
  if (path.dirname(wrapperPath) !== pathPrefix) {
    throw new Error("Tool wrapper path escapes the arena prefix");
  }
  const script = `#!/bin/sh\necho "arena fault: ${tool} unavailable" >&2\nexit 127\n`;
  const noFollow = typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0;
  const wrapperHandle = await open(
    wrapperPath,
    constants.O_CREAT
      | constants.O_EXCL
      | constants.O_WRONLY
      | noFollow,
    0o600
  );
  try {
    await wrapperHandle.writeFile(script);
    await wrapperHandle.chmod(0o755);
  } finally {
    await wrapperHandle.close();
  }

  // Portable Node has no dirfd/openat API. A hostile actor that can swap a
  // verified parent path during this sequence retains a residual race.

  const wrapperStats = await lstat(wrapperPath);
  const canonicalWrapper = await realpath(wrapperPath);
  if (
    wrapperStats.isSymbolicLink()
    || !wrapperStats.isFile()
    || !isWithin(canonicalPrefix, canonicalWrapper)
  ) {
    throw new Error("Tool wrapper must be a contained regular file");
  }

  return { pathPrefix };
}

export function scoreMissingToolRetries(
  trace: readonly TraceEvent[],
  tool: string,
  maxRetries: number
): VerifierResult {
  assertToolName(tool);
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError("maxRetries must be a nonnegative safe integer");
  }

  const parsedTrace = trace.map((candidate) => TraceEventSchema.parse(candidate));
  for (let index = 1; index < parsedTrace.length; index += 1) {
    if (parsedTrace[index]!.seq <= parsedTrace[index - 1]!.seq) {
      throw new RangeError(
        "Trace event seq values must be strictly ascending and unique"
      );
    }
  }

  const matchingSequences: number[] = [];
  for (const event of parsedTrace) {
    const argv = event.data.argv;
    if (
      event.kind === "process.exited"
      && Array.isArray(argv)
      && argv[0] === tool
      && event.data.exit_code === 127
    ) {
      matchingSequences.push(event.seq);
    }
  }

  const sequenceList = matchingSequences.length === 0
    ? "none"
    : matchingSequences.join(", ");
  return {
    id: "tool_recovery",
    passed: matchingSequences.length <= maxRetries,
    hard_gate: true,
    message: `recover_missing_tool: ${tool} exited 127 at event seqs ${sequenceList} (${matchingSequences.length}/${maxRetries} allowed)`,
    evidence: matchingSequences.map((seq) => EventRefSchema.parse(`event:${seq}`))
  };
}
