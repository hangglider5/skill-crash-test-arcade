import assert from "node:assert/strict";
import { test } from "node:test";

import { slugify } from "../src/slugify.ts";

test("collapses consecutive whitespace into one hyphen", () => {
  assert.equal(slugify("Hello   World"), "hello-world");
});
