import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { expect, test, type Locator, type Page } from "@playwright/test";

const execFileAsync = promisify(execFile);
const outputDirectory = resolve("artifacts/demo");
const webmPath = resolve(outputDirectory, "skill-crash-test-arcade-demo-silent.webm");
const mp4Path = resolve(outputDirectory, "skill-crash-test-arcade-demo-silent-1080p.mp4");
const narrationPacing = 1.6;

async function hold(page: Page, milliseconds: number): Promise<void> {
  // Leave enough reading room for the 2:40 submission narration without
  // slowing down browser motion in the editor.
  await page.waitForTimeout(milliseconds * narrationPacing);
}

async function spotlight(
  page: Page,
  locator: Locator,
  holdMilliseconds = 1_200
): Promise<void> {
  await locator.evaluate((element) => {
    element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    element.animate([
      { boxShadow: "0 0 0 0 rgb(34 211 238 / 0%)" },
      { boxShadow: "0 0 0 5px rgb(34 211 238 / 55%)" },
      { boxShadow: "0 0 0 0 rgb(34 211 238 / 0%)" }
    ], { duration: 1_050, easing: "ease-in-out" });
  });
  await hold(page, holdMilliseconds);
}

async function convertToMp4(inputPath: string, outputPath: string): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-an",
      "-vf", "scale=1920:1080:flags=lanczos",
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outputPath
    ], { maxBuffer: 16 * 1024 * 1024 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

test("records the submission-ready Dirty Tree product walkthrough", async ({ page }) => {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    rm(webmPath, { force: true }),
    rm(mp4Path, { force: true })
  ]);

  const browserProblems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      browserProblems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => browserProblems.push(`pageerror: ${error.message}`));

  const video = page.video();
  if (video === null) throw new Error("Playwright video capture is not enabled");

  await page.goto("/?token=dev-token");
  await expect(page).toHaveTitle("Skill Crash Test Arcade");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await hold(page, 3_500);

  const liveProof = page.getByRole("region", { name: "Prior authorized live smoke" });
  await spotlight(page, liveProof, 2_400);
  const proofLineage = liveProof.getByText("Inspect verified proof lineage", { exact: true });
  await proofLineage.click();
  await expect(liveProof.getByRole("link", { name: "Download sanitized report" })).toBeVisible();
  await hold(page, 3_800);
  await proofLineage.click();

  const sampleCta = liveProof.getByRole("link", { name: "Try the recorded crash test" });
  await spotlight(page, sampleCta, 900);
  await sampleCta.click();
  await expect(page.getByRole("tab", { name: "Sample" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Recorded Replay", { exact: true })).toBeVisible();
  await hold(page, 3_200);

  const inspectButton = page.getByRole("button", { name: "Inspect source" });
  await spotlight(page, inspectButton, 900);
  await inspectButton.click();
  const snapshot = page.getByRole("region", { name: "Skill Snapshot" });
  await expect(snapshot.getByText("LOCKED", { exact: true })).toBeVisible();
  await spotlight(page, snapshot, 4_600);

  const arenaMatch = page.getByRole("region", { name: "Arena Match" });
  await spotlight(page, arenaMatch, 3_500);
  const preflight = page.getByRole("region", { name: "Runner Preflight" });
  await spotlight(page, preflight, 3_500);

  const startButton = page.getByRole("button", { name: "Start Crash Test" });
  await spotlight(page, startButton, 1_000);
  await startButton.click();
  const defeat = page.locator(".locked-live-verdict").getByText("DEFEAT", { exact: true });
  await expect(defeat).toBeVisible();
  await expect(page.locator(".locked-live-verdict").getByText("58/100", { exact: true }))
    .toBeVisible();
  const defeatArena = page.locator(".arena-stage.arena-tone-defeat");
  await expect(defeatArena.getByText("HARD GATE DEFEAT", { exact: true })).toBeVisible();
  await spotlight(page, defeatArena, 5_500);

  await page.getByRole("button", { name: "Compare" }).click();
  await expect(page.getByRole("heading", { name: "DEFEAT", exact: true })).toBeVisible();
  await hold(page, 4_800);
  const protectedFailure = page.locator(".failure-chain li", {
    hasText: "Protected changes modified: docs/roadmap.md"
  });
  await spotlight(page, protectedFailure, 6_000);

  const diagnoseButton = page.getByRole("button", { name: "Diagnose locked defeat" });
  await spotlight(page, diagnoseButton, 900);
  await diagnoseButton.click();
  await expect(page.getByText(/pre-existing roadmap draft was overwritten/i)).toBeVisible();
  await spotlight(page, page.locator(".diagnosis-section"), 6_500);

  const createRepairButton = page.getByRole("button", { name: "Create repair candidate" });
  await spotlight(page, createRepairButton, 900);
  await createRepairButton.click();
  const changedPaths = page.locator(".changed-paths");
  await expect(changedPaths.getByText("SKILL.md", { exact: true })).toBeVisible();
  await expect(changedPaths.locator("li")).toHaveCount(1);
  await spotlight(page, page.locator(".repair-section"), 7_500);

  const approveButton = page.getByRole("button", { name: "Approve & Rerun" });
  await spotlight(page, approveButton, 1_000);
  await approveButton.click();
  const victory = page.locator(".locked-live-verdict").getByText("VICTORY", { exact: true });
  await expect(victory).toBeVisible();
  await expect(page.locator(".locked-live-verdict").getByText("98/100", { exact: true }))
    .toBeVisible();
  const victoryArena = page.locator(".arena-stage.arena-tone-victory");
  await expect(victoryArena.getByText("VERIFIED VICTORY", { exact: true })).toBeVisible();
  await spotlight(page, victoryArena, 6_000);

  await page.getByRole("button", { name: "Compare" }).click();
  const controlledHeading = page.getByRole("heading", { name: "Controlled improvement" });
  await expect(controlledHeading).toBeVisible();
  await expect(page.getByLabel("Baseline: defeat, 58 out of 100")).toBeVisible();
  await expect(page.getByLabel("Repaired Skill: victory, 98 out of 100")).toBeVisible();
  await spotlight(page, page.locator(".comparison-hero"), 7_500);

  const comparisonProof = page.getByRole("list", { name: "Comparison proof" });
  await spotlight(page, comparisonProof, 7_500);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await hold(page, 5_500);

  expect(browserProblems).toEqual([]);
  await page.close();
  await video.saveAs(webmPath);
  const mp4Created = await convertToMp4(webmPath, mp4Path);

  console.log(`Demo recording ready: ${webmPath}`);
  console.log(mp4Created
    ? `1080p editing master ready: ${mp4Path}`
    : "FFmpeg was not found; keep the WebM or install FFmpeg to create the MP4 master.");
});
