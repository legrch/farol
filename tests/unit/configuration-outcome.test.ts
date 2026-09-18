import { describe, expect, it } from "vitest";
import {
  classifyConfigurationResponse,
  UNCONFIRMED_CONFIGURATION_MESSAGE,
  type ConfigurationTransport,
} from "../../src/ui/configuration-outcome";

// A minimal, schema-valid snapshot. Its own contents are not under test here
// — only whether it is carried through applied/refused and withheld on an
// unconfirmed outcome.
const snapshot = {
  status: "error",
  error: "SETTINGS_CORRUPT",
} as const;

describe("classifyConfigurationResponse", () => {
  it("classifies a malformed reply as unconfirmed, never as a refusal", () => {
    const transport: ConfigurationTransport = {
      settled: "fulfilled",
      value: { ok: "not-a-boolean" },
    };

    const outcome = classifyConfigurationResponse(transport);

    expect(outcome).toEqual({
      kind: "unconfirmed",
      reason: "malformed-response",
    });
  });

  it("classifies a rejected transport as unconfirmed with its own reason", () => {
    const transport: ConfigurationTransport = { settled: "rejected" };

    const outcome = classifyConfigurationResponse(transport);

    expect(outcome).toEqual({
      kind: "unconfirmed",
      reason: "transport-rejected",
    });
  });

  it("never states or implies that nothing was applied", () => {
    expect(UNCONFIRMED_CONFIGURATION_MESSAGE).not.toMatch(/nothing/iu);
    expect(UNCONFIRMED_CONFIGURATION_MESSAGE).toMatch(
      /could not be confirmed/iu,
    );
    expect(UNCONFIRMED_CONFIGURATION_MESSAGE).toMatch(
      /already have taken effect/iu,
    );
    expect(UNCONFIRMED_CONFIGURATION_MESSAGE).toMatch(
      /check the current state/iu,
    );
  });

  it("classifies a valid refusal as refused and preserves its exact error code (positive control)", () => {
    const transport: ConfigurationTransport = {
      settled: "fulfilled",
      value: { ok: false, error: "CONNECTOR_STOP_REQUIRED", snapshot },
    };

    const outcome = classifyConfigurationResponse(transport);

    expect(outcome.kind).toBe("refused");
    expect(outcome.kind).not.toBe("unconfirmed");
    if (outcome.kind !== "refused") throw new Error("expected refused");
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error).toBe("CONNECTOR_STOP_REQUIRED");
    expect(outcome.result.snapshot).toEqual(snapshot);
  });

  it("classifies a valid success as applied", () => {
    const transport: ConfigurationTransport = {
      settled: "fulfilled",
      value: { ok: true, snapshot },
    };

    const outcome = classifyConfigurationResponse(transport);

    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("expected applied");
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.snapshot).toEqual(snapshot);
  });
});
