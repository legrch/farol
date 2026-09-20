import { describe, expect, it } from "vitest";
import {
  modelDisconnectedReadiness,
  modelDisconnectedSummary,
  modelEvidenceAbsenceAfterFailure,
} from "../../src/ui/model-presentation";

describe("Farol Model with no status evidence", () => {
  it("still reads as not connected before anything has been tried", () => {
    expect(modelDisconnectedReadiness("no-evidence-yet")).toBe("Not connected");
    expect(modelDisconnectedSummary("no-evidence-yet")).toBe(
      "Not connected. Preview the connection to see what Farol would change in your Codex config.toml.",
    );
  });

  it("says an endpoint stopped rather than that it never started", () => {
    expect(modelDisconnectedReadiness("endpoint-stopped")).toBe("Stopped");
    expect(modelDisconnectedSummary("endpoint-stopped")).toBe(
      "Farol Model stopped accepting requests. Preview the connection and apply it again.",
    );
  });

  it("names the failed rotation when that is what sealed the endpoint", () => {
    // The lifecycle seals the endpoint when a rotation can neither restore
    // nor clear its token, and every later command answers
    // MODEL_ENDPOINT_UNAVAILABLE. The card must not present that as a
    // connection the owner has not made yet.
    expect(modelDisconnectedSummary("endpoint-stopped-after-rotation")).toBe(
      "Farol Model stopped accepting requests after a failed token rotation. Preview the connection and apply it again.",
    );
  });
});

describe("classifying a failed model command", () => {
  it("treats an unavailable endpoint after a rotation as a stop with a cause", () => {
    expect(
      modelEvidenceAbsenceAfterFailure(
        "MODEL_ENDPOINT_UNAVAILABLE",
        "model.rotate-token",
      ),
    ).toBe("endpoint-stopped-after-rotation");
  });

  it("treats an unavailable endpoint from any other command as a plain stop", () => {
    for (const kind of [
      "model.status",
      "model.config-preview",
      "model.config-apply",
      "model.config-rollback",
    ]) {
      expect(
        modelEvidenceAbsenceAfterFailure("MODEL_ENDPOINT_UNAVAILABLE", kind),
      ).toBe("endpoint-stopped");
    }
  });

  it("does not claim the endpoint stopped for an unrelated refusal", () => {
    // Only MODEL_ENDPOINT_UNAVAILABLE means the endpoint is refusing
    // everything. A cancelled picker or a busy host says nothing about it,
    // and must leave the card's reading alone.
    for (const error of [
      "CODEX_HOST_PICKER_CANCELLED",
      "CODEX_AGENT_STILL_RUNNING",
      "MODEL_CONFIG_CONFLICT",
    ]) {
      expect(
        modelEvidenceAbsenceAfterFailure(error, "model.rotate-token"),
      ).toBeNull();
    }
  });
});
