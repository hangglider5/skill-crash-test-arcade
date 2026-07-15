import { writeFile } from "node:fs/promises";
import { closeSync } from "node:fs";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (args[0] === "--close-stdin") {
  closeSync(0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.exit(0);
}
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const outputPath = valueAfter("--output-last-message") ?? valueAfter("-o");
const promptChunks = [];
for await (const chunk of process.stdin) promptChunks.push(chunk);
const prompt = Buffer.concat(promptChunks).toString("utf8");
const stdinPreamble = "Reading prompt from stdin...";
const oneEvent = '{"type":"thread.started","thread_id":"thread_fake"}';
const malformedPreambleOutput = new Map([
  ["stdin-preamble-duplicate", `${stdinPreamble}\n${stdinPreamble}\n`],
  ["stdin-preamble-after-event", `${oneEvent}\n${stdinPreamble}\n`],
  ["stdin-preamble-prefix", `prefix ${stdinPreamble}\n`],
  ["stdin-preamble-suffix", `${stdinPreamble} suffix\n`],
  ["stdin-preamble-ansi", `\u001b[32m${stdinPreamble}\u001b[0m\n`],
  ["stdin-preamble-unknown", "Reading additional input from stdin...\n"]
]);

if (prompt === "stdin-preamble") {
  process.stdout.write(`${stdinPreamble}\n${oneEvent}\n`);
  await writeFile(outputPath, '{"completed":true,"summary":"ok"}');
} else if (malformedPreambleOutput.has(prompt)) {
  process.stdout.write(malformedPreambleOutput.get(prompt));
} else if (prompt === "timeout") {
  setInterval(() => {}, 1_000);
} else if (prompt === "ignore-term") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else if (prompt?.startsWith("spawn-child:")) {
  const marker = prompt.slice("spawn-child:".length);
  spawn(process.execPath, ["-e", `setTimeout(() => require('fs').appendFileSync(${JSON.stringify(marker)}, 'alive'), 1500)`], {
    stdio: "ignore"
  });
  setInterval(() => {}, 1_000);
} else if (prompt === "invalid-json") {
  process.stdout.write('not secret: hidden payload\n{"type":"thread.started","thread_id":"must_not_emit"}\n');
} else if (prompt === "invalid-json-ignore-term") {
  process.on("SIGTERM", () => {});
  process.stdout.write('not secret: hidden payload\n');
  setInterval(() => {}, 1_000);
} else if (prompt === "one-event") {
  process.stdout.write('{"type":"thread.started","thread_id":"thread_fake"}\n');
  await writeFile(outputPath, '{"completed":true,"summary":"ok"}');
} else if (prompt === "final-no-newline") {
  process.stdout.write('{"type":"thread.started","thread_id":"thread_fake"}');
  await writeFile(outputPath, '{"completed":true,"summary":"ok"}');
} else if (prompt === "crlf") {
  process.stdout.write('{"type":"thread.started","thread_id":"thread_fake"}\r\n');
  await writeFile(outputPath, '{"completed":true,"summary":"ok"}');
} else if (prompt === "oversize-line") {
  process.stdout.write(`${"x".repeat(2048)}\n`);
} else if (prompt === "oversize-stream") {
  for (let index = 0; index < 100; index += 1) {
    process.stdout.write(`${JSON.stringify({ type: "unknown", index, pad: "x".repeat(80) })}\n`);
  }
} else if (prompt === "stderr-large") {
  process.stderr.write("s".repeat(4096));
  process.exitCode = 3;
} else if (prompt === "missing-output") {
  process.stdout.write('{"type":"thread.started","thread_id":"thread_fake"}\n');
} else if (prompt === "invalid-output") {
  await writeFile(outputPath, "not json");
} else if (prompt === "oversize-output") {
  await writeFile(outputPath, JSON.stringify({ value: "x".repeat(4096) }));
} else if (prompt === "exit-7") {
  process.stderr.write("private stderr");
  process.exitCode = 7;
} else {
  const events = [
    { type: "thread.started", thread_id: "thread_fake" },
    { type: "item.started", item: { id: "item_1", type: "command_execution", command: "git status --short", status: "in_progress" } },
    { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "git status --short", aggregated_output: " M docs/roadmap.md\n", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Task complete" } },
    { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 10 } }
  ];
  process.stdout.write(`${events.map(JSON.stringify).join("\n")}\n`);
  await writeFile(outputPath, JSON.stringify({
    completed: true,
    summary: "Task complete",
    argv: args,
    prompt,
    env: process.env
  }));
}
