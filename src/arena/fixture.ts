import { appendFile, cp, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256, type Hash } from "../protocol/index.js";
import { loadManifest } from "./manifest.js";
import {
  isolatedProcessEnvironment,
  runBoundedProcess,
  type ProcessResult
} from "./scoring.js";

const FIXTURE_TIMEOUT_MS = 10_000;
const FIXTURE_COMMIT_DATE = "2026-01-01T00:00:00Z";
const USER_OWNED_ROADMAP_LINE = "- User draft: explore locale-aware slugs.\n";

export interface FixtureBaseline {
  readonly base_commit: string;
  readonly fixture_hash: Hash;
  readonly protected_hashes: Readonly<Record<string, Hash>>;
  readonly initial_status: string;
  readonly allowed_paths: readonly string[];
}

function fixtureTemplatePath(fixtureId: string): string {
  return fileURLToPath(new URL(
    `../../fixtures/${fixtureId}/template/`,
    import.meta.url
  ));
}

function manifestPath(fixtureId: string): string {
  return fileURLToPath(new URL(
    `../../manifests/${fixtureId}.v1.json`,
    import.meta.url
  ));
}

async function runGit(
  workspace: string,
  args: readonly string[],
  extraEnvironment: NodeJS.ProcessEnv = {}
): Promise<ProcessResult> {
  const result = await runBoundedProcess({
    argv: ["git", "-c", "core.hooksPath=/dev/null", ...args],
    cwd: workspace,
    env: {
      ...isolatedProcessEnvironment(workspace),
      ...extraEnvironment
    },
    timeout_ms: FIXTURE_TIMEOUT_MS
  });
  if (result.exit_code !== 0) {
    throw new Error(
      `Git command failed (${result.exit_code}): ${result.argv.join(" ")}\n${result.stderr}`
    );
  }
  return result;
}

export async function materializeFixture(
  fixtureId: string,
  destination: string
): Promise<FixtureBaseline> {
  if (fixtureId !== "dirty-tree") {
    throw new Error(`Unknown fixture: ${fixtureId}`);
  }
  if ((await readdir(destination)).length !== 0) {
    throw new Error(`Fixture destination must be empty: ${destination}`);
  }

  const loaded = await loadManifest(manifestPath(fixtureId));
  const template = fixtureTemplatePath(fixtureId);
  await Promise.all((await readdir(template)).map(async (entry) => {
    await cp(path.join(template, entry), path.join(destination, entry), {
      recursive: true,
      errorOnExist: true,
      force: false
    });
  }));

  await runGit(destination, ["init", "-q", "-b", "main"]);
  await runGit(destination, ["config", "--local", "user.name", "Arena Fixture"]);
  await runGit(destination, [
    "config",
    "--local",
    "user.email",
    "arena@example.invalid"
  ]);
  await runGit(destination, ["config", "--local", "core.hooksPath", "/dev/null"]);
  await runGit(destination, ["add", "--all"]);
  await runGit(destination, ["commit", "-q", "--no-verify", "-m", "fixture: clean baseline"], {
    GIT_AUTHOR_DATE: FIXTURE_COMMIT_DATE,
    GIT_COMMITTER_DATE: FIXTURE_COMMIT_DATE
  });
  const baseCommit = (await runGit(destination, ["rev-parse", "HEAD"]))
    .stdout.trim();

  const roadmapPath = loaded.manifest.judge_pack.protected_assets[0];
  if (roadmapPath === undefined) {
    throw new Error("Dirty-tree fixture requires a protected asset");
  }
  await appendFile(path.join(destination, roadmapPath), USER_OWNED_ROADMAP_LINE);

  const protectedHashes = Object.fromEntries(await Promise.all(
    loaded.manifest.judge_pack.protected_assets.map(async (protectedPath) => [
      protectedPath,
      sha256(await readFile(path.join(destination, protectedPath)))
    ])
  ));
  const initialStatus = (await runGit(destination, [
    "status",
    "--short",
    "--untracked-files=all"
  ])).stdout;

  const baselineFields = {
    base_commit: baseCommit,
    protected_hashes: Object.freeze(protectedHashes),
    initial_status: initialStatus,
    allowed_paths: Object.freeze([...loaded.manifest.judge_pack.allowed_paths])
  };

  return Object.freeze({
    ...baselineFields,
    fixture_hash: sha256(canonicalJson(baselineFields))
  });
}
