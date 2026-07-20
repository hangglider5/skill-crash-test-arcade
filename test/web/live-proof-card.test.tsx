import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LiveProofCard } from "../../apps/web/src/components/LiveProofCard.js";
import { VERIFIED_LIVE_PROOF } from "../../apps/web/src/live-proof.js";

describe("LiveProofCard", () => {
  it("renders the committed real-Sol proof without relabeling the active run", () => {
    render(<LiveProofCard {...VERIFIED_LIVE_PROOF} />);

    const card = screen.getByRole("region", { name: "Prior authorized live smoke" });
    expect(card).toHaveTextContent("LIVE · GPT-5.6 SOL");
    expect(card).toHaveTextContent("run_d8e70569-2c6e-4473-904e-0350adddbf9e");
    expect(card).toHaveTextContent("VICTORY · 80/100");
    expect(card).toHaveTextContent("5/5 VERIFIERS PASSED");
    expect(card).toHaveTextContent("REDACTION COMPLETE");
    expect(card).toHaveTextContent("24 sanitized event headers");
    expect(card).toHaveTextContent("Project-generated provenance metadata");
  });

  it("keeps full lineage available and exposes token-free report downloads", () => {
    render(<LiveProofCard {...VERIFIED_LIVE_PROOF} />);
    const { report, proof } = VERIFIED_LIVE_PROOF;
    const lineage = screen.getByText("Inspect verified proof lineage");

    expect(screen.getByText(proof.run_id)).not.toBeVisible();
    fireEvent.click(lineage);
    expect(screen.getByLabelText(`Manifest hash ${report.run.manifest_hash}`)).toBeVisible();
    expect(screen.getByLabelText(`Snapshot hash ${report.run.snapshot_hash}`)).toBeVisible();
    expect(screen.getByLabelText(`Fixture hash ${report.run.fixture_hash}`)).toBeVisible();

    const reportLink = screen.getByRole("link", { name: "Download sanitized report" });
    const traceLink = screen.getByRole("link", { name: "Download sanitized Trace" });
    expect(reportLink).toHaveAttribute("download", `arena-live-report-${proof.run_id}.json`);
    expect(traceLink).toHaveAttribute("download", `arena-live-trace-${proof.run_id}.jsonl`);
    expect(reportLink.getAttribute("href")).toMatch(/^data:application\/json/u);
    expect(traceLink.getAttribute("href")).toMatch(/^data:application\/x-ndjson/u);
    expect(reportLink.getAttribute("href")).not.toContain("token");
    expect(traceLink.getAttribute("href")).not.toContain("token");
  });

  it("offers the recorded crash test as the compact primary action", () => {
    const onTrySample = vi.fn();
    render(<LiveProofCard {...VERIFIED_LIVE_PROOF} onTrySample={onTrySample} />);

    const action = screen.getByRole("link", { name: "Try the recorded crash test" });
    expect(action).toHaveAttribute("href", "#source-title");
    fireEvent.click(action);
    expect(onTrySample).toHaveBeenCalledTimes(1);
  });

  it("reveals only the sanitized Trace projection", () => {
    render(<LiveProofCard {...VERIFIED_LIVE_PROOF} />);
    const details = screen.getByText("Inspect 24 sanitized event headers");
    fireEvent.click(details);

    expect(screen.getAllByText("agent.claimed")).toHaveLength(5);
    expect(screen.getByText("verifier.completed")).toBeVisible();
    expect(screen.getAllByText(/arena|codex|verifier|gpt-5\.6-sol/u).length).toBeGreaterThan(0);
    expect(screen.queryByText(/aggregated_output/u)).not.toBeInTheDocument();
  });
});
