import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.env.ARENA_WORKSPACE;
if (workspace === undefined || workspace.length === 0) {
  throw new Error("ARENA_WORKSPACE is required for the private slugify oracle");
}

const target = await import(pathToFileURL(
  path.join(workspace, "src/slugify.ts")
).href) as { slugify(value: string): string };

test("private full suite covers consecutive mixed whitespace", () => {
  assert.equal(target.slugify("  Hello\t \nWorld  "), "hello-world");
});
