import { describe, expect, it, vi } from "vitest";

import {
  LiveSmokeRequestError,
  requestLiveSmokeJson
} from "../../scripts/smoke-live-codex.js";

describe("live smoke stage errors", () => {
  it("maps a contract HTTP failure to a bounded stage-specific safe code", async () => {
    const secret = "sk-private-response-body";
    const fetchImpl = vi.fn(async () => new Response(secret, { status: 500 }));
    let caught: unknown;
    try {
      await requestLiveSmokeJson(fetchImpl, "contract", "http://127.0.0.1/api/contracts", {
        headers: { authorization: "Bearer private-token" }
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LiveSmokeRequestError);
    expect(caught).toMatchObject({
      stage: "contract",
      code: "LIVE_CONTRACT_HTTP_500",
      message: "Live smoke contract request failed safely"
    });
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect(JSON.stringify(caught)).not.toContain("private-token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("distinguishes request transport and invalid JSON without exposing their errors", async () => {
    const privateTransport = new Error("private transport detail");
    await expect(requestLiveSmokeJson(
      async () => { throw privateTransport; },
      "run_poll",
      "http://127.0.0.1/api/runs/run_1"
    )).rejects.toMatchObject({
      code: "LIVE_RUN_POLL_REQUEST_FAILED",
      message: "Live smoke run_poll request failed safely"
    });
    await expect(requestLiveSmokeJson(
      async () => new Response("private invalid response", { status: 200 }),
      "report",
      "http://127.0.0.1/api/runs/run_1/report"
    )).rejects.toMatchObject({
      code: "LIVE_REPORT_RESPONSE_INVALID",
      message: "Live smoke report request failed safely"
    });
  });
});
