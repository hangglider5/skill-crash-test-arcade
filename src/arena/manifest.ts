import { readFile } from "node:fs/promises";

import {
  ArenaManifestSchema,
  canonicalJson,
  sha256,
  type ArenaManifest,
  type Hash
} from "../protocol/index.js";

export interface LoadedManifest {
  manifest: ArenaManifest;
  hash: Hash;
}

export interface RunnerView {
  id: string;
  name: string;
  task: string;
  budgets: ArenaManifest["budgets"];
  fault_labels: string[];
}

export interface ReplayManifest {
  schema: "arena.replay-manifest/v1";
  id: string;
  name: string;
  fixture: ArenaManifest["fixture"];
  fault_cards: ArenaManifest["fault_cards"];
  budgets: ArenaManifest["budgets"];
  scoring: ArenaManifest["scoring"];
}

export async function loadManifest(manifestPath: string): Promise<LoadedManifest> {
  const contents = await readFile(manifestPath, "utf8");
  const manifest = ArenaManifestSchema.parse(JSON.parse(contents));

  return {
    manifest,
    hash: sha256(canonicalJson(manifest))
  };
}

export function buildRunnerView(manifest: ArenaManifest): RunnerView {
  return {
    id: manifest.id,
    name: manifest.name,
    task: manifest.runner_brief.task,
    budgets: manifest.budgets,
    fault_labels: manifest.fault_cards.map(({ id }) => id)
  };
}

export function buildReplayManifest(manifest: ArenaManifest): ReplayManifest {
  return {
    schema: "arena.replay-manifest/v1",
    id: manifest.id,
    name: manifest.name,
    fixture: manifest.fixture,
    fault_cards: manifest.fault_cards,
    budgets: manifest.budgets,
    scoring: manifest.scoring
  };
}
