import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const STARTUP_TIMEOUT_MS = 10_000;

async function requireBuildOutput(candidate: string, kind: "file" | "directory"): Promise<void> {
  const value = await stat(candidate);
  if (kind === "file" ? !value.isFile() : !value.isDirectory()) {
    throw new Error(`Built ${kind} is unavailable`);
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000))
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

export async function smokeBuiltServer(): Promise<void> {
  const cli = path.join(PROJECT_ROOT, "dist", "core", "cli.js");
  const web = path.join(PROJECT_ROOT, "dist", "web");
  await Promise.all([requireBuildOutput(cli, "file"), requireBuildOutput(web, "directory")]);
  const appData = await realpath(await mkdtemp(path.join(tmpdir(), "scta-built-smoke-")));
  const child = spawn(process.execPath, [
    cli,
    "--no-open",
    "--port", "4318",
    "--app-data", appData
  ], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  try {
    const startupUrl = await new Promise<string>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("Built server startup exceeded 10 seconds")), STARTUP_TIMEOUT_MS);
      const inspect = (): void => {
        const match = /http:\/\/localhost:4318\/\?token=[A-Za-z0-9%_-]+/u.exec(stdout);
        if (match?.[0] !== undefined) {
          clearTimeout(deadline);
          resolve(match[0]);
        }
      };
      child.stdout?.on("data", inspect);
      child.once("exit", (code) => {
        clearTimeout(deadline);
        reject(new Error(`Built server exited before startup (${code ?? "signal"})`));
      });
      inspect();
    });
    const parsed = new URL(startupUrl);
    if (parsed.hostname !== "localhost" || parsed.port !== "4318"
      || (parsed.searchParams.get("token")?.length ?? 0) < 32) {
      throw new Error("Built server did not print a valid tokenized loopback URL");
    }
    const response = await fetch("http://127.0.0.1:4318/api/health", {
      signal: AbortSignal.timeout(2_000)
    });
    if (response.status !== 200) throw new Error(`Built health returned ${response.status}`);
    process.stdout.write("built server smoke: loopback health 200; dist/core and dist/web present\n");
  } catch (error) {
    if (stderr.length > 0) process.stderr.write(stderr.slice(0, 2_000));
    throw error;
  } finally {
    await terminate(child);
    await rm(appData, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void smokeBuiltServer().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Built server smoke failed"}\n`);
    process.exitCode = 1;
  });
}
