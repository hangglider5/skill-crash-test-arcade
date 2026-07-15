import { describe, expect, it } from "vitest";

import { ExactActiveAuthority } from "../../src/core/repair-authority.js";

describe("ExactActiveAuthority", () => {
  it.each(["rejected", "approved", "failed"] as const)(
    "releases the exact %s terminal repair",
    (state) => {
      const authority = new ExactActiveAuthority<{ readonly id: string; state: string }>();
      const repair = { id: "repair_A", state };
      authority.replace("run_01", repair);

      expect(authority.release("run_01", repair)).toBe(true);
      expect(authority.current("run_01")).toBeUndefined();
    }
  );

  it("does not let stale A cleanup delete replacement B", () => {
    const authority = new ExactActiveAuthority<{ readonly id: string }>();
    const first = { id: "repair_A" };
    const second = { id: "repair_B" };
    authority.replace("run_01", first);
    expect(authority.replace("run_01", second)).toBe(first);

    expect(authority.release("run_01", first)).toBe(false);
    expect(authority.current("run_01")).toBe(second);
    expect(authority.release("run_01", second)).toBe(true);
    expect(authority.current("run_01")).toBeUndefined();
  });
});
