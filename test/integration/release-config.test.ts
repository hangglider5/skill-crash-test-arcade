import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly scripts: Readonly<Record<string, string>>;
}

describe("development and production launch documentation", () => {
  it("keeps dev on Vite without auto-opening Core and preserves the built production launcher", async () => {
    const projectRoot = path.resolve(".");
    const [manifestText, readme] = await Promise.all([
      readFile(path.join(projectRoot, "package.json"), "utf8"),
      readFile(path.join(projectRoot, "README.md"), "utf8")
    ]);
    const manifest = JSON.parse(manifestText) as PackageManifest;

    expect(manifest.scripts["dev:core"]).toContain("--no-open");
    expect(manifest.scripts.start).toBe("node dist/core/cli.js");
    expect(manifest.scripts.start).not.toContain("--no-open");
    expect(readme).toContain("http://127.0.0.1:5173/?token=dev-token");
    expect(readme).toMatch(/Vite proxies the token-authenticated `\/api` requests to Core/u);
    expect(readme).toMatch(/`pnpm start`.+randomized tokenized.+4317/u);
  });
});
