import { describe, expect, it } from "vitest";
import {
  connectionCheckRuntimeRefusal,
  type ConnectionCheckCode,
} from "../../apps/desktop/connection-check-command";
import { mappedOperationOutcome } from "../../apps/desktop/renderer/operation-outcomes";
import { ProductConfigurationResultSchema } from "../../src/pkg/product-settings/contract";
import { chatGptPreSubmitRemedy } from "../../src/ui/chatgpt-pre-submit-remedy";

const ready: Parameters<typeof connectionCheckRuntimeRefusal>[0] = {
  appSelected: true,
  workspaceKnown: true,
  tunnelPresent: true,
  runtimeState: "ready",
  buildCurrent: true,
  generationsCurrent: true,
  running: true,
  unresolvedEffect: false,
};

describe("Ping runtime refusal causes", () => {
  it.each<[string, Partial<typeof ready>, ConnectionCheckCode]>([
    ["no app", { appSelected: false }, "CONNECTION_CHECK_CONNECTOR_NOT_SET_UP"],
    [
      "no tunnel",
      { tunnelPresent: false },
      "CONNECTION_CHECK_CONNECTOR_NOT_SET_UP",
    ],
    [
      "no runtime record",
      { runtimeState: "missing" },
      "CONNECTION_CHECK_CONNECTOR_NOT_SET_UP",
    ],
    [
      "unreachable runtime",
      { runtimeState: "unreachable" },
      "CONNECTION_CHECK_RUNTIME_NOT_RUNNING",
    ],
    [
      "unknown runtime outcome",
      { runtimeState: "outcome_unknown" },
      "CONNECTION_CHECK_SETUP_UNRESOLVED",
    ],
    [
      "other build",
      { buildCurrent: false },
      "CONNECTION_CHECK_CONNECTOR_NOT_SET_UP",
    ],
    [
      "stale generation",
      { generationsCurrent: false },
      "CONNECTION_CHECK_CONNECTOR_NOT_SET_UP",
    ],
    ["not running", { running: false }, "CONNECTION_CHECK_RUNTIME_NOT_RUNNING"],
    [
      "unresolved effect",
      { unresolvedEffect: true },
      "CONNECTION_CHECK_SETUP_UNRESOLVED",
    ],
  ])("maps %s", (_name, change, code) => {
    expect(connectionCheckRuntimeRefusal({ ...ready, ...change })).toBe(code);
  });
});

describe("Ping refusal codes", () => {
  const codes = [
    "CONNECTION_CHECK_PREREQUISITES_REQUIRED",
    "CONNECTION_CHECK_HOST_NOT_READY",
    "CONNECTION_CHECK_CONNECTOR_NOT_SET_UP",
    "CONNECTION_CHECK_RUNTIME_NOT_RUNNING",
  ] as const;

  it.each(codes)("%s passes the result schema and is a refusal", (code) => {
    const failureArm = ProductConfigurationResultSchema.options.find(
      (option) => "error" in option.shape,
    );
    const errors =
      failureArm && "error" in failureArm.shape
        ? failureArm.shape.error.options
        : [];
    expect(errors).toContain(code);
    expect(mappedOperationOutcome(code)).toBe("refused");
  });

  it("names a distinct, actionable message per cause", () => {
    const messages = codes.map((code) => chatGptPreSubmitRemedy(code));
    expect(new Set(messages).size).toBe(codes.length);
    expect(messages[2]).toContain("Connect this Mac");
    expect(messages[3]).toContain("not running");
    expect(messages[3]).toContain("Connect this Mac");
    expect(messages[3]).not.toContain("ChatGPT page");
    expect(messages[1]).toContain("Try again in a moment");
    expect(messages[1]).toContain("open Setup");
  });
});
