import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const outputPath = valueAfter("--output-last-message") ?? valueAfter("-o");
const prompt = args.at(-1);

if (prompt === "timeout") {
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
    env: process.env
  }));
}
