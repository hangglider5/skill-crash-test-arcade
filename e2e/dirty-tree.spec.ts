import { expect, test } from "@playwright/test";

test("runs the Dirty Tree defeat, reviewed Skill repair, and controlled victory", async ({ page }, testInfo) => {
  const browserProblems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      browserProblems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => browserProblems.push(`pageerror: ${error.message}`));
  await page.goto("/?token=dev-token");
  await expect(page).toHaveTitle("Skill Crash Test Arcade");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);

  const liveProof = page.getByRole("region", { name: "Prior authorized live smoke" });
  await expect(liveProof.getByText("LIVE · GPT-5.6 SOL", { exact: true })).toBeVisible();
  await expect(liveProof.getByText("VICTORY · 80/100", { exact: true })).toBeVisible();
  await expect(liveProof.getByText("5/5 VERIFIERS PASSED", { exact: true })).toBeVisible();
  await expect(liveProof.getByRole("link", { name: "Download sanitized report" })).toBeVisible();

  await page.getByRole("tab", { name: "Sample" }).click();
  await expect(page.getByText("Recorded Replay", { exact: true })).toBeVisible();
  await expect(page.getByText(/distinct from a Live Run/i)).toBeVisible();
  await page.getByRole("button", { name: "Inspect source" }).click();

  const snapshot = page.getByRole("region", { name: "Skill Snapshot" });
  await expect(snapshot.getByText("LOCKED", { exact: true })).toBeVisible();
  await expect(snapshot.getByText("repo-bugfix", { exact: true })).toBeVisible();
  await expect(page.getByText("preservation unspecified", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Dirty Tree Doppelgänger/ })).toBeChecked();

  await page.getByRole("button", { name: "Start Crash Test" }).click();
  await expect(page.locator(".locked-live-verdict").getByText("DEFEAT", { exact: true }))
    .toBeVisible();
  await expect(page.locator(".locked-live-verdict").getByText("58/100", { exact: true }))
    .toBeVisible();

  await page.getByRole("button", { name: "Compare" }).click();
  await expect(page.getByRole("heading", { name: "DEFEAT", exact: true })).toBeVisible();
  const protectedFailure = page.locator(".failure-chain li", {
    hasText: "Protected changes modified: docs/roadmap.md"
  });
  await expect(protectedFailure).toBeVisible();
  await protectedFailure.getByRole("button").first().click();
  await expect(page.getByText(/Selected evidence:/)).toBeVisible();
  const defeatScreenshot = await page.screenshot({
    fullPage: false,
    path: "/tmp/skill-crash-test-arcade-locked-defeat.png"
  });
  await testInfo.attach("locked-defeat-evidence", {
    body: defeatScreenshot,
    contentType: "image/png"
  });

  await page.getByRole("button", { name: "Diagnose locked defeat" }).click();
  await expect(page.getByText("ADVISORY", { exact: true })).toBeVisible();
  await expect(page.getByText(/pre-existing roadmap draft was overwritten/i)).toBeVisible();

  await page.getByRole("button", { name: "Create repair candidate" }).click();
  const changedPaths = page.locator(".changed-paths");
  await expect(changedPaths.getByText("SKILL.md", { exact: true })).toBeVisible();
  await expect(changedPaths.locator("li")).toHaveCount(1);
  await expect(page.getByText("Original unchanged", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Approve & Rerun" }).click();
  await expect(page.locator(".locked-live-verdict").getByText("VICTORY", { exact: true }))
    .toBeVisible();
  await page.screenshot({
    fullPage: false,
    path: "/tmp/skill-crash-test-arcade-child-victory.png"
  });

  await page.getByRole("button", { name: "Compare" }).click();
  await expect(page.getByText("Controlled comparison", { exact: true })).toBeVisible();
  await expect(page.getByText("Observed improvement", { exact: true })).toBeVisible();
  const proof = page.getByRole("list", { name: "Comparison proof" });
  for (const label of [
    "Same Manifest",
    "Same fixture",
    "Same Runner config",
    "Changed Skill Snapshot",
    "Approved repair"
  ]) {
    await expect(proof.locator("li").filter({ hasText: label })).toBeVisible();
  }
  const victoryScreenshot = await page.screenshot({
    fullPage: true,
    path: "/tmp/skill-crash-test-arcade-controlled-victory.png"
  });
  await testInfo.attach("controlled-victory-proof", {
    body: victoryScreenshot,
    contentType: "image/png"
  });
  expect(browserProblems).toEqual([]);
});
