import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../src/protocol/index.js";

describe("protocol hashing", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(canonicalJson({
      "ä": 3,
      z: 2,
      nested: { second: 2, first: 1 },
      array: [{ beta: 2, alpha: 1 }, "unchanged"]
    })).toBe(
      "{\"array\":[{\"alpha\":1,\"beta\":2},\"unchanged\"],\"nested\":{\"first\":1,\"second\":2},\"z\":2,\"ä\":3}"
    );
  });

  it("sorts integer-like object keys lexically at every depth", () => {
    expect(canonicalJson({ nested: { "2": "two", "10": "ten" } })).toBe(
      "{\"nested\":{\"10\":\"ten\",\"2\":\"two\"}}"
    );
  });

  it("computes a lowercase SHA-256 digest", () => {
    expect(sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});
